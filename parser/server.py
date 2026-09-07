from __future__ import annotations

import os
import re
import ipaddress
import logging
import signal
import unicodedata
from concurrent import futures
from email.message import Message
from pathlib import PurePosixPath
from urllib.parse import urlparse

import grpc
import httpx

from .contracts import ParserFailure
from .media import OpenAICompatibleVlmClient
from .router import ParserRouter


GRPC_MAX_MESSAGE_BYTES = 64 * 1024 * 1024
GRPC_MESSAGE_OPTIONS = (
    ("grpc.max_send_message_length", GRPC_MAX_MESSAGE_BYTES),
    ("grpc.max_receive_message_length", GRPC_MAX_MESSAGE_BYTES),
)
SOURCE_HARD_LIMIT_BYTES = 50 * 1024 * 1024
SOURCE_STREAM_CHUNK_BYTES = 64 * 1024
LOGGER = logging.getLogger(__name__)


def _generated_modules():
    try:
        from .generated import parser_pb2, parser_pb2_grpc
    except ImportError as error:
        raise RuntimeError(
            "gRPC bindings are missing; run `python scripts/generate_proto.py`"
        ) from error
    return parser_pb2, parser_pb2_grpc


class ParserService:
    def __init__(self, router: ParserRouter | None = None) -> None:
        self._router = router or ParserRouter()

    def Parse(self, request, context):
        parser_pb2, _ = _generated_modules()
        yield parser_pb2.ParseEvent(
            progress=parser_pb2.Progress(stage="download", percent=5, message="Downloading source")
        )
        try:
            source, source_name = _download_source(request.source_url)
            yield parser_pb2.ParseEvent(
                progress=parser_pb2.Progress(stage="parse", percent=20, message="Parsing document")
            )
            vlm_client = _vlm_client(
                request.vlm_endpoint,
                request.vlm_model,
                request.vlm_api_key,
            )
            document = self._router.parse_bytes(
                source,
                mime_type=request.mime_type,
                engine=request.engine,
                source_name=source_name,
                vlm_client=vlm_client,
            )
            for block in document.blocks:
                yield parser_pb2.ParseEvent(block=_block_message(parser_pb2, block))
            for asset in document.assets:
                yield parser_pb2.ParseEvent(asset=_asset_message(parser_pb2, asset))
            yield parser_pb2.ParseEvent(
                completed=parser_pb2.Completed(
                    page_count=document.page_count,
                    block_count=len(document.blocks),
                    asset_count=len(document.assets),
                    warnings=document.warnings,
                )
            )
        except ParserFailure as error:
            yield parser_pb2.ParseEvent(
                error=parser_pb2.Error(
                    code=error.code,
                    message=str(error),
                    retryable=error.retryable,
                )
            )
        except (httpx.HTTPError, ValueError) as error:
            yield parser_pb2.ParseEvent(
                error=parser_pb2.Error(
                    code="SOURCE_DOWNLOAD_FAILED",
                    message="Parser could not download the source document",
                    retryable=True,
                )
            )


def _download_source(source_url: str) -> tuple[bytes, str]:
    parsed = urlparse(source_url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("source_url must be an internal HTTP(S) URL")
    max_source_bytes = _max_source_bytes()
    try:
        with httpx.Client(
            timeout=_source_timeout_seconds(), follow_redirects=False
        ) as client:
            with client.stream("GET", source_url) as response:
                response.raise_for_status()
                content_length = response.headers.get("Content-Length")
                if content_length is not None and int(content_length) > max_source_bytes:
                    raise ParserFailure(
                        "SOURCE_TOO_LARGE",
                        "Source document exceeds the parser size limit",
                        retryable=False,
                    )
                chunks: list[bytes] = []
                total_bytes = 0
                for chunk in response.iter_bytes(SOURCE_STREAM_CHUNK_BYTES):
                    total_bytes += len(chunk)
                    if total_bytes > max_source_bytes:
                        raise ParserFailure(
                            "SOURCE_TOO_LARGE",
                            "Source document exceeds the parser size limit",
                            retryable=False,
                        )
                    chunks.append(chunk)
                content = b"".join(chunks)
                source_name = _response_filename(response)
    except ParserFailure:
        raise
    except httpx.HTTPStatusError as error:
        status_code = error.response.status_code
        raise ParserFailure(
            "SOURCE_DOWNLOAD_FAILED",
            "Parser could not download the source document",
            retryable=status_code >= 500,
        ) from error
    except (httpx.TimeoutException, httpx.TransportError) as error:
        raise ParserFailure(
            "SOURCE_DOWNLOAD_FAILED",
            "Parser could not download the source document",
            retryable=True,
        ) from error
    if not content:
        raise ParserFailure("EMPTY_CONTENT", "The source document is empty")
    fallback_name = PurePosixPath(parsed.path).name or "document"
    return content, source_name or _normalize_source_filename(fallback_name)


def _max_source_bytes() -> int:
    raw_limit = os.getenv("OHMYDOCAGENT_PARSER_MAX_SOURCE_BYTES", os.getenv("DOCMIND_PARSER_MAX_SOURCE_BYTES"))
    if raw_limit is None:
        return SOURCE_HARD_LIMIT_BYTES
    try:
        configured = int(raw_limit)
    except ValueError:
        return SOURCE_HARD_LIMIT_BYTES
    return min(max(configured, 1), SOURCE_HARD_LIMIT_BYTES)


def _source_timeout_seconds() -> float:
    raw_timeout = os.getenv("OHMYDOCAGENT_PARSER_SOURCE_TIMEOUT_SECONDS", os.getenv("DOCMIND_PARSER_SOURCE_TIMEOUT_SECONDS"))
    if raw_timeout is None:
        return 60.0
    try:
        configured = float(raw_timeout)
    except ValueError:
        return 60.0
    return min(max(configured, 0.01), 60.0)


def _response_filename(response: httpx.Response) -> str | None:
    disposition = response.headers.get("Content-Disposition")
    if not disposition:
        return None
    message = Message()
    message["Content-Disposition"] = disposition
    filename = message.get_filename()
    if not filename:
        return None
    return _normalize_source_filename(filename)


def _normalize_source_filename(filename: str) -> str:
    normalized = unicodedata.normalize("NFKC", filename).replace("\\", "/")
    basename = PurePosixPath(normalized).name
    basename = "".join(
        character
        for character in basename
        if not unicodedata.category(character).startswith("C")
    )
    basename = re.sub(r'[<>:"|?*]', "_", basename)
    extension = PurePosixPath(basename).suffix.lower()
    stem = basename[: -len(extension)] if extension else basename
    stem = stem.strip(" ._") or "document"
    extension_bytes = len(extension.encode("utf-8"))
    max_stem_bytes = max(1, 255 - extension_bytes)
    stem = stem.encode("utf-8")[:max_stem_bytes].decode("utf-8", errors="ignore")
    return f"{stem or 'document'}{extension}"


def _vlm_client(
    endpoint: str,
    model: str,
    request_api_key: str = "",
) -> OpenAICompatibleVlmClient | None:
    api_key = request_api_key or os.getenv("OHMYDOCAGENT_VLM_API_KEY", os.getenv("DOCMIND_VLM_API_KEY", ""))
    if not endpoint or not model or not api_key:
        return None
    return OpenAICompatibleVlmClient(endpoint=endpoint, model=model, api_key=api_key)


def _block_message(parser_pb2, block):
    kwargs = {
        "block_id": block.block_id,
        "type": block.type,
        "text": block.text,
        "page": block.page,
        "order": block.order,
        "heading_path": block.heading_path,
        "asset_key": block.asset_key or "",
    }
    if block.bbox is not None:
        kwargs["bbox"] = _bbox_message(parser_pb2, block.bbox)
    return parser_pb2.Block(**kwargs)


def _asset_message(parser_pb2, asset):
    kwargs = {
        "asset_key": asset.asset_key,
        "mime_type": asset.mime_type,
        "content": asset.content,
        "page": asset.page,
        "description": asset.description or "",
    }
    if asset.bbox is not None:
        kwargs["bbox"] = _bbox_message(parser_pb2, asset.bbox)
    return parser_pb2.Asset(**kwargs)


def _bbox_message(parser_pb2, bbox):
    return parser_pb2.BoundingBox(
        left=bbox.left,
        top=bbox.top,
        right=bbox.right,
        bottom=bbox.bottom,
    )


def _parser_bind_target(port: int) -> str:
    if not isinstance(port, int) or isinstance(port, bool) or not 1 <= port <= 65535:
        raise ValueError("DOCMIND_PARSER_PORT must be between 1 and 65535")
    configured = os.getenv("OHMYDOCAGENT_PARSER_BIND", os.getenv("DOCMIND_PARSER_BIND"))
    if configured is None:
        host = "127.0.0.1"
    else:
        host = configured.strip()
        if not host or host != configured:
            raise ValueError("DOCMIND_PARSER_BIND must be a non-empty IP address")
    candidate = host[1:-1] if host.startswith("[") and host.endswith("]") else host
    try:
        address = ipaddress.ip_address(candidate)
    except ValueError as error:
        raise ValueError("DOCMIND_PARSER_BIND must be a valid IP address") from error
    normalized = f"[{address}]" if address.version == 6 else str(address)
    return f"{normalized}:{port}"


def _parser_concurrency() -> int:
    raw_concurrency = os.getenv("OHMYDOCAGENT_PARSER_CONCURRENCY", os.getenv("DOCMIND_PARSER_CONCURRENCY", "1"))
    try:
        concurrency = int(raw_concurrency)
    except ValueError as error:
        raise ValueError("DOCMIND_PARSER_CONCURRENCY must be a positive integer") from error
    if concurrency < 1 or raw_concurrency.strip() != raw_concurrency:
        raise ValueError("DOCMIND_PARSER_CONCURRENCY must be a positive integer")
    return concurrency


def serve(port: int = 50051) -> grpc.Server:
    parser_pb2, parser_pb2_grpc = _generated_modules()
    server = grpc.server(
        futures.ThreadPoolExecutor(max_workers=_parser_concurrency()),
        options=GRPC_MESSAGE_OPTIONS,
    )
    service = ParserService()
    parser_pb2_grpc.add_ParserServicer_to_server(service, server)
    # Both application names share the same protobuf field numbers and wire format.
    # Keep existing clients working when the backend and parser upgrade separately.
    registered_name = parser_pb2.DESCRIPTOR.services_by_name["Parser"].full_name
    for alias in {"ohmydocagent.parser.v1.Parser", "docmind.parser.v1.Parser"} - {registered_name}:
        server.add_generic_rpc_handlers((grpc.method_handlers_generic_handler(alias, {
            "Parse": grpc.unary_stream_rpc_method_handler(
                service.Parse,
                request_deserializer=parser_pb2.ParseRequest.FromString,
                response_serializer=parser_pb2.ParseEvent.SerializeToString,
            ),
        }),))
    target = _parser_bind_target(port)
    if server.add_insecure_port(target) == 0:
        raise RuntimeError("Parser gRPC bind failed")
    server.start()
    LOGGER.info("DocMind parser listening on %s", target)
    return server


def _install_signal_shutdown(server: grpc.Server) -> None:
    def shutdown(_signum: int, _frame: object) -> None:
        server.stop(grace=5)

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)


def main() -> None:
    port = int(os.getenv("OHMYDOCAGENT_PARSER_PORT", os.getenv("DOCMIND_PARSER_PORT", "50051")))
    server = serve(port)
    _install_signal_shutdown(server)
    try:
        server.wait_for_termination()
    except KeyboardInterrupt:
        server.stop(grace=5)


if __name__ == "__main__":
    main()
