// 消息创建服务（Task 2.2）：对话管线的统一消息写入入口——创建用户消息 + 首条
// 用户消息触发会话标题自动生成（TITLE_QUEUE，消费方见 title.processor.ts）。
// - HTTP 对话发送端点（流式输出）在 Task 2.4/2.5 实现，届时对话管线直接调用
//   本服务（本任务无 HTTP 端点，e2e 通过 app.get(MessageService) 直调验证，
//   见 test/title.e2e-spec.ts 文件头注释）。
// - 内容校验（TODO Task 2.5，质量审查整改登记）：HTTP 端点实现时对 content
//   加 class-validator 校验（@MinLength(1) 非空 + 长度上限，如 @MaxLength(4000)
//   对齐前端输入框限制）——本服务方法层目前依赖调用方传参（e2e/对话管线
//   直调），端点层校验防脏数据落库；TITLE_INPUT_MAX_LENGTH（title.processor）
//   只是 LLM 输入防御，不替代入参校验。
// - 事务边界：会话归属校验（404/403 + 22P02 兜底 404，与 SessionService
//   getOwnedSession 同一语义）→ 首条用户消息判定（count role=user）→ 创建
//   user 消息，同一 dataSource.transaction——首条判定与创建原子化：并发双
//   首条（两个请求同时 count=0）会双入队双生成标题。UI 单次发送不会并发
//   （且双入队的最坏结果是标题被生成两次后第二次覆盖，最终一致），注释说明
//   不额外加锁；若要彻底串行化可对会话行 SELECT ... FOR UPDATE，当前场景
//   过度设计不引入。
// - 入队在事务提交后（fire-and-forget）：提交成功才入队，保证 TitleProcessor
//   读得到消息（事务未提交读不到）；入队失败仅记日志（标题缺失不影响会话
//   可用，非关键路径，见 title.processor.ts 文件头注释）。
// - 实体访问：createUserMessage 经 EntityManager 走事务（事务内查询/创建
//   原子化）；createAssistantMessage（Task 2.4 新增）是单条插入、无跨表
//   原子性需求——注入 Message 仓库走普通 save（不引入事务；注释说明例外，
//   避免「事务外无实体访问」原则被误读为所有写入都必须在事务里）。
import { InjectQueue } from '@nestjs/bullmq';
import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Queue } from 'bullmq';
import { DataSource, FindOptionsWhere, Not, Repository } from 'typeorm';
import { addQueueJob } from '../parse/parse-queue.constants.js';
import { TITLE_QUEUE } from './chat-queue.constants.js';
import type { TitleJob } from './chat-queue.constants.js';
import { Message } from './message.entity.js';
import { Session } from './session.entity.js';
import type { RagReference } from './pipeline/rag.types.js';

@Injectable()
export class MessageService {
  private readonly logger = new Logger(MessageService.name);

  constructor(
    // 事务（归属校验 + 首条判定 + 创建原子化，见文件头注释）
    private readonly dataSource: DataSource,
    // 标题生成队列：首条用户消息入队（TITLE_QUEUE 由 TitleQueueModule 单点注册，
    // 入队侧与消费侧注入同一实例，见 title-queue.module.ts 注释）
    @InjectQueue(TITLE_QUEUE) private readonly titleQueue: Queue<TitleJob>,
    // assistant 消息单条插入用（Task 2.4，见文件头「实体访问」注释）
    @InjectRepository(Message)
    private readonly messageRepository: Repository<Message>,
  ) {}

  /**
   * 创建用户消息（对话管线统一入口，Task 2.5 流式对话复用）：
   * 事务内归属校验 → 首条用户消息判定 → 创建 user 消息；事务提交后若为
   * 首条用户消息则入队标题生成（见文件头注释：判定与创建同事务、入队在提交后）。
   * 失败语义：会话不存在/非 UUID → 404，他人会话 → 403（与 SessionService
   * 归属语义一致）；入队失败仅记日志不阻断消息创建。
   */
  async createUserMessage(
    sessionId: string,
    content: string,
    userId: string,
  ): Promise<Message> {
    let firstUserMessage = false;
    const message = await this.dataSource.transaction(async (manager) => {
      // 归属校验：先查会话（非 UUID 格式 id 撞 PG 22P02 同样视为不存在，404，
      // 不泄露内部错误——与 SessionService.getOwnedSession 同模式）
      let session: Session | null;
      try {
        session = await manager.findOne(Session, { where: { id: sessionId } });
      } catch (err) {
        if (
          (err as { driverError?: { code?: string } })?.driverError?.code ===
          '22P02'
        ) {
          throw new NotFoundException('会话不存在');
        }
        throw err;
      }
      if (!session) {
        throw new NotFoundException('会话不存在');
      }
      // 单用户归属：会话属于他人 → 403（P4 共享机制启用前无共享写语义）
      if (session.userId !== userId) {
        throw new ForbiddenException('无权访问该会话');
      }
      // 首条用户消息判定（与创建同一事务，防并发双首条双入队，见文件头注释）
      const userMessageCount = await manager.count(Message, {
        where: { sessionId, role: 'user' },
      });
      firstUserMessage = userMessageCount === 0;
      const created = manager.create(Message, {
        sessionId,
        role: 'user',
        content,
      });
      return manager.save(Message, created);
    });
    // 入队在事务提交后：首条用户消息 → 入队标题生成（fire-and-forget——
    // 标题缺失不影响会话可用；入队配置统一走 addQueueJob 单点，attempts=2 +
    // 指数退避 2s，见 parse-queue.constants.ts 注释）
    if (firstUserMessage) {
      this.enqueueTitle(sessionId);
    }
    return message;
  }

  /**
   * 创建 assistant 消息（Task 2.4 对话管线生成完成后的统一落库入口）：
   * 单条插入（content 为 delta 累积全文；reasoning 为 Task 2.8 深度思考内容，
   * 未输出时 null）。无归属校验——assistant 消息只由编排器在 createUserMessage
   * 校验通过后生成；不触发标题生成（标题只由首条 user 消息触发，见文件头注释）。
   * references（Task 2.5 RAG 引用）：管线 merge 产物随 assistant 落库
   * （[n] 编号/标题/内容/score，见 rag.types.ts），供前端引用展示（Task 2.6）；
   * 非 RAG 路径为空数组。
   * interrupted（Task 2.10）：生成被中断（stop/断连）→ true（前端展示「已
   * 停止」）；正常完成缺省 false。
   */
  async createAssistantMessage(
    sessionId: string,
    content: string,
    options?: {
      reasoning?: string | null;
      references?: RagReference[];
      interrupted?: boolean;
      usage?: { inputTokens?: number; outputTokens?: number; cacheHitTokens?: number } | null;
    },
  ): Promise<Message> {
    const message = this.messageRepository.create({
      sessionId,
      role: 'assistant',
      content,
      reasoning: options?.reasoning ?? null,
      references: options?.references ?? [],
      interrupted: options?.interrupted ?? false,
      usage: options?.usage ?? null,
    });
    return this.messageRepository.save(message);
  }

  /**
   * 加载最近 N 条消息（Task 2.5 RAG 管线历史上下文用）：按 createdAt DESC +
   * id DESC 取最近 limit 条（id 决胜键保证同秒消息排序稳定），反转回时间升序
   * （对话自然时序）。excludeId 可选排除某条（RAG 管线排除当前用户消息——
   * 编排器先落库当前消息再进管线，见 rag-pipeline.service.ts 注释）。
   * 返回空数组当会话无消息（不抛错）。
   */
  async listRecentMessages(
    sessionId: string,
    limit: number,
    excludeId?: string,
  ): Promise<Message[]> {
    const where: FindOptionsWhere<Message> = { sessionId };
    if (excludeId) {
      where.id = Not(excludeId);
    }
    const rows = await this.messageRepository.find({
      where,
      order: { createdAt: 'DESC', id: 'DESC' },
      take: limit,
    });
    return rows.reverse();
  }

  /** 入队标题生成任务：载荷只带 sessionId（首条消息内容由 worker 从 DB 读取）。
   * 不用 jobId: sessionId 去重：与 enqueueEmbed/enqueueSummary 的评估结论一致
   * （见 parse.processor.ts 注释）——同 jobId 去重会吞掉后续 job（completed job
   * 的 key 在清理前一直存在）；首条判定在事务内已保证每会话最多入队一次，
   * 不需要去重。 */
  private enqueueTitle(sessionId: string): void {
    addQueueJob(this.titleQueue, TITLE_QUEUE, {
      sessionId,
    } satisfies TitleJob).catch((err: unknown) => {
      this.logger.warn(`标题生成任务入队失败: ${sessionId}`, err as Error);
    });
  }
}
