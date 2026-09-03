// 图谱抽取队列处理器（Task 3.2）：消费 GRAPH_QUEUE，载荷 { knowledgeId }。
// 流程：加载 knowledge（404 → 记日志跳过，与 ParseProcessor 的 404 抛错重试
// 区分——图谱是非关键路径：文档已删除时重试无意义，且图谱缺失不影响文档
// 可用性，故不写失败状态）→ 取 parsedText（空/null → no-op 跳过）→ 读 KB
// extractConfig（KB 缺失 → no-op；enabled=false → no-op——消费侧 KB 级开关
// 双保险，入队侧 ParseProcessor 已拦一道）→ 读 chunks（空 → no-op，文档删除
// 竞态后的中间态）→ 存在性复查（chunks 读取期间文档被删 → no-op，Task 3.2
// 质量审查整改）→ 追加 graph running 阶段 → 读图谱既有实体集合（跨文档关系
// 端点判定）→ 并行抽取（GraphExtractionService.extractAll，并发 4）→ 清理
// 该文档旧子图（deleteKnowledgeSubgraph——reparse 幂等：实体/边保留、旧 chunk
// 关联/镜像剔除，防陈旧 chunkIds 累积）→ 单事务批量写入（upsertDocumentGraphInTx）
// → 追加 graph done 阶段。
//
// 失败语义（Task 3.2 质量审查整改）：单 chunk 抽取失败在 extractAll 内隔离
// （记日志含 chunkId 跳过，其余照常写图——1/50 chunk 失败不整批重跑）；全部
// chunk 失败 → extractAll 抛错 → 本处理器 catch 后抛错触发 BullMQ 重试
// （attempts=2 + 指数退避 2s 起，入队时配置，见 ParseProcessor enqueueGraph 与
// parse-queue.constants.ts addQueueJob）——首次失败 BullMQ 重试一次，重试耗尽后
// job 进 failed 状态；全程仅记日志，不写 status=failed、不追加 graph failed
// 阶段（决策：图谱缺失 ≠ 文档失败——文档已 ready 可用，stages 时间线不应出现
// 误导性的 failed 状态；图谱缺失可由 reparse 触发重建，或接真实模型后成功率
// 提升自然收敛）。与 SummaryProcessor 同语义（见 summary.processor.ts 文件头注释）。
import { Injectable, Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Chunk } from '../chunk/chunk.entity.js';
import { KnowledgeBase } from '../kb/kb.entity.js';
import { Knowledge } from '../knowledge/knowledge.entity.js';
import { KnowledgeProgressService } from '../knowledge/knowledge-progress.service.js';
import { GRAPH_QUEUE } from './graph-queue.constants.js';
import type { GraphJob } from './graph-queue.constants.js';
import { GraphExtractionService } from './graph-extraction.service.js';
import { GraphRepository } from './graph.repository.js';

@Processor(GRAPH_QUEUE)
@Injectable()
export class ExtractProcessor extends WorkerHost {
  private readonly logger = new Logger(ExtractProcessor.name);

  constructor(
    @InjectRepository(Knowledge)
    private readonly repo: Repository<Knowledge>,
    @InjectRepository(KnowledgeBase)
    private readonly kbRepository: Repository<KnowledgeBase>,
    @InjectRepository(Chunk)
    private readonly chunkRepository: Repository<Chunk>,
    private readonly progress: KnowledgeProgressService,
    private readonly extraction: GraphExtractionService,
    private readonly graph: GraphRepository,
  ) {
    super();
  }

  /**
   * 消费 GRAPH_QUEUE：存在性/可用性/开关/分块四道 no-op 前置检查 →
   * graph running 阶段 → 并行抽取 → 清理旧子图 → 批量写入 → graph done 阶段。
   * 返回 { extracted }：是否实际完成抽取（调试/仪表盘展示用）。
   * 失败抛错触发 BullMQ 重试（attempts=2 + backoff 由入队配置决定）；
   * 重试耗尽后仅记日志（见文件头注释——图谱非关键路径，不写失败状态）。
   */
  async process(job: Job<GraphJob>): Promise<{ extracted: boolean }> {
    const { knowledgeId } = job.data;
    // 文档已删除（含 KB/文档级联清理）→ 图谱无处可写；记日志跳过不抛错
    // （与 SummaryProcessor 的删除跳过同一语义：重试只会空转）
    const knowledge = await this.repo.findOne({ where: { id: knowledgeId } });
    if (!knowledge) {
      this.logger.warn(
        `图谱抽取任务引用的文档不存在（可能已删除），跳过: ${knowledgeId}`,
      );
      return { extracted: false };
    }
    // 空文本（图片占位返回 ''）或无文本（异常中间态）→ no-op：
    // 没有可抽取的内容（与 ParseProcessor「分块成功才入队」双保险）
    if (!knowledge.parsedText) {
      return { extracted: false };
    }
    // KB 缺失（被并发删除）→ no-op（图谱按 KB 隔离，无 KB 无图）
    const kb = await this.kbRepository.findOne({
      where: { id: knowledge.kbId },
    });
    if (!kb) {
      return { extracted: false };
    }
    // 消费侧 KB 级开关双保险：extractConfig.enabled=false → 不入队不建图
    // （入队侧 ParseProcessor 已拦一道；这里兜底直连/遗留 job，见文件头注释）
    const extractConfig = kb.extractConfig as { enabled?: boolean } | undefined;
    if (extractConfig?.enabled === false) {
      return { extracted: false };
    }
    // chunks 为空（文档删除竞态后的中间态）→ no-op：无分块可抽取
    const chunks = await this.chunkRepository.find({
      where: { knowledgeId },
      select: { id: true, content: true },
      order: { chunkIndex: 'ASC' },
    });
    if (chunks.length === 0) {
      return { extracted: false };
    }
    // 存在性复查（Task 3.2 质量审查整改，轻量校验）：chunks 读取期间文档被
    // 删除（remove 事务提交 → 图谱子图已清理）时，继续写入会把镜像/关联
    // 复活成已删文档的残留——读后再查一次 knowledge 行。残留竞态窗口缩小
    // 到「复查通过 → 写入完成」之间（毫秒级，低概率；图谱非关键路径，不
    // 引入 FOR UPDATE 长事务——写 Neo4j 与 PG 行锁本就无法原子，代价不划算，
    // 且残留可由后续文档删除/KB 删除的清理兜底）
    const alive = await this.repo.findOne({
      where: { id: knowledgeId },
      select: { id: true },
    });
    if (!alive) {
      this.logger.warn(
        `图谱抽取任务引用的文档在分块读取后被删除，跳过: ${knowledgeId}`,
      );
      return { extracted: false };
    }
    try {
      // 追加 graph running 阶段（抽取调用前）：时间线反映「图谱抽取进行中」；
      // 失败时此处已写入的 running 保持悬挂（决策：不写 failed 阶段，见文件头）
      await this.markGraphStage(knowledgeId, 'running');
      // 图谱既有实体集合（跨文档关系端点判定，Task 3.2 质量审查整改）：
      // 历史文档抽取过的实体可在本文档的关系里引用（保留合法跨文档边），
      // 见 graph-extraction.service.ts extractAll 注释
      const existingEntityNames = await this.graph.listEntityNames(
        knowledge.kbId,
      );
      // 并行抽取（并发 4，Promise pool 见 graph-extraction.service.ts）：
      // 传 chunk id + content（content 为当前内容——编辑后取编辑内容）；
      // 单 chunk 失败在 extractAll 内隔离（记日志跳过，其余照常写图），
      // 全部失败才抛错触发重试
      const agg = await this.extraction.extractAll(
        chunks.map((c) => ({ id: c.id, content: c.content })),
        existingEntityNames,
        knowledgeId,
      );
      // reparse 幂等：写入前清理该文档旧 chunk 关联/镜像（实体/边保留——
      // 图谱是跨文档聚合结构，见 graph.repository.ts deleteKnowledgeSubgraph
      // 注释），再单事务批量写（实体×N + 边×M + chunk 镜像×K，全成功或全回滚）
      await this.graph.deleteKnowledgeSubgraph(knowledge.kbId, knowledgeId);
      await this.graph.upsertDocumentGraphInTx(
        knowledge.kbId,
        knowledgeId,
        agg,
      );
      // 抽取完成：追加 graph done 阶段
      await this.markGraphStage(knowledgeId, 'done');
      return { extracted: true };
    } catch (err) {
      // 失败：仅记日志并抛错触发重试（attempts=2 + backoff 2s 由入队配置）。
      // 重试耗尽后 job 进 failed——不写 status=failed（文档本身可用），
      // 不追加 graph failed 阶段（时间线不误伤，见文件头决策注释）
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `图谱抽取失败（将按 backoff 重试，重试耗尽仅记日志）: ` +
          `${knowledgeId} - ${message}`,
      );
      throw err;
    }
  }

  /**
   * 追加 graph 阶段（running/done）。
   * 阶段对象携带 at 时间戳（Task 3.2 质量审查整改）：与 extract/chunk/summary
   * 等阶段形态一致（ParserStage 类型定义 at 为必填，此前用 as unknown as
   * 绕过类型检查——缺 at 与其它阶段不一致，且绕过让类型约束失效）；
   * updateProgress 的 SQL 拼接只消费 stage/status 字段，时间字段供 stages
   * API 时间线展示。
   */
  private async markGraphStage(
    knowledgeId: string,
    status: 'running' | 'done',
  ): Promise<void> {
    await this.progress.updateProgress(knowledgeId, {
      stage: { stage: 'graph', status, at: new Date().toISOString() },
    });
  }
}
