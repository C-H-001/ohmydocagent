"""Real normalize/router/client tests; only the external VLM HTTP call is replaced."""
import base64
import importlib
import importlib.util
import io
import random
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx
from PIL import Image

PACKAGE = next(name for name in ("ohmydocagent_parser", "docmind_parser")
               if importlib.util.find_spec(name) is not None)
engine = importlib.import_module(f"{PACKAGE}.engines.mineru_engine")
router = importlib.import_module(f"{PACKAGE}.router")
media = importlib.import_module(f"{PACKAGE}.media")


def response(url, content, finish_reason="stop"):
    return httpx.Response(200, request=httpx.Request("POST", url), json={
        "choices": [{"message": {"content": content}, "finish_reason": finish_reason}],
    })


def inspect_request(payload):
    parts = payload["messages"][0]["content"]
    prompt = next(part["text"] for part in parts if part["type"] == "text")
    tags = []
    for part in parts:
        if part["type"] != "image_url":
            continue
        raw = base64.b64decode(part["image_url"]["url"].split(",", 1)[1])
        with Image.open(io.BytesIO(raw)) as image:
            tags.append(image.getpixel((0, 0))[0])
    return prompt, tags


class ChartRoutingTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="chart-routing-")
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.client = media.OpenAICompatibleVlmClient(
            endpoint="https://vlm.invalid/v1", model="test-vlm", api_key="test-only")

    def assets(self, kinds):
        entries = []
        for tag, kind, small in kinds:
            if small:
                image = Image.new("RGBA", (16, 16), (tag, 0, 0, 255))
            else:
                image = Image.frombytes("RGBA", (128, 128), random.Random(tag).randbytes(128 * 128 * 4))
                image.putpixel((0, 0), (tag, 0, 0, 255))
            name = f"{tag}.png"
            image.save(self.root / name)
            entries.append({"type": kind, "img_path": name, "page_idx": tag,
                            "bbox": [10, 20, 100, 200]})
        return engine._normalize_content_list(entries, self.root)

    def test_normalization_retains_original_kind_for_vlm_routing(self):
        blocks, assets = self.assets([(1, "chart", False), (2, "figure", False), (3, "image", False)])
        self.assertEqual([getattr(asset, "source_type", None) for asset in assets], ["chart", "figure", "image"])
        self.assertEqual([block.type for block in blocks], ["image", "image", "image"])

    def test_mixed_assets_use_separate_prompts_and_preserve_original_order(self):
        _, assets = self.assets([(1, "image", False), (2, "chart", True), (3, "image", True),
                                 (4, "chart", False), (5, "figure", False)])
        calls = []

        def complete(url, **kwargs):
            payload = kwargs["json"]
            prompt, tags = inspect_request(payload)
            chart_mode = payload.get("max_tokens", 0) > 1024 and "数值" in prompt and "图例" in prompt
            calls.append((tuple(tags), payload.get("max_tokens"), chart_mode))
            kind = "chart-data" if chart_mode else "image-description"
            return response(url, "\n".join(f"[{i + 1}] {kind}-{tag}" for i, tag in enumerate(tags)))

        with patch.object(media.httpx, "post", side_effect=complete):
            results = router.describe_many_assets(assets, self.client)
        self.assertEqual([item[1] for item in results],
                         ["image-description-1", "chart-data-2", None, "chart-data-4", "image-description-5"])
        self.assertEqual(sorted(tags for tags, _, _ in calls), [(1, 5), (2, 4)])
        self.assertEqual(next(budget for tags, budget, _ in calls if tags == (1, 5)), 1024)
        self.assertEqual([item[0].asset_key for item in results], [asset.asset_key for asset in assets])
        self.assertEqual([item[0].page for item in results], [2, 3, 4, 5, 6])
        self.assertTrue(all(item[2] is None for item in results))

    def test_chart_batches_are_small_without_changing_ordinary_batch_size(self):
        _, assets = self.assets([(i, "chart", False) for i in range(1, 6)]
                               + [(i, "image", False) for i in range(6, 23)])
        calls = []

        def complete(url, **kwargs):
            _, tags = inspect_request(kwargs["json"])
            calls.append((tags, kwargs["json"]["max_tokens"]))
            return response(url, "\n".join(f"[{i + 1}] data-{tag}" for i, tag in enumerate(tags)))

        with patch.object(media.httpx, "post", side_effect=complete):
            results = router.describe_many_assets(assets, self.client)
        chart_calls = [(tags, budget) for tags, budget in calls if all(tag <= 5 for tag in tags)]
        ordinary_calls = [(tags, budget) for tags, budget in calls if all(tag >= 6 for tag in tags)]
        self.assertEqual(sorted(len(tags) for tags, _ in chart_calls), [1, 2, 2])
        self.assertEqual(sorted(len(tags) for tags, _ in ordinary_calls), [1, 16])
        self.assertTrue(all(budget > 1024 for _, budget in chart_calls))
        self.assertTrue(all(budget == 1024 for _, budget in ordinary_calls))
        self.assertTrue(all(item[1] for item in results))

    def test_missing_chart_result_falls_back_with_chart_prompt_and_budget(self):
        _, assets = self.assets([(1, "chart", False), (2, "chart", False)])
        calls = []

        def complete(url, **kwargs):
            payload = kwargs["json"]
            prompt, tags = inspect_request(payload)
            calls.append(tags)
            if len(tags) == 2:
                return response(url, "[1] first-complete")
            correct_route = "数值" in prompt and "图例" in prompt and payload.get("max_tokens", 0) > 1024
            return response(url, "second-complete" if correct_route else "generic-caption")

        with patch.object(media.httpx, "post", side_effect=complete):
            results = router.describe_many_assets(assets, self.client)
        self.assertEqual([item[1] for item in results], ["first-complete", "second-complete"])
        self.assertEqual(calls, [[1, 2], [2]])

    def test_truncated_chart_batch_is_retried_instead_of_saving_partial_numbers(self):
        _, assets = self.assets([(1, "chart", False), (2, "chart", False)])
        calls = []

        def complete(url, **kwargs):
            payload = kwargs["json"]
            prompt, tags = inspect_request(payload)
            calls.append(tags)
            if len(tags) == 2:
                return response(url, "[1] partial-first\n[2] partial-second", "length")
            correct_route = "数值" in prompt and payload.get("max_tokens", 0) > 1024
            return response(url, f"complete-{tags[0]}" if correct_route else "generic-caption")

        with patch.object(media.httpx, "post", side_effect=complete):
            results = router.describe_many_assets(assets, self.client)
        self.assertEqual([item[1] for item in results], ["complete-1", "complete-2"])
        self.assertEqual(calls, [[1, 2], [1], [2]])

    def test_chart_multiline_batch_cannot_silently_drop_data_lines(self):
        _, assets = self.assets([(1, "chart", False), (2, "chart", False)])

        def complete(url, **kwargs):
            _, tags = inspect_request(kwargs["json"])
            if len(tags) == 2:
                return response(url, "[1] header only\nvalues: 31, 42\n[2] header only\nvalues: 53, 64")
            return response(url, f"complete-values-{tags[0]}")

        with patch.object(media.httpx, "post", side_effect=complete):
            results = router.describe_many_assets(assets, self.client)
        self.assertEqual([item[1] for item in results], ["complete-values-1", "complete-values-2"])

    def test_empty_chart_number_does_not_steal_next_chart_data(self):
        _, assets = self.assets([(1, "chart", False), (2, "chart", False)])
        calls = []

        def complete(url, **kwargs):
            _, tags = inspect_request(kwargs["json"])
            calls.append(tags)
            if len(tags) == 2:
                return response(url, "[1]\n[2] chart-2-revenue=42")
            return response(url, "chart-1-complete")

        with patch.object(media.httpx, "post", side_effect=complete):
            results = router.describe_many_assets(assets, self.client)
        self.assertEqual([item[1] for item in results], ["chart-1-complete", "chart-2-revenue=42"])
        self.assertEqual(calls, [[1, 2], [1]])

    def test_repeated_chart_truncation_keeps_asset_with_failure_warning(self):
        _, assets = self.assets([(1, "chart", False)])
        with patch.object(media.httpx, "post", side_effect=lambda url, **kwargs: response(url, "[1] incomplete values", "length")):
            results = router.describe_many_assets(assets, self.client)
        self.assertIsNone(results[0][1])
        self.assertEqual(results[0][2], "VLM_DESCRIPTION_FAILED:asset-1.png")
        self.assertEqual(results[0][0].content, assets[0].content)

    def test_ordinary_fallback_keeps_original_prompt_and_unset_single_limit(self):
        _, assets = self.assets([(1, "image", False), (2, "figure", False)])
        single_payloads = []

        def complete(url, **kwargs):
            payload = kwargs["json"]
            prompt, tags = inspect_request(payload)
            if len(tags) == 2:
                raise httpx.ConnectError("offline batch")
            single_payloads.append(payload)
            self.assertEqual(prompt, "Describe this document image concisely for retrieval.")
            self.assertNotIn("max_tokens", payload)
            return response(url, f"ordinary-{tags[0]}")

        with patch.object(media.httpx, "post", side_effect=complete):
            results = router.describe_many_assets(assets, self.client)
        self.assertEqual([item[1] for item in results], ["ordinary-1", "ordinary-2"])
        self.assertEqual(len(single_payloads), 2)


if __name__ == "__main__":
    unittest.main()
