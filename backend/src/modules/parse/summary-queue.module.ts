// 自动摘要队列共享模块（Task 1.7）：SUMMARY_QUEUE 的注册与导出单点。
// 背景：SUMMARY_QUEUE 的入队发生在两侧——ParseModule（ParseProcessor 分块成功
// 后自动入队）与 KnowledgeModule（KnowledgeService regenerate-summary 手动入队），
// 消费在 ParseModule（SummaryProcessor）。若只在一侧注册，对侧无法注入：
// NestJS 的模块 exports 校验（validateExportedProvider）只认「本模块 providers」
// 或「imports 的模块类」——从导入的 DynamicModule 拿到的 provider 不能被本模块
// 再导出（本任务实现期实测，见 Module.validateExportedProvider），因此「在
// KnowledgeModule 注册 + exports 透传」不可行；而在两侧分别 registerQueue 会
// 产生双队列实例（双 Redis 连接，项目约定明确禁止，见 ParseModule 文件头）。
// 解法：本模块单点 registerQueue + 导出同一 DynamicModule 对象（imports 与
// exports 共用同一实例——导出 DynamicModule 时容器只把其模块类加入 exports，
// 不会重复实例化，队列仍只有一个）；KnowledgeModule 与 ParseModule 都 import
// 本模块，两侧注入同一队列实例。非全局模块（与 RedisModule/Neo4jModule 的
// 按需注入约定一致，不引入隐式全局依赖）。
import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { SUMMARY_QUEUE } from './parse-queue.constants.js';

/** 同一 registerQueue DynamicModule 对象：imports 实例化 + exports 引用（见文件头注释） */
const summaryQueueDynamicModule = BullModule.registerQueue({
  name: SUMMARY_QUEUE,
});

@Module({
  imports: [summaryQueueDynamicModule],
  exports: [summaryQueueDynamicModule],
})
export class SummaryQueueModule {}
