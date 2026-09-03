from __future__ import annotations

import base64
import io
import re

import httpx

from .contracts import ParsedAsset


MIN_SIGNIFICANT_EMBEDDED_IMAGE_BYTES = 4096

# ===== 图片体积/分辨率处理（多图批量优化） =====
# 默认只做体积优化（PNG→JPEG/PNG 无损压缩），保持原始分辨率——表格/扫描/截图
# 等细节图需要清晰小字，降分辨率会损失信息。分辨率缩放做成可配参数（默认关）：
#   VLM_MAX_EDGE_PX（环境变量，默认 0=不缩放）>0 时把最长边缩到该像素
VLM_MAX_EDGE_PX = 0  # 可被环境覆盖（见 _load_config）

# 目标 JPEG 质量
_JPEG_QUALITY = 90
# PNG 无损压缩优化级别
_PNG_OPTIMIZE = True

# 估算 token/像素 表（按分辨率区间查表——用于分批累计，避免逐批精确计算）
# 量级近似：约 1 token ≈ 每 4 像素（对 OpenAI/多模态常见估法），高分辨率略摊薄
_TOKEN_PER_PX = 1 / 512


def _load_env_int(name: str, default: int) -> int:
    import os

    try:
        return int(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        return default


def _config() -> None:
    global VLM_MAX_EDGE_PX
    VLM_MAX_EDGE_PX = _load_env_int("VLM_MAX_EDGE_PX", 0)


_config()


def _decode_image(content: bytes) -> tuple[object, str]:
    """解码为 PIL Image（体积优化需要像素级重编码）。返回 (image, 原始格式)。"""
    from PIL import Image

    try:
        img = Image.open(io.BytesIO(content))
        img.load()
        fmt = (img.format or "PNG").upper()
        return img, fmt
    except Exception:
        return None, ""


def _optimize_image(content: bytes, mime_type: str) -> tuple[bytes, str]:
    """体积优化（默认不降分辨率）：PNG→JPEG(q90)（有透明则保留 PNG 无损压缩），
    JPEG 不重编码（已是压缩格式，重编码只会二次损失）。VLM_MAX_EDGE_PX>0 时
    先按最长边缩放（保持纵横比）。返回 (优化后 bytes, 新 mime)。"""
    if VLM_MAX_EDGE_PX > 0:
        # 需要像素级缩放 → 必须解码重编码
        img, _ = _decode_image(content)
        if img is None:
            return content, mime_type
        w, h = img.size
        longest = max(w, h)
        if longest > VLM_MAX_EDGE_PX:
            ratio = VLM_MAX_EDGE_PX / longest
            img = img.resize((max(1, round(w * ratio)), max(1, round(h * ratio))))
        buf = io.BytesIO()
        img.convert("RGB").save(buf, format="JPEG", quality=_JPEG_QUALITY)
        return buf.getvalue(), "image/jpeg"
    if mime_type == "image/png":
        img, _ = _decode_image(content)
        if img is None:
            return content, mime_type
        if "A" in (img.getbands() or []):
            # 有透明通道 → 保留 PNG（无损压缩优化）
            buf = io.BytesIO()
            img.save(buf, format="PNG", optimize=_PNG_OPTIMIZE)
            return buf.getvalue(), "image/png"
        # 无透明 → JPEG 更小（照片/扫描内容为主）
        buf = io.BytesIO()
        img.convert("RGB").save(buf, format="JPEG", quality=_JPEG_QUALITY)
        return buf.getvalue(), "image/jpeg"
    if mime_type == "image/webp":
        img, _ = _decode_image(content)
        if img is None:
            return content, mime_type
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=_JPEG_QUALITY)
        return buf.getvalue(), "image/jpeg"
    return content, mime_type


def estimate_image_tokens(content: bytes, mime_type: str) -> int:
    """发送前估算单图 token（按解码分辨率查表——分批累计用）。解码失败按
    字节量粗估。"""
    img, _ = _decode_image(content)
    if img is not None:
        w, h = img.size
        return max(85, round(w * h * _TOKEN_PER_PX))
    return max(85, round(len(content) / 8))


# ===== VLM 客户端 =====


class OpenAICompatibleVlmClient:
    def __init__(
        self,
        *,
        endpoint: str,
        model: str,
        api_key: str,
        timeout_seconds: float = 60.0,
    ) -> None:
        self._endpoint = _completion_endpoint(endpoint)
        self._model = model
        self._api_key = api_key
        self._timeout_seconds = timeout_seconds

    def describe(self, content: bytes, *, mime_type: str) -> str:
        content, mime_type = _optimize_image(content, mime_type)
        encoded = base64.b64encode(content).decode("ascii")
        response = httpx.post(
            self._endpoint,
            headers={"Authorization": f"Bearer {self._api_key}"},
            json={
                "model": self._model,
                "messages": [
                    {
                        "role": "user",
                        "content": [
                            {
                                "type": "text",
                                "text": "Describe this document image concisely for retrieval.",
                            },
                            {
                                "type": "image_url",
                                "image_url": {
                                    "url": f"data:{mime_type};base64,{encoded}",
                                },
                            },
                        ],
                    }
                ],
            },
            timeout=self._timeout_seconds,
        )
        response.raise_for_status()
        payload = response.json()
        try:
            content_value = payload["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError) as error:
            raise ValueError("VLM response did not contain message content") from error
        return _parse_vlm_message_content(content_value)

    def describe_many(
        self,
        images: list[tuple[bytes, str]],
        prompt: str = "Describe each document image concisely for retrieval.",
    ) -> list[str]:
        """一次请求描述多张图：content 数组带 N 张图（优化后），要求模型按
        [1]..[N] 编号逐行输出 → 解析映射回列表（缺失项留空，调用方回退单张）。
        返回 list 长度 == 输入长度（元素可为 ''——该图缺失/失败）。"""
        if not images:
            return []
        optimized: list[tuple[bytes, str]] = []
        for content, mime_type in images:
            optimized.append(_optimize_image(content, mime_type))
        content_parts: list[dict] = [
            {
                "type": "text",
                "text": prompt
                + "\nOutput each description on its own line, prefixed with [1]..[%d]."
                % len(optimized),
            }
        ]
        for content, mime_type in optimized:
            encoded = base64.b64encode(content).decode("ascii")
            content_parts.append(
                {
                    "type": "image_url",
                    "image_url": {
                        "url": f"data:{mime_type};base64,{encoded}",
                    },
                }
            )
        response = httpx.post(
            self._endpoint,
            headers={"Authorization": f"Bearer {self._api_key}"},
            json={
                "model": self._model,
                "messages": [{"role": "user", "content": content_parts}],
                "max_tokens": 1024,
            },
            timeout=self._timeout_seconds,
        )
        response.raise_for_status()
        payload = response.json()
        try:
            content_value = payload["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError) as error:
            raise ValueError("VLM response did not contain message content") from error
        text = _parse_vlm_message_content(content_value)
        return _parse_numbered_descriptions(text, len(optimized))


def describe_asset(
    asset: ParsedAsset,
    client: OpenAICompatibleVlmClient | None,
) -> tuple[ParsedAsset, str | None]:
    if client is None:
        return asset, None
    try:
        description = client.describe(asset.content, mime_type=asset.mime_type)
    except Exception:
        return asset, f"VLM_DESCRIPTION_FAILED:{asset.asset_key}"
    return asset.model_copy(update={"description": description}), None


def is_significant_embedded_asset(asset: ParsedAsset) -> bool:
    return len(asset.content) >= MIN_SIGNIFICANT_EMBEDDED_IMAGE_BYTES


def _parse_numbered_descriptions(text: str, expected: int) -> list[str]:
    """解析 [1]..[N] 编号输出 → 列表：
    - 按行正则 ^\s*\[(\d+)\]\s*(.*) 切分 → 编号→描述映射
    - 行数==expected 且无编号 → 按序兜底
    - 缺失编号留空（调用方回退单张）"""
    result: list[str] = [""] * expected
    if not text:
        return result
    numbered = re.findall(r"^\s*\[(\d+)\]\s*(.*)$", text, re.MULTILINE)
    if numbered:
        for idx_str, desc in numbered:
            idx = int(idx_str) - 1
            desc = desc.strip()
            if 0 <= idx < expected and desc:
                result[idx] = desc
        return result
    # 无编号：按行数 == expected 时按序兜底（每行一条描述）
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    if len(lines) == expected:
        for i, ln in enumerate(lines):
            result[i] = ln
    return result


def _parse_vlm_message_content(content: object) -> str:
    if isinstance(content, str) and content.strip():
        return content.strip()
    if isinstance(content, list) and content:
        text_parts: list[str] = []
        for part in content:
            if (
                not isinstance(part, dict)
                or part.get("type") != "text"
                or not isinstance(part.get("text"), str)
                or not part["text"].strip()
            ):
                raise ValueError("VLM content parts must all contain non-empty text")
            text_parts.append(part["text"].strip())
        return "\n".join(text_parts)
    raise ValueError("VLM returned an empty or invalid description")


def _completion_endpoint(endpoint: str) -> str:
    normalized = endpoint.rstrip("/")
    if normalized.endswith("/chat/completions"):
        return normalized
    return f"{normalized}/chat/completions"
