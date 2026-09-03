// 中文分词工具（jieba-wasm，纯 WASM 跨平台：Windows dev + alpine 生产均可用）。
// 用途：知识库关键词检索——PG 'simple' 分词器不切中文（整段一个 token），
// 本工具在应用侧按词粒度分词，写入 chunks.keywords 列（GIN 索引）供检索。
// - cut 为同步 API（wasm 首次调用自动初始化，无需显式 await load）
// - 过滤：标点/空白/单字虚词/纯数字（保留 2+ 位数字串与英文单词）
// - 兜底：分词失败（wasm 加载异常等）返回 [原文]（整段语义，退化为词面检索）
import { cut } from 'jieba-wasm';

/** 停用词：单字虚词/助词（中文检索里无区分度） */
const STOP_WORDS = new Set([
  '的', '了', '是', '在', '和', '有', '就', '不', '都', '而', '及', '与', '或',
  '于', '之', '其', '此', '这', '那', '个', '中', '为', '以', '等', '对', '从',
  '到', '上', '下', '里', '外', '被', '把', '让', '给', '向', '比', '按', '因',
  '为', '但', '可', '也', '很', '更', '最', '又', '再', '还', '已', '将', '正',
  '要', '会', '能', '应', '该', '着', '过', '得', '地', '所', '如', '若', '则',
  '且', '并', '虽', '然', '即', '使', '来', '去', '用', '做', '说', '想', '看',
  '被', '叫', '让', '请', '一', '两', '几', '多', '少', '全', '半', '共', '各',
]);

/** 全角/半角标点与空白（jieba 会把标点作为独立 token 输出） */
const PUNCT_RE = /^[\s\u3000，。、；：！？…—·“”‘’（）《》〈〉【】〔〕\[\]{}()'"`~!@#$%^&*\-_=+\\|/<>.,;:?]+$/;

/** 纯数字（全数字串，如 "123"；版本号 "1.2.3" 含点不在此列） */
const DIGITS_ONLY_RE = /^[0-9]+$/;

/** 单字（中文检索里单字无区分度；英文单词/数字串除外） */
const SINGLE_CJK_RE = /^[\u4e00-\u9fa5]$/;

let segmentEnabled = true;

/** 分词：文本 → 检索词数组（去重保序） */
export function segment(text: string): string[] {
  if (!text || !segmentEnabled) return [];
  try {
    const words = cut(text) as string[];
    const seen = new Set<string>();
    const result: string[] = [];
    for (const w of words) {
      if (PUNCT_RE.test(w)) continue; // 标点/空白
      if (DIGITS_ONLY_RE.test(w)) continue; // 纯数字
      if (STOP_WORDS.has(w)) continue; // 虚词
      if (SINGLE_CJK_RE.test(w)) continue; // 单字
      const t = w.trim();
      if (!t || seen.has(t)) continue;
      seen.add(t);
      result.push(t);
    }
    return result;
  } catch {
    // wasm 异常兜底：整段作为单个词（词面检索语义）
    segmentEnabled = false;
    return [text];
  }
}

/** 查询分词：与 segment 同逻辑，但保留单字（查询词短，单字也可能有区分度）；
 *  如 "如何部署" → ["如何","部署"]；纯标点 → [] */
export function segmentQuery(text: string): string[] {
  if (!text) return [];
  try {
    const words = cut(text) as string[];
    const result: string[] = [];
    for (const w of words) {
      if (PUNCT_RE.test(w)) continue;
      if (DIGITS_ONLY_RE.test(w)) continue;
      if (STOP_WORDS.has(w)) continue;
      const t = w.trim();
      if (!t || result.includes(t)) continue;
      result.push(t);
    }
    return result;
  } catch {
    return [text.trim()].filter(Boolean);
  }
}
