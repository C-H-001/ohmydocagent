// 知识图谱模块（Task 3.1 + Task 3.2 + Task 3.3）：GraphRepository（Neo4j
// 读写封装）+ GraphExtractionService（LLM 实体/关系抽取）+ ExtractProcessor（GRAPH_QUEUE
// 消费，Task 3.2 抽取管线）+ GraphController/GraphService（Task 3.3 图谱 API：
// 可视化数据/实体搜索/实体详情含反查文档/覆盖统计）。
// 依赖：Neo4jModule（非全局模块，须显式 import——仓储写入）；ModelModule
// （ChatModelService，抽取调 LLM）；KnowledgeModule（KnowledgeProgressService
// 进度写回——GraphModule 依赖 KnowledgeModule）；GraphQueueModule（GRAPH_QUEUE
// 单点注册/导出——消费侧在此注入，入队侧 ParseModule 也 import 本模块类，见
// graph-queue.module.ts 注释）。
// Task 3.3：GraphService 通过 DataSource 直查 PG（KB 存在性/文档标题/chunk
// 片段，跨库反查装配），DataSource 由 TypeOrmCoreModule 全局提供（@Global，
// 见 database.module.ts）——无需新增 import；forFeature 实体（Knowledge/
// KnowledgeBase/Chunk）Task 3.2 已注册，GraphService 的实体查询走
// DataSource.getRepository（与 KnowledgeService.ensureKbExists 同款，避免
// 注入业务服务造成循环依赖）。
// 循环依赖说明（Task 3.2 质量审查整改）：KnowledgeModule 反向 import 本模块
// 注入 GraphRepository（文档删除时清理图谱子图，见 KnowledgeService.remove
// 注释）——两模块互相依赖（本模块 → KnowledgeModule 的进度写回、
// KnowledgeModule → 本模块的 GraphRepository），用 forwardRef 双向声明打破
// 实例化顺序死锁（Nest 循环依赖标准解法）。Provider 级依赖仍无环：
// KnowledgeService → GraphRepository → Neo4jService、ExtractProcessor →
// KnowledgeProgressService，均无反向引用。
// 业务消费方（Task 3.4 图谱增强检索）按需 import GraphModule。
import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Neo4jModule } from '../../neo4j/neo4j.module.js';
import { Chunk } from '../chunk/chunk.entity.js';
import { KnowledgeBase } from '../kb/kb.entity.js';
import { Knowledge } from '../knowledge/knowledge.entity.js';
import { KnowledgeModule } from '../knowledge/knowledge.module.js';
import { ModelModule } from '../model/model.module.js';
import { ExtractProcessor } from './extract.processor.js';
import { GraphController } from './graph.controller.js';
import { GraphQueueModule } from './graph-queue.module.js';
import { GraphExtractionService } from './graph-extraction.service.js';
import { GraphRepository } from './graph.repository.js';
import { GraphSearchService } from './graph-search.service.js';
import { GraphService } from './graph.service.js';

@Module({
  imports: [
    Neo4jModule,
    // GRAPH_QUEUE 单点注册/导出（入队侧 ParseProcessor 与消费侧本模块注入
    // 同一实例，见 graph-queue.module.ts 注释）
    GraphQueueModule,
    // ChatModelService（GraphExtractionService 依赖，Task 3.2 LLM 抽取）
    ModelModule,
    // KnowledgeProgressService（graph 阶段写回，抽取管线进度与文档状态同源）
    // forwardRef：KnowledgeModule 反向 import 本模块（文档删除清理图谱子图），
    // 双向循环依赖声明（见文件头「循环依赖说明」）
    forwardRef(() => KnowledgeModule),
    // ExtractProcessor 直读 Knowledge/KnowledgeBase/Chunk（存在性/开关/分块）
    TypeOrmModule.forFeature([Knowledge, KnowledgeBase, Chunk]),
  ],
  providers: [
    GraphRepository,
    GraphExtractionService,
    // GRAPH_QUEUE worker（@Processor 装饰器注册，AppModule 加载本模块即启动消费）
    ExtractProcessor,
    // Task 3.3 图谱 API 装配层（跨库反查：Neo4j chunkIds → PG 标题/片段）
    GraphService,
    // Task 3.4 图谱增强检索（实体引导，KbSearchTool 消费）
    GraphSearchService,
  ],
  // Task 3.3：图谱 API 路由（可视化/搜索/实体详情/覆盖统计）
  controllers: [GraphController],
  exports: [GraphRepository, GraphSearchService],
})
export class GraphModule {}
