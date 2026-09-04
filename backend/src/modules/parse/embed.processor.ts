// 向量化队列处理器（Task 1.6 + Task 1.9）：消费 EMBED_QUEUE，载荷两种：
// - { knowledgeId }：文档批量（Task 1.6 解析/重新解析后入队）——加载
//   knowledge（不存在 = 文档已被删除/级联清理 → 无块可向量化，记日志跳过
//   而非抛错——与 ParseProcessor 的 404 抛错重试不同：解析是「文档还在但
//   解析失败」可重试，向量化在删除场景下重试无意义）→ 查该文档全部
//   indexStatus='processing' 的块 → 批量 embed（一个文档的块一批向量化，
//   减少队列条目，见 parse.processor.ts enqueueEmbed 注释）→ 批量 upsert
//   （单事务，任一块失败整体回滚，见 VectorService.upsertEmbeddings 注释）→
//   成功置 ready。失败：置 failed 后抛错触发 BullMQ 重试（attempts=2 + 指数
//   backoff，与 PARSE_QUEUE 入队配置一致，见 ParseProcessor 注释）。
// - { chunkId }：单块重新向量化（Task 1.9 编辑/回滚后入队）——直接按当前
//   内容重嵌入该块（语义差异见 processSingleChunk 注释）。
//
// 批量路径幂等语义：只处理 indexStatus='processing' 的块——重复入队（如重试/
// 手动重放）时已 ready 的块跳过（天然幂等）；failed 块不自动重试（Task 1.9
// 提供重试入口语义，避免无限循环消耗）。
// 失败标记与读取同快照：失败时仅把「本次读取的 id 集合」置 failed（并带
// processing 守卫），不按 knowledgeId 误伤其他批次/并发已 ready 的块/reparse
// 后新插入的块（见 process() catch 注释）。
//
// 与 parse 的衔接：文档 status='ready'（分块完成）与块向量化完成是异步的——
// 文档 ready ≠ 全部块已嵌入；检索只查 indexStatus='ready' 的块（见
// VectorService.searchVector 注释），两者解耦互不阻塞。
// 时间线（Task 1.7 stages API）：批量路径成功追加 embed running + done 阶段
// （running 在读取待向量化块之后——无块可向量化的幂等 no-op 不污染时间线；
// done 在 upsert 实际写入 > 0 行之后——reparse 竞态下全部 UPDATE 命中 0 行
// 时不追加孤立 done 阶段，见 process() 注释），失败路径追加 embed failed 阶段
// （每次尝试都追加，与 ParseProcessor markFailed 的尝试级记录同语义——时间线
// 如实反映重试轨迹）。单块路径不触碰知识级时间线（块级操作，见
// processSingleChunk 注释）。
import { Logger, Inject } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { Knowledge } from '../knowledge/knowledge.entity.js';
import { KnowledgeProgressService } from '../knowledge/knowledge-progress.service.js';
import { EMBEDDING_SERVICE } from '../model/embedding.interface.js';
import type { EmbeddingService } from '../model/embedding.interface.js';
import { VectorService } from '../vector/vector.service.js';
import { EMBED_QUEUE } from './parse-queue.constants.js';
import type { EmbedJob } from './parse-queue.constants.js';

/** 待向量化的块行（原生 SQL 读取：embedding 列 select:false，这里显式只取
 * 需要的字段，不触碰大向量列） */
interface EmbeddableChunk {
  id: string;
  content: string;
}

@Processor(EMBED_QUEUE)
export class EmbedProcessor extends WorkerHost {
  private readonly logger = new Logger(EmbedProcessor.name);

  constructor(
    @InjectRepository(Knowledge)
    private readonly repo: Repository<Knowledge>,
    private readonly dataSource: DataSource,
    private readonly vectorService: VectorService,
    // 直接注入 EmbeddingService（批量 embed 是向量化管线的职责，VectorService
    // 只负责检索与写库，见 process() 注释）
    @Inject(EMBEDDING_SERVICE) private readonly embedding: EmbeddingService,
    // 时间线写回（Task 1.7）：embed running/done/failed 阶段追加
    private readonly progress: KnowledgeProgressService,
  ) {
    super();
  }

  /**
   * 消费 EMBED_QUEUE：按载荷分支——{ chunkId } 单块重新向量化（Task 1.9
   * 编辑/回滚），{ knowledgeId } 文档批量（Task 1.6）。
   * 失败（embed/写库异常）→ 置 failed + 抛错触发 BullMQ 重试。
   * 返回 { embedded }：已向量化块数（调试/仪表盘展示用）。
   */
  async process(job: Job<EmbedJob>): Promise<{ embedded: number }> {
    // 载荷分支（Task 1.9）：单块编辑/回滚走精确的 chunkId 路径（见文件头与
    // processSingleChunk 注释——语义与批量路径不同，不合并到同一流程）
    if ('chunkId' in job.data) {
      return this.processSingleChunk(job.data.chunkId);
    }
    const { knowledgeId } = job.data;
    const knowledge = await this.repo.findOne({ where: { id: knowledgeId } });
    if (!knowledge) {
      // 文档已删除（含 KB/文档级联清理）→ 块必然已被级联清理，无向量可写；
      // 记日志跳过（不抛错：重试只会得到同样的结果，空转浪费）
      this.logger.warn(
        `向量化任务引用的文档不存在（可能已删除），跳过: ${knowledgeId}`,
      );
      return { embedded: 0 };
    }
    // 只取待向量化块（indexStatus='processing'）：ready 幂等跳过、
    // failed 不自动重试（见文件头注释）
    const chunks = await this.dataSource.query<EmbeddableChunk[]>(
      `SELECT id, content FROM chunks
       WHERE "knowledgeId" = $1 AND "indexStatus" = 'processing'
       ORDER BY "chunkIndex" ASC`,
      [knowledgeId],
    );
    if (chunks.length === 0) {
      // 无待向量化块（空文本文档 / 已全部 ready）→ 无事可做（幂等）
      return { embedded: 0 };
    }
    // 追加 embed running 阶段（Task 1.7 时间线）：在确认有块要处理之后——
    // 幂等 no-op 不追加（running/done 在成功路径恒成对出现）
    await this.progress.updateProgress(knowledgeId, {
      stage: {
        stage: 'embed',
        status: 'running',
        at: new Date().toISOString(),
      },
    });
    try {
      // 批量向量化（分批：真实 embedding 供应商单次请求有 batch 上限——
      // 已实测 dashscope text-embedding-v4 单次 ≤10 条，156 块一次请求
      // 必然 400 失败；分批对结果无影响）
      const EMBED_BATCH = 10;
      const vectors: number[][] = [];
      let embedTokens = 0;
      for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
        const batch = chunks.slice(i, i + EMBED_BATCH);
        // 真实 token 消耗：embedWithUsage 返回供应商 usage.total_tokens
        // （dashscope/OpenAI 兼容 embed 响应带该字段）；供应商不支持时
        // totalTokens=0 → 回退字符估算
        const { vectors: v, totalTokens } = await this.embedding.embedWithUsage(
          batch.map((c) => c.content),
          (await this.knowledgeOwnerId(knowledgeId)) ?? undefined,
        );
        vectors.push(...v);
        embedTokens += totalTokens;
      }
      const { embedded } = await this.vectorService.upsertEmbeddings(
        chunks.map((c, i) => ({ chunkId: c.id, vector: vectors[i] })),
      );
      // 文档 token 消耗累计：优先真实 usage；供应商未返回时回退估算
      // （1 token ≈ 1.5 字符——中文为主文档的近似口径）
      if (embedded > 0) {
        const chars = chunks.reduce((acc, c) => acc + (c.content?.length ?? 0), 0);
        const tokens = embedTokens > 0 ? embedTokens : Math.ceil(chars / 1.5);
        await this.kbTokenCostIncr(knowledgeId, tokens);
      }
      // 追加 embed done 阶段（Task 1.7 时间线）：实际写入 > 0 行才追加——
      // 竞态语义（质量审查整改）：reparse 在飞时本批块可能已被并发「删旧建新」
      // 清掉（旧块被删、新块由新 embed job 处理），批量 UPDATE 全部命中 0 行
      // → upsertEmbeddings 返回 { embedded: 0 }，此时不追加 done 阶段：孤立
      // 的 done 阶段是时间线外观污染（running 悬挂如实反映「尝试过但无事可做」，
      // 与幂等 no-op 不追加阶段的语义一致，见 VectorService.upsertEmbeddings 注释）
      if (embedded > 0) {
        await this.progress.updateProgress(knowledgeId, {
          stage: {
            stage: 'embed',
            status: 'done',
            at: new Date().toISOString(),
          },
        });
      }
      return { embedded };
    } catch (err) {
      // 失败原因（embed/写库异常消息，落 embed failed 阶段 detail）
      const message = err instanceof Error ? err.message : String(err);
      // 失败：仅将「本次读取并尝试向量化」的 chunk id 集合置 failed——
      // 读取条件与标记条件基于同一快照（同一个查询结果集合），精确整批语义：
      // - 按 id 集合而非 knowledgeId：knowledgeId 维度会把本批之外
      //   的块一并误伤（并发 job 已 ready 的块、reparse 后新插入的块，
      //   见文件头注释）；
      // - AND "indexStatus" = 'processing' 守卫：本批中已被并发 job 置
      //   ready 的块不被降级为 failed（保留成功结果，不重复触发向量化）。
      // 与 upsertEmbeddings 的事务回滚语义一致——要么全部 ready 要么
      // 全部 failed，无部分中间态。置 failed 本身失败（DB 抖动）不掩盖
      // 原始错误：仅记日志
      await this.dataSource
        .query(
          `UPDATE chunks SET "indexStatus" = 'failed'
           WHERE id = ANY($1::uuid[]) AND "indexStatus" = 'processing'`,
          [chunks.map((c) => c.id)],
        )
        .catch(() =>
          this.logger.warn(`向量化失败状态写回失败: ${knowledgeId}`),
        );
      // 追加 embed failed 阶段（Task 1.7 时间线）：与 chunk 失败标记同快照
      // （本次尝试失败）；每次尝试都追加（与 ParseProcessor 的尝试级记录同
      // 语义，时间线如实反映重试轨迹）。写失败（DB 抖动）不掩盖原始错误
      await this.progress
        .updateProgress(knowledgeId, {
          stage: {
            stage: 'embed',
            status: 'failed',
            detail: message,
            at: new Date().toISOString(),
          },
        })
        .catch(() =>
          this.logger.warn(`向量化失败阶段写回失败: ${knowledgeId}`),
        );
      throw err;
    }
  }

  /**
   * 单块向量化（Task 1.9 编辑/回滚）：载荷 { chunkId }——编辑后该块
   * indexStatus=processing，本方法按当前内容重嵌入（EmbedProcessor 不依赖
   * ChunkService，用原生 SQL 读块，与批量路径同风格）。
   * 与批量路径的语义差异（决策，见任务书）：
   * - 读取不校验 indexStatus：单块 job 由编辑显式触发，处理的是「当前内容」
   *   ——重复 job（并发编辑/重放）重嵌入同一内容幂等（确定性向量：同内容
   *   同向量，最终收敛到最新内容，见下文「收敛」）；失败重试也依赖此语义
   *   （失败标记置 failed 后重试仍能找到该块并重嵌入，不会永久卡在 failed）
   *   ——与批量路径「只处理 processing + failed 不自动重试」的幂等守卫不同
   *   （批量 job 重放时块已 ready，读取为空自然 no-op；单块 job 无此状态
   *   判定，直接按当前内容重嵌入即可）。
   *   - 收敛性：并发编辑 A→B 产生 jobA/jobB（FIFO 串行），jobA 可能读到 B
   *   的内容（编辑 B 先提交）→ 嵌入 B 向量；jobB 再嵌 B（同向量）——无论
   *   交错如何，最后执行的 job 写入的向量 = 当前内容的向量（确定性模型下
   *   内容决定向量），终态正确。
   * - 失败标记仅该块（WHERE id=$1 + processing 守卫：并发已 ready 不降级，
   *   与批量路径同快照语义）；写失败（DB 抖动）不掩盖原始错误。
   * - 不追加知识级时间线阶段：parserStages 记录文档级流程（解析/摘要），
   *   单块编辑是块级操作，不因单块编辑改变文档时间线。
   * 块不存在（编辑后块被删除/级联清理）→ no-op（与批量路径「文档已删跳过」
   * 同语义：重试只会得到同样的结果，空转浪费）。返回 { embedded }。
   */
  private async processSingleChunk(
    chunkId: string,
  ): Promise<{ embedded: number }> {
    const rows = await this.dataSource.query<
      Array<{ id: string; content: string }>
    >(`SELECT id, content FROM chunks WHERE id = $1`, [chunkId]);
    if (rows.length === 0) {
      this.logger.warn(
        `单块向量化任务引用的分块不存在（可能已删除），跳过: ${chunkId}`,
      );
      return { embedded: 0 };
    }
    const chunk = rows[0];
    try {
      // 单块 embed（
      // 此处同样只嵌入一块，批量调用合并优化不适用）
      const [vector] = await this.embedding.embed([chunk.content]);
      // 单条 upsert（rowCount 校验：块在读取后被删则抛错 → 走失败标记 + 重试
      // → 重试时块不存在 → no-op，见 VectorService.upsertEmbedding 注释）
      await this.vectorService.upsertEmbedding(chunk.id, vector);
      return { embedded: 1 };
    } catch (err) {
      // 失败：仅将该块置 failed（带 processing 守卫，见方法头注释）后抛错
      // 触发 BullMQ 重试（attempts=2 + 指数退避，入队配置见 addQueueJob）——
      // 重试时读取无守卫仍能找到该块并重嵌入（与批量路径「failed 不自动
      // 重试」区分：编辑是用户主动操作，向量化失败不应让块永久停在 failed）
      const message = err instanceof Error ? err.message : String(err);
      await this.dataSource
        .query(
          `UPDATE chunks SET "indexStatus" = 'failed'
           WHERE id = $1 AND "indexStatus" = 'processing'`,
          [chunkId],
        )
        .catch(() =>
          this.logger.warn(`单块向量化失败状态写回失败: ${chunkId}`),
        );
      this.logger.warn(`单块向量化失败: ${chunkId} - ${message}`);
      throw err;
    }
  }

  /** 文档 token 消耗累加（知识表字段；repository.update 表达式累加，
   *  不占用 dataSource.query 调用面——与嵌入管线 SELECT 查询解耦）；
   *  失败仅日志——用量是辅助数据 */
  private async kbTokenCostIncr(knowledgeId: string, tokens: number): Promise<void> {
    if (tokens <= 0) return;
    try {
      await this.repo.update(
        { id: knowledgeId },
        { tokenCost: () => `"tokenCost" + ${tokens}` },
      );
    } catch (err) {
      this.logger.warn(`文档 token 消耗累计失败: knowledgeId=${knowledgeId}`, err as Error);
    }
  }

  /** BYOK：文档归属用户（knowledge → KB → creatorId）——向量化用用户私有
   *  embedding 模型（无则全局兜底）；查不到 → null（走全局） */
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
}
