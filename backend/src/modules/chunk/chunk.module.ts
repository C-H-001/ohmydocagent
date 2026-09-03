// 分块模块（Task 1.5 + Task 1.9）：Chunk 实体 + ChunkRevision（版本历史）实体 +
// ChunkingService（纯算法）+ ChunkService（持久化/列表/编辑/版本/回滚/级联清理）
// + ChunkController（列表 + 顶层 chunks 路由）。
// - ChunkingService/ChunkService 导出供解析管线（ParseModule）与文档删除级联
//   （KnowledgeModule）消费；本模块不依赖其它业务模块（文档存在性校验直查表，
//   模块依赖方向单向无环）
// - 编辑/版本管理（Task 1.9）：ChunkService 编辑/回滚后入队单块 EMBED job
//   （payload { chunkId }）——队列由 EmbedQueueModule 单点注册/导出，本模块
//   import 注入同一实例（避免双 Redis 连接，见 embed-queue.module.ts 注释）
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Knowledge } from '../knowledge/knowledge.entity.js';
import { EmbedQueueModule } from '../parse/embed-queue.module.js';
import { ChunkController } from './chunk.controller.js';
import { ChunkRevision } from './chunk-revision.entity.js';
import { Chunk } from './chunk.entity.js';
import { ChunkService } from './chunk.service.js';
import { ChunkingService } from './chunking.service.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([Chunk, Knowledge, ChunkRevision]),
    // 单块向量化入队（编辑/回滚触发重新向量化，见 chunk.service.ts 注释）
    EmbedQueueModule,
  ],
  controllers: [ChunkController],
  providers: [ChunkingService, ChunkService],
  exports: [ChunkingService, ChunkService],
})
export class ChunkModule {}
