// 公共 Unicode 工具（Task 2.2 质量审查整改）：UTF-16 代理对边界处理。
// 背景：JS string 的 length/slice 按 UTF-16 码元计——emoji 等非 BMP 字符占
// 2 码元（高代理 0xD800–0xDBFF + 低代理 0xDC00–0xDFFF）。硬切位置落在代理对
// 中间会把配对劈成两半，两侧各自出现孤立代理（静默乱码，拼接无法还原原文）。
// 用途（双字节安全截断/切分，两个消费方共用同一实现，防逻辑漂移）：
// - 分块引擎（chunking.service）：切点位置钳制，保证块边界不劈开代理对
//   （startAt/endAt 偏移语义与 content.slice 完全对应）；
// - 标题/摘要等 LLM 输出与输入截断（title.processor）：以
//   clampSurrogateBoundary(text, maxLen) 求安全截断位置后 slice——直接
//   slice(0, maxLen) 可能把 emoji 标题切成乱码（实测复现）。

/**
 * 代理对边界回退：把切点 pos 钳制到不在 UTF-16 代理对中间的位置。
 * 规则：pos 处码元是低代理（0xDC00–0xDFFF）→ 回退一个码元到 pos-1。
 * 论证：合法 UTF-16 中「pos 是低代理」⟺「pos-1 是它的配对高代理」——此时
 * 切点恰落在代理对中间（高代理归前块、低代理归后块），回退后切点落在该对
 * 的高代理上，配对整体归后块，安全。pos 处是高代理（配对 [pos,pos+1) 完整
 * 落入后块）或普通字符则无需回退。单次回退即满足不变量：回退后的新切点
 * 要么是普通字符，要么是代理对起点。pos≤0（串首/越界）或 ≥length（串尾）
 * 不处理。注：若输入含未配对代理（畸形 UTF-16），本规则尽力而为。
 * 截断用法：text.slice(0, clampSurrogateBoundary(text, maxLen)) 即「双字节
 * 安全截断」——切点落在低代理上时回退一个码元，被截掉的尾巴以代理对起点
 * 收尾（配对整体被丢弃而非劈开），不会产生孤立代理。
 */
export function clampSurrogateBoundary(text: string, pos: number): number {
  if (pos <= 0 || pos >= text.length) return pos;
  const code = text.charCodeAt(pos);
  // 低代理 → 切点在代理对中间，回退一个码元
  return code >= 0xdc00 && code <= 0xdfff ? pos - 1 : pos;
}
