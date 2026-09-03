// 自动摘要队列处理器（Task 1.7）：消费 SUMMARY_QUEUE，载荷 { knowledgeId }。
// 流程：加载 knowledge（404 → 记日志跳过，与 ParseProcessor 的 404 抛错重试
// 区分——摘要是非关键路径：文档已删除时重试无意义，且摘要缺失不影响文档
// 可用性，故不写失败状态）→ 取 parsedText（空/null → no-op 跳过）→
// chatModel.chat([system 提示 + user 正文截断 8000 字符]) → 保存 summary +
// 追加 summary done 阶段（同一条 UPDATE 原子写，见 progress.updateProgress）→
// 成功追加 running 阶段（在 chat 调用前，时间线反映「摘要进行中」）。
//
// 失败语义：attempts=2 + 指数退避（2s 起，入队时配置，见 ParseProcessor
// enqueueSummary 与 KnowledgeService enqueueSummary）——首次失败 BullMQ 重试
// 一次，重试耗尽后 job 进 failed 状态；全程仅记日志，不写 status=failed、
// 不追加 summary failed 阶段（决策：摘要失败 ≠ 文档失败——文档已 ready 可用，
// stages 时间线不应出现误导性的 failed 状态；缺失摘要可由 regenerate-summary
// 手动重生成，或 Task 2.3 接真实模型后自动重试）。
//
// 截断保护：parsedText 可能远大于 LLM 上下文窗口（大文档解析全文），
// slice(0, 8000) 取文档开头摘要（真实模型接入后按需改分块摘要/引用策略）。
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Repository } from 'typeorm';
import { Knowledge } from '../knowledge/knowledge.entity.js';
import { KnowledgeProgressService } from '../knowledge/knowledge-progress.service.js';
import { CHAT_MODEL_SERVICE } from '../model/chat-model.interface.js';
import type { ChatModelService } from '../model/chat-model.interface.js';
import { SUMMARY_QUEUE } from './parse-queue.constants.js';
import type { SummaryJob } from './parse-queue.constants.js';

/** 摘要输入正文截断上限（字符）：LLM 上下文窗口保护——大文档只取开头摘要 */
const SUMMARY_INPUT_LIMIT = 8000;

/** 摘要系统提示（固定中文：直接输出中文摘要） */
const SUMMARY_SYSTEM_PROMPT =
  '请用 3-5 句话总结以下文档内容，直接输出中文摘要。';

@Processor(SUMMARY_QUEUE)
@Injectable()
export class SummaryProcessor extends WorkerHost {
  private readonly logger = new Logger(SummaryProcessor.name);

  constructor(
    @InjectRepository(Knowledge)
    private readonly repo: Repository<Knowledge>,
    private readonly progress: KnowledgeProgressService,
    private readonly dataSource: DataSource,
    // 直接注入 ChatModelService（LLM 对话是摘要管线的职责；Task 2.3 换真实
    // 实现时改 ModelModule 的 useClass，本处理器零改动）
    @Inject(CHAT_MODEL_SERVICE) private readonly chatModel: ChatModelService,
  ) {
    super();
  }

  /**
   * 消费 SUMMARY_QUEUE：文档存在性 → 正文可用性 → 调 LLM 生成 → 落库。
   * 返回 { summarized }：是否实际生成了摘要（调试/仪表盘展示用）。
   * 失败抛错触发 BullMQ 重试（attempts=2 + backoff 由入队配置决定）；
   * 重试耗尽后仅记日志（见文件头注释——摘要非关键路径，不写失败状态）。
   */
  async process(job: Job<SummaryJob>): Promise<{ summarized: boolean }> {
    const { knowledgeId } = job.data;
    const knowledge = await this.repo.findOne({ where: { id: knowledgeId } });
    if (!knowledge) {
      // 文档已删除（含 KB/文档级联清理）→ 摘要无处可写；记日志跳过不抛错
      // （与 EmbedProcessor 的删除跳过同一语义：重试只会空转）
      this.logger.warn(
        `摘要任务引用的文档不存在（可能已删除），跳过: ${knowledgeId}`,
      );
      return { summarized: false };
    }
    // 空文本（图片占位返回 ''）或无文本（异常中间态）→ no-op：
    // 没有可总结的内容（与 ParseProcessor「有 parsedText 才入队」双保险）
    if (!knowledge.parsedText) {
      return { summarized: false };
    }
    try {
      // 追加 summary running 阶段（chat 调用前）：时间线反映「摘要进行中」；
      // 失败时此处已写入的 running 保持悬挂（决策：不写 failed 阶段，见文件头）
      await this.progress.updateProgress(knowledgeId, {
        stage: {
          stage: 'summary',
          status: 'running',
          at: new Date().toISOString(),
        },
      });
      // 截断保护（见文件头注释）：LLM 上下文窗口兜底
      const text = knowledge.parsedText.slice(0, SUMMARY_INPUT_LIMIT);
      // BYOK：按文档归属（KB creatorId）取用户默认对话模型——worker 无
      // 请求上下文，必须显式传 userId（getDefault 无 userId 返回 null 会 503，
      // 导致 running 阶段悬挂在“进度中”，见 embed.processor 同款 knowledgeOwnerId）
      const ownerId = await this.knowledgeOwnerId(knowledgeId);
      const summary = await this.chatModel.chat(
        [
          { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
          { role: 'user', content: text },
        ],
        undefined,
        ownerId ?? undefined,
      );
      // 保存 summary + 追加 done 阶段：单条 UPDATE 原子写（与分块管线的
      // status+stage 合并写同模式——不会出现「摘要已写但阶段缺失」的中间态）
      await this.progress.updateProgress(knowledgeId, {
        summary,
        stage: {
          stage: 'summary',
          status: 'done',
          at: new Date().toISOString(),
        },
      });
      // 文档 token 消耗累计（摘要：输入正文 + 输出摘要，估算 1 token ≈ 1.5 字符）
      try {
        const chars = SUMMARY_SYSTEM_PROMPT.length + text.length + summary.length;
        await this.dataSource.query(
          `UPDATE knowledge SET "tokenCost" = "tokenCost" + $1 WHERE id = $2`,
          [Math.ceil(chars / 1.5), knowledgeId],
        );
      } catch (err) {
        this.logger.warn(`摘要 token 累计失败: knowledgeId=${knowledgeId}`, err as Error);
      }
      return { summarized: true };
    } catch (err) {
      // 失败：仅记日志并抛错触发重试（attempts=2 + backoff 2s 由入队配置）。
      // 重试耗尽后 job 进 failed——不写 status=failed（文档本身可用），
      // 不追加 summary failed 阶段（时间线不误伤，见文件头决策注释）
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `摘要生成失败（将按 backoff 重试，重试耗尽仅记日志）: ` +
          `${knowledgeId} - ${message}`,
      );
      throw err;
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
}
