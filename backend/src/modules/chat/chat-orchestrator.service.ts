// backend/src/modules/chat/chat-orchestrator.service.ts
// 对话生成编排（Task 2.4 基础版 + Task 2.5 注入 RAG 管线 + Task 2.8 改造为
// Agent 工具循环）：POST /chat/sessions/:id/messages 的生成回路——user 消息
// 落库（复用 MessageService.createUserMessage：事务内归属校验 + 首条用户消息
// 触发标题生成）→ AgentOrchestratorService.run（ReAct 工具循环：LLM 自主决定
// 调 search_kb 检索知识库 / web_search 联网搜索 / 直接生成，见
// agent-orchestrator.service.ts 文件头）→ assistant 消息落库
// （content/references/reasoning）→ stage(generate done) → done 事件
// （messageId + usage）。
//
// 方案 A 决策（Task 2.8，RAG 管线与 Agent 的合成）：Task 2.5 的固定五阶段
// 管线改造为 Agent 的 KB 检索工具——RagPipelineService/QueryUnderstandService
// 删除（检索/重排/合并逻辑移入 agent/tools/kb-search.tool.ts；query_understand
// 职责并入 LLM 工具调用参数）；stage 事件语义同步调整（search/rerank/merge
// 在 search_kb 工具执行时发出，query_understand 取消；generate start 由 Agent
// 循环发出），见 chat-event.types.ts 与 agent-orchestrator.service.ts 注释。
//
// 职责划分（Task 2.5 延续）：编排器管落库/事件收尾（stage generate done +
// done）/错误事件（error code + 脱敏文案）；Agent 管工具循环/检索/生成 +
// stage(start/delta/reasoning_delta/tool_call/references) 事件。保持 Task 2.4
// 事件序（质量审查整改 #3）：先落库 assistant 再 stage(generate done)/done——
// 客户端不会看到「已 done 但消息没存」的假成功。
//
// SSE 错误处理（@Res 手动模式陷阱，见 session.controller.ts 注释）：NestJS
// 全局异常过滤器/拦截器对已开始的 SSE 响应不生效（headers 已发送、状态码
// 不可改）——生成期错误全部在编排器内捕获 → SSE error 事件 + 结束流
// （HTTP 保持 200，客户端按事件协议展示错误），而不是让异常过滤器尝试写
// JSON（会撞 "Cannot set headers after they are sent"）。仅归属校验错误
// （404/403）在 SSE 开始前抛出、由异常过滤器以标准 JSON 响应（见控制器注释：
// 控制器先 getById 预检，createUserMessage 内再事务校验作为并发兜底——若并发
// 竞态发生（预检后会话被删），SSE 已开始、异常过滤器不可用，编排器转 SSE
// error 事件表达，见 runStream 内 createUserMessage 的 catch）。
//
// 断连处理（Task 2.4 质量审查整改 #1）：SseService 检测到客户端断开（res
// close 且响应未结束）→ 触发 onDisconnect 注册的回调 → 编排器 abort
// AbortController → 该 signal 经 Agent 传到 chatStream(options.signal)（供应商
// fetch 与内部超时经 AbortSignal.any 组合）→ 上游生成立即中止（烧 token
// 止损）。断连路径：Agent 在 abort 检查点返回已累积部分（断连不丢已生成
// 部分）→ 编排器落库 partial assistant；不再发事件（连接已关，写了会触发
// 未处理 error）。Task 2.10 的显式 stop 接口是「用户主动中止」，本断连处理
// 是「连接消失」，两者独立但共用 abort 信号——区别只在收尾事件的发送：
//
// 停止生成（Task 2.10）：GenerationRegistry（sessionId → AbortController，
// 见 generation-registry.service.ts）——runStream 开始 register、finally
// unregister（防泄漏）；POST /chat/sessions/:id/stop 经 registry.stop abort
// 该会话的活动生成。abort 语义区分（stop vs 断连）：abort 后检查
// SseService.isDisconnected()——未断连（=stop，socket 仍开）→ 落库 partial
// （interrupted=true）后发 stage(generate done) + done（interrupted=true，
// 前端展示「已停止」+ partial 内容）；已断连 → 落库 partial
// （interrupted=true）但不发事件（既有行为，连接已关）。
// 降级路径（Task 2.10 质量审查整改，runStream catch）：stop 与管线真实错误
// 同时发生（stop 后管线抛工具 DB 故障等）时，无法按正常 stop 路径收尾——
// Agent 把已累积部分挂到错误上（PARTIAL_ON_ERROR_KEY），编排器落库 partial
// 后发 error generation_stopped（客户端展示「已停止」；区别于正常 stop 路径
// 的 done——该路径是 stop+异常同时发生的降级，真实错误细节只进日志）。
// 决策：断连 partial 也标 interrupted=true——生成未完成即视为中断，与 stop
// 同一语义（正常完成 false），前端统一按 interrupted 展示「已停止/未完成」。
// 多实例登记：registry 为单进程内存 Map（stop 路由到生成实例即可命中），
// 多实例部署需 Redis pub/sub 广播，P5 部署评估（见 registry 文件头注释）。
//
// done 事件 usage：chatStream 末尾 chunk 携带 usage（OpenAI 兼容
// stream_options.include_usage / Ollama done 行统计）时透传，前端可展示
// token 消耗；无则省略字段（协议 usage 可选）。
//
// 错误码设计（Task 2.4 质量审查整改 #4 脱敏）：error 事件 message 不透传原始
// err.message（可能含 DB 连接串/内网地址等内部细节）——按错误码映射固定中文
// 文案，内部细节只进 logger.error。错误码：
// - no_default_model：未配置默认对话模型（503 ServiceUnavailableException 映射，
//   可引导配置）；
// - chat_timeout：生成超时（AbortSignal.timeout 触发的 TimeoutError）；
// - chat_network_error：网络层失败（供应商「连接供应商失败（网络错误）」包装）；
// - chat_model_error：上游/Agent 失败（重试语义，通用兜底）；
// - persist_failed：消息落库失败（user/assistant 写入 DB 失败）。
// Task 2.10 质量审查整改新增：generation_stopped——「用户停止 + 管线真实错误
// 同时发生」的降级收尾（stop 后管线抛真实错误，无法按正常 stop 路径发 done，
// 以 error 告知客户端「已停止」+ partial 已落库，见 runStream catch 注释）。
// Task 2.8 变更：search_failed 不再作为 SSE error 错误码——检索失败降级为
// 工具级错误（search_kb 工具返回 status error + 友好文本回填 LLM，对话继续，
// 见 agent-orchestrator.service.ts 错误语义注释）。
import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { MessageService } from './message.service.js';
import type { Message } from './message.entity.js';
import { MentionService } from './mention.service.js';
import { ModelUsageService } from '../usage/model-usage.service.js';
import { ModelService } from '../model/model.service.js';
import { LangfuseService } from '../observability/langfuse.service.js';
import { GenerationRegistry } from './sse/generation-registry.service.js';
import type { SseService } from './sse/sse.service.js';
import type { AgentRunOptions, PartialOnError } from './agent/agent.types.js';
import {
  MENTION_ONLY_PLACEHOLDER,
  PARTIAL_ON_ERROR_KEY,
} from './agent/agent.types.js';
import { AgentOrchestratorService } from './agent/agent-orchestrator.service.js';
import type { RagReference } from './pipeline/rag.types.js';

/** 生成期错误 → SSE error 事件的错误码（协议字段，前端按 code 处理文案/重试） */
export const ERROR_CODE_CHAT_MODEL = 'chat_model_error';
/** 未配置默认对话模型（503 ServiceUnavailableException 映射） */
export const ERROR_CODE_NO_DEFAULT_MODEL = 'no_default_model';
/** 生成超时（AbortSignal.timeout 触发；与断连 AbortError 区分，见 mapError） */
export const ERROR_CODE_TIMEOUT = 'chat_timeout';
/** 网络层失败（连接拒绝/DNS/断网；供应商「连接供应商失败」包装映射） */
export const ERROR_CODE_NETWORK = 'chat_network_error';
/** 消息落库失败（user/assistant 写入 DB 失败） */
export const ERROR_CODE_PERSIST = 'persist_failed';
/** 生成被用户停止（stop 与管线真实错误竞态的降级收尾，见 runStream catch 注释） */
export const ERROR_CODE_GENERATION_STOPPED = 'generation_stopped';

@Injectable()
export class ChatOrchestratorService {
  private readonly logger = new Logger(ChatOrchestratorService.name);

  constructor(
    private readonly messageService: MessageService,
    // Task 2.8：Agent 工具循环（ReAct 编排：search_kb/web_search 工具 + 深度
    // 思考——Task 2.4 的 chatModel 直调与 Task 2.5 的 RAG 管线都移入 Agent，
    // 编排器只留落库/事件收尾/错误映射，见文件头职责划分注释）
    private readonly agentOrchestrator: AgentOrchestratorService,
    // Task 2.9 质量审查整改 #5a：@提及解析——落库前清理提及标记（user 消息
    // content 存 cleanedText），原始 @kb:/@file: 只在当次请求消费（Agent 侧
    // 再解析用于检索范围），历史回放不再把垃圾标记喂给 LLM
    private readonly mentionService: MentionService,
    // Task 2.10：生成注册表（sessionId → AbortController）——POST /stop 端点
    // 经 registry 定位并 abort 活动生成；本编排器 register（开始）/unregister
    // （finally），见文件头停止生成注释
    private readonly generationRegistry: GenerationRegistry,
    // 模型用量记录（普通用户用量管理界面数据源）：生成完成后累计 token
    private readonly usageService: ModelUsageService,
    // 当前使用的默认对话模型（记录用量需要 modelId/modelName）
    private readonly modelService: ModelService,
    // Langfuse 观测（评测链路，可选；关闭时 no-op）
    private readonly langfuse: LangfuseService,
  ) {}

  /**
   * 流式生成回路（Task 2.4 基础版 + Task 2.5 RAG 管线 + Task 2.8 Agent）：
   * 1. 创建 user 消息（事务内归属校验 + 首条触发标题生成）——移入 try 内
   *    （质量审查整改 #5：并发竞态收窄，见下方注释）
   * 2. Agent 工具循环（Task 2.8）：ReAct 编排——LLM 自主决定调 search_kb/
   *    web_search 工具或直接生成（stage/search/rerank/merge/tool_call/delta/
   *    reasoning_delta/references 事件由 Agent 与工具内部发出，返回生成结果）
   * 3. 事件序（质量审查整改 #3）：先落库 assistant（content/references/
   *    reasoning；失败 → error persist_failed，避免「客户端已见 done 但消息
   *    没存」的假成功）→ stage(generate done) → done（messageId + usage）
   * 4. 断连（质量审查整改 #1）：abort 传 Agent 停止上游生成，Agent 返回已累积
   *    部分 → 编排器落库 partial assistant，不向已关闭连接发事件
   * 生成期任何错误 → SSE error 事件（脱敏文案）+ 结束流（HTTP 200 保持）。
   * 调用方（SessionController）负责在归属校验通过后创建 SseService 并传入。
   */
  async runStream(
    sessionId: string,
    userId: string,
    content: string,
    sse: SseService,
    opts: AgentRunOptions = {},
  ): Promise<void> {
    // 断连取消信号：SseService 检测到客户端断开 → abort → 经管线传到供应商
    // fetch（signal 经 chatStream 透传，见文件头断连处理注释）；Task 2.10
    // 显式 stop 也经同一 signal（registry.stop → abort）——stop 与断连共用
    // abort 信号，区别只在收尾事件（见文件头停止生成注释）
    const controller = new AbortController();
    sse.onDisconnect(() => controller.abort());
    // Langfuse 会话 trace（可选；评测链路观测 ReAct 问答输入→输出）
    const obsTrace = await this.langfuse.trace('chat', content, {
      sessionId,
      userId,
    });
    // Task 2.10：注册生成任务（stop 端点据此定位并 abort；finally 注销防
    // 泄漏——register 在 try 外，异常路径同样进 finally 注销）
    this.generationRegistry.register(sessionId, controller);
    try {
      // 1. user 消息落库（统一写入入口：事务内归属校验 + 首条用户消息触发
      //    标题生成）。移入 try 内（质量审查整改 #5）：控制器已 getById 预检，
      //    这里的 404/403 只可能是预检后到落库间的并发竞态（会话被删）——
      //    SSE 已开始，异常过滤器 JSON 不可用，转 SSE error 事件表达；
      //    非 404/403 错误（DB 故障等）同样转 error 事件（persist_failed），
      //    不让异常过滤器尝试写已发送的 headers。
      let userMessage: Message;
      try {
        // Task 2.9 质量审查整改 #5a（决策：落库存 cleanedText）：user 消息
        // content 存清理后文本（提及标记移除）——历史回放（Agent 历史加载）
        // 不再把 @kb:/@file: 垃圾标记喂给 LLM；原始提及只在当次请求消费
        // （下方 run 传原始 content，Agent 内解析检索范围）。纯提及消息
        // （cleanedText 空）落占位文案（#5b：与 Agent 侧 user 内容组装同一
        // 占位——DB 不落空串，历史回放的空 content 同样会触发 provider 拒绝）
        const parsed = this.mentionService.parse(content);
        const storedContent = parsed.cleanedText || MENTION_ONLY_PLACEHOLDER;
        userMessage = await this.messageService.createUserMessage(
          sessionId,
          storedContent,
          userId,
        );
      } catch (err) {
        // 404/403：会话被并发删除/权限竞态（预检后到落库间的窗口）→ 前端
        // 按 message 提示刷新/重试；SSE 已开始，只能走事件协议（见文件头注释）
        if (
          err instanceof NotFoundException ||
          err instanceof ForbiddenException
        ) {
          sse.send({
            type: 'error',
            code: ERROR_CODE_CHAT_MODEL,
            message: '会话不存在或无权访问，请刷新后重试',
          });
        } else {
          this.logger.error(
            `用户消息落库失败: session=${sessionId}`,
            err instanceof Error ? err.stack : String(err),
          );
          sse.send({
            type: 'error',
            code: ERROR_CODE_PERSIST,
            message: '消息保存失败，请稍后重试',
          });
        }
        return;
      }
      // 2. Agent 工具循环（Task 2.8）：Agent 内部发 stage/delta/reasoning_delta/
      //    tool_call/references 事件（sse 传入），返回
      //    { content, references, reasoning, usage } 供本编排器落库。
      //    excludeMessageId：历史加载排除当前消息（Agent 用）；
      //    Web 搜索开关（默认 true）
      const result = await this.agentOrchestrator.run(
        sessionId,
        userId,
        content,
        sse,
        controller.signal,
        userMessage.id,
        opts,
        // Langfuse：会话 trace 下挂 agent 各轮 LLM generation 与工具 span
        // （此前 trace 建了未传 → generation 游离为独立 observation）
        obsTrace,
      );
      // 断连/stop：abort 已触发——Agent 已返回已累积部分（stop 与断连都不丢
      // 已生成部分），编排器落库 partial assistant。Task 2.10 决策：统一标
      // interrupted=true（生成未完成，见文件头注释）；区分只在收尾事件——
      // stop（socket 仍开，isDisconnected()=false）→ 发 stage(generate done)
      // + done（interrupted=true，前端展示「已停止」+ partial 内容）；断连
      // （socket 已关）→ 不发事件（连接已关，写了会触发未处理 error，既有
      // 行为）
      if (controller.signal.aborted) {
        this.logger.warn(
          `生成被中止（stop/断连），保存已累积内容: session=${sessionId}`,
        );
        const assistant = await this.persistPartial(
          sessionId,
          result.content,
          result.reasoning,
          result.references,
          result.usage,
        );
        // stop（socket 仍开）：发收尾事件——done 携带 interrupted=true +
        // partial messageId；落库失败 → error persist_failed（客户端不 hang——
        // 等不到 done/error 会一直转圈）
        if (!sse.isDisconnected()) {
          if (assistant) {
            sse.send({ type: 'stage', stage: 'generate', status: 'done' });
            sse.send({
              type: 'done',
              messageId: assistant.id,
              interrupted: true,
              ...(result.usage ? { usage: result.usage } : {}),
            });
            await this.recordUsage(userId, result.usage);
          } else {
            sse.send({
              type: 'error',
              code: ERROR_CODE_PERSIST,
              message: '消息保存失败，请稍后重试',
            });
          }
        }
        return;
      }
      // 3. 事件序（质量审查整改 #3）：先落库 assistant，再发 stage(done)，最后
      //    done（messageId 此时才可引用）——落库失败走 error（persist_failed），
      //    客户端不会看到「已 done 但消息没存」的假成功
      let assistant: Message;
      try {
        assistant = await this.messageService.createAssistantMessage(
          sessionId,
          result.content,
          {
            reasoning: result.reasoning,
            references: result.references,
            usage: result.usage,
          },
        );
      } catch (err) {
        // 落库失败（DB 故障等）→ persist_failed（区别于上游生成错误：重试
        // 语义不同——消息没存上，前端提示重发）
        this.logger.error(
          `assistant 消息落库失败: session=${sessionId}`,
          err instanceof Error ? err.stack : String(err),
        );
        sse.send({
          type: 'error',
          code: ERROR_CODE_PERSIST,
          message: '消息保存失败，请稍后重试',
        });
        return;
      }
      // stage(generate done)：管线已发 generate start（见 rag-pipeline 注释）
      sse.send({ type: 'stage', stage: 'generate', status: 'done' });
      // 4. done 事件：messageId 定位消息 + usage 透传（无则省略字段）
      sse.send({
        type: 'done',
        messageId: assistant.id,
        ...(result.usage ? { usage: result.usage } : {}),
      });
      // 模型用量累计（辅助数据：失败仅日志，不阻断对话；模型取默认对话模型
      // ——Agent 内部同源，见 agent-orchestrator chatModel 注释）
      await this.recordUsage(userId, result.usage);
      // Langfuse：trace 输出（最终答案 + token 用量）
      obsTrace.end({ answer: result.content, usage: result.usage });
    } catch (err) {
      // 中止信号已触发（stop 或断连——共用同一 abort 信号，区别只在收尾事件，
      // 见文件头停止生成注释）时管线抛真实错误（工具 DB 故障等）：Agent 已把
      // 累积部分挂到错误上（PARTIAL_ON_ERROR_KEY，见 agent-orchestrator run
      // catch）——已流式转发的 delta 不能丢。按 socket 状态区分三种场景：
      if (controller.signal.aborted) {
        const partial = this.partialFromError(err);
        if (sse.isDisconnected()) {
          // 断连（连接已关）：不写 error 事件（写了会触发未处理 error，既有
          // 行为）——日志措辞「客户端断开」；累积部分尽力落库（与正常断连
          // 路径一致：断连不丢已生成部分，见文件头断连处理注释）
          this.logger.warn(
            `客户端断开，生成中止: session=${sessionId}`,
            err instanceof Error ? err.message : undefined,
          );
          if (partial) {
            await this.persistPartial(
              sessionId,
              partial.content,
              partial.reasoning,
              partial.references,
            );
          }
          return;
        }
        // stop（socket 仍开）降级路径：stop 与真实错误同时发生——无法按正常
        // stop 路径收尾（发 done，见上方 abort 处理），降级为「落库 partial +
        // error generation_stopped」（客户端展示「已停止」语义；区别于正常
        // stop 路径的 done：该路径是 stop+异常同时发生的降级，真实错误细节
        // 只进日志，见文件头停止生成注释）
        this.logger.warn(`生成被用户停止: session=${sessionId}`);
        this.logger.error(
          `对话生成失败（用户停止与管线错误竞态）: session=${sessionId}`,
          err instanceof Error ? err.stack : String(err),
        );
        if (partial) {
          await this.persistPartial(
            sessionId,
            partial.content,
            partial.reasoning,
            partial.references,
          );
        }
        sse.send({
          type: 'error',
          code: ERROR_CODE_GENERATION_STOPPED,
          message: '生成已停止',
        });
        return;
      }
      // 真实错误：SSE error 事件（脱敏文案，内部细节只进 logger，见文件头
      // 错误码设计注释）+ 结束流（HTTP 200 保持，不 500 断开）
      const { code, message } = this.mapError(err);
      this.logger.error(
        `对话生成失败: session=${sessionId} code=${code}`,
        err instanceof Error ? err.stack : String(err),
      );
      sse.send({ type: 'error', code, message });
    } finally {
      // Task 2.10：注销生成任务（防泄漏；controller 参数防「旧生成的 finally
      // 注销新注册」竞态，见 registry.unregister 注释）——sse.end 仍最后执行
      this.generationRegistry.unregister(sessionId, controller);
      sse.end();
    }
  }

  /**
   * 中断路径（stop/断连）的落库：尽力而为——落库失败仅记日志（stop 时客户端
   * 仍开、可发 error 事件告知；断连时无从告知，已生成部分丢失可接受，重试
   * 语义同正常失败）。统一标记 interrupted=true（决策，见文件头 Task 2.10
   * 注释：断连与 stop 都是生成未完成——正常完成 false，前端据此展示「已
   * 停止」状态）。空内容也落一条空 assistant（与正常路径一致：user 消息已
   * 落库，成对语义不被中断打破）。references 随 partial assistant 一并落库
   * （中断前已生成的引用不丢，Task 2.5）。返回落库的消息（stop 路径发 done
   * 需要 messageId）；失败返回 null。
   */
  private async persistPartial(
    sessionId: string,
    content: string,
    reasoning: string | null,
    references: RagReference[],
    usage?: { inputTokens?: number; outputTokens?: number; cacheHitTokens?: number },
  ): Promise<Message | null> {
    try {
      return await this.messageService.createAssistantMessage(
        sessionId,
        content,
        {
          reasoning: reasoning ?? null,
          references,
          usage: usage ?? null,
          // 决策：断连与 stop 都标 interrupted=true（生成未完成；正常完成 false，
          // 见文件头 Task 2.10 注释）
          interrupted: true,
        },
      );
    } catch (err) {
      this.logger.error(
        `中断后累积内容落库失败: session=${sessionId}`,
        err instanceof Error ? err.stack : String(err),
      );
      return null;
    }
  }

  /**
   * 从错误对象上取回 Agent 挂载的累积生成部分（Task 2.10 质量审查整改）：
   * 中止与真实错误竞态时 agent-orchestrator run catch 把已流式转发的累积
   * （正文/思考/引用）挂到错误上（PARTIAL_ON_ERROR_KEY，见 agent.types.ts
   * 注释），此处取回落库 partial——已生成内容不丢。未挂载（错误非来自 Agent
   * 管线，如 sse.send 抛错）→ null（不落库，仅发收尾事件）。
   */
  private partialFromError(err: unknown): PartialOnError | null {
    if (typeof err !== 'object' || err === null) return null;
    const partial = (err as Record<string, unknown>)[PARTIAL_ON_ERROR_KEY];
    if (typeof partial !== 'object' || partial === null) return null;
    const p = partial as PartialOnError;
    return typeof p.content === 'string' ? p : null;
  }

  /**
   * 错误 → SSE error 事件（code + 脱敏 message）的映射（质量审查整改 #4/#6）：
   * 原始 err.message（可能含 DB 连接串/内网地址/供应商详情）只进 logger.error，
   * 事件透传固定中文文案，避免信息泄露。判定优先级：503 未配置模型 → 超时
   * （TimeoutError，AbortSignal.timeout 触发——注意 Node 中 DOMException 不是
   * Error 子类，按 name 判断）→ 网络错误（供应商「连接供应商失败」包装）→
   * 通用 chat_model_error 兜底。Task 2.8 变更：检索失败不再经此映射（search_kb
   * 工具内部捕获 → 工具级错误，见文件头错误码设计注释）。
   */
  private mapError(err: unknown): { code: string; message: string } {
    if (err instanceof ServiceUnavailableException) {
      return {
        code: ERROR_CODE_NO_DEFAULT_MODEL,
        message: '未配置默认对话模型，请先在模型管理中设置',
      };
    }
    if (this.isNamedError(err, 'TimeoutError')) {
      return {
        code: ERROR_CODE_TIMEOUT,
        message: '模型响应超时，请稍后重试',
      };
    }
    if (err instanceof Error && err.message.includes('连接供应商失败')) {
      return {
        code: ERROR_CODE_NETWORK,
        message: '网络连接异常，请稍后重试',
      };
    }
    return { code: ERROR_CODE_CHAT_MODEL, message: '模型调用失败，请稍后重试' };
  }

  /** 判断错误 name（兼容 DOMException——它不是 Error 子类，见 mapError 注释） */
  private isNamedError(err: unknown, name: string): boolean {
    return (
      typeof err === 'object' &&
      err !== null &&
      (err as { name?: unknown }).name === name
    );
  }

  /** 模型用量累计（生成完成后调用；失败仅日志，不阻断对话） */
  private async recordUsage(
    userId: string,
    usage?: { inputTokens?: number; outputTokens?: number; cacheHitTokens?: number },
  ): Promise<void> {
    if (!usage || (usage.inputTokens ?? 0) === 0 && (usage.outputTokens ?? 0) === 0) {
      return;
    }
    try {
      const model = await this.modelService.getDefault('chat');
      if (!model) return;
      await this.usageService.record({
        userId,
        modelId: model.id,
        modelName: model.name,
        type: model.type,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      });
    } catch (err) {
      this.logger.warn(`模型用量记录失败: userId=${userId}`, err as Error);
    }
  }
}
