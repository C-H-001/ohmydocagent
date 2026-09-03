// 图谱抽取任务队列常量（Task 3.2）：队列名集中管理——避免字符串散落各处。
// GRAPH_QUEUE 的入队发生在 ParseModule（ParseProcessor 分块成功后按 KB
// extractConfig 入队），消费在 GraphModule（ExtractProcessor）；队列实例由
// GraphQueueModule 单点注册/导出（同 SummaryQueueModule 的「两侧注入同一实例」
// 模式，避免双队列实例/双 Redis 连接，见 graph-queue.module.ts 注释）。
export const GRAPH_QUEUE = 'graph';

/** 图谱抽取任务载荷：只携带 knowledgeId——知识/分块/开关等字段由 worker 从
 * DB 读取（同 ParseJob 载荷最小化约定，见 parse-queue.constants.ts 注释） */
export interface GraphJob {
  knowledgeId: string;
}
