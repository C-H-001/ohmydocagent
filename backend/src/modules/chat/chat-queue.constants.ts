// 会话/对话队列常量（Task 2.2）：TITLE_QUEUE（会话标题自动生成）+ TitleJob 载荷。
// 与 parse-queue.constants.ts 分离的决策：解析管线的常量（PARSE/EMBED/SUMMARY）
// 是文档域的内聚单元，标题生成属于对话域（chat 模块）——混装会让对话域代码
// 依赖解析域文件（跨域耦合）。「队列名集中管理」原则不变（避免字符串散落各处），
// 只是按域拆成两个文件（parse 文件头的「TITLE 也在此追加」注释已同步更新，见
// parse-queue.constants.ts）。
// 入队配置（attempts=2 + 指数退避 2s + 保留 1000）复用 parse-queue.constants 的
// addQueueJob 单点助手——新增队列入队请直接复用（见该文件注释），防 Task 2.x
// 配置漂移。
export const TITLE_QUEUE = 'title';

/** 标题生成任务载荷（Task 2.2）：只携带 sessionId——首条用户消息内容由 worker
 * 从 DB 读取（同 ParseJob 载荷最小化约定，见 parse-queue.constants.ts 注释） */
export interface TitleJob {
  sessionId: string;
}
