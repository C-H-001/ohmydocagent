from __future__ import annotations

import json
import tempfile
import uuid
from pathlib import Path
from typing import Any

from ..contracts import BoundingBox, ParsedAsset, ParsedBlock, ParsedDocument, ParserFailure


class MinerUEngine:
    def parse(
        self,
        content: bytes,
        *,
        mime_type: str,
        source_name: str,
        ocr_required: bool,
    ) -> ParsedDocument:
        try:
            from mineru.cli.common import do_parse

            stem = _internal_output_stem()
            with tempfile.TemporaryDirectory(prefix="docmind-mineru-") as output_dir:
                do_parse(
                    output_dir=output_dir,
                    pdf_file_names=[stem],
                    pdf_bytes_list=[content],
                    p_lang_list=["ch"],
                    backend="pipeline",
                    parse_method="ocr" if ocr_required else "txt",
                    f_draw_layout_bbox=False,
                    f_draw_span_bbox=False,
                    f_dump_md=False,
                    f_dump_middle_json=False,
                    f_dump_model_output=False,
                    f_dump_orig_pdf=False,
                    f_dump_content_list=True,
                )
                result_path = _find_result(Path(output_dir), f"{stem}_content_list.json")
                entries = json.loads(result_path.read_text(encoding="utf-8"))
                blocks, assets = _normalize_content_list(entries, result_path.parent)
        except ParserFailure:
            raise
        except Exception as error:
            raise ParserFailure(
                "MINERU_PARSE_FAILED",
                "MinerU could not parse the document",
                retryable=False,
            ) from error

        if not blocks:
            raise ParserFailure("EMPTY_CONTENT", "MinerU extracted no usable content")
        return ParsedDocument(
            parser_engine="mineru",
            extraction_method="mineru",
            page_count=max(block.page for block in blocks),
            blocks=tuple(blocks),
            assets=tuple(assets),
        )


def _find_result(output_dir: Path, filename: str) -> Path:
    matches = list(output_dir.rglob(filename))
    if len(matches) != 1:
        raise ParserFailure("MINERU_OUTPUT_MISSING", "MinerU did not produce a content list")
    return matches[0]


def _internal_output_stem() -> str:
    return f"docmind-{uuid.uuid4().hex}"


def _normalize_content_list(
    entries: Any,
    output_dir: Path,
) -> tuple[list[ParsedBlock], list[ParsedAsset]]:
    if not isinstance(entries, list):
        raise ParserFailure("MINERU_OUTPUT_INVALID", "MinerU content list is not an array")

    blocks: list[ParsedBlock] = []
    assets: list[ParsedAsset] = []
    heading_path: tuple[str, ...] = ()
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        raw_type = str(entry.get("type", "text"))
        page = int(entry.get("page_idx", 0)) + 1
        bbox = _mineru_bbox(entry.get("bbox"))
        asset_key: str | None = None

        if raw_type in {"image", "figure", "chart"}:
            image_path = entry.get("img_path") or entry.get("image_path")
            asset = _read_asset(image_path, output_dir, page, bbox, len(assets), source_type=raw_type)
            if asset is not None:
                assets.append(asset)
                asset_key = asset.asset_key
            block_type = "image"
            if raw_type == "chart":
                text = _join_text(
                    entry.get("chart_caption"), entry.get("chart_body"), entry.get("chart_footnote")
                )
            else:
                text = _join_text(entry.get("image_caption"), entry.get("image_footnote"))
        elif raw_type == "table":
            block_type = "table"
            text = _join_text(entry.get("table_caption"), entry.get("table_body"), entry.get("table_footnote"))
        else:
            text = str(entry.get("text") or "").strip()
            level = entry.get("text_level")
            if isinstance(level, int) and level > 0:
                block_type = "heading"
                heading_path = heading_path[: level - 1] + (text,)
            elif raw_type in {"list", "list_item"}:
                block_type = "list_item"
            else:
                block_type = "paragraph"

        if not text and block_type != "image":
            continue
        blocks.append(
            ParsedBlock(
                block_id=f"block-{len(blocks) + 1}",
                type=block_type,
                text=text,
                page=page,
                order=len(blocks),
                bbox=bbox,
                heading_path=heading_path,
                asset_key=asset_key,
            )
        )
    return blocks, assets


def _mineru_bbox(value: Any) -> BoundingBox | None:
    if not isinstance(value, list) or len(value) != 4:
        return None
    return BoundingBox(left=value[0], top=value[1], right=value[2], bottom=value[3])


def _read_asset(
    value: Any,
    output_dir: Path,
    page: int,
    bbox: BoundingBox | None,
    index: int,
    *,
    source_type: str = "image",
) -> ParsedAsset | None:
    if not isinstance(value, str) or not value:
        return None
    candidate = (output_dir / value).resolve()
    if not candidate.is_relative_to(output_dir.resolve()) or not candidate.is_file():
        return None
    mime_type = "image/png" if candidate.suffix.lower() == ".png" else "image/jpeg"
    return ParsedAsset(
        asset_key=f"asset-{index + 1}{candidate.suffix.lower()}",
        mime_type=mime_type,
        content=candidate.read_bytes(),
        page=page,
        bbox=bbox,
        source_type=source_type,
    )


def _join_text(*values: Any) -> str:
    return "\n".join(str(value).strip() for value in values if value and str(value).strip())
