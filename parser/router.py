from __future__ import annotations

import re
from collections.abc import Callable

from .contracts import (
    PageSignal,
    ParsedAsset,
    ParsedBlock,
    ParsedDocument,
    ParserEngine,
    ParserFailure,
)
from .engines import DoclingEngine, MinerUEngine
from .media import (
    OpenAICompatibleVlmClient,
    describe_asset,
    estimate_image_tokens,
    is_significant_embedded_asset,
)


TEXT_MIME_TYPES = {"text/plain", "text/markdown"}
DOCUMENT_MIME_TYPES = {
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
}
IMAGE_MIME_TYPES = {"image/jpeg", "image/png", "image/webp"}
SUPPORTED_MIME_TYPES = TEXT_MIME_TYPES | DOCUMENT_MIME_TYPES | IMAGE_MIME_TYPES


def should_enable_ocr(signal: PageSignal) -> bool:
    return signal.usable_text_characters == 0 and signal.raster_count > 0


class ParserRouter:
    def __init__(
        self,
        engine_factories: dict[ParserEngine, Callable[[], object]] | None = None,
    ) -> None:
        self._engine_factories = engine_factories or {
            "docling": DoclingEngine,
            "mineru": MinerUEngine,
        }

    def parse_bytes(
        self,
        content: bytes,
        *,
        mime_type: str,
        engine: ParserEngine,
        source_name: str,
        vlm_client: OpenAICompatibleVlmClient | None = None,
    ) -> ParsedDocument:
        normalized_mime = mime_type.split(";", 1)[0].strip().lower()
        if normalized_mime not in SUPPORTED_MIME_TYPES:
            raise ParserFailure(
                "UNSUPPORTED_FORMAT",
                f"Unsupported document MIME type: {normalized_mime or '<empty>'}",
            )
        if engine not in self._engine_factories:
            raise ParserFailure("UNSUPPORTED_ENGINE", f"Unsupported parser engine: {engine}")
        if not content:
            raise ParserFailure("EMPTY_CONTENT", "The source document is empty")

        if normalized_mime in TEXT_MIME_TYPES:
            return _parse_text(content, normalized_mime, engine)
        if normalized_mime in IMAGE_MIME_TYPES:
            return _parse_image(content, normalized_mime, engine, vlm_client)
        adapter = self._engine_factories[engine]()
        ocr_required = _pdf_requires_ocr(content) if normalized_mime == "application/pdf" else False
        document = adapter.parse(
            content,
            mime_type=normalized_mime,
            source_name=source_name,
            ocr_required=ocr_required,
        )
        if vlm_client is None or not document.assets:
            return document

        described_assets: list[ParsedAsset] = []
        descriptions: dict[str, str] = {}
        warnings = list(document.warnings)
        # 多图批量描述（对齐 OhMyDocAgent 调优）：单图单次请求 token 贵且请求次数
        # = 图数——改为 describe_many 一次请求多图（[1]..[N] 编号输出），按
        # 「累计 token ≥ BATCH_TOKEN_BUDGET 或 张数 ≥ BATCH_MAX_IMAGES 谁先到
        # 切批」分批，批间 ThreadPool(4) 并发；批内缺失/失败项回退单张
        # describe()，仍失败保持 VLM_DESCRIPTION_FAILED 降级（不阻断文档）。
        for asset, description, warning in describe_many_assets(
            document.assets,
            vlm_client,
        ):
            described_assets.append(asset)
            if description:
                descriptions[asset.asset_key] = description
            if warning:
                warnings.append(warning)
        described_blocks = tuple(
            block.model_copy(update={"text": descriptions[block.asset_key]})
            if block.asset_key in descriptions and not block.text
            else block
            for block in document.blocks
        )
        return document.model_copy(
            update={
                "blocks": described_blocks,
                "assets": tuple(described_assets),
                "warnings": tuple(warnings),
            }
        )


def _pdf_requires_ocr(content: bytes) -> bool:
    import pypdfium2 as pdfium

    document = None
    try:
        document = pdfium.PdfDocument(content)
        for page in document:
            text_page = page.get_textpage()
            try:
                usable_text = text_page.get_text_bounded().strip()
            finally:
                text_page.close()
            raster_count = sum(
                1
                for _ in page.get_objects(filter=[pdfium.raw.FPDF_PAGEOBJ_IMAGE])
            )
            if should_enable_ocr(
                PageSignal(
                    usable_text_characters=len(usable_text),
                    raster_count=raster_count,
                )
            ):
                return True
        return False
    except Exception as error:
        raise ParserFailure(
            "INVALID_PDF",
            "PDF structure is invalid or unreadable",
            retryable=False,
        ) from error
    finally:
        if document is not None:
            document.close()


def _parse_text(content: bytes, mime_type: str, engine: ParserEngine) -> ParsedDocument:
    try:
        text = content.decode("utf-8-sig")
    except UnicodeDecodeError as error:
        raise ParserFailure("INVALID_TEXT_ENCODING", "Text inputs must use UTF-8") from error

    blocks: list[ParsedBlock] = []
    heading_path: tuple[str, ...] = ()
    paragraphs = [part.strip() for part in re.split(r"\n\s*\n", text) if part.strip()]
    for order, paragraph in enumerate(paragraphs):
        heading_match = re.fullmatch(r"(#{1,6})\s+(.+)", paragraph)
        if mime_type == "text/markdown" and heading_match:
            level = len(heading_match.group(1))
            heading = heading_match.group(2).strip()
            heading_path = heading_path[: level - 1] + (heading,)
            block_type = "heading"
            block_text = heading
        else:
            block_type = "paragraph"
            block_text = paragraph
        blocks.append(
            ParsedBlock(
                block_id=f"block-{order + 1}",
                type=block_type,
                text=block_text,
                order=order,
                heading_path=heading_path,
            )
        )

    if not blocks:
        raise ParserFailure("EMPTY_CONTENT", "No usable text was extracted")
    return ParsedDocument(
        parser_engine=engine,
        extraction_method="direct",
        blocks=tuple(blocks),
    )


def _parse_image(
    content: bytes,
    mime_type: str,
    engine: ParserEngine,
    vlm_client: OpenAICompatibleVlmClient | None,
) -> ParsedDocument:
    asset = ParsedAsset(
        asset_key="asset-1",
        mime_type=mime_type,
        content=content,
        description=None,
    )
    described_asset, warning = describe_asset(asset, vlm_client)
    warnings = (warning,) if warning else ()
    block = ParsedBlock(
        block_id="block-1",
        type="image",
        text=described_asset.description or "",
        order=0,
        asset_key=described_asset.asset_key,
    )
    return ParsedDocument(
        parser_engine=engine,
        extraction_method="direct",
        blocks=(block,),
        assets=(described_asset,),
        warnings=warnings,
    )


# ===== 多图批量 VLM 描述 =====
# 单张图单独一次 VLM 请求（单 image_url）token 贵、请求次数 = 图数，浪费。
# describe_many_assets：
#   1) 过滤 significant asset（≥4KB）；跳过项原样返回（无描述）
#   2) 发送前每张估算 token（按分辨率）→ 按「累计 ≥BATCH_TOKEN_BUDGET 或
#      张数 ≥BATCH_MAX_IMAGES，谁先到切批」
#   3) 每批调 client.describe_many（一次请求 N 图，模型按 [1]..[N] 编号输出）
#   4) 批间 ThreadPool(4) 并发（图多时吞吐）
#   5) 批内某图缺失/失败 → 仅该图回退 describe() 单张；仍失败 →
#      VLM_DESCRIPTION_FAILED 降级（不阻断文档，与既有降级语义一致）
# 返回按原 assets 顺序的 [(asset, description|None, warning|None)]。
_BATCH_TOKEN_BUDGET = 20000
_BATCH_MAX_IMAGES = 16
_VLM_PROMPT = "Describe each document image concisely for retrieval."


def describe_many_assets(
    assets: list,
    client: OpenAICompatibleVlmClient | None,
) -> list[tuple[object, str | None, str | None]]:
    if client is None:
        return [(a, None, None) for a in assets]
    # 1. 过滤 significant
    significant: list = []
    for asset in assets:
        if not is_significant_embedded_asset(asset):
            continue
        significant.append(asset)
    # 2-3. 分批：累计 token ≥ BATCH_TOKEN_BUDGET 或张数 ≥ BATCH_MAX_IMAGES
    batches: list[list] = []
    current: list = []
    tokens = 0
    for asset in significant:
        est = estimate_image_tokens(asset.content, asset.mime_type)
        if current and (tokens + est >= _BATCH_TOKEN_BUDGET or len(current) >= _BATCH_MAX_IMAGES):
            batches.append(current)
            current = []
            tokens = 0
        current.append(asset)
        tokens += est
    if current:
        batches.append(current)
    # 4. 批间并发（每批一次 describe_many——单次请求内已是 N 图，批间并发
    #    只对「批次数 >1」有意义，如超大图文档）
    from concurrent.futures import ThreadPoolExecutor

    def _run_batch(batch: list) -> list:
        try:
            descriptions = client.describe_many(
                [(a.content, a.mime_type) for a in batch],
                prompt=_VLM_PROMPT,
            )
        except Exception:
            return [None] * len(batch)  # 整批失败 → 全部回退单张
        return descriptions

    if len(batches) > 1:
        with ThreadPoolExecutor(max_workers=4) as pool:
            batch_results = list(pool.map(_run_batch, batches))
    else:
        batch_results = [_run_batch(b) for b in batches]

    # 5. 映射回 asset_key + 缺失回退单张
    results: dict[str, tuple[object, str | None, str | None]] = {}
    for batch, descs in zip(batches, batch_results):
        for idx, asset in enumerate(batch):
            desc = descs[idx] if idx < len(descs) else None
            if not (desc and desc.strip()):
                # 缺失/失败 → 回退单张 describe
                try:
                    fallback = client.describe(asset.content, mime_type=asset.mime_type)
                    if fallback and fallback.strip():
                        desc = fallback
                    else:
                        results[asset.asset_key] = (
                            asset,
                            None,
                            f"VLM_DESCRIPTION_FAILED:{asset.asset_key}",
                        )
                        continue
                except Exception:
                    results[asset.asset_key] = (
                        asset,
                        None,
                        f"VLM_DESCRIPTION_FAILED:{asset.asset_key}",
                    )
                    continue
            results[asset.asset_key] = (
                asset.model_copy(update={"description": desc.strip()}),
                desc.strip(),
                None,
            )
    # 按原顺序输出（含跳过的 non-significant asset——无描述无警告）
    ordered: list[tuple[object, str | None, str | None]] = []
    for asset in assets:
        if asset.asset_key in results:
            ordered.append(results[asset.asset_key])
        else:
            ordered.append((asset, None, None))
    return ordered
