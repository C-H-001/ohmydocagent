"""Run inside a parser image: python -m unittest discover -s /tests -v."""

import base64
import importlib
import importlib.util
import io
import json
import random
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx
from PIL import Image


PACKAGE = next(
    name for name in ("ohmydocagent_parser", "docmind_parser")
    if importlib.util.find_spec(name) is not None
)
engine = importlib.import_module(f"{PACKAGE}.engines.mineru_engine")
router = importlib.import_module(f"{PACKAGE}.router")
media = importlib.import_module(f"{PACKAGE}.media")


def chart_png():
    # Real, non-trivial image bytes exercise the existing significant-image gate.
    pixels = random.Random(17).randbytes(128 * 128 * 3)
    image = Image.frombytes("RGB", (128, 128), pixels)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


class MinerUChartTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="parser-chart-test-")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        (self.root / "images").mkdir()
        self.image = chart_png()
        (self.root / "images" / "chart.png").write_bytes(self.image)

    def test_chart_without_text_retains_image_asset_and_position(self):
        blocks, assets = engine._normalize_content_list([
            {"type": "text", "text": "Results", "text_level": 1, "page_idx": 0},
            {"type": "chart", "img_path": "images/chart.png", "page_idx": 2,
             "bbox": [10, 20, 300, 400]},
        ], self.root)

        self.assertEqual(len(assets), 1)
        self.assertEqual(len(blocks), 2)
        self.assertEqual(blocks[1].type, "image")
        self.assertEqual(blocks[1].text, "")
        self.assertEqual(blocks[1].page, 3)
        self.assertEqual(blocks[1].order, 1)
        self.assertEqual(blocks[1].heading_path, ("Results",))
        self.assertEqual(blocks[1].asset_key, assets[0].asset_key)
        self.assertEqual(assets[0].content, self.image)
        self.assertEqual(assets[0].mime_type, "image/png")
        self.assertEqual(assets[0].bbox.model_dump(),
                         {"left": 10, "top": 20, "right": 300, "bottom": 400})

    def test_chart_text_is_preserved_when_image_is_missing(self):
        blocks, assets = engine._normalize_content_list([
            {"type": "chart", "img_path": "images/missing.png",
             "chart_caption": "Annual revenue", "chart_body": "2024: 1503",
             "chart_footnote": "Unit: million"},
        ], self.root)

        self.assertEqual(len(blocks), 1)
        self.assertEqual(blocks[0].text, "Annual revenue\n2024: 1503\nUnit: million")
        self.assertEqual(assets, [])

    def test_existing_images_figures_and_tables_keep_their_content(self):
        blocks, assets = engine._normalize_content_list([
            {"type": "image", "img_path": "images/chart.png", "image_caption": "Photo"},
            {"type": "figure", "image_path": "images/chart.png", "image_footnote": "Source"},
            {"type": "table", "table_caption": "Table", "table_body": "<table>1500</table>",
             "table_footnote": "95%"},
        ], self.root)

        self.assertEqual([block.type for block in blocks], ["image", "image", "table"])
        self.assertEqual([block.text for block in blocks],
                         ["Photo", "Source", "Table\n<table>1500</table>\n95%"])
        self.assertEqual(len(assets), 2)

    def test_chart_asset_cannot_escape_output_directory(self):
        (self.root / "private.png").write_bytes(self.image)
        blocks, assets = engine._normalize_content_list([
            {"type": "chart", "img_path": "../private.png"},
        ], self.root / "images")
        self.assertEqual(len(blocks), 1)
        self.assertIsNone(blocks[0].asset_key)
        self.assertEqual(assets, [])

    def parse_chart(self, vlm_client=None):
        # Only replace the external MinerU inference; normalize/router/media stay real.
        def extract(**kwargs):
            output = Path(kwargs["output_dir"])
            (output / "chart.png").write_bytes(self.image)
            entries = [{"type": "chart", "img_path": "chart.png", "page_idx": 1}]
            (output / f'{kwargs["pdf_file_names"][0]}_content_list.json').write_text(
                json.dumps(entries), encoding="utf-8")

        mineru_cli = types.ModuleType("mineru.cli.common")
        mineru_cli.do_parse = extract
        with patch.dict(sys.modules, {"mineru.cli.common": mineru_cli}), \
                patch.object(router, "_pdf_requires_ocr", return_value=False):
            try:
                return router.ParserRouter().parse_bytes(
                    b"synthetic-pdf-input", mime_type="application/pdf", engine="mineru",
                    source_name="chart.pdf", vlm_client=vlm_client)
            except engine.ParserFailure as error:
                self.fail(f"Chart-only document was rejected: {error.code}")

    def test_chart_only_document_is_preserved_without_vlm(self):
        document = self.parse_chart()
        self.assertEqual(document.page_count, 2)
        self.assertEqual(len(document.assets), 1)
        self.assertEqual(document.blocks[0].type, "image")
        self.assertEqual(document.assets[0].content, self.image)

    def test_chart_reaches_vlm_and_description_returns_in_document(self):
        description = "图表显示 2024 年收入为 1503 万元。"

        def complete(url, **kwargs):
            content = kwargs["json"]["messages"][0]["content"]
            images = [part for part in content if part["type"] == "image_url"]
            self.assertEqual(len(images), 1)
            payload = images[0]["image_url"]["url"].split(",", 1)[1]
            with Image.open(io.BytesIO(base64.b64decode(payload))) as image:
                self.assertEqual(image.size, (128, 128))
            return httpx.Response(200, request=httpx.Request("POST", url), json={
                "choices": [{"message": {"content": "[1] " + description}}],
            })

        client = media.OpenAICompatibleVlmClient(
            endpoint="https://vlm.invalid/v1", model="test-vlm", api_key="test-only")
        with patch.object(media.httpx, "post", side_effect=complete):
            document = self.parse_chart(client)
        self.assertEqual(document.assets[0].description, description)
        self.assertEqual(document.blocks[0].text, description)
        self.assertEqual(document.blocks[0].asset_key, document.assets[0].asset_key)
        self.assertEqual(document.warnings, ())

    def test_vlm_failure_keeps_chart_asset_with_warning(self):
        client = media.OpenAICompatibleVlmClient(
            endpoint="https://vlm.invalid/v1", model="test-vlm", api_key="test-only")
        with patch.object(media.httpx, "post", side_effect=httpx.ConnectError("offline")):
            document = self.parse_chart(client)
        self.assertEqual(len(document.assets), 1)
        self.assertEqual(document.assets[0].content, self.image)
        self.assertEqual(document.blocks[0].type, "image")
        self.assertEqual(document.warnings, ("VLM_DESCRIPTION_FAILED:asset-1.png",))


if __name__ == "__main__":
    unittest.main()
