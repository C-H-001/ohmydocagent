// 解析/向量化任务队列常量（Task 1.4 + Task 1.6 + Task 1.7）：队列名集中管理——
// 避免字符串散落各处。会话/对话域队列（TITLE 等）按 Task 2.2 决策独立于
// chat-queue.constants.ts（解析与对话分属不同域，各自内聚，避免跨域耦合）。
import type { Job, Queue } from 'bullmq';
export const PARSE_QUEUE = 'parse';

/** 向量化队列（Task 1.6）：分块落库后入队，EmbedProcessor 消费 */
export const EMBED_QUEUE = 'embed';

/** 自动摘要队列（Task 1.7）：分块成功后入队，SummaryProcessor 消费
 * （见 summary.processor.ts） */
export const SUMMARY_QUEUE = 'summary';

/** 解析任务载荷：只携带 knowledgeId，解析所需字段（fileType/filePath/url/manualContent）
 * 由 worker 从 DB 读取（载荷最小化，避免 payload 携带大字段） */
export interface ParseJob {
  knowledgeId: string;
}

/** 向量化任务载荷（Task 1.6 + Task 1.9）：两种语义并存，EmbedProcessor 按
 * 载荷分支（见 embed.processor.ts process()）：
 * - { knowledgeId }：一个文档的全部块批量向量化（解析/重新解析后入队，
 *   逐块入队会为每块建一个 job，量级大且无必要；批量减少队列条目，见
 *   parse.processor.ts enqueueEmbed 注释）；
 * - { chunkId }：单块重新向量化（Task 1.9 编辑/回滚后入队——编辑场景块少，
 *   显式 chunkId 载荷语义自明，不依赖「编辑后无其他 processing 块」的隐式
 *   前提，见 ChunkService.enqueueSingleEmbed 注释） */
export type EmbedJob = { knowledgeId: string } | { chunkId: string };

/** 摘要任务载荷（Task 1.7）：只携带 knowledgeId——正文由 worker 从 DB 读取
 * （同 ParseJob 载荷最小化约定，见文件头注释） */
export interface SummaryJob {
  knowledgeId: string;
}

/** 队列任务公共入队配置（单点维护，防 Task 2.x 漂移）：attempts=2（失败自动
 * 重试一次）+ 指数退避（2s 起逐次翻倍，错峰重试：瞬时故障下多个失败 job 同时
 * 重试会打爆依赖）+ 保留最近 1000 条完成/失败记录（供 P4.3 仪表盘排查）。
 * 五处入队共用同一配置（KnowledgeService enqueueParse/enqueueSummary、
 * ParseProcessor enqueueEmbed/enqueueSummary、MessageService enqueueTitle）——
 * 质量审查整改：此前各入队点
 * 内联同一对象，Task 2.x 新增队列（TITLE/GRAPH 等）时易配置漂移，统一收敛
 * 到本助手；新增队列入队请直接复用，入队失败处理（catch 记日志不阻断）仍由
 * 各调用方决定（知识服务/解析处理器的非关键路径约定，见各 enqueue 注释）。 */
export function addQueueJob<JobType>(
  queue: Queue<any>,
  queueName: string,
  data: JobType,
): Promise<Job<JobType>> {
  return queue.add(queueName, data, {
    attempts: 2,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 1000 },
  });
}
