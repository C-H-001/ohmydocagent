// LLM 实体/关系抽取服务（Task 3.2）：对单个 chunk 调用 ChatModelService 抽取
// 实体与关系，JSON 解析容错（markdown 代码块 / 前后缀废话 / 损坏 JSON /
// 无 name 实体过滤 / attributes 清洗），extractAll 以并行度 4 的 Promise pool
// 逐 chunk 抽取并汇总（实体带 chunkId、关系 weight=1、跨 chunk 端点过滤、
// chunk 镜像同步）。
//
// 图模型（写入侧，见 graph.repository.ts / graph.types.ts）：
// - 实体 (:Entity { kbId, name, attributes, chunkIds })——kbId+name 复合唯一；
// - 关系 (:Entity)-[:RELATES_TO { type, fromId, toId, kbId, weight, chunkIds }]
//   ->(:Entity)——同类型同向边 MERGE 合并，weight 随重复写入累加；
// - chunk 镜像 (:Chunk { id, kbId, knowledgeId, content })——轻量反查。
// 本服务产出 DocumentGraphInput 行数据（entities/relationships/chunks），
// 由 ExtractProcessor 调 GraphRepository.upsertDocumentGraphInTx 单事务写入。
//
// 权重（P1 语义）：初始 weight=1 按出现聚合计数（upsert 的 ON MATCH 累加已
// 实现，见 graph.repository.ts）——「共现次数」即 P1 的关系强度。PMI/共现细化
// 登记为 TODO：WeKnora 的 PMIWeight=0.6 / StrengthWeight=0.4 / 衰减系数 0.5
// （随 chunk 距离衰减）为参考，P2 引入统计显著性（PMI）与距离衰减时，在
// extractAll 汇总阶段按 chunk 间距计算 weight 并在关系行携带——仓储侧累加
// 语义无需改动。
//
// 温度：0.1（低温保格式稳定，JSON 输出是硬约束，见 EXTRACTION_SYSTEM_PROMPT）。
// 失败语义（Task 3.2 质量审查整改，单 chunk 失败隔离）：损坏 JSON / LLM 上游
// 错误 → extractChunk 抛错 → extractAll 逐 chunk 捕获——单个 chunk 失败记日志
// （含 chunkId）跳过，其余照常汇总（图谱非关键路径，1 个 chunk 失败不应拖垮
// 整文档→整批重跑 ~2 倍 token 浪费）；全部失败 → extractAll 抛错 → 调用方
// （ExtractProcessor）抛错即触发 BullMQ 重试（attempts=2 + backoff 2s 由入队
// 配置决定，见 parse-queue.constants.ts addQueueJob 注释）。
import { Inject, Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { clampSurrogateBoundary } from '../../common/unicode.js';
import { CHAT_MODEL_SERVICE } from '../model/chat-model.interface.js';
import type { ChatModelService } from '../model/chat-model.interface.js';

/** 抽取温度：低温保 JSON 格式稳定（模型输出受温度扰动时易跑偏格式） */
const EXTRACTION_TEMPERATURE = 0.1;

/**
 * 抽取输入正文截断上限（字符）：LLM 上下文窗口保护。与 SummaryProcessor 的
 * 8000 截断（文档开头摘要）的差异——抽取是逐 chunk 调用，chunk 本身已按
 * chunkSize 分块（默认 800 字符），但手动文档/异常分块配置可能产出超长
 * chunk（如 chunkSize 调大或 chunking 异常未切分），全量发给 LLM 白烧 token/
 * 超上下文；抽取只需要实体/关系密度，2000 字符足够覆盖长 chunk。
 * 截断用 clampSurrogateBoundary 钳制（不劈开 emoji 等非 BMP 字符的代理对，
 * 见 common/unicode.ts 注释）
 */
const EXTRACTION_INPUT_LIMIT = 2000;

/** 并行抽取并发上限（Promise pool）：逐 chunk 调 LLM 是抽取管线的主要耗时，
 * 并行 4 与文档解析/向量化的并发约定同量级——既压满吞吐，又不至于把上游
 * LLM 并发打爆（真实模型接入后按供应商限流再调） */
const EXTRACTION_CONCURRENCY = 12; // DeepSeek v4 服务端动态批处理可承载更高并发
// 输出上限（token）：抽取只返回结构化 JSON——限制长度防模型自由发挥拖慢
// （实体/关系 JSON 通常 <500 token；1000 充足且显著快于无上限的长输出）

/**
 * 抽取系统提示（中文）：输出 { "node": [...], "relation": [...] } 结构化 JSON。
 * 实体语义：具体名词（专名/术语，不抽抽象描述短语）；关系语义：简洁动词/名词
 * 短语（如「开发」「隶属于」）；只输出 JSON（不做任何解释——解析容错在
 * parseExtractionJson 兜底，但 prompt 先约束，减少无效输出概率）。
 * 测试契约（graph-extraction.service.spec.ts）：本常量须包含 "node"/"relation"
 * 字段名与「实体是具体名词」「只输出 JSON」约束文案。
 */
export const EXTRACTION_SYSTEM_PROMPT = `你是知识图谱实体关系抽取引擎。请从用户提供的文本中抽取实体与实体间的关系，并只输出 JSON（不要任何解释、前后缀或 markdown 代码块）。

输出格式：
{
  "node": [
    { "name": "实体名", "attributes": ["属性1", "属性2"] }
  ],
  "relation": [
    { "node1": "实体名A", "node2": "实体名B", "type": "关系类型" }
  ]
}

要求：
- 实体是具体名词（人名、机构名、产品名、技术术语等专名），不抽取抽象描述或修饰短语；
- 关系类型简洁（动词或名词短语，如「开发」「隶属于」「合作」）；
- 只输出 JSON，字段名固定为 node 与 relation；
- 没有可抽取内容时输出 {"node": [], "relation": []}。`;

/** 单 chunk 抽取结果（parseExtractionJson 的结构化形态，未带 chunkId） */
export interface ChunkExtraction {
  entities: Array<{ name: string; attributes: string[] }>;
  /** 关系行端点保留到聚合期（跨 chunk 判定合法引用，见 extractAll 注释） */
  relations: Array<{ from: string; to: string; type: string }>;
}

/** extractAll 汇总行（DocumentGraphInput 的行数据，带 chunkId/weight） */
export interface ExtractionAggregate {
  entities: Array<{ name: string; attributes: string[]; chunkId: string }>;
  relationships: Array<{
    from: string;
    to: string;
    type: string;
    weight: number;
    chunkId: string;
  }>;
  chunks: Array<{ id: string; content: string }>;
}

@Injectable()
export class GraphExtractionService {
  private readonly logger = new Logger(GraphExtractionService.name);

  constructor(
    @Inject(CHAT_MODEL_SERVICE) private readonly chatModel: ChatModelService,
    private readonly dataSource: DataSource,
  ) {}

  /** 用户提示：直接附 chunk 文本（抽取指令与格式说明已在系统提示中）。
   * 截断保护（Task 3.2 质量审查整改，见 EXTRACTION_INPUT_LIMIT 注释）：
   * clampSurrogateBoundary 钳制到 2000 字符——超长 chunk 不白烧 token，
   * 且不劈开代理对（无孤立代理/乱码） */
  buildUserPrompt(content: string): string {
    return content.slice(
      0,
      clampSurrogateBoundary(content, EXTRACTION_INPUT_LIMIT),
    );
  }

  /**
   * 单 chunk 抽取：调 LLM（[system, user] + temperature=0.1）→ 容错解析。
   * 损坏 JSON / LLM 上游错误 → 抛错（调用方 ExtractProcessor 抛错即触发
   * BullMQ 重试，attempts=2 + backoff 2s 由入队配置决定）。
   */
  async extractChunk(chunk: {
    id: string;
    content: string;
    knowledgeId?: string;
  }): Promise<ChunkExtraction> {
    const userPrompt = this.buildUserPrompt(chunk.content);
    // BYOK：按文档归属（KB creatorId）取用户默认对话模型——图谱抽取 worker
    // 无请求上下文，须显式传 userId（getDefault 无 userId 返回 null 会 503）
    const ownerId = chunk.knowledgeId
      ? await this.knowledgeOwnerId(chunk.knowledgeId)
      : null;
    const text = await this.chatModel.chat(
      [
        { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      { temperature: EXTRACTION_TEMPERATURE, maxTokens: 1000 },
      ownerId ?? undefined,
    );
    const parsed = GraphExtractionService.parseExtractionJson(text);
    if (!parsed) {
      throw new Error(`抽取 JSON 解析失败: ${chunk.id}`);
    }
    // 文档 token 消耗累计（图谱抽取：输入 prompt + 输出 JSON，估算 1 token
    // ≈ 1.5 字符；真实 usage 需 chat 响应透传，见文件头注释）
    if (chunk.knowledgeId) {
      const chars = EXTRACTION_SYSTEM_PROMPT.length + userPrompt.length + text.length;
      await this.incrTokenCost(chunk.knowledgeId, Math.ceil(chars / 1.5));
    }
    return parsed;
  }

  /** 文档 token 消耗累加（知识表字段；失败仅日志） */
  private async incrTokenCost(knowledgeId: string, tokens: number): Promise<void> {
    if (tokens <= 0) return;
    try {
      await this.dataSource.query(
        `UPDATE knowledge SET "tokenCost" = "tokenCost" + $1 WHERE id = $2`,
        [tokens, knowledgeId],
      );
    } catch (err) {
      this.logger?.warn?.(`图谱抽取 token 累计失败: knowledgeId=${knowledgeId}`, err as Error);
    }
  }

  /** 文档归属用户：KB 创建者（BYOK 取默认模型用——worker 无请求上下文）。
   *  与 EmbedProcessor.knowledgeOwnerId 同源（knowledge → kb.creatorId） */
  private async knowledgeOwnerId(knowledgeId: string): Promise<string | null> {
    try {
      const rows = await this.dataSource.query<{ creatorId: string | null }[]>(
        `SELECT kb."creatorId" AS "creatorId"
         FROM knowledge k JOIN knowledge_bases kb ON kb.id = k."kbId"
         WHERE k.id = $1`,
        [knowledgeId],
      );
      return rows[0]?.creatorId ?? null;
    } catch {
      return null;
    }
  }

  /**
   * 逐 chunk 并行抽取（并发上限 4，Promise pool）→ 汇总。
   * 汇总语义：
   * - 实体行带来源 chunkId（实体去重由仓储 MERGE (kbId,name) 幂等完成，
   *   此处不预聚合——保留行级 chunkId，仓储侧追加去重）；
   * - 关系行 weight=1（P1 共现计数，见文件头「权重」注释）、带 chunkId；
   * - 跨文档端点两段判定（Task 3.2 质量审查整改）：关系端点须在
   *   「本文档实体集合 ∪ 图谱既有实体」中——chunk1 抽到的实体可在 chunk2
   *   的关系里引用（本文档内合法），历史文档抽取过的实体也可引用（跨文档
   *   合法边，existingEntityNames 由 ExtractProcessor 查 GraphRepository.
   *   listEntityNames 传入）；两处都不存在的端点丢弃（防仓储端点守卫抛错
   *   回滚整批，见 graph.repository.ts upsertDocumentGraphInTx 注释）；
   * - chunks 镜像行：id+content 原样透传（仓储按 (id,kbId) MERGE）——
   *   含抽取失败的 chunk（镜像反映文档实际分块内容，与抽取成败无关）。
   * 失败隔离（Task 3.2 质量审查整改）：单 chunk 失败（损坏 JSON/LLM 上游
   * 错误）记日志（含 chunkId）跳过，其余照常汇总；全部失败 → 抛错（调用方
   * ExtractProcessor 抛错触发 BullMQ 重试 attempts=2，见 extract.processor.ts
   * 注释）——避免 50 个 chunk 中 1 个失败导致整批重跑的 ~2 倍 token 浪费。
   * 空 chunk 列表 → 空汇总（不调 LLM）。
   */
  async extractAll(
    chunks: Array<{ id: string; content: string }>,
    existingEntityNames: string[] = [],
    knowledgeId?: string,
  ): Promise<ExtractionAggregate> {
    if (chunks.length === 0) {
      return { entities: [], relationships: [], chunks: [] };
    }
    // Promise pool（并发上限 EXTRACTION_CONCURRENCY）：固定 worker 从共享
    // 游标取任务（mapLimit 保持入参顺序归位）；单 chunk 失败在此捕获为
    // 结果分支（不外抛），全部失败时聚合期统一抛错（见下）
    const outcomes = await mapLimit(
      chunks,
      EXTRACTION_CONCURRENCY,
      async (
        chunk,
      ): Promise<
        | { ok: true; extraction: ChunkExtraction }
        | { ok: false; error: unknown }
      > => {
        try {
          return { ok: true, extraction: await this.extractChunk({ ...chunk, knowledgeId }) };
        } catch (err) {
          return { ok: false, error: err };
        }
      },
    );
    // 汇总：globalNames 以图谱既有实体初始化（跨文档合法端点），两段判定见
    // 方法头注释；先收集全部成功 chunk 的实体、再过滤关系行——保证端点判定
    // 与 chunk 顺序无关（chunk2 引用 chunk1 的实体同样合法）
    const globalNames = new Set<string>(existingEntityNames);
    const entities: ExtractionAggregate['entities'] = [];
    // 关系行暂存（带来源 chunkId），实体集合收集完整后二次过滤（见下）
    const pendingRelations: Array<{
      rel: ChunkExtraction['relations'][number];
      chunkId: string;
    }> = [];
    let failedChunks = 0;
    let lastError: unknown;
    outcomes.forEach((outcome, i) => {
      const chunkId = chunks[i].id;
      if (!outcome.ok) {
        // 单 chunk 失败隔离：记日志（含 chunkId）跳过，其余照常写图
        failedChunks++;
        lastError = outcome.error;
        const message =
          outcome.error instanceof Error
            ? outcome.error.message
            : String(outcome.error);
        this.logger.warn(
          `图谱抽取单 chunk 失败（跳过该 chunk，其余继续）: chunkId=${chunkId} - ${message}`,
        );
        return;
      }
      const extraction = outcome.extraction;
      for (const e of extraction.entities) globalNames.add(e.name);
      for (const e of extraction.entities) {
        entities.push({ ...e, chunkId });
      }
      for (const rel of extraction.relations) {
        pendingRelations.push({ rel, chunkId });
      }
    });
    const relationships: ExtractionAggregate['relationships'] = [];
    for (const { rel, chunkId } of pendingRelations) {
      // 端点必须存在（本文档 ∪ 图谱既有，跨 chunk/跨文档引用合法）；
      // 缺失则丢弃该行
      if (globalNames.has(rel.from) && globalNames.has(rel.to)) {
        relationships.push({ ...rel, weight: 1, chunkId });
      }
    }
    if (chunks.length > 0 && failedChunks === chunks.length) {
      // 全部失败：抛错触发 job 重试（attempts=2）——避免静默产出空图
      // （部分失败不抛——成功部分已写入，缺失 chunk 由 reparse 重建）
      if (lastError instanceof Error) throw lastError;
      throw new Error('全部 chunk 图谱抽取失败');
    }
    return {
      entities,
      relationships,
      chunks: chunks.map((c) => ({ id: c.id, content: c.content })),
    };
  }

  /**
   * JSON 解析容错（LLM 输出的四道防线，按序执行）：
   * 1. 剥 markdown 代码块（```json ... ``` 及其它语言标注的 ``` 围栏）；
   * 2. 取首个 { 到末尾 } 截取（模型输出前后缀废话时剥掉，防 JSON.parse
   *    在前后缀处报错）；
   * 3. JSON.parse——失败返回 null（调用方抛错触发重试）；
   * 4. 结构校验：node/relation 必须为数组（{} 或结构缺失 → null）；
   *    实体清洗：name 缺省/空白丢弃、attributes 非字符串项过滤 + 去重；
   *    关系行保留（端点过滤在聚合期跨 chunk 判定，见 extractAll 注释）。
   */
  static parseExtractionJson(text: string): ChunkExtraction | null {
    if (!text || !text.trim()) return null;
    // 1. 剥 markdown 代码块围栏（```json ... ``` / ``` ... ```）
    let cleaned = text.replace(/```[a-zA-Z]*\n?/g, '');
    // 2. 取首个 { 到末尾 }（无 { } 则直接按原文解析，parse 失败返回 null）
    const first = cleaned.indexOf('{');
    const last = cleaned.lastIndexOf('}');
    if (first !== -1 && last !== -1 && last > first) {
      cleaned = cleaned.slice(first, last + 1);
    }
    // 3. JSON.parse
    let raw: unknown;
    try {
      raw = JSON.parse(cleaned);
    } catch {
      return null;
    }
    if (typeof raw !== 'object' || raw === null) return null;
    const obj = raw as Record<string, unknown>;
    // 4a. node/relation 必须为数组（结构不合法 → null）
    if (!Array.isArray(obj.node) || !Array.isArray(obj.relation)) return null;
    // 4b. 实体清洗：name 缺省/空白丢弃；attributes 非字符串过滤 + 去重（保序）
    const entities: ChunkExtraction['entities'] = [];
    for (const item of obj.node) {
      if (typeof item !== 'object' || item === null) continue;
      const row = item as Record<string, unknown>;
      const name = typeof row.name === 'string' ? row.name.trim() : '';
      if (!name) continue; // 无 name / 空白 name → 丢弃
      const attributes: string[] = [];
      if (Array.isArray(row.attributes)) {
        const seen = new Set<string>();
        for (const a of row.attributes) {
          if (typeof a !== 'string') continue; // 非字符串项过滤
          if (seen.has(a)) continue; // 去重
          seen.add(a);
          attributes.push(a);
        }
      }
      entities.push({ name, attributes });
    }
    // 4c. 关系行：from/to/type 清洗后保留（端点缺失保留到聚合期跨 chunk 判定）
    const relations: ChunkExtraction['relations'] = [];
    for (const item of obj.relation) {
      if (typeof item !== 'object' || item === null) continue;
      const row = item as Record<string, unknown>;
      const from = typeof row.node1 === 'string' ? row.node1.trim() : '';
      const to = typeof row.node2 === 'string' ? row.node2.trim() : '';
      const type = typeof row.type === 'string' ? row.type.trim() : '';
      if (!from || !to || !type) continue;
      relations.push({ from, to, type });
    }
    return { entities, relations };
  }
}

/**
 * 并发受限 map（Promise pool）：固定 limit 个 worker 从共享游标取任务，
 * 每个任务串行 await fn（天然限流），结果按下标归位（保序）。
 * 任一任务 reject → Promise.all 整体 reject（调用方按整体失败处理/重试）。
 */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  // 结果按下标收集（Map），收尾按下标重排——避免预尺寸数组（new Array
  // 语义含糊，见 oxlint unicorn(no-new-array)）
  const results = new Map<number, R>();
  let cursor = 0;
  const workerCount = Math.min(limit, items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results.set(index, await fn(items[index]));
    }
  });
  await Promise.all(workers);
  return items.map((_, i) => results.get(i) as R);
}
