// 引用系统服务（Task 2.6）：检索结果 → 同文档合并的引用列表（build）+ 生成
// 后正文 [n] 兜底对齐（align）。本服务是**纯函数**（无 DB 依赖）——标题补查
// 由调用方（管线）承担（决策：保持纯函数便于单测；DB 职责留在管线，见
// rag-pipeline.service.ts merge 阶段注释）。
//
// 设计决策：
// - 同文档合并：按 knowledgeId 分组，组内 score 降序取最佳块为「主引用」
//   （chunkId/content/score 均取最佳块），chunks 数组记录组内全部位置——
//   前端点击引用可定位到同文档各块（一个文档可能被多块命中，引用展示应
//   合并为一条 + 可展开定位）
// - 编号语义：按「文档首次出现顺序」重新编号 1..N（非原始 topK 序号）——
//   检索块数组按 score 降序，首次出现顺序 = 各文档最佳块的分数顺序；编号
//   与 references 数组下标对齐（正文 [n] ↔ refs[n-1]），前端无需查表映射
// - 内容截断：REFERENCE_CONTENT_MAX_LENGTH=200 字符（Task 2.6 从 500 收紧
//   ——悬浮摘要所需信息量远小于 prompt 上下文；prompt 与悬浮摘要共用同一份
//   截断内容，见 rag.types.ts 注释）。截断带 '…' 省略号（提示截断语义——
//   模型看到省略号知道内容被截，不误以为原文到此为止）
// - 标题缺省：「未知文档」（文档已删/孤儿 chunk 不报错——引用列表的标题
//   只是展示辅助，检索主数据是 content）
// - align（生成后兜底对齐）：扫描正文 `[n]` 提取引用编号集合，剔除 references
//   中未被正文引用的项。**编号语义（关键决策）：正文引用编号保留原文编号，
//   不做重映射**——剔除会导致编号不连续（如仅 [1][3] 被引用），但正文已含
//   [n] 无法改写，重映射会破坏正文与引用对应；references 数组按 index 过滤
//   保留被引用的项，前端按 index 匹配（悬浮/跳转只看 index，不依赖连续）
// - 正文无任何 [n] → 返回空 references（无引用不生成——LLM 未按提示标注
//   引用时，不展示任何引用来源）
// - 越界编号（[99] 无对应引用）：保留正文（幻觉编号是 LLM 输出，不改写），
//   references 无该 index（前端悬浮无对应项，自然降级）
import { Injectable } from '@nestjs/common';
import type { HybridSearchItem } from '../../vector/vector.service.js';
import type { RagReference } from './rag.types.js';

/** 单块内容最大长度（字符）：悬浮摘要 + prompt 共用截断（Task 2.6 从 500
 * 收紧到 200，见文件头设计决策；实测长度 = 常量 + 1（'…' 省略号）） */
export const REFERENCE_CONTENT_MAX_LENGTH = 200;

/** 标题缺省值（sources Map 查不到时兜底——文档已删/孤儿 chunk） */
export const UNKNOWN_TITLE = '未知文档';

/** build 入参的文档信息（由调用方补查 knowledge 表构造）：
 * - title：文档标题（references 的 knowledgeTitle）
 * - sourceUrl：仅 url 类型文档有值（references 的 url 字段透传） */
export interface ReferenceSourceInfo {
  title: string;
  sourceUrl?: string;
}

@Injectable()
export class ReferencesService {
  /**
   * 检索结果 → 同文档合并的引用列表：
   * 1. 按 knowledgeId 分组（保持首次出现顺序）；组内已是 score 降序
   *    （hybridSearch 排序 + rerank 截断的产物）
   * 2. 每组合并为 1 条引用：主引用 = 组内首个（最高分）块；chunks 记录
   *    组内全部 { chunkId, score }（score 降序，前端跳转定位用）
   * 3. 编号：按文档首次出现顺序 1..N（= 各文档最佳块的分数顺序），与
   *    references 数组下标对齐（正文 [n] ↔ refs[n-1]）
   * 4. content 截断到 REFERENCE_CONTENT_MAX_LENGTH（带 '…'）；标题从
   *    sources Map 获取（缺省「未知文档」）；url 类型文档透传 sourceUrl
   * 空检索 → 空数组（不查库，快速路径）。
   */
  /** 同文档多块拼接后的 content 上限（字符；默认单块截断 3000 的 2 倍） */
  private static readonly MAX_MULTI_CHUNK_CHARS = 6000;

  build(
    chunks: HybridSearchItem[],
    sources: Map<string, ReferenceSourceInfo>,
  ): RagReference[] {
    if (chunks.length === 0) return [];
    // 按 knowledgeId 分组（Map 保持首次出现顺序；组内按原顺序即 score 降序）
    const byDoc = new Map<string, HybridSearchItem[]>();
    for (const c of chunks) {
      const group = byDoc.get(c.knowledgeId);
      if (group) {
        group.push(c);
      } else {
        byDoc.set(c.knowledgeId, [c]);
      }
    }
    const references: RagReference[] = [];
    let index = 1;
    for (const [knowledgeId, group] of byDoc) {
      const main = group[0]; // 组内首个 = 最高分块（score 降序，见文件头注释）
      const info = sources.get(knowledgeId);
      // 同文档多块答案（MMLongBench 一库一文档、参考文献/图表跨多 chunk）：
      // 只给最高分 1 块会丢关键信息——把组内高分块内容拼接进 content
      // （上限 ReferencesService.MAX_MULTI_CHUNK_CHARS，控制 prompt 成本；[n] 仍按文档编号，
      // chunks 字段保留各块位置供前端定位）
      const mergeContent = group
        .slice(0, 8)
        .map((c) => c.content)
        .join('\n\n');
      // 多模态（对齐 WeKnora 引用带图）：组内 image caption 块聚合图片——
      // url/caption/assetKey（url 为存储相对路径，前端经签名图片端点加载；
      // 主块类型/页信息取自组内首个 image 块——图片问答时引用即图）
      const imageChunks = group.filter((c) => c.type === 'image' && c.imageInfo);
      const mainIsImage = main.type === 'image' && main.imageInfo;
      references.push({
        index,
        chunkId: main.chunkId,
        kbId: main.kbId,
        knowledgeId,
        knowledgeTitle: info?.title ?? UNKNOWN_TITLE,
        content: this.truncate(
          // image 主块：content 已是 VLM 描述（图片问答引用正文，无需拼接）
          mainIsImage ? (main.content || '') : mergeContent,
          mainIsImage
            ? REFERENCE_CONTENT_MAX_LENGTH
            : group.length > 1
              ? 6000
              : REFERENCE_CONTENT_MAX_LENGTH,
        ),
        score: main.score,
        // 同文档全部块位置（score 降序；前端点击引用可定位到各块）
        chunks: group.map((c) => ({ chunkId: c.chunkId, score: c.score })),
        // URL 导入类型文档透传 sourceUrl（非 url 类型省略字段）
        ...(info?.sourceUrl ? { url: info.sourceUrl } : {}),
        // 主块是 image → type/page（文本块缺省；旧引用无字段前端降级）
        ...(mainIsImage
          ? {
              type: 'image' as const,
              page: main.imageInfo?.page,
            }
          : {}),
        // 组内 image caption 块聚合图（url 去重保序；无图省略 images 字段）
        ...(imageChunks.length > 0
          ? {
              images: [
                ...new Map(
                  imageChunks.map((c) => [
                    c.imageInfo!.url,
                    {
                      url: c.imageInfo!.url,
                      caption: c.imageInfo!.caption,
                      assetKey: c.imageInfo!.assetKey ?? c.assetKey,
                    },
                  ]),
                ).values(),
              ],
            }
          : {}),
      });
      index += 1;
    }
    return references;
  }

  /**
   * 生成后兜底对齐：扫描正文 `[n]` 提取引用编号集合，剔除 references 中
   * 未被正文引用的项。编号语义见文件头设计决策：
   * - 保留原文编号不重映射（正文已含 [n] 无法改写；references 按 index
   *   过滤，前端按 index 匹配——编号不连续是预期结果）
   * - 正文无任何 [n] → references 空数组（无引用不生成）
   * - 越界编号（正文 [n] 无对应 reference）→ 保留正文（不改写 LLM 输出），
   *   references 无该 index（幻觉编号前端悬浮无对应项，自然降级）
   * content 原样返回（正文不做任何改写）——返回 { content, references }
   * 仅便于调用方解构。
   */
  align(
    content: string,
    references: RagReference[],
  ): { content: string; references: RagReference[] } {
    // 提取正文 [n]（独立方括号整数——`[数字]` 即引用标记；`[1.5]`/`[x]`
    // 不匹配；`[2024]` 这类疑似年份的方括号数字会误入集合，但无对应引用
    // index 时被越界语义自然降级，无副作用）
    const cited = new Set<number>();
    const pattern = /\[(\d+)\]/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      cited.add(Number(match[1]));
    }
    if (cited.size === 0) {
      // 正文无任何 [n]：无引用不生成（LLM 未标注引用，不展示引用来源）
      return { content, references: [] };
    }
    // 仅保留正文引用的引用（index 保留原文编号，见文件头设计决策）
    const kept = references.filter((r) => cited.has(r.index));
    return { content, references: kept };
  }

  /** 内容截断：超长截到 REFERENCE_CONTENT_MAX_LENGTH 并追加 '…'（提示截断
   * 语义，见文件头设计决策）；短内容原样。 */
  private truncate(content: string, max = 3000): string {
    return content.length > max
      ? `${content.slice(0, max)}…`
      : content;
  }
}
