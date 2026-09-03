// 会话路由（Task 2.1 + Task 2.9，全部需登录——全局 JwtAuthGuard 默认拦截）：
// POST /chat/sessions 创建（201，默认标题「新会话」）、GET /chat/sessions 分页列表
// （置顶优先 + 消息数聚合）、GET /chat/sessions/:id 详情、PUT /chat/sessions/:id 更新
// （重命名/更新 kbIds/置顶）、DELETE /chat/sessions/:id 删除（级联删消息 + 附件，204）、
// DELETE /chat/sessions/batch 批量删除（宽容：只删本人的）、
// DELETE /chat/sessions/:id/messages 清空消息（会话保留，204）、
// GET /chat/sessions/:id/messages 消息列表（createdAt 升序分页）、
// POST /chat/sessions/:id/messages 发送对话消息（Task 2.4：返回 SSE 流，事件
// 协议见 sse/chat-event.types.ts；生成回路见 chat-orchestrator.service.ts）。
// Task 2.10：POST /chat/sessions/:id/stop 停止生成——经 GenerationRegistry
// abort 该会话的活动生成（幂等 200，见 registry 注释）。
// 路由顺序：DELETE /chat/sessions/batch 必须声明在 DELETE /chat/sessions/:id 之前
// ——Express 按注册顺序匹配，若 batch 在 :id 之后注册，'batch' 会被 :id 吞掉
// （复用 Task 1.8/1.10 的批量路由经验）。
// 归属权限（非本人操作 → 403）在 SessionService 内统一判定（getOwnedSession），
// 控制器只做 HTTP 层（DTO 校验 + 当前用户注入）。
//
// @Res 手动模式决策（Task 2.4）：POST messages 用 @Res({ passthrough:false })
// 手动控制响应——SSE 需要逐块 write + 手动 end，无法走 NestJS 返回值序列化。
// 代价（NestJS 文档明确）：@Res 手动模式下全局拦截器/异常过滤器对响应不生效
// ——因此错误处理分层：
// - 归属校验（getById）与 DTO 校验在 SSE headers 发送前 → 异常过滤器仍可写
//   标准 JSON（404/403/400/401）；
// - 生成期错误在编排器内捕获 → SSE error 事件 + end（headers 已发送、状态码
//   不可改，见 chat-orchestrator.service.ts 注释）。
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { User } from '../users/user.entity.js';
import { UploadedFileLike } from '../storage/storage.service.js';
import { BatchDeleteSessionsDto } from './dto/batch-delete-sessions.dto.js';
import { CreateSessionDto } from './dto/create-session.dto.js';
import { ListSessionDto } from './dto/list-session.dto.js';
import { SendMessageDto } from './dto/send-message.dto.js';
import { UpdateSessionDto } from './dto/update-session.dto.js';
import { ChatOrchestratorService } from './chat-orchestrator.service.js';
import { SessionService } from './session.service.js';
import { SseService } from './sse/sse.service.js';
import { GenerationRegistry } from './sse/generation-registry.service.js';

@Controller('chat/sessions')
export class SessionController {
  constructor(
    private readonly sessionService: SessionService,
    // Task 2.4：对话生成编排（流式回路，见 chat-orchestrator.service.ts）
    private readonly orchestrator: ChatOrchestratorService,
    // Task 2.9：附件上传/列表（归属校验与白名单在服务层，见
    // attachment.service.ts 文件头注释）
    // Task 2.10：生成注册表——POST :id/stop 经 registry.stop abort 活动生成
    // （归属校验仍走 sessionService.getById，见 stopGeneration 注释）
    private readonly generationRegistry: GenerationRegistry,
  ) {}

  /** 创建会话：201 返回完整实体（默认标题「新会话」，kbIds 宽松校验见 DTO 注释） */
  @Post()
  @HttpCode(201)
  create(@Body() dto: CreateSessionDto, @CurrentUser() user: User) {
    return this.sessionService.create(dto, user.id);
  }

  /** 分页列表：只返回当前用户会话，置顶优先 + updatedAt DESC + messageCount 聚合 */
  @Get()
  list(@Query() query: ListSessionDto, @CurrentUser() user: User) {
    return this.sessionService.list(query.page, query.pageSize, user.id);
  }

  /** 详情：归属校验（非本人 403，不存在 404） */
  @Get(':id')
  getById(@Param('id') id: string, @CurrentUser() user: User) {
    return this.sessionService.getById(id, user.id);
  }

  /** 更新：重命名（title）/关联知识库（kbIds）/置顶开关（pinned，仅更新传入字段） */
  @Put(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateSessionDto,
    @CurrentUser() user: User,
  ) {
    return this.sessionService.update(id, dto, user.id);
  }

  /**
   * 批量删除（宽容语义）：只删本人的会话，200 返回 { deleted } 删除数。
   * 必须声明在 DELETE /chat/sessions/:id 之前（Express 按注册顺序匹配，
   * 否则 'batch' 会被 :id 吞掉，见文件头注释）。
   */
  @Delete('batch')
  @HttpCode(200)
  batchDelete(
    @Body() dto: BatchDeleteSessionsDto,
    @CurrentUser() user: User,
  ): Promise<{ deleted: number }> {
    return this.sessionService.removeBatch(dto.ids, user.id);
  }

  /** 删除会话（级联删消息）：204 无响应体；非本人 403、不存在 404 */
  @Delete(':id')
  @HttpCode(204)
  async remove(
    @Param('id') id: string,
    @CurrentUser() user: User,
  ): Promise<void> {
    await this.sessionService.remove(id, user.id);
  }

  /** 消息列表：createdAt 升序分页（对话自然时序）；非本人 403、不存在 404 */
  @Get(':id/messages')
  listMessages(
    @Param('id') id: string,
    @Query() query: ListSessionDto,
    @CurrentUser() user: User,
  ) {
    return this.sessionService.listMessages(
      id,
      user.id,
      query.page,
      query.pageSize,
    );
  }

  /** 清空消息：删除该会话全部消息、会话保留（204）；非本人 403、不存在 404 */
  @Delete(':id/messages')
  @HttpCode(204)
  async clearMessages(
    @Param('id') id: string,
    @CurrentUser() user: User,
  ): Promise<void> {
    await this.sessionService.clearMessages(id, user.id);
  }

  /**
   * 停止生成（Task 2.10）：POST /chat/sessions/:id/stop——经 GenerationRegistry
   * abort 该会话的活动生成（AbortController → 编排器 → Agent → 供应商 fetch，
   * 烧 token 止损；停止后 partial 落库 interrupted=true + done 事件，见
   * chat-orchestrator.service.ts 停止生成注释）。
   * 时序：先 getById 归属校验（404/403 JSON——stop 请求非 SSE，异常过滤器
   * 正常响应），再 registry.stop。幂等语义（决策，见 registry 注释）：无活动
   * 生成 → 200 { stopped: false, reason: 'no_active_generation' }（选幂等 200
   * 而非 409——stop 是「尽力而为」操作，前端连点安全，无需区分错误分支）。
   */
  @Post(':id/stop')
  @HttpCode(200)
  async stopGeneration(
    @Param('id') id: string,
    @CurrentUser() user: User,
  ): Promise<{ stopped: boolean; reason?: string }> {
    // 归属校验（404 不存在 / 403 他人会话）——与其余会话路由同一语义（复用
    // getById 的 getOwnedSession，见 session.service.ts 注释）
    await this.sessionService.getById(id, user.id);
    return this.generationRegistry.stop(id);
  }

  /**
   * 发送对话消息（Task 2.4 基础生成回路 + Task 2.8 Agent 工具循环）：返回
   * SSE 流（事件协议见 sse/chat-event.types.ts）。@Res 手动模式
   * （passthrough:false）——SSE 响应由控制器直接写流；错误处理分层见文件头
   * @Res 决策注释。
   * 时序：先 getById 归属校验（404/403 以 JSON 响应，SSE 未开始），再创建
   * SseService（writeHead + flushHeaders，客户端开始收流），最后编排器
   * runStream（createUserMessage 内还有一次事务内归属校验作为并发兜底——
   * 会话在两次校验间被删的极端竞态下，异常过滤器会尝试写 JSON 撞已发送
   * headers，属可接受的罕见竞态，注释说明）。
   * 决定是否注入 web_search 工具，见 agent-orchestrator.service.ts）。
   */
  @Post(':id/messages')
  async sendMessage(
    @Param('id') id: string,
    @Body() dto: SendMessageDto,
    @CurrentUser() user: User,
    @Res() res: Response,
  ): Promise<void> {
    // 前置归属校验：SSE headers 发送前暴露 404/403（异常过滤器正常写 JSON）
    await this.sessionService.getById(id, user.id);
    const sse = new SseService(res);
    // Task 2.9：附件引用（attachmentIds → user 消息上下文占位）与 @提及范围
    // （mentionKbIds/mentionKnowledgeIds 显式数组 + content 内嵌 @kb:/@file:
    // 解析合并，见 agent-orchestrator.service.ts 注释；联网搜索已删除）
    await this.orchestrator.runStream(id, user.id, dto.content, sse, {
      attachmentIds: dto.attachmentIds,
      mentionKbIds: dto.mentionKbIds,
      mentionKnowledgeIds: dto.mentionKnowledgeIds,
    });
  }
}
