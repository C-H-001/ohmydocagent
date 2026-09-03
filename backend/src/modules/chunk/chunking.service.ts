// 分块引擎（Task 1.5）：贪心切分，纯算法无 DB 依赖（可单测）。
// 输入：原文 + 分块配置 { chunkSize, chunkOverlap, separators }；
// 输出：ChunkUnit[] = { content, startAt, endAt }[] 纯数据——id/链表（pre/next）
// 由持久化层补充（见 ChunkService.buildChunkRows），本服务不感知存储。
// startAt/endAt 为 UTF-16 码元偏移（JS string 的 length/charCodeAt/slice 默认
// 语义——非 BMP 字符如 emoji 占 2 码元）；切点经代理对边界回退保证不劈开
// 配对（clampSurrogateBoundary，公共实现见 src/common/unicode.ts——Task 2.2
// 质量审查整改：标题截断同样需要双字节安全截断，逻辑收敛到公共工具共用，
// 防两份实现漂移），偏移语义与 content 的 slice 完全对应。
//
// 算法（贪心窗口 + 分隔符边界优先，参考 WeKnora chunker 思路，不照搬代码）：
// 1. 取 [cursor, cursor+chunkSize) 窗口；
// 2. 从窗口末尾往前找「最近的」分隔符位置（窗口内最后一次出现任意分隔符的
//    位置，切在该分隔符之后——标点/换行随本块保留）；窗口内无分隔符时用空串
//    兜底强制硬切（整块 chunkSize）；
// 3. 切出本块（内容 ≤ chunkSize 恒成立）后，下一块起点 = 本块末尾 - overlap
//    （重叠语义：重叠内容出现在相邻块尾部/头部）；若该起点越过本块起点
//    （分隔符靠前导致本块过小），则退化为无重叠直接跳到本块末尾，防止
//    死循环式 1 字蠕动（见 nextStart 注释）。
//
// 配置容错（KB 的 chunkingConfig 是 jsonb，Task 1.1 未做结构校验）：
// 缺字段/非法值（非数字/越界）一律收敛到默认值，不抛错——解析管线在
// normalizeConfig 兜底（见 normalizeConfig 注释）。
import { Injectable } from '@nestjs/common';
import { clampSurrogateBoundary } from '../../common/unicode.js';

export interface ChunkUnit {
  content: string;
  startAt: number;
  endAt: number;
  /** 块类型：缺省 'text'；'image' = 图片 caption 块（parse.processor 由
   *  知识库图片生成，content = VLM 描述，见 chunk.entity type 注释） */
  type?: 'text' | 'image';
  /** image 块：parser asset 键（图片定位用） */
  assetKey?: string;
  /** image 块：图片元数据（url/caption/page/mimeType，与 knowledge.images
   *  同源——引用富化时透传到 RagReference.images） */
  imageInfo?: {
    url: string;
    caption?: string;
    page?: number;
    mimeType?: string;
    assetKey?: string;
  } | null;
}

/** 分块策略（参考 WeKnora chunker）：
 * - token：贪心窗口 + 分隔符边界（Task 1.5 既有算法，默认）
 * - recursive：递归分隔符优先降级切段 + 合并到 chunkSize（WeKnora splitter）
 * - header：按主导 Markdown 标题层级分节（标题行随块保留，天然带节上下文）
 */
export type ChunkStrategy = 'token' | 'recursive' | 'header';

/** 分块配置（与 KB.chunkingConfig 的结构约定，Task 1.5 起生效；文档级
 *  chunkingConfig 覆盖 KB 级，见 knowledge.entity 与 parse.processor） */
export interface ChunkingConfig {
  /** 分块策略（缺省 token——向后兼容） */
  strategy?: ChunkStrategy;
  /** 目标块大小（字/字符数） */
  chunkSize: number;
  /** 相邻块重叠长度（必须 < chunkSize，越界收敛） */
  chunkOverlap: number;
  /** 分隔符列表（同一位置多分隔符重叠时长者优先——如 '\n\n' 内含 '\n'，
   * 长分隔符命中即胜出；等长时按列表顺序，见 findCut 注释。
   * 空串 '' 兜底强制切分，恒存在） */
  separators: string[];
}

/** 默认分块配置：P1 文档类知识库通用默认（段落 > 换行 > 句号 > 空格 > 硬切） */
export const DEFAULT_CHUNKING_CONFIG: ChunkingConfig = {
  strategy: 'token',
  chunkSize: 800,
  chunkOverlap: 100,
  separators: ['\n\n', '\n', '。', '！', '？', '.', ' ', ''],
};

@Injectable()
export class ChunkingService {
  /** 分块主入口：text 为空 → 空数组；config 为 null/缺字段 → 默认配置。
   *  按 strategy 分流：recursive/header 走 WeKnora 参考实现，其余走 token
   *  贪心窗口（既有算法）。 */
  chunk(text: string, config?: Partial<ChunkingConfig> | null): ChunkUnit[] {
    const cfg = this.normalizeConfig(config);
    if (!text) return [];
    if (cfg.strategy === 'recursive') return this.chunkRecursive(text, cfg);
    if (cfg.strategy === 'header') return this.chunkHeader(text, cfg);
    const units: ChunkUnit[] = [];
    const n = text.length;
    let start = 0;
    while (start < n) {
      const windowEnd = Math.min(start + cfg.chunkSize, n);
      if (windowEnd === n) {
        // 尾块：剩余不足一个窗口，直接取到原文末尾（不再找分隔符，
        // 保证最后一段内容完整收尾）。start 理论上来自上一轮已回退的
        // next（见下），此处再防御性回退一次——防未来改动破坏不变量
        const tailStart = clampSurrogateBoundary(text, start);
        units.push({
          content: text.slice(tailStart),
          startAt: tailStart,
          endAt: n,
        });
        break;
      }
      // 窗口内从末尾往前找最近分隔符；找不到 → 硬切（返回 windowEnd）
      let cut = this.findCut(text, start, windowEnd, cfg.separators);
      // 代理对边界回退（见 clampSurrogateBoundary）：硬切位置可能落在
      // 代理对中间（emoji 等非 BMP 字符被劈成两半 → 相邻两块各自出现孤立
      // 代理，内容静默乱码）。回退不能越过 start——窗口首码元即代理对
      // 高代理的退化场景（chunkSize=1 < 代理对长度）保持原切点，接受该
      // 配置下的截断（chunkSize=1 本就不适用非 BMP 文本）
      const cutClamped = clampSurrogateBoundary(text, cut);
      if (cutClamped > start) cut = cutClamped;
      units.push({
        content: text.slice(start, cut),
        startAt: start,
        endAt: cut,
      });
      // 重叠语义：下一块起点 = 本块末尾 - overlap（重叠区间出现在相邻块的
      // 尾部/头部）。退化保护：若重叠回退会越过本块起点（本块过小，如
      // 分隔符紧贴窗口起点），则无重叠直接跳到本块末尾——否则下一窗口
      // 仍只含同一分隔符，起点逐字右移产生 1 字蠕动块（死循环等价）。
      // 同时做代理对回退：重叠起点落在代理对中间时同样会劈开配对
      const next = clampSurrogateBoundary(text, cut - cfg.chunkOverlap);
      start = next > start ? next : cut;
    }
    return units;
  }

  /**
   * 从窗口末尾往前找最近分隔符的切割位置。
   * - 返回 [start, windowEnd] 内的切割点（切在分隔符之后，分隔符随本块保留）；
   * - 窗口内无任何分隔符 → 返回 windowEnd（硬切，空串 '' 兜底语义）；
   * - 同一位置多分隔符重叠（如 '\n\n' 与 '\n'）时长者优先：非空分隔符先按
   *   长度降序比较，startsWith 命中长分隔符即切——注意实际规则是「同位置
   *   长者优先」，顺序不是严格优先级（等长时才按列表顺序）。
   */
  private findCut(
    text: string,
    start: number,
    windowEnd: number,
    separators: string[],
  ): number {
    // 非空分隔符按长度降序：startsWith 命中长分隔符时短分隔符也会命中
    // （'\n\n' 内含 '\n'），长者优先与 separators 的优先级语义一致
    const seps = separators
      .filter((s) => s.length > 0)
      .sort((a, b) => b.length - a.length);
    for (let p = windowEnd - 1; p >= start; p--) {
      for (const sep of seps) {
        const begin = p - sep.length + 1;
        // begin ≥ start 保证分隔符完整落在窗口内（防跨窗口误切）
        if (begin >= start && text.startsWith(sep, begin)) {
          return p + 1; // 切在分隔符之后
        }
      }
    }
    return windowEnd; // 无分隔符 → 硬切
  }

  /**
   * 配置归一化（容错收敛，不抛错）：
   * - chunkSize：非有限数字 → 默认 800；≤0 数字 → 收敛为 1（取整；chunkSize=0
   *   会导致死循环，必须收敛到 ≥1）
   * - chunkOverlap：非有限数字/<0 → 0；上限收敛为 min(chunkSize-1,
   *   floor(chunkSize/2))——重叠必须 < 块大小（否则下一块起点退到本块起点
   *   之前，重叠语义失效），且不能超过块大小一半（性能取舍，见下）
   * - separators：非数组 → 默认列表；过滤非字符串项；空串兜底恒存在
   *   （无其它分隔符时窗口整体作为一块 = 强制切分语义）
   *
   * overlap 上限 = floor(chunkSize/2) 的性能论证：步进 = chunkSize - overlap
   * ≥ chunkSize/2 → 块数 ≤ 2n/chunkSize，每块窗口扫描 ≤ chunkSize 码元 →
   * 总复杂度摊销 O(n)（块数 × 每块窗口 = O(n)）。若允许 overlap 收敛到
   * chunkSize-1（步进 1 码元/块），20 万字符文本会产生 O(n·chunkSize) 的
   * 二次方退化（实测 ~16s）——重叠内容收益随比例递减（相邻块高度雷同），
   * 故主动封顶：牺牲极端重叠配置，换最坏情况性能有界。
   */
  private normalizeConfig(
    config?: Partial<ChunkingConfig> | null,
  ): ChunkingConfig {
    const raw = config ?? {};
    const chunkSizeRaw =
      typeof raw.chunkSize === 'number' && Number.isFinite(raw.chunkSize)
        ? Math.floor(raw.chunkSize)
        : DEFAULT_CHUNKING_CONFIG.chunkSize;
    const chunkSize = Math.max(1, chunkSizeRaw);
    const overlapRaw =
      typeof raw.chunkOverlap === 'number' && Number.isFinite(raw.chunkOverlap)
        ? Math.floor(raw.chunkOverlap)
        : DEFAULT_CHUNKING_CONFIG.chunkOverlap;
    // 上限收敛：min(chunkSize-1, floor(chunkSize/2))（步进 ≥ chunkSize/2 →
    // 摊销 O(n)，见方法头注释；chunkSize=1 时上限为 0 = 无重叠）
    const chunkOverlap = Math.min(
      Math.max(0, overlapRaw),
      Math.min(chunkSize - 1, Math.floor(chunkSize / 2)),
    );
    const separators = Array.isArray(raw.separators)
      ? raw.separators.filter((s): s is string => typeof s === 'string')
      : [...DEFAULT_CHUNKING_CONFIG.separators];
    if (!separators.includes('')) {
      separators.push(''); // 空串兜底恒存在
    }
    const strategy: ChunkStrategy =
      raw.strategy === 'recursive' || raw.strategy === 'header'
        ? raw.strategy
        : 'token';
    return { strategy, chunkSize, chunkOverlap, separators };
  }

  // ==================== 策略实现（参考 WeKnora chunker） ====================

  /**
   * recursive：按分隔符优先级递归切段——高级分隔符切出的段仍大于 chunkSize
   * 时，用下一级分隔符在该段内继续切（递归降级）；切完后把小段合并成
   * chunkSize 大小的块（WeKnora SplitText = splitBySeparators + mergeUnits）。
   */
  private chunkRecursive(text: string, cfg: ChunkingConfig): ChunkUnit[] {
    const pieces = this.splitRecursive(text, cfg.separators, cfg.chunkSize);
    // 合并段到 chunkSize（参考 WeKnora mergeUnits）：
    // - 段不跨块（段是递归切分的最小语义单元；单个超长段由 splitRecursive
    //   已降级切小）
    // - 块满时 flush；重叠 = 本块尾部 chunkOverlap 字符作为下一块前缀
    //   （精确字符级，回退对齐换行/空格语义边界——WeKnora
    //   findSemanticOverlapBoundary 简化；重叠随下一块继续累积）
    const units: ChunkUnit[] = [];
    let curText = ''; // 当前块累积文本（段拼接 = 原文连续片段）
    let curStart = 0; // 当前块在原文的起始偏移
    let cursor = 0; // 已消费的原文位置（段按序连续）
    for (const p of pieces) {
      if (curText && curText.length + p.length > cfg.chunkSize) {
        // 本块结束：内容 = curText，覆盖 [curStart, cursor)
        units.push({ content: curText, startAt: curStart, endAt: cursor });
        // 精确重叠：取 curText 尾部 ≈chunkOverlap 字符，回退对齐换行/空格
        // （边界在段尾附近则整体保留——不劈开段语义；见 WeKnora computeOverlap）
        const ovTarget = Math.min(cfg.chunkOverlap, curText.length);
        let s = curText.length - ovTarget;
        if (s < 0) s = 0;
        while (s < curText.length - 1 && curText[s] !== '\n' && curText[s] !== ' ') s++;
        const ovPrefix = curText.slice(s);
        // 重叠前缀在原文的起点 = curStart + s（curText 自 curStart 连续）
        curStart = curStart + s;
        curText = ovPrefix;
      }
      curText += p;
      cursor += p.length;
    }
    if (curText) {
      units.push({ content: curText, startAt: curStart, endAt: cursor });
    }
    return units.length ? units : [{ content: text, startAt: 0, endAt: text.length }];
  }

  /** 递归切段（WeKnora splitBySeparators 移植）：返回按分隔符优先级切出的段列表 */
  private splitRecursive(
    text: string,
    separators: string[],
    chunkSize: number,
  ): string[] {
    if (!text || separators.length === 0) return [text];
    if (text.length <= chunkSize) return [text];
    const seps = separators.filter((s) => s.length > 0);
    if (seps.length === 0) return [text];
    for (let i = 0; i < seps.length; i++) {
      const sep = seps[i];
      const parts = text.split(sep);
      if (parts.length <= 1) continue;
      // 重建带分隔符的段（分隔符随前段保留，语义同 token 算法）
      const pieces: string[] = [];
      for (let j = 0; j < parts.length; j++) {
        if (parts[j]) pieces.push(parts[j]);
        if (j < parts.length - 1) pieces.push(sep);
      }
      if (pieces.length <= 1) continue;
      const remaining = seps.slice(i + 1);
      const out: string[] = [];
      for (const p of pieces) {
        if (p.length > chunkSize && remaining.length > 0) {
          out.push(...this.splitRecursive(p, remaining, chunkSize));
        } else {
          out.push(p);
        }
      }
      return out;
    }
    return [text];
  }

  /**
   * header：按主导 Markdown 标题层级分节（WeKnora splitByHeadings 语义）：
   * - 主导级别 = 出现最多的标题级别
   * - 每行位置维护祖先标题链（面包屑 crumb，WeKnora breadcrumb）
   * - 按主导级别分节，节成块：content = 面包屑 + 节正文（面包屑来自原文
   *   标题行，跨层级上下文不丢失；标题行本身已在正文开头，不重复）
   * - 节过大 → 节内 recursive，子块按起点位置带对应祖先链 crumb
   */
  private chunkHeader(text: string, cfg: ChunkingConfig): ChunkUnit[] {
    const lines = text.split('\n');
    const lineStarts: number[] = [];
    let offset = 0;
    for (const line of lines) {
      lineStarts.push(offset);
      offset += line.length + 1; // +1 换行
    }
    interface Heading { level: number; line: number; text: string }
    const headings: Heading[] = [];
    for (let i = 0; i < lines.length; i++) {
      const m = /^(#{1,6})\s+(.*)$/.exec(lines[i].trim());
      if (m) headings.push({ level: m[1].length, line: i, text: lines[i].trim() });
    }
    const levelCount = new Map<number, number>();
    for (const h of headings) levelCount.set(h.level, (levelCount.get(h.level) ?? 0) + 1);
    let primary = 0;
    let max = 0;
    for (const [lv, c] of levelCount) {
      if (c > max) { max = c; primary = lv; }
    }
    if (primary === 0 || headings.length === 0) {
      return this.chunkRecursive(text, cfg);
    }
    // 每行位置的祖先标题链（面包屑）：逐行模拟标题栈；每行 crumb =
    // 该行之前仍生效的标题链（不含该行自身标题——标题行在正文中）
    const crumbAt: string[] = [];
    const stack: Heading[] = [];
    for (let i = 0; i < lines.length; i++) {
      const h = headings.find((x) => x.line === i);
      // 主导标题行是新节起点：祖先链清空（面包屑不含上一节标题）；
      // 子标题行保留祖先（子节上下文链）
      crumbAt.push(h && h.level === primary ? '' : stack.map((x) => x.text).join('\n'));
      if (h) {
        while (stack.length > 0 && stack[stack.length - 1].level >= h.level) stack.pop();
        stack.push(h);
      }
    }
    // 按主导级别分节
    const sections: { start: number; end: number }[] = [];
    const primaryLines = headings.filter((h) => h.level === primary).map((h) => h.line);
    for (let i = 0; i < primaryLines.length; i++) {
      sections.push({
        start: lineStarts[primaryLines[i]],
        end: i + 1 < primaryLines.length ? lineStarts[primaryLines[i + 1]] : text.length,
      });
    }
    const units: ChunkUnit[] = [];
    for (const sec of sections) {
      const secText = text.slice(sec.start, sec.end);
      const pushUnit = (content: string, startAt: number, endAt: number) => {
        // 该块起点位置的祖先链（原文行）
        const absPos = sec.start + startAt;
        let lineIdx = 0;
        for (let i = 0; i < lineStarts.length; i++) {
          if (lineStarts[i] <= absPos) lineIdx = i;
          else break;
        }
        const crumb = crumbAt[lineIdx] ?? '';
        units.push({ content: crumb ? crumb + '\n' + content : content, startAt, endAt });
      };
      if (secText.length <= cfg.chunkSize || secText.trim().length === 0) {
        pushUnit(secText, 0, secText.length);
      } else {
        const sub = this.chunkRecursive(secText, cfg);
        for (const u of sub) pushUnit(u.content, u.startAt, u.endAt);
      }
    }
    return units;
  }
}