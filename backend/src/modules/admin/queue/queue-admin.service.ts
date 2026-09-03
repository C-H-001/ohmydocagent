// 队列仪表盘服务（Task 4.3）：管理员查看五条任务队列（parse/embed/summary/
// title/graph）的概览、任务列表（按状态筛选 + 内存分页）、任务详情（payload/
// progress/result/failedReason）与重试/取消操作。
// 队列实例来源：五条队列均由各自单点模块注册/导出（ParseQueueModule/
// EmbedQueueModule/SummaryQueueModule/TitleQueueModule/GraphQueueModule），
// 本服务 import 这些模块注入同一实例——避免同一队列双实例（双 Redis 连接，
// 项目约定禁止，见 parse-queue.module.ts 注释）。
// 依赖 BullMQ 原生 API：getJobCounts（概览）、getJobs（列表，支持 start/end
// 偏移即天然分页）、getJob（详情）、Job.retry/remove（重试/取消）。所有操作
// 只读/仅作用于单任务，不做入队（入队职责仍归各业务服务）。
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import type { JobState } from 'bullmq';
import { GRAPH_QUEUE } from '../../graph/graph-queue.constants.js';
import { TITLE_QUEUE } from '../../chat/chat-queue.constants.js';
import {
  EMBED_QUEUE,
  PARSE_QUEUE,
  SUMMARY_QUEUE,
} from '../../parse/parse-queue.constants.js';

/** 仪表盘可见队列名（集中声明，扩展新队列时在此追加） */
export const ADMIN_QUEUES = [
  PARSE_QUEUE,
  EMBED_QUEUE,
  SUMMARY_QUEUE,
  TITLE_QUEUE,
  GRAPH_QUEUE,
] as const;

/** 任务状态枚举（BullMQ JobState 全集——注意无 'paused'：那是队列级状态；
 * 列表筛选/计数按任务状态划分，见 queue-getters getJobs 注释） */
export const QUEUE_JOB_STATES: QueueJobState[] = [
  'waiting',
  'active',
  'completed',
  'failed',
  'delayed',
  'prioritized',
  'waiting-children',
];
export type QueueJobState = JobState;

/** 任务列表项（脱敏视图：只暴露运维排查字段，不含敏感业务载荷的展开） */
export interface QueueJobView {
  id: string;
  name: string;
  data: unknown;
  state: QueueJobState;
  progress: unknown;
  attemptsMade: number;
  timestamp: number;
  processedOn: number | null;
  finishedOn: number | null;
  failedReason?: string | null;
  returnvalue: unknown;
}

@Injectable()
export class QueueAdminService {
  private readonly queues: Array<{ name: string; queue: Queue }>;

  constructor(
    @InjectQueue(PARSE_QUEUE) private readonly parseQueue: Queue,
    @InjectQueue(EMBED_QUEUE) private readonly embedQueue: Queue,
    @InjectQueue(SUMMARY_QUEUE) private readonly summaryQueue: Queue,
    @InjectQueue(TITLE_QUEUE) private readonly titleQueue: Queue,
    @InjectQueue(GRAPH_QUEUE) private readonly graphQueue: Queue,
  ) {
    // 注入顺序与 ADMIN_QUEUES 一致（下标对应，见 getQueue）
    this.queues = [
      { name: PARSE_QUEUE, queue: parseQueue },
      { name: EMBED_QUEUE, queue: embedQueue },
      { name: SUMMARY_QUEUE, queue: summaryQueue },
      { name: TITLE_QUEUE, queue: titleQueue },
      { name: GRAPH_QUEUE, queue: graphQueue },
    ];
  }

  /** 按名取队列实例：未知队列名 → 404（列表接口先校验，避免裸 Redis key 误探） */
  getQueue(name: string): Queue {
    const found = this.queues.find((q) => q.name === name);
    if (!found) {
      throw new NotFoundException(`未知队列: ${name}`);
    }
    return found.queue;
  }

  /** 五队列概览：getJobCounts 一次返回各状态计数（BullMQ 原生聚合） */
  async overview(): Promise<
    Array<{ name: string; counts: Record<string, number> }>
  > {
    const result = [];
    for (const { name, queue } of this.queues) {
      const counts = await queue.getJobCounts();
      result.push({ name, counts });
    }
    return result;
  }

  /**
   * 任务列表：按状态筛选（缺省全部可见状态）+ 内存分页（getJobs 的
   * start/end 偏移即分页，顺序 new→old；总数为各筛选状态计数之和——
   * 状态集合与筛选一致，见 QUEUE_JOB_STATES 注释）。
   */
  async jobs(
    name: string,
    state?: QueueJobState,
    page = 1,
    pageSize = 10,
  ): Promise<{
    items: QueueJobView[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    const queue = this.getQueue(name);
    const states: QueueJobState[] = state ? [state] : [...QUEUE_JOB_STATES];
    const start = (page - 1) * pageSize;
    const jobs = await queue.getJobs(
      states,
      start,
      start + pageSize - 1,
      false,
    );
    const counts = await queue.getJobCounts(...states);
    const total = states.reduce((sum, s) => sum + (counts[s] ?? 0), 0);
    const items = await Promise.all(jobs.map((j) => this.toView(j)));
    return { items, total, page, pageSize };
  }

  /** 任务详情：不存在 → 404；含 payload/progress/result/failedReason */
  async jobDetail(name: string, id: string): Promise<QueueJobView> {
    const queue = this.getQueue(name);
    const job = await queue.getJob(id);
    if (!job) {
      throw new NotFoundException('任务不存在');
    }
    return this.toView(job);
  }

  /**
   * 重试失败任务：Job.retry() 把失败任务重新放回等待队列（attemptsMade 重置）。
   * 仅失败/延迟任务可重试；已完成/等待中的任务 BullMQ 拒绝 → 统一 400
   * （不暴露底层错误细节）。
   */
  async retry(name: string, id: string): Promise<{ retried: boolean }> {
    const queue = this.getQueue(name);
    const job = await queue.getJob(id);
    if (!job) {
      throw new NotFoundException('任务不存在');
    }
    try {
      await job.retry();
    } catch {
      throw new BadRequestException('任务不可重试（仅失败任务可重试）');
    }
    return { retried: true };
  }

  /** 取消（移除）任务：等待/延迟中的任务直接从队列移除；失败/完成的任务也一并清理 */
  async cancel(name: string, id: string): Promise<{ canceled: boolean }> {
    const queue = this.getQueue(name);
    const job = await queue.getJob(id);
    if (!job) {
      throw new NotFoundException('任务不存在');
    }
    await job.remove();
    return { canceled: true };
  }

  /** Job → 运维视图：state 为异步查询（一次 Promise.all 收敛，避免 N+1 串行） */
  private async toView(job: Job): Promise<QueueJobView> {
    const state = (await job.getState()) as QueueJobState;
    return {
      id: job.id as string,
      name: job.name,
      data: job.data,
      state,
      progress: job.progress,
      attemptsMade: job.attemptsMade,
      timestamp: job.timestamp,
      processedOn: job.processedOn ?? null,
      finishedOn: job.finishedOn ?? null,
      failedReason: job.failedReason,
      returnvalue: job.returnvalue,
    };
  }
}
