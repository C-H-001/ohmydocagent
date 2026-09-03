// 解析队列共享模块（Task 4.3）：PARSE_QUEUE 的注册与导出单点。
// 背景：PARSE_QUEUE 的入队发生在 KnowledgeModule（KnowledgeService 上传/URL 导入
// 入队），消费在 ParseModule（ParseProcessor）——Task 4.3 队列仪表盘（QueueModule）
// 需要注入同一实例做概览/列表/重试/取消。若三侧分别 registerQueue 会多实例
// （多 Redis 连接，项目约定禁止，见 ParseModule 文件头注释）；而 QueueModule 不能
// import KnowledgeModule（会把 KnowledgeModule 的整棵依赖树拖进来，且 KnowledgeModule
// 未导出队列）。解法与 EmbedQueueModule/SummaryQueueModule 同模式：本模块单点
// registerQueue + 导出同一 DynamicModule 对象（imports 与 exports 共用同一实例——
// 导出 DynamicModule 时容器只把其模块类加入 exports，不会重复实例化，队列仍只有
// 一个）；KnowledgeModule 与 QueueModule 都 import 本模块，两侧注入同一队列实例。
// 非全局模块（与 SummaryQueueModule/RedisModule 的按需注入约定一致）。
import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { PARSE_QUEUE } from './parse-queue.constants.js';

/** 同一 registerQueue DynamicModule 对象：imports 实例化 + exports 引用（见文件头注释） */
const parseQueueDynamicModule = BullModule.registerQueue({
  name: PARSE_QUEUE,
});

@Module({
  imports: [parseQueueDynamicModule],
  exports: [parseQueueDynamicModule],
})
export class ParseQueueModule {}
