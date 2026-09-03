// 向量化队列共享模块（Task 1.9）：EMBED_QUEUE 的注册与导出单点。
// 背景：Task 1.6 EMBED_QUEUE 只在 ParseModule 注册（入队=ParseProcessor，
// 消费=EmbedProcessor，同模块内聚）；Task 1.9 编辑/回滚后单块重新向量化
// 的入队发生在 ChunkModule（ChunkService）——若在 ChunkModule 直接
// registerQueue 会双实例（双 Redis 连接，项目约定禁止，见 ParseModule 文件
// 头注释）；而 ChunkModule 不能 import ParseModule（ParseModule 依赖
// ChunkModule，反向会成环）。解法与 SummaryQueueModule 同模式：本模块单点
// registerQueue + 导出同一 DynamicModule 对象（imports 与 exports 共用同一
// 实例——导出 DynamicModule 时容器只把其模块类加入 exports，不会重复实例化，
// 队列仍只有一个）；ParseModule 与 ChunkModule 都 import 本模块，两侧注入
// 同一队列实例。非全局模块（与 SummaryQueueModule/RedisModule 的按需注入
// 约定一致）。
import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { EMBED_QUEUE } from './parse-queue.constants.js';

/** 同一 registerQueue DynamicModule 对象：imports 实例化 + exports 引用（见文件头注释） */
const embedQueueDynamicModule = BullModule.registerQueue({
  name: EMBED_QUEUE,
});

@Module({
  imports: [embedQueueDynamicModule],
  exports: [embedQueueDynamicModule],
})
export class EmbedQueueModule {}
