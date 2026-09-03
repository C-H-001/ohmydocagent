// 标题生成队列共享模块（Task 2.2）：TITLE_QUEUE 的注册与导出单点。
// 背景：TITLE_QUEUE 的入队（MessageService）与消费（TitleProcessor）都在
// ChatModule 内——为什么仍要独立模块？单点注册约定（EmbedQueueModule/
// SummaryQueueModule 同模式，见 summary-queue.module.ts 注释）：队列实例只在一
// 处 registerQueue，入队侧与消费侧注入同一实例。本任务内聚在 ChatModule 时
// 单点即模块内；Task 2.5 对话管线若在其他模块入队（流式对话等），import 本
// 模块即可复用同一实例，避免双队列实例（双 Redis 连接，项目约定明确禁止）。
// 非全局模块（与 RedisModule/Neo4jModule 的按需注入约定一致，不引入隐式全局依赖）。
import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { TITLE_QUEUE } from './chat-queue.constants.js';

/** 同一 registerQueue DynamicModule 对象：imports 实例化 + exports 引用（见文件头注释） */
const titleQueueDynamicModule = BullModule.registerQueue({
  name: TITLE_QUEUE,
});

@Module({
  imports: [titleQueueDynamicModule],
  exports: [titleQueueDynamicModule],
})
export class TitleQueueModule {}
