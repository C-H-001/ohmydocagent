// 图谱抽取队列共享模块（Task 3.2）：GRAPH_QUEUE 的注册与导出单点。
// 背景：GRAPH_QUEUE 的入队发生在 ParseModule（ParseProcessor 分块成功后按 KB
// extractConfig 自动入队），消费在 GraphModule（ExtractProcessor）——若两侧
// 分别 registerQueue 会双实例（双 Redis 连接，项目约定禁止，见 ParseModule
// 文件头注释）；而 ParseModule 不能 import GraphModule（GraphModule 依赖
// KnowledgeModule 的 KnowledgeProgressService，反向会成环——即使不环，把
// 消费侧 worker 拖进解析模块也不合理）。解法与 SummaryQueueModule 同模式：
// 本模块单点 registerQueue + 导出同一 DynamicModule 对象（imports 与 exports
// 共用同一实例——导出 DynamicModule 时容器只把其模块类加入 exports，不会
// 重复实例化，队列仍只有一个）；ParseModule 与 GraphModule 都 import 本模块，
// 两侧注入同一队列实例。非全局模块（与 SummaryQueueModule/RedisModule 的
// 按需注入约定一致，不引入隐式全局依赖）。
import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { GRAPH_QUEUE } from './graph-queue.constants.js';

/** 同一 registerQueue DynamicModule 对象：imports 实例化 + exports 引用（见文件头注释） */
const graphQueueDynamicModule = BullModule.registerQueue({
  name: GRAPH_QUEUE,
});

@Module({
  imports: [graphQueueDynamicModule],
  exports: [graphQueueDynamicModule],
})
export class GraphQueueModule {}
