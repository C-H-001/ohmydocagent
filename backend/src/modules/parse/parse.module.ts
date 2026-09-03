// 解析队列模块（Task 1.4 + Task 1.5 + Task 1.6 + Task 1.7）：注册 ParseProcessor
// worker 消费 PARSE_QUEUE、EmbedProcessor worker 消费 EMBED_QUEUE、
// SummaryProcessor worker 消费 SUMMARY_QUEUE。
// 队列本身（BullModule.registerQueue）在 KnowledgeModule 注册（PARSE_QUEUE——
// 入队入口 KnowledgeService 在那里消费）与本模块注册（EMBED_QUEUE——分块成功
// 后入队与消费都在本模块，见 parse.processor.ts enqueueEmbed 注释）；
// Task 1.9 起 EMBED_QUEUE 改由 EmbedQueueModule 单点注册（编辑/回滚的单块
// 向量化入队发生在 ChunkModule，两侧共用同一队列实例——避免同一队列双实例
// （双 Redis 连接），见 embed-queue.module.ts 注释）；
// SUMMARY_QUEUE 由 SummaryQueueModule 单点注册，两侧（KnowledgeModule/
// ParseModule）import 复用（见 summary-queue.module.ts 注释）。依赖：
// ParserClient（ParserModule）、KnowledgeProgressService（KnowledgeModule）、
// ChunkingService/ChunkService（ChunkModule，Task 1.5 分块）、VectorService
// （VectorModule，Task 1.6 批量 upsert）、EmbeddingService（ModelModule，Task
// 1.6 批量向量化）与 ChatModelService（ModelModule，Task 1.7 摘要生成），依赖
// 方向无环。
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ParserModule } from '../../parser/parser.module.js';
import { ChunkModule } from '../chunk/chunk.module.js';
import { GraphQueueModule } from '../graph/graph-queue.module.js';
import { KnowledgeBase } from '../kb/kb.entity.js';
import { Knowledge } from '../knowledge/knowledge.entity.js';
import { KnowledgeModule } from '../knowledge/knowledge.module.js';
import { ModelModule } from '../model/model.module.js';
import { VectorModule } from '../vector/vector.module.js';
import { EmbedProcessor } from './embed.processor.js';
import { EmbedQueueModule } from './embed-queue.module.js';
import { SummaryProcessor } from './summary.processor.js';
import { SummaryQueueModule } from './summary-queue.module.js';
import { ParseProcessor } from './parse.processor.js';

import { StorageModule } from '../storage/storage.module.js';

@Module({
  imports: [
    KnowledgeModule,
    ParserModule,
    // Task 1.5 分块：ChunkingService（纯算法）+ ChunkService（事务内写块）
    ChunkModule,
    // 图片资产落盘（多模态）：StorageService（parse.processor.persistImages 用）
    StorageModule,
    // Task 1.6 向量化：VectorService（批量 upsert）+ EmbeddingService（批量 embed）
    VectorModule,
    ModelModule,
    // 向量化队列由 EmbedQueueModule 单点注册/导出（Task 1.9 起：入队两侧——
    // ParseProcessor 分块成功批量入队、ChunkService 编辑/回滚单块入队——与
    // 消费侧 EmbedProcessor 注入同一实例，见 embed-queue.module.ts 注释）；
    // SUMMARY_QUEUE（Task 1.7）由 SummaryQueueModule 单点注册/导出（入队两侧
    // 与消费侧都注入同一实例，见 summary-queue.module.ts 注释）
    EmbedQueueModule,
    SummaryQueueModule,
    // GRAPH_QUEUE（Task 3.2）由 GraphQueueModule 单点注册/导出（入队侧——
    // 本模块 ParseProcessor 分块成功后人队；消费侧 ExtractProcessor 在
    // GraphModule——两侧注入同一实例，见 graph-queue.module.ts 注释）
    GraphQueueModule,
    // ParseProcessor 直接读 Knowledge（加载解析对象 + 404 语义）与
    // KnowledgeBase（读 KB 分块配置 chunkingConfig），EmbedProcessor 读
    // Knowledge（存在性校验），需在本模块注册实体
    TypeOrmModule.forFeature([Knowledge, KnowledgeBase]),
  ],
  providers: [ParseProcessor, EmbedProcessor, SummaryProcessor],
})
export class ParseModule {}
