// search_kb 工具（Task 2.8）：企业知识库检索工具——Task 2.5 RAG 管线的
// 检索/重排/合并三段改造（query_understand 职责并入 LLM 工具调用参数——LLM
// 结合对话历史自行决定检索 query，见 agent-orchestrator.service.ts 文件头）。
//
// 执行流程（对应原管线 search → rerank → merge 阶段，阶段事件仍发——前端
// 检索语义不变，见 chat-event.types.ts 注释）：
// 1. search：会话 kbIds 内 hybridSearch（向量 + 关键词混合，topK 由 LLM 指定
//    或默认 RAG_SEARCH_TOP_K=10）
// 2. rerank：无重排模型 → 按 score 降序截断（hybridSearch 已降序，截断即
//    重排；真实重排模型接入点同原管线注释）
// 3. merge：检索 0 结果 → 跳过 merge（无引用，search_nothing 语义——
//    返回「未找到相关内容」文案）；有结果 → 标题补查（批量 WHERE id IN，
//    防 N+1）+ ReferencesService.build（同文档合并/[n] 编号/内容截断）→
//    返回「编号 + 标题 + 摘要」文本（LLM 引用 [n] 的依据）+ references
//    数据（Agent 累积后随 assistant 落库，Task 2.6 引用系统不变）
//
// 失败语义（设计决策，见 tool.interface.ts 文件头）：检索失败 → status
// error + 友好文案（不抛错）——错误文本回填 LLM（模型可降级回答），对话
// 不中断（区别于 Task 2.5 管线检索失败 → SSE error 中断整个生成）；
// stage(search error) 事件仍发（前端可见检索阶段失败）。
//
// 检索范围限定：kbIds 经 ToolExecutionContext 透传（会话级；工具保持无状态
// 单例，「每次直传配置」形态，见 tool.interface.ts）。
// Task 2.9：@提及范围（ctx.scope）优先于会话 kbIds——有 @kb → kbIds 覆盖会话
// 范围（用户显式指定）；有 @file → knowledgeIds 限定文件 chunks（hybridSearch
// 增加 knowledgeIds 过滤维度，见 vector.service.ts）；两者并集由 VectorService
// SQL 的 OR 语义承担；两者都缺省 → 会话 kbIds（既有语义）。
// 质量审查登记（P4 KB 权限落地时必做）：@file:F 按 knowledgeId 检索该文件的
// 全 chunks——即使 F 所属 KB 不在会话 kbIds 也命中（@提及范围跨越 KB 边界）。
// 当前 P1 无 KB ACL 无越权问题；Task 4.2 KbAccessGuard 落地时，检索范围
// （会话 kbIds 与 @kb/@file 提及的并集）需与用户可见 KB 做交集过滤（提及
// 不可见 KB/文档时静默忽略或 403），见 docs/plans/2026-08-27-ohmydocagent-
// implementation.md Task 4.2 加注。
import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { CHAT_MODEL_SERVICE } from '../../../model/chat-model.interface.js';
import type { ChatModelService } from '../../../model/chat-model.interface.js';
import { RerankService } from '../../../model/rerank.service.js';
import { Chunk } from '../../../chunk/chunk.entity.js';
import { Knowledge } from '../../../knowledge/knowledge.entity.js';
import { KnowledgeBase } from '../../../kb/kb.entity.js';
import { VectorService } from '../../../vector/vector.service.js';
import type { HybridSearchItem } from '../../../vector/vector.service.js';
import { ReferencesService } from '../../pipeline/references.service.js';
import { ParserFileGuard } from '../../../../parser/parser-file.controller.js';
import type {
  Tool,
  ToolExecutionContext,
  ToolExecutionResult,
} from './tool.interface.js';

/** 检索无结果时的回填文案（search_nothing 语义）：0 结果 → 跳过 merge，
 * 返回固定文案——LLM 据此基于常识回答并说明（原 merge.service.ts 常量
 * 随死代码清理移入本工具——唯一消费方，见质量审查整改） */
export const NO_RESULT_SYSTEM_PROMPT = '未找到相关内容，请基于常识回答并说明。';

/** search 阶段检索条数上限（hybridSearch topK 默认值；LLM 可传 topK 覆盖） */
export const RAG_SEARCH_TOP_K = 10;
/** rerank 阶段保留条数（RRF 融合后截断上限——提高至 12：多块型答案
 * （参考文献/图表/连续段落）需要完整进入 rerank/模型视野，5 条截断会把
 * 融合后排名 6~20 的关键块挡在 rerank 外（MMLongBench 实测：参考文献页
 * 向量召回第 3，但截断 5 后进不了 rerank，模型答不出「数 12 篇引用」）） */
export const RAG_RERANK_TOP_K = 12;

/** 工具参数 query 最大长度（字符）：超长 query 白烧 embedding/检索，
 * 执行前校验拒绝（质量审查整改，见 execute 参数校验注释） */
export const QUERY_MAX_LENGTH = 200;

/** KB 检索配置默认值（参考 WeKnora RetrievalConfig：向量偏重、k=60；
 * OhMyDocAgent 三路拆分——图谱实体命中保持强信号（rank 前置 + 最高权重，
 * 见 rrfFuse 注释），向量次之、关键词最低，均可由 KB retrievalConfig 覆盖） */
export const DEFAULT_RETRIEVAL = {
  vectorThreshold: 0.05, // 对齐 VectorService.MIN_VECTOR_SCORE
};

@Injectable()
export class KbSearchTool implements Tool {
  private readonly logger = new Logger(KbSearchTool.name);

  /** 工具定义（透传供应商 tools 参数；LLM 据此决策调用方式） */
  readonly definition = {
    name: 'search_kb',
    description:
      '在企业知识库中检索与问题相关的资料（检索增强回答的知识来源）。' +
      '返回 [n] 编号的资料列表，回答时应基于这些资料并标注引用 [n]；' +
      '检索不到相关内容时请基于常识回答并说明。',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '检索查询（可结合对话历史改写为独立检索查询）',
        },
        topK: {
          type: 'number',
          description:
            '检索条数上限（最终保留条数）。策略：先小值快检——从 8 开始；' +
            '若结果不足以回答（含多文档对比/多跳需更多片段），逐步调大：8 → 12 → 16 → 20。' +
            '扩大 topK 比更换查询词更高效（同一 query 更多候选经重排保留）。上限 20。',
        },
      },
      required: ['query'],
    },
  };

  constructor(
    // 混合检索（向量 + 关键词，Task 2.5 已实现）
    private readonly vectorService: VectorService,
    // KB 检索配置（RRF 权重/阈值，参考 WeKnora RetrievalConfig）
    @InjectRepository(KnowledgeBase)
    private readonly kbRepo: Repository<KnowledgeBase>,
    // 标题/sourceUrl 补查（references 的 knowledgeTitle/url 来源——批量
    // WHERE id IN，防 N+1，同原管线 merge 阶段）
    @InjectRepository(Knowledge)
    private readonly knowledgeRepo: Repository<Knowledge>,
    // 引用构建（同文档合并/[n] 编号/内容截断，纯函数服务，Task 2.6）
    private readonly referencesService: ReferencesService,
    // 图谱增强检索（Task 3.4）：实体引导补充候选（chunk 内容查询用）
    @InjectRepository(Chunk)
    private readonly chunkRepo: Repository<Chunk>,
    // 查询理解（参考 WeKnora QueryUnderstand/ExtractEntity/QueryExpansion）：
    // LLM 一次调用产出「图谱实体名 + 检索改写变体」
    @Inject(CHAT_MODEL_SERVICE)
    private readonly chatModel: ChatModelService,
    // 真实重排模型（参考 WeKnora PluginRerank）：RRF 融合后精排
    private readonly rerankService: RerankService,
    // Task: 多模态——引用 images 签名 URL（<img> 直出用，见 parser-file.controller）
    private readonly fileGuard: ParserFileGuard,
  ) {}

  /**
   * 执行检索：hybridSearch → score 截断 → 标题补查 + 引用构建。
   * 入参宽松处理（LLM 可能传类型不匹配的值）：query 非字符串按空串兜底、
   * topK 非正数用默认（不抛错）。阶段事件经 ctx.sse 发出（search/rerank/
   * merge start/done；0 结果跳过 merge）；断连检查点：阶段间检查
   * ctx.signal.aborted → 返回已算结果（Agent 循环据此落库 partial）。
   */
  async execute(
    args: Record<string, unknown>,
    ctx: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    // 参数校验（质量审查整改）：query 必须是非空且 ≤200 字符的字符串——LLM
    // 可能传超长/非字符串/空 query（白烧 embedding/检索）；非法 → status
    // error + 友好文案回填（对话继续，模型降级回答，不发检索阶段事件）
    const rawQuery = args.query;
    if (
      typeof rawQuery !== 'string' ||
      rawQuery.length === 0 ||
      rawQuery.length > QUERY_MAX_LENGTH
    ) {
      return {
        content: '检索参数无效，请基于已有知识回答。',
        status: 'error',
        references: [],
      };
    }
    const query = rawQuery;
    // topK 宽松解析：模型可调（提示词引导：先小 k 快检，答案不足再逐步调大
    // ——同 query 扩 topK 比反复换 query 更高效）。上限 20 防白检索。
    // 最终保留条数 = topK（rerank 后按此截断），默认 RAG_RERANK_TOP_K=12。
    const topK =
      typeof args.topK === 'number' && args.topK > 0
        ? Math.min(Math.floor(args.topK), 20)
        : RAG_RERANK_TOP_K;
    // 检索范围（Task 2.9）：mention scope（@提及限定）优先于会话 kbIds——
    // 有 @kb → kbIds 覆盖会话范围；有 @file → knowledgeIds 限定文件 chunks；
    // 两者都缺省 → 会话 kbIds（既有语义），见文件头注释
    const scopeKbIds = ctx.scope?.kbIds ?? ctx.kbIds;
    const scopeKnowledgeIds = ctx.scope?.knowledgeIds ?? [];
    // KB 检索配置（参考 WeKnora RetrievalConfig）：RRF 权重/阈值——取首个
    // 目标 KB 的配置（多 KB 并集时用第一个的配置，简化；缺省用默认）
    const retrieval = await this.loadRetrievalConfig(scopeKbIds);
    // 防御：范围空时工具定义本就不注入（见 agent-orchestrator 工具装配），
    // 此处双保险——直接返回无结果（不检索全局库）
    if (scopeKbIds.length === 0 && scopeKnowledgeIds.length === 0) {
      return {
        content: '当前会话未关联知识库，无法提供企业知识库资料。',
        status: 'done',
        references: [],
      };
    }
    // 1. search：查询理解（LLM 抽取图谱实体 + 生成改写变体，参考 WeKnora
    //    QueryUnderstand/ExtractEntity/QueryExpansion）→ 原查询 + 变体并行
    //    混合检索 → 合并（score 取各查询最高——多角度命中取最强信号）
    ctx.sse.send({ type: 'stage', stage: 'search', status: 'start' });
    // 查询分析（一次小调用；失败/解析失败 → 空实体 + 仅原查询，不阻断检索）
    let expandedQueries: string[] = [];
    try {
      const analyzed = await this.analyzeQuery(query, ctx.userId);
      expandedQueries = analyzed.queries;
    } catch (err) {
      this.logger.warn(
        `查询理解失败，回退原始检索: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const searchQueries = [query, ...expandedQueries.filter((q) => q && q !== query)].slice(0, 3);
    let chunks: HybridSearchItem[] = [];
    try {
      const results = await Promise.all(
        searchQueries.map((q) =>
          scopeKnowledgeIds.length > 0
            ? this.vectorService.hybridSearch(scopeKbIds, q, topK, scopeKnowledgeIds, retrieval.vectorThreshold, ctx.userId)
            : this.vectorService.hybridSearch(scopeKbIds, q, topK, undefined, retrieval.vectorThreshold, ctx.userId),
        ),
      );
      // 合并去重：同一 chunk 出现在多路检索 → 分数取最高（多角度命中加分，
      // 用命中路数做微弱加权：score + 0.01 * 命中次数）
      const best = new Map<string, HybridSearchItem>();
      const hits = new Map<string, number>();
      for (const r of results) {
        for (const item of r) {
          const prev = best.get(item.chunkId);
          const prevScore = prev ? prev.score : 0;
          hits.set(item.chunkId, (hits.get(item.chunkId) ?? 0) + 1);
          if (!prev || item.score > prevScore) {
            best.set(item.chunkId, { ...item, score: item.score });
          }
        }
      }
      chunks = [...best.values()];
      for (const c of chunks) {
        const n = hits.get(c.chunkId) ?? 1;
        if (n > 1) c.score = c.score + 0.01 * (n - 1);
      }
      chunks.sort((a, b) => b.score - a.score);
    } catch (err) {
      // 检索失败：stage error + 返回友好文案（不抛错——错误文本回填 LLM，
      // 对话继续；原始细节只进 logger 防泄露，见文件头失败语义）
      ctx.sse.send({
        type: 'stage',
        stage: 'search',
        status: 'error',
        detail: '知识库检索服务异常',
      });
      this.logger.error(
        `知识库检索失败: scope=${scopeKbIds.join(',')}/knowledge=${scopeKnowledgeIds.join(',')}`,
        err instanceof Error ? err.stack : String(err),
      );
      return {
        content: '知识库检索失败，请稍后重试。',
        status: 'error',
        references: [],
      };
    }
    ctx.sse.send({ type: 'stage', stage: 'search', status: 'done' });
    if (ctx.signal.aborted)
      return { content: '', status: 'done', references: [] };

    // 2. rerank：无重排模型 → 三路检索（向量/关键词/图谱）RRF 融合后按
    //    融合分排序截断（真实重排模型接入点同原管线注释）
    ctx.sse.send({ type: 'stage', stage: 'rerank', status: 'start' });
    // GraphRAG（Task: 参考 WeKnora ENTITY_SEARCH）：图谱作为第三路召回路——
    // query 实体词 CONTAINS 命中实体 + 一跳邻居 → 实体关联 chunk 进入候选池，
    // 与向量/关键词结果做 RRF 融合（Reciprocal Rank Fusion，各路 rank 倒数
    // 求和），实体强关联 chunk 得以进入排序而非仅「不足时补充」；同时产出
    // entityContext（实体关系描述）供 generate 阶段注入（见下方 merge）。
    // 无命中/图不可用 → 静默降级（图谱路为空，融合退化为向量+关键词）。
    // 真实重排模型精排（参考 WeKnora PluginRerank）：有默认 rerank 模型 →
    // 对候选 content 重排取 RAG_RERANK_TOP_K；无模型/失败 → 分数截断（既有）
    const reranked = await this.rerankService.rerank(
      query,
      chunks.slice(0, Math.min(topK * 2, 30)).map((c) => c.content),
      topK,
    );
    if (reranked && reranked.length > 0) {
      const byIndex = new Map(reranked.map((r) => [r.index, r]));
      chunks = chunks
        .slice(0, Math.min(topK * 2, 30))
        .map((c, i) => ({ c, r: byIndex.get(i) }))
        .filter((x): x is { c: HybridSearchItem; r: NonNullable<typeof x.r> } => !!x.r)
        .sort((a, b) => b.r.score - a.r.score)
        .map((x) => x.c);
    }
    chunks = chunks.slice(0, topK);
    ctx.sse.send({ type: 'stage', stage: 'rerank', status: 'done' });
    if (ctx.signal.aborted)
      return { content: '', status: 'done', references: [] };

    // 3. merge：检索 0 结果 → 跳过 merge（无引用，search_nothing 语义——
    //    返回固定文案，LLM 据此基于常识回答）
    if (chunks.length === 0) {
      return {
        content: NO_RESULT_SYSTEM_PROMPT,
        status: 'done',
        references: [],
      };
    }
    ctx.sse.send({ type: 'stage', stage: 'merge', status: 'start' });
    // 上下文扩展 + 相邻块合并（参考 WeKnora MergeExpand/Overlap/ParentResolve）：
    // - 扩展：命中 chunk 的 pre/next 相邻块（不在结果中）纳入候选——被切碎的
    //   上下文得以补全（MergeExpand 语义）
    // - 合并：结果中通过 pre/next 链相邻的 chunk 合并为同一片段（内容拼接，
    //   引用定位主块——MergeOverlap/ParentResolve 的相邻合并语义）
    chunks = await this.expandNeighbors(chunks, scopeKbIds, topK);
    // 标题补查（批量 WHERE id IN，防 N+1——references 的 knowledgeTitle/url
    // 来源；仅 url 类型透传 sourceUrl，见 references.service.ts 注释）
    const knowledgeIds = [...new Set(chunks.map((c) => c.knowledgeId))];
    const knowledge = await this.knowledgeRepo.find({
      where: { id: In(knowledgeIds) },
    });
    const sources = new Map(
      knowledge.map((k) => [
        k.id,
        {
          title: k.title,
          ...(k.type === 'url' && k.sourceUrl
            ? { sourceUrl: k.sourceUrl }
            : {}),
        },
      ]),
    );
    const references = this.referencesService.build(chunks, sources);
    // 引用 images 签名 URL（存储相对路径 → Public 签名端点完整 URL，前端
    // <img> 无 header 直出；无图引用跳过——签名 1 小时过期，前端直接加载）
    for (const ref of references) {
      if (ref.images?.length) {
        ref.images = ref.images.map((img) => ({
          ...img,
          url: this.fileGuard.signUrl(img.url),
        }));
      }
    }
    // 工具返回文本：编号 + 标题 + 摘要（LLM 引用 [n] 的依据——与系统提示
    // 引用规则对应；references 数据由 Agent 累积后随 assistant 落库。
    // 注意：图谱检索已拆分为独立 search_graph 工具（hybrid→graph 工作流，
    // 不再在本工具内 RRF 融合——避免图谱噪声污染语义召回，见文件头注释）
    const content = references
      .map((r) => `[${r.index}] ${r.knowledgeTitle}：${r.content}`)
      .join('\n');
    ctx.sse.send({ type: 'stage', stage: 'merge', status: 'done' });
    return { content, status: 'done', references };
  }

  /** 读 KB 检索配置（首个目标 KB；缺省默认——WeKnora 默认向量偏重） */
  private async loadRetrievalConfig(kbIds: string[]): Promise<{
    vectorThreshold: number;
  }> {
    let cfg: Record<string, unknown> | undefined;
    if (kbIds.length > 0) {
      try {
        const kb = await this.kbRepo.findOne({
          where: { id: kbIds[0] },
          select: { retrievalConfig: true },
        });
        cfg = kb?.retrievalConfig;
      } catch { /* 配置读取失败用默认 */ }
    }
    return {
      vectorThreshold:
        typeof cfg?.vectorThreshold === 'number' && cfg.vectorThreshold >= 0
          ? cfg.vectorThreshold
          : DEFAULT_RETRIEVAL.vectorThreshold,
    };
  }

  /**
   * 查询理解（参考 WeKnora QueryUnderstand/ExtractEntity/QueryExpansion）：
   * 一次 LLM 调用产出 { entities: 图谱实体名[], queries: 检索改写变体[] }。
   * 解析失败/上游错误 → 返回空（调用方回退原始检索，不阻断）。
   */
  private async analyzeQuery(query: string, userId?: string): Promise<{
    queries: string[];
  }> {
    try {
      const raw = await this.chatModel.chat(
        [
          {
            role: 'system',
            content:
              '你是企业知识库的检索查询分析器。给定用户问题，输出 JSON（不要多余文字）：' +
              '{"queries": ["2 个检索改写变体：同义改写/补充关键词/中英表达，均独立完整可检索"]}' +
              '改写应保留原意，便于语义检索命中。',
          },
          { role: 'user', content: `问题：${query}` },
        ],
        { temperature: 0.2, maxTokens: 100 },
        userId,
      );
      const json = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
      const parsed = JSON.parse(json) as { queries?: unknown };
      const queries = Array.isArray(parsed.queries)
        ? parsed.queries.filter((q): q is string => typeof q === 'string' && q.trim().length > 0).slice(0, 2)
        : [];
      return { queries };
    } catch {
      return { queries: [] };
    }
  }

  /**
   * 上下文扩展 + 相邻块合并：
   * - 对结果中每个 chunk，拉取 pre/next 相邻块（不在结果中）→ 追加为候选
   *   （限制：每个方向 1 块，总量不超过 maxChunks——避免无限膨胀）
   * - 结果按 pre/next 链相邻的 chunk 合并为同一片段（content 以换行拼接，
   *   引用定位链首块；模拟父子块切分的整段上下文，参考 WeKnora Merge）
   */
  private async expandNeighbors(
    base: HybridSearchItem[],
    kbIds: string[],
    maxChunks: number,
  ): Promise<HybridSearchItem[]> {
    if (base.length === 0) return base;
    // 1) 拉取结果块的相邻块
    const ids = base.map((c) => c.chunkId);
    const known = new Set(ids);
    const neighbors = await this.chunkRepo.find({
      where: { id: In(ids) },
      select: { id: true, preChunkId: true, nextChunkId: true },
    });
    const linkMap = new Map<string, { pre?: string; next?: string }>();
    for (const n of neighbors) {
      linkMap.set(n.id, {
        ...(n.preChunkId ? { pre: n.preChunkId } : {}),
        ...(n.nextChunkId ? { next: n.nextChunkId } : {}),
      });
    }
    const adjacentIds = new Set<string>();
    for (const id of ids) {
      const link = linkMap.get(id);
      if (link?.pre && !known.has(link.pre)) adjacentIds.add(link.pre);
      if (link?.next && !known.has(link.next)) adjacentIds.add(link.next);
    }
    let all = base;
    if (adjacentIds.size > 0) {
      const adjChunks = await this.chunkRepo.find({
        where: { id: In([...adjacentIds]), kbId: In(kbIds) },
        select: { id: true, content: true, kbId: true, knowledgeId: true },
      });
      const byId = new Map(adjChunks.map((c) => [c.id, c]));
      const adjItems: HybridSearchItem[] = [...adjacentIds]
        .map((id) => byId.get(id))
        .filter((c): c is NonNullable<typeof c> => !!c)
        .map((c) => ({
          chunkId: c.id,
          content: c.content,
          kbId: c.kbId,
          knowledgeId: c.knowledgeId,
          score: 0,
          vectorScore: 0,
          keywordScore: 0,
        }));
      all = [...base, ...adjItems];
    }
    // 2) 相邻块合并：按 pre/next 链把连续 chunk 合并为片段
    const items = all.slice(0, maxChunks + adjacentIds.size);
    const merged: HybridSearchItem[] = [];
    const used = new Set<string>();
    for (const item of items) {
      if (used.has(item.chunkId)) continue;
      // 沿 next 链向后收集连续块
      let cur = item.chunkId;
      let content = item.content;
      const chain: string[] = [item.chunkId];
      let guard = 0;
      while (guard++ < 5) {
        const link = linkMap.get(cur);
        if (!link?.next || !all.some((c) => c.chunkId === link.next)) break;
        const nx = all.find((c) => c.chunkId === link.next)!;
        content = `${content}\n\n${nx.content}`;
        chain.push(nx.chunkId);
        used.add(nx.chunkId);
        cur = nx.chunkId;
      }
      used.add(item.chunkId);
      // 内容截断：合并片段总长上限（防超长喂 LLM，参考 ReferencesService 截断）
      merged.push({ ...item, content: content.slice(0, 3000) });
    }
    return merged.slice(0, maxChunks);
  }
}
