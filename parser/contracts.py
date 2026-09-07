from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


ParserEngine = Literal["docling", "mineru"]
ExtractionMethod = Literal["direct", "docling", "mineru"]
BlockType = Literal["heading", "paragraph", "table", "image", "list_item"]


class BoundingBox(BaseModel):
    model_config = ConfigDict(frozen=True)

    left: float
    top: float
    right: float
    bottom: float


class ParsedBlock(BaseModel):
    model_config = ConfigDict(frozen=True)

    block_id: str
    type: BlockType
    text: str = ""
    page: int = Field(default=1, ge=1)
    order: int = Field(ge=0)
    bbox: BoundingBox | None = None
    heading_path: tuple[str, ...] = ()
    asset_key: str | None = None


class ParsedAsset(BaseModel):
    model_config = ConfigDict(frozen=True)

    asset_key: str
    mime_type: str
    content: bytes
    page: int = Field(default=1, ge=1)
    bbox: BoundingBox | None = None
    description: str | None = None
    # Internal routing hint; deliberately not added to the public gRPC schema.
    source_type: Literal["image", "figure", "chart"] = "image"


class ParsedDocument(BaseModel):
    model_config = ConfigDict(frozen=True)

    parser_engine: ParserEngine
    extraction_method: ExtractionMethod
    page_count: int = Field(default=1, ge=1)
    blocks: tuple[ParsedBlock, ...]
    assets: tuple[ParsedAsset, ...] = ()
    warnings: tuple[str, ...] = ()


class PageSignal(BaseModel):
    model_config = ConfigDict(frozen=True)

    usable_text_characters: int = Field(ge=0)
    raster_count: int = Field(ge=0)


class ParserFailure(RuntimeError):
    def __init__(self, code: str, message: str, *, retryable: bool = False) -> None:
        super().__init__(message)
        self.code = code
        self.retryable = retryable
