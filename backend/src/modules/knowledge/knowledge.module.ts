// 知识文档模块（Task 1.2 + Task 1.3 + Task 1.4 + Task 1.5 + Task 1.7）：文档实体
// + 三种创建方式 + 本地存储 + 文件夹树（KnowledgeFolder）+ 标签（Tag/KnowledgeTag
// 多对多）+ 解析进度写回（KnowledgeProgressService，Task 1.4）+ 分块级联清理
// （ChunkService，Task 1.5——文档删除/KB 级联时显式删 chunks 子表）。
// 解析队列 BullModule.registerQueue 在本模块注册——入队入口 KnowledgeService 在
// 此消费；ParseModule 只注册 worker（复用本模块的队列与进度服务），避免同一队列
// 双实例。
// KbModule imports 本模块（KB 删除级联调用 KnowledgeService.removeByKbInTx）；
// 本模块不依赖 KbModule（KB 存在性校验直查表），依赖 ChunkModule（chunks 子表
// 清理），模块依赖方向单向无环
// Task 1.7：自动摘要队列由 SummaryQueueModule 单点注册并导出（入队两侧——
// 本模块 KnowledgeService regenerate-summary 与 ParseModule ParseProcessor 分块
// 后自动入队——通过 import SummaryQueueModule 注入同一实例，见该模块注释；
// PARSE_QUEUE 仍在本模块注册，与 Task 1.4 约定一致）
// Task 3.2：本模块反向 import GraphModule（GraphRepository——文档删除后清理
// 图谱子图，见 KnowledgeService.remove 注释）；GraphModule 也依赖本模块
// （KnowledgeProgressService），双向循环依赖用 forwardRef 声明（见
// graph.module.ts 文件头「循环依赖说明」）
import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ParseQueueModule } from '../parse/parse-queue.module.js';
import { SummaryQueueModule } from '../parse/summary-queue.module.js';
import { GraphModule } from '../graph/graph.module.js';
import { ChunkModule } from '../chunk/chunk.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { KnowledgeFolder } from './folder.entity.js';
import { KnowledgeController } from './knowledge.controller.js';
import { KnowledgeProgressService } from './knowledge-progress.service.js';
import { KnowledgeTag } from './knowledge-tag.entity.js';
import { Knowledge } from './knowledge.entity.js';
import { KnowledgeService } from './knowledge.service.js';
import { Tag } from './tag.entity.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([Knowledge, KnowledgeFolder, Tag, KnowledgeTag]),
    // Task 1.5：分块子表清理（ChunkService），ChunkModule 已注册 Chunk 实体
    ChunkModule,
    StorageModule,
    // Task 4.3：PARSE_QUEUE 单点注册/导出（Task 1.4 起在本模块内联 registerQueue，
    // 4.3 队列仪表盘需要注入同一实例——改为 import ParseQueueModule 复用，
    // 见 parse-queue.module.ts 注释；三侧（入队 KnowledgeService/消费
    // ParseProcessor/仪表盘 QueueModule）注入同一队列实例）
    ParseQueueModule,
    // Task 1.7：自动摘要队列单点注册/导出（见 SummaryQueueModule 注释）
    SummaryQueueModule,
    // Task 3.2：GraphRepository（文档删除清理图谱子图，forwardRef 循环依赖见文件头注释）
    forwardRef(() => GraphModule),
  ],
  controllers: [KnowledgeController],
  providers: [KnowledgeService, KnowledgeProgressService],
  exports: [KnowledgeService, KnowledgeProgressService],
})
export class KnowledgeModule {}
