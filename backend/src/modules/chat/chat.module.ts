// 会话模块（Task 2.1 + Task 2.2 + Task 2.4 + Task 2.5 + Task 2.6 + Task 2.8 + Task 2.9
// + Task 2.10 + Task 2.11）：
// Session/Message 实体
// + 会话管理（CRUD/置顶/批量删除/清空/重命名 + 消息列表）+ 消息创建服务
// （MessageService：首条用户消息触发会话标题自动生成，TitleProcessor 消费
// TITLE_QUEUE）+ 对话生成编排（ChatOrchestratorService：POST :id/messages
// 的 SSE 流式回路）+ Agent 工具循环（Task 2.8：AgentOrchestratorService 编排
// ReAct 循环——search_kb（KbSearchTool：Task 2.5 RAG 管线的检索/重排/合并
// 改造）search_kb 工具（知识库检索），
// ReferencesService 承担引用构建与正文 [n] 对齐；RagPipelineService/
// QueryUnderstandService 随方案 A 删除，见 chat-orchestrator.service.ts 注释）。
// - 对话生成（Task 2.5 对话管线）消费 MessageService/SessionService，exports
//   提前声明（同模块依赖无需 exports；跨模块消费方在需要时 import 本模块）
// - TITLE_QUEUE 由 TitleQueueModule 单点注册（入队 MessageService + 消费
//   TitleProcessor 注入同一实例，见 title-queue.module.ts 注释）
// - ModelModule 提供 ChatModelService（标题生成/Agent 工具循环的 LLM 能力，
//   见 model.module.ts）；VectorModule 提供 VectorService（search_kb 混合检索）；
//   （联网搜索已删除——不作为兜底）
// - 归属 403 在 SessionService.getOwnedSession / MessageService 事务内判定
// - Task 2.9：@提及解析（MentionService：@kb:/@file: 解析）——对话上传附件
//   （图片/文件）链路已删除（占位功能，不做多模态注入）
// - Task 2.11：聊天历史（ChatHistoryService/Controller）——历史搜索（keyword
//   ILIKE 本人会话消息）+ 按知识库统计（references jsonb 展开 → join knowledge
//   反查 kbId 聚合）+ 清空全部会话（复用附件级联语义）；口径与 kbId 反查
//   决策见 chat-history.service.ts 文件头注释
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ModelModule } from '../model/model.module.js';
import { UsageModule } from '../usage/usage.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { VectorModule } from '../vector/vector.module.js';
import { GraphModule } from '../graph/graph.module.js';
import { ParserModule } from '../../parser/parser.module.js';
import { Knowledge } from '../knowledge/knowledge.entity.js';
import { KnowledgeBase } from '../kb/kb.entity.js';
// Task 3.4：KbSearchTool 图谱增强补充候选（实体关联 chunk 内容查询）
import { Chunk } from '../chunk/chunk.entity.js';
// Task 2.11：聊天历史（搜索/统计/清空全部，见 chat-history.service.ts 注释）
import { ChatHistoryController } from './chat-history.controller.js';
import { ChatHistoryService } from './chat-history.service.js';
import { MentionService } from './mention.service.js';
import { ChatOrchestratorService } from './chat-orchestrator.service.js';
import { GenerationRegistry } from './sse/generation-registry.service.js';
import { MessageService } from './message.service.js';
import { Message } from './message.entity.js';
import { Session } from './session.entity.js';
import { SessionController } from './session.controller.js';
import { SessionService } from './session.service.js';
import { TitleProcessor } from './title.processor.js';
import { TitleQueueModule } from './title-queue.module.js';
import { ReferencesService } from './pipeline/references.service.js';
import { AgentOrchestratorService } from './agent/agent-orchestrator.service.js';
import { KbSearchTool } from './agent/tools/kb-search.tool.js';
import { GraphSearchTool } from './agent/tools/graph-search.tool.js';

@Module({
  imports: [
    // Session/Message 为会话基础实体；Knowledge 供 KbSearchTool 引用
    // 标题补查（search_kb 工具 references 的 knowledgeTitle/url 来源，Task
    // 2.6——同 Task 2.5 管线的补查职责随检索逻辑移入工具）；Task 2.11：
    // KnowledgeBase 供历史统计的 kbName 补查（knowledge_bases，见
    // chat-history.service.ts stats 注释）
    TypeOrmModule.forFeature([
      Session,
      Message,
      Knowledge,
      KnowledgeBase,
      // Task 3.4：KbSearchTool 图谱增强补充候选查 chunk 内容
      Chunk,
    ]),
    // LLM 对话抽象（标题生成/Agent 工具循环）
    ModelModule,
    // 模型用量（生成完成后累计 token，供普通用户用量管理界面）
    UsageModule,
    // Task 2.2：TITLE_QUEUE 单点注册/导出（入队与消费共用同一实例）
    TitleQueueModule,
    // Task 2.5：VectorService（search_kb 混合检索，见 vector.module.ts）
    VectorModule,

    // Task: StorageService（parser 图片落盘 saveImage/清理，见 parse.processor）
    StorageModule,
    // Task 3.4：GraphSearchService（search_kb 图谱增强——实体引导补充候选）
    GraphModule,
    // Task: 多模态——ParserFileGuard（引用 images 签名 URL，<img> 直出用）
    ParserModule,
  ],
  controllers: [SessionController, ChatHistoryController],
  providers: [
    SessionService,
    MessageService,
    TitleProcessor,
    // @提及解析（双通道 mention 范围，见 agent-orchestrator.service.ts 注释）
    MentionService,
    // Task 2.4：对话生成编排（流式回路，见 chat-orchestrator.service.ts）
    ChatOrchestratorService,
    // Task 2.10：生成注册表（sessionId → AbortController）——POST :id/stop
    // 经 registry 定位并 abort 活动生成（单进程内存 Map；多实例部署需 Redis
    // pub/sub 广播，P5 部署评估，见 registry 文件头注释）
    GenerationRegistry,
    // Task 2.8：Agent 工具循环（ReAct 编排）与内置工具（search_kb）
    AgentOrchestratorService,
    KbSearchTool,
    GraphSearchTool,
    // Task 2.6：阶段服务（ReferencesService：引用构建 + 正文 [n] 兜底对齐，
    // 纯函数服务；MergeService 随质量审查整改删除——提示构建职责已收窄为
    // 工具回填文案，移入 kb-search.tool.ts）
    ReferencesService,
    // Task 2.11：聊天历史（历史搜索/按知识库统计/清空全部会话——搜索与统计
    // 数据隔离限当前用户）
    ChatHistoryService,
  ],
  exports: [SessionService, MessageService],
})
export class ChatModule {}
