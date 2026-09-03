// Agent 编排服务（Task 2.8）：ReAct 工具调用循环——接管 POST
// /chat/sessions/:id/messages 的生成回路（方案 A：Task 2.5 的固定五阶段管线
// 改造为 Agent 的 KB 检索工具，见 chat-orchestrator.service.ts 文件头）。
// Task 2.9：@提及检索范围 + 附件占位——run() 解析 content 内嵌 @kb:/@file:
// 标记（与 body 显式 mentionKbIds/mentionKnowledgeIds 双通道合并去重）→ 有
// 提及 → 检索范围 = 提及范围（覆盖会话 kbIds，用户显式指定——即使 X 不在
// 会话 kbIds 也按 X 检索；@file:F 限定文件 chunks；两者并集）→ 经
// ToolExecutionContext.scope 传 search_kb（无提及缺省 → 会话 kbIds 既有语义）；
// user 消息内容 = cleanedText（移除提及标记，避免 LLM 看到垃圾标记）。
//
// 循环语义（max MAX_TOOL_ROUNDS=5 轮）：
// 1. 装配：载入会话（kbIds 决定 search_kb 是否注入）、历史（排除当前消息）、
//    工具列表（kbIds 非空 → search_kb；与
//    系统提示同步，见 buildSystemPrompt）
// 2. 每轮：stage(generate start)（仅首轮）→ chatStream（系统提示 + 历史 +
//    当前问题 + 工具结果回填；tools 透传供应商）→ 累积 delta/reasoning_delta/
//    toolCalls/usage（usage 跨轮逐项相加——多轮只取最后一轮会少报，见
//    run() 中 usage 累积注释）
// 3. 本轮有 toolCalls：回填 assistant 消息（含 tool_calls，先于 tool 结果——
//    OpenAI 协议顺序；reasoning_content 携带本轮累积思考——DeepSeek R1
//    工具模式要求回传，否则第二轮思考上下文断裂）→ 逐个执行工具（阶段事件
//    search/rerank/merge 由 search_kb 工具内部发出；tool_call 事件在执行
//    **完成后**发出，携带 result/status，前端工具树节点——单事件语义见
//    agent.types.ts 注释）→ tool 结果消息回填 → continue（下一轮）
// 4. 本轮无 toolCalls → 正文即最终答案（break）；第 6 轮被上限拦截 → 以已
//    累积文本强制完成（不抛错——见 MAX_TOOL_ROUNDS 注释）；正文为空时生成
//    占位提示（质量审查整改：LLM 全程只输出工具调用时强制完成无正文，见
//    收尾注释）
// 5. 收尾：正文 [n] 对齐（ReferencesService.align，Task 2.6 语义不变——
//    正文无 [n] → 空引用）→ references 事件（与落库同一份）→ 返回
//    RagPipelineResult（编排器落库 assistant + stage(generate done)/done）
//
// 事件语义（方案 A 对 Task 2.5 的调整）：
// - query_understand 阶段取消：改写职责并入 LLM 工具调用参数（LLM 结合历史
//   自行决定检索 query——少一次 LLM 往返，检索质量由模型决定）
// - search/rerank/merge 阶段事件在 search_kb 工具执行时发出（前端检索语义
//   search_kb 无阶段事件（不对应 RAG 阶段）
// - stage(generate start) 仅首轮发（整个循环 = 一次 generate）；stage(generate
//   done) 由编排器在 assistant 落库后发（事件序不变，见编排器注释）
//
// 断连/错误语义（同 Task 2.4/2.5 约定）：
// - signal 经 chatStream 透传供应商（断连中止上游生成）；循环内 abort 检查点
//   与 chatStream 抛 AbortError 两条路径都返回已累积部分（断连不丢已生成
//   内容，不做 align——partial 正文可能未出现 [n]，引用保留工具结果）
// - 工具内部失败（检索失败/搜索不可用）→ status error + 友好文本回填 LLM
//   （对话继续，模型降级回答）——区别于 Task 2.5 管线检索失败 → SSE error
//   中断整个生成（工具级错误语义见 tool.interface.ts 注释）
// - chatStream 抛真实错误 → 原样传播（编排器 mapError 转 SSE error 事件）
import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CHAT_MODEL_SERVICE } from '../../model/chat-model.interface.js';
import { LangfuseService } from '../../observability/langfuse.service.js';
import type { ObsSpan } from '../../observability/langfuse.service.js';
import type {
  ChatMessage,
  ChatModelService,
  ChatToolCall,
  ToolDefinition,
} from '../../model/chat-model.interface.js';
import { MessageService } from '../message.service.js';
import { Session } from '../session.entity.js';
import { MentionService } from '../mention.service.js';
import type { SseService } from '../sse/sse.service.js';
import type { RagReference, RagPipelineResult } from '../pipeline/rag.types.js';
import { ReferencesService } from '../pipeline/references.service.js';
import type { AgentRunOptions } from './agent.types.js';
import { PARTIAL_ON_ERROR_KEY, TOOL_RESULT_MAX_LENGTH } from './agent.types.js';
import { KbSearchTool } from './tools/kb-search.tool.js';
import { GraphSearchTool } from './tools/graph-search.tool.js';
import type {
  MentionScope,
  Tool,
  ToolExecutionResult,
} from './tools/tool.interface.js';
import { MENTION_ONLY_PLACEHOLDER } from './agent.types.js';

/** ReAct 循环轮数上限：最多 8 轮 LLM 调用（每轮可含工具执行；第 9 轮被
 * 拦截 → 以已累积文本强制完成——防止模型陷入工具调用死循环烧 token。
 * 原 5 轮在复杂文档（多块型答案、MMLongBench 参考文献跨 chunk）时模型
 * 反复检索未收敛就耗尽 → 空回答；8 轮给足收敛空间，仍防死循环） */
export const MAX_TOOL_ROUNDS = 8;
/** 历史加载条数（多轮对话指代上下文；同原管线 RAG_HISTORY_LIMIT 值） */
export const AGENT_HISTORY_LIMIT = 10;
/** 记忆源消息条数（滑动窗口外可纳入 LLM 摘要的早期历史上限——
 *  LLM 上下文记忆压缩，见 buildMemorySummary 注释） */
export const AGENT_MEMORY_SOURCE_LIMIT = 30;

/** 流式 tool_calls 的最终形态（ChatStreamChunk.toolCalls 元素——provider 已
 * 累积完整：id/name/arguments 字符串） */
interface StreamToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** 单轮 chatStream 结果：本轮文本（assistant 消息回填用）+ 本轮深度思考
 * （reasoning_content 回填用——DeepSeek R1 工具模式要求 assistant 消息带
 * 推理内容，见文件头收尾注释）+ 工具调用 + usage（跨轮累积在 run() 中求和，
 * 见 usage 累积注释） */
interface RoundResult {
  text: string;
  reasoning?: string;
  toolCalls: StreamToolCall[];
  usage?: { inputTokens?: number; outputTokens?: number; cacheHitTokens?: number };
}

@Injectable()
export class AgentOrchestratorService {
  private readonly logger = new Logger(AgentOrchestratorService.name);

  constructor(
    private readonly messageService: MessageService,
    // 载入会话（kbIds 决定 search_kb 注入与检索范围）——归属已由编排器在
    // createUserMessage 事务内校验，此处仅读 kbIds，不做二次归属判定
    @InjectRepository(Session)
    private readonly sessionRepo: Repository<Session>,
    // LLM 对话抽象（工具调用由供应商流式返回，见 providers tool_calls 支持）
    @Inject(CHAT_MODEL_SERVICE)
    private readonly chatModel: ChatModelService,
    // 内置工具：企业知识库检索（search_kb）——装配
    // 条件见 run() 注释（工具无状态单例，kbIds 经上下文透传）
    private readonly kbSearchTool: KbSearchTool,
    private readonly graphSearchTool: GraphSearchTool,
    // 引用对齐（正文 [n] 兜底，Task 2.6 语义不变，见文件头收尾注释）
    private readonly referencesService: ReferencesService,
    // Task 2.9：@提及解析（content 内嵌 @kb:/@file: → 检索范围 + cleanedText）
    private readonly mentionService: MentionService,
    // Langfuse 观测（可选；关闭时 no-op）
    private readonly langfuse: LangfuseService,
  ) {}

  /**
   * 运行 ReAct 工具循环（见文件头注释）：
   * @param sessionId 会话 id（kbIds 检索范围 + search_kb 注入条件）
   * @param userId 归属用户（与编排器 createUserMessage 校验同源；当前不消费）
   * @param content 当前用户消息（generate 的当前问题；历史排除当前消息）
   * @param sse SSE 写入器（stage/delta/reasoning_delta/tool_call/references 事件）
   * @param signal 断连取消信号（abort 检查点，见文件头断连注释）
   * @param excludeMessageId 当前用户消息 id（历史加载排除——编排器落库后传入）
   * @param opts Agent 运行选项
   * @returns 生成结果（content/references/reasoning/usage），编排器落库
   */
  async run(
    sessionId: string,
    userId: string,
    content: string,
    sse: SseService,
    signal: AbortSignal,
    excludeMessageId: string,
    opts: AgentRunOptions,
    obsSpan?: ObsSpan | null,
  ): Promise<RagPipelineResult> {
    // 生成累积（断连/中止路径返回已生成前缀与错误挂载，见文件头断连注释与
    // 下方 catch）：引用数组经参数透传 runPipeline 共享——chatRound push
    // 原地累积（同址可见）；usage/abortedResult 在 runPipeline 内声明（usage
    // 由循环重赋值、abortedResult 捕获同一变量，见 runPipeline 注释）
    const textParts: string[] = [];
    const reasoningParts: string[] = [];
    // search_kb 工具累积的引用（落库来源；声明在 run 侧——中止+真实错误
    // 竞态时挂到错误上，见下方 catch）
    const references: RagReference[] = [];

    // Task 2.10 质量审查整改（stop/断连与真实错误竞态）：管线抛真实错误
    // （工具 DB 故障等）与中止（stop/断连共用同一 abort 信号，区别只在收尾
    // 事件，见编排器文件头）同时发生时，已流式转发的 delta 不能丢——把累积
    // 部分挂到错误对象上再抛（编排器 catch 据此落库 partial，见
    // chat-orchestrator.service.ts runStream catch 注释；错误键见
    // agent.types.ts PARTIAL_ON_ERROR_KEY）。挂载的 partial 不含 usage——
    // 中断路径的 error generation_stopped 事件无 usage 字段（见编排器 catch）
    try {
      return await this.runPipeline(
        sessionId,
        userId,
        content,
        sse,
        signal,
        excludeMessageId,
        opts,
        textParts,
        reasoningParts,
        references,
        obsSpan,
      );
    } catch (err) {
      // 中止信号已触发（stop 或断连——编排器用 sse.isDisconnected() 区分）：
      // 真实错误与中止竞态 → 挂载累积部分（已流式转发的文本不丢）；非中止
      // 路径不挂（编排器按真实错误处理，无 partial 语义，见编排器 catch）
      if (signal.aborted && typeof err === 'object' && err !== null) {
        (err as Record<string, unknown>)[PARTIAL_ON_ERROR_KEY] = {
          content: textParts.join(''),
          reasoning: reasoningParts.join('') || null,
          references: [...references],
        };
      }
      throw err;
    }
  }

  /** ReAct 循环主体（run() 的 try 包装目标——中止与真实错误竞态时 run()
   * 把累积部分挂到错误上再抛，见 run() 注释）。参数与 run() 一致，另透传
   * 累积引用数组（textParts/reasoningParts/references——chatRound push 原地
   * 累积，run() 据此在错误竞态时挂载 partial）；usage 与 abortedResult 在
   * 本方法内声明（usage 由循环重赋值、abortedResult 捕获同一变量，供各
   * abort 检查点返回已累积结果）。 */
  private async runPipeline(
    sessionId: string,
    userId: string,
    content: string,
    sse: SseService,
    signal: AbortSignal,
    excludeMessageId: string,
    opts: AgentRunOptions,
    textParts: string[],
    reasoningParts: string[],
    references: RagReference[],
    obsSpan?: ObsSpan | null,
  ): Promise<RagPipelineResult> {
    // usage 跨轮累积（质量审查整改）：多轮工具循环只取最后一轮会少报 done
    // 事件 token 用量——逐轮 inputTokens/outputTokens 相加（供应商单流内
    // 最后一块覆盖语义不变，见 chatRound；缺失字段按 0 计）。仅正常完成
    // 路径返回值携带（run 侧不持有——中断路径的 error generation_stopped
    // 事件无 usage 字段，见 run() 注释）
    let usage: { inputTokens?: number; outputTokens?: number; cacheHitTokens?: number } | undefined;
    // abort 检查点：断连 → 返回已算出的结果（引用保留工具已返回的部分；
    // 编排器落库 partial assistant，见文件头断连注释）。不做 align——partial
    // 正文可能尚未出现 [n]，align 会误剔（同 Task 2.6 断连语义）
    const abortedResult = (): RagPipelineResult => ({
      content: textParts.join(''),
      reasoning: reasoningParts.join('') || null,
      references: [...references],
      ...(usage ? { usage } : {}),
    });

    // 0. 载入会话（kbIds）：检索范围 + search_kb 注入条件；会话不存在（生成
    //    期被删的罕见竞态）按无知识库处理（降级为无工具生成，不额外报错）
    const session = await this.sessionRepo.findOne({
      where: { id: sessionId },
    });
    const kbIds = session?.kbIds ?? [];
    // abort 检查点：断连后不再启动任何阶段（不发事件，编排器落库空 partial）
    if (signal.aborted) {
      return abortedResult();
    }
    // Task 2.9：@提及解析（双通道——content 内嵌标记 + body 显式数组，合并
    // 去重；cleanedText 作为当前消息传给 LLM 的内容，移除提及标记避免 LLM
    // 看到垃圾标记，见 mention.service.ts 文件头注释）
    const parsed = this.mentionService.parse(content);
    const mentionKbIds = [
      ...new Set([...parsed.kbIds, ...(opts.mentionKbIds ?? [])]),
    ];
    const mentionKnowledgeIds = [
      ...new Set([...parsed.knowledgeIds, ...(opts.mentionKnowledgeIds ?? [])]),
    ];
    // 检索范围（设计决策，见文件头）：有 @提及 → 覆盖会话 kbIds（@kb:X 即使
    // 不在会话 kbIds 也按 X 检索——用户显式指定；@file:F 限定文件 chunks；
    // 两者并集由 VectorService SQL OR 语义承担）；无提及 → 不传 scope，工具
    // 退回会话 kbIds（既有语义）
    const searchScope: MentionScope | undefined =
      mentionKbIds.length > 0 || mentionKnowledgeIds.length > 0
        ? { kbIds: mentionKbIds, knowledgeIds: mentionKnowledgeIds }
        : undefined;

    // abort 检查点：附件加载/提及解析后断连同样返回已累积（不启动阶段）
    if (signal.aborted) {
      return abortedResult();
    }
    // 历史加载（窗口 = 最近 10 条 + 记忆源 = 再往前 30 条）——多轮对话指代
    // 上下文不因无知识库丢失；窗口外早期历史经 LLM 压缩成记忆注入（长会话
    // 不丢早期信息，见 buildMemorySummary 注释）
    const history = await this.messageService.listRecentMessages(
      sessionId,
      AGENT_HISTORY_LIMIT + AGENT_MEMORY_SOURCE_LIMIT,
      excludeMessageId,
    );
    if (signal.aborted) {
      return abortedResult();
    }
    // 记忆压缩：窗口外历史（若超过窗口）→ LLM 摘要（缓存于 session.memorySummary，
    // 窗口外新增时增量重摘要）；摘要注入 system prompt
    const memorySummary = await this.buildMemorySummary(
      sessionId,
      history,
      signal,
      userId,
    );

    // 工具装配（方案 A 设计决策，见文件头）：kbIds 非空 → search_kb + search_graph
    // ——hybrid→graph 双工具工作流：search_kb 语义检索文本内容（[n] 引用），
    // search_graph 图谱检索实体关系（解耦避免图谱噪声污染语义召回，见
    // graph-search.tool.ts 文件头）；工具顺序由系统提示编排（先 hybrid，
    // 实体/多跳问题再 graph）
    const tools: Tool[] = kbIds.length > 0
      ? [this.kbSearchTool, this.graphSearchTool]
      : [];
    const toolDefs: ToolDefinition[] = tools.map((t) => t.definition);
    const toolByName = new Map(tools.map((t) => [t.definition.name, t]));

    // messages = 系统提示 + 历史 + 当前问题（原始内容——检索 query 由 LLM
    // 工具调用参数决定）。历史 role 安全映射（同原管线注释）：Message 表 role
    // 枚举含 'system'——过滤到 user/assistant（LLM 对话协议除注入的 system
    // 提示外只接受这两种角色）
    const isChatMessage = (m: {
      role: string;
      content: string;
    }): m is { role: 'user' | 'assistant'; content: string } =>
      m.role === 'user' || m.role === 'assistant';
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: this.buildSystemPrompt(kbIds) + memorySummary,
      },
      ...history.filter(isChatMessage).map((m) => ({
        role: m.role,
        content: m.content,
      })),
      // Task 2.9：当前消息 = cleanedText（提及标记移除）+ 附件占位（多模态
      // P2 文本降级）——LLM 看到的是干净的用户内容 + 附件文件名提示
      {
        role: 'user',
        content: parsed.cleanedText,
      },
    ];

    // 首轮：stage(generate start)——整个 ReAct 循环 = 一次 generate（事件语义
    // 见文件头；stage(generate done) 由编排器在 assistant 落库后发送）
    sse.send({ type: 'stage', stage: 'generate', status: 'start' });

    // ReAct 循环（max MAX_TOOL_ROUNDS 轮，见常量注释）
    for (let round = 1; round <= MAX_TOOL_ROUNDS; round++) {
      // abort 检查点：断连后不启动新一轮生成（编排器落库已累积部分）
      if (signal.aborted) {
        return abortedResult();
      }
      // chatStream：本轮累积（delta/reasoning_delta 事件由 chatRound 转发；
      // 断连在生成循环内检查——抛 AbortError 或 break 两路径都返回已累积）
      const roundResult = await this.chatRound(
        messages,
        sse,
        signal,
        toolDefs,
        textParts,
        reasoningParts,
        userId,
        obsSpan,
      );
      // usage 跨轮累积（质量审查整改）：多轮工具循环只取最后一轮会少报
      // done 事件 token 用量——逐轮 inputTokens/outputTokens 相加（供应商
      // 单流内最后一块覆盖语义不变，见 chatRound；缺失字段按 0 计，含
      // 只回 completion_tokens 的门槛放宽形态）
      if (roundResult.usage) {
        usage = {
          inputTokens:
            (usage?.inputTokens ?? 0) + (roundResult.usage.inputTokens ?? 0),
          outputTokens:
            (usage?.outputTokens ?? 0) + (roundResult.usage.outputTokens ?? 0),
          cacheHitTokens:
            (usage?.cacheHitTokens ?? 0) + (roundResult.usage.cacheHitTokens ?? 0),
        };
      }
      // abort 检查点：chatStream 期间断连（chatRound 已返回已累积部分）
      if (signal.aborted) {
        return abortedResult();
      }
      if (roundResult.toolCalls.length === 0) {
        // 无工具调用 → 本轮文本即最终答案（break 出循环）
        break;
      }
      // 有工具调用：先回填 assistant 消息（含 tool_calls——必须先生于 tool
      // 结果消息，OpenAI 协议顺序；文本为本轮累积，通常为空——模型输出纯
      // 工具调用）。reasoning_content：携带本轮累积的深度思考（DeepSeek R1
      // 工具模式要求回传，否则第二轮思考上下文断裂；无思考输出则缺省字段）
      messages.push({
        role: 'assistant',
        content: roundResult.text,
        ...(roundResult.reasoning
          ? { reasoning_content: roundResult.reasoning }
          : {}),
        tool_calls: roundResult.toolCalls.map((tc): ChatToolCall => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.arguments },
        })),
      });
      // 执行工具（tool_call 事件 + tool 结果回填 + 引用累积）；断连在工具间
      // 检查——已执行工具的结果保留
      const toolRefs = await this.executeToolCalls(
        roundResult.toolCalls,
        toolByName,
        messages,
        sse,
        signal,
        kbIds,
        searchScope,
        userId,
        obsSpan,
      );
      references.push(...toolRefs);
      if (signal.aborted) {
        return abortedResult();
      }
      // continue：下一轮（第 6 轮被 for 条件拦截 → 循环后强制完成）
    }

    // 正常完成或轮数上限（强制完成）：正文 → 空正文占位（质量审查整改：
    // LLM 全程只输出工具调用、第 6 轮被上限强制结束时正文为空串——任务书
    // 语义「强制生成」，空正文落库无意义；生成占位提示（用户可见的重试引导
    // 文案，区别于静默空回复））→ 生成后兜底对齐（Task 2.6）：扫描正文 [n]
    // 提取引用编号，剔除未被引用的项（编号保留原文编号；正文无 [n] → 空
    // 引用）。对齐后发 references 事件（载荷与编排器随后落库的同一份引用
    // 一致——前端据此渲染引用区）
    const fullText = textParts.join('');
    const finalContent =
      fullText.length > 0
        ? fullText
        : '模型未生成有效回复，请重试或更换问题表述。';
    const aligned = this.referencesService.align(finalContent, references);
    if (aligned.references.length > 0) {
      sse.send({ type: 'references', references: aligned.references });
    }
    return {
      content: finalContent,
      reasoning: reasoningParts.join('') || null,
      references: aligned.references,
      ...(usage ? { usage } : {}),
    };
  }

  /**
   * 单轮 chatStream：系统提示 + 历史 + 当前问题 + 工具结果回填 → 累积
   * 文本/reasoning/toolCalls/usage 并转发 delta/reasoning_delta 事件。
   * 断连（生成循环内 abort）：
   * - 循环顶部检查命中 break（for await 自然收尾、无异常）→ 返回已累积
   * - chatStream 抛 AbortError（供应商 fetch 流被中断）→ catch 分支同样
   *   返回已累积（run() 的 abort 守卫据此落库 partial）
   * 真实错误原样传播（run() → 编排器 mapError，见文件头错误语义）。
   */
  private async chatRound(
    messages: ChatMessage[],
    sse: SseService,
    signal: AbortSignal,
    tools: ToolDefinition[],
    textParts: string[],
    reasoningParts: string[],
    userId?: string,
    obsSpan?: ObsSpan | null,
  ): Promise<RoundResult> {
    const roundText: string[] = [];
    const roundReasoning: string[] = [];
    const toolCalls: StreamToolCall[] = [];
    let usage: RoundResult['usage'];
    // Langfuse：LLM generation span（挂会话 trace 下——parent 为编排器传入
    // 的 obsSpan；无 trace（历史/独立路径）→ 独立 generation 兜底）
    const obsGen = await this.langfuse.generation(obsSpan ?? null, 'llm', messages, {
      model: 'chat',
    });
    try {
      for await (const chunk of this.chatModel.chatStream(messages, {
        signal,
        tools,
        userId,
      })) {
        // 断连检查点：停止转发与累积（连接已关，send 守卫也会跳过写入）
        if (signal.aborted) break;
        if (chunk.reasoning) {
          sse.send({ type: 'reasoning_delta', text: chunk.reasoning });
          reasoningParts.push(chunk.reasoning);
          roundReasoning.push(chunk.reasoning);
        }
        if (chunk.text) {
          sse.send({ type: 'delta', text: chunk.text });
          textParts.push(chunk.text);
          roundText.push(chunk.text);
        }
        // 流式 tool_calls（provider 已累积完整，见 providers 注释）
        if (chunk.toolCalls && chunk.toolCalls.length > 0) {
          toolCalls.push(...chunk.toolCalls);
        }
        if (chunk.usage) usage = chunk.usage;
      }
    } catch (err) {
      // 断连/stop 导致的生成中止（AbortError 从 for await 抛出）：返回已累积
      // 部分（run() 的 abort 守卫落库 partial；不做 align，见文件头断连注释）
      if (signal.aborted) {
        // 日志措辞区分（Task 2.10 质量审查整改）：stop 与断连共用 abort 信号
        // ——按 sse.isDisconnected() 区分措辞，避免 stop 场景误记「客户端断开」
        // 误导排障（与编排器 catch 同一措辞约定）
        this.logger.warn(
          sse.isDisconnected()
            ? '客户端断开，生成中止，返回已累积内容'
            : '生成被用户停止，返回已累积内容',
        );
        obsGen.end({
          output: { text: roundText.join(''), toolCalls: toolCalls.length },
          usage,
        });
        return {
          text: roundText.join(''),
          ...(roundReasoning.length > 0
            ? { reasoning: roundReasoning.join('') }
            : {}),
          toolCalls,
          ...(usage ? { usage } : {}),
        };
      }
      obsGen.end({ output: { text: roundText.join('') }, usage });
      throw err; // 真实错误 → 编排器 mapError（见文件头错误语义）
    }
    return {
      text: roundText.join(''),
      ...(roundReasoning.length > 0
        ? { reasoning: roundReasoning.join('') }
        : {}),
      toolCalls,
      ...(usage ? { usage } : {}),
    };
  }

  /**
   * 逐个执行工具调用：参数解析（JSON 宽松兜底）→ 工具执行（阶段事件由
   * search_kb 内部发出）→ tool_call 事件（执行完成后单事件，含 result/status
   * ——前端工具树节点，见 agent.types.ts 注释）→ tool 结果消息回填。
   * 防御：工具名不存在（LLM 幻觉）→ 错误文本回填（对话继续）；工具实现
   * 抛错 → 兜底错误文本（工具契约是返回错误结果，抛错说明内部 bug——不
   * 中断整个生成）。断连：工具间检查 signal.aborted → 停止执行剩余工具
   * （已执行工具的结果保留——references 返回给 run() 累积）。
   */
  private async executeToolCalls(
    calls: StreamToolCall[],
    toolByName: Map<string, Tool>,
    messages: ChatMessage[],
    sse: SseService,
    signal: AbortSignal,
    kbIds: string[],
    // Task 2.9：@提及检索范围（有提及 → search_kb 覆盖会话 kbIds，见文件头）
    scope: MentionScope | undefined,
    userId?: string,
    obsSpan?: ObsSpan | null,
  ): Promise<RagReference[]> {
    const references: RagReference[] = [];
    for (const call of calls) {
      // 断连检查点：停止执行剩余工具（已执行工具的结果保留）
      if (signal.aborted) break;
      const tool = toolByName.get(call.name);
      // 参数解析：LLM 流式输出可能产生非法 JSON（截断/格式漂移）——按空参
      // 兜底（不中断循环；空参下工具按默认值执行）
      let args: Record<string, unknown>;
      try {
        args = call.arguments
          ? (JSON.parse(call.arguments) as Record<string, unknown>)
          : {};
      } catch {
        this.logger.warn(
          `工具参数 JSON 解析失败，按空参处理: name=${call.name}`,
        );
        args = {};
      }
      let result: ToolExecutionResult;
      if (!tool) {
        // LLM 幻觉了不存在的工具名：错误文本回填（模型据此降级回答）
        result = {
          content: `工具不存在: ${call.name}，请基于已有知识回答。`,
          status: 'error',
        };
      } else {
        // Langfuse：工具执行 span（挂会话 trace 下——input=args，end=结果
        // 摘要，UI 里 tool 调用与 LLM generation 同树可见耗时）
        const obsTool = await this.langfuse.span(obsSpan ?? null, `tool:${call.name}`, args);
        try {
          result = await tool.execute(args, { sse, signal, kbIds, scope, userId });
          obsTool.end({
            status: result.status,
            result: (result.content ?? '').slice(0, 500),
          });
        } catch (err) {
          // 工具实现抛错（防御性兜底，见方法头注释）：不中断整个生成
          obsTool.end({
            status: 'error',
            error: err instanceof Error ? err.message : String(err),
          });
          this.logger.error(
            `工具执行异常: name=${call.name}`,
            err instanceof Error ? err.stack : String(err),
          );
          result = {
            content: `工具执行失败: ${call.name}，请稍后重试。`,
            status: 'error',
          };
        }
      }
      // search_kb 附加的引用数据（落库来源）
      if (result.references) {
        references.push(...result.references);
      }
      // tool_call 事件：执行完成后单事件（含 result/status；result 截断防
      // 超长事件——全文仍回填 LLM，截断只作用于事件载荷，见 agent.types.ts）
      sse.send({
        type: 'tool_call',
        call: {
          id: call.id,
          parentId: null, // 树形深度简化：恒 null（见 agent.types.ts 注释）
          name: call.name,
          arguments: args,
          result: this.truncateToolResult(result.content),
          status: result.status,
        },
      });
      // 工具结果回填（role:'tool' 消息：tool_call_id 指向 assistant 的调用
      // ——OpenAI 协议；Ollama 请求映射时剥除，见 ollama.provider.ts）
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: result.content,
      });
    }
    return references;
  }

  /** 工具结果截断（tool_call 事件 result 载荷上限，见 agent.types.ts 注释） */
  private truncateToolResult(content: string): string {
    return content.length > TOOL_RESULT_MAX_LENGTH
      ? `${content.slice(0, TOOL_RESULT_MAX_LENGTH)}…`
      : content;
  }

  /**
   * 系统提示构建（与工具装配同步，见 run() 注释——开关生效双保险）：
   * - kbIds 非空：search_kb 使用说明 + 引用规则（标注引用 [n]）；
   *   kbIds 空：「未关联知识库」说明（提示用户关联，同原 NO_KB 语义）
   * - 深度思考说明（reasoning 流展示，Task 2.8 产品语义）
   */
  private buildSystemPrompt(kbIds: string[]): string {
    const capabilities: string[] = [];
    if (kbIds.length > 0) {
      capabilities.push(
        '需要知识库内容/事实/引用片段时，先调用 search_kb 检索（返回 [n] 编号资料列表，回答标注引用 [n]）。' +
        'search_kb 的 topK 参数可调：先从 k=8 开始检索；若结果不足以回答（多文档对比/跨页/需更多证据），' +
        '逐步调大 topK（8 → 12 → 16 → 20）扩大保留候选——优先扩大 topK 而非更换查询词。' +
        '当问题涉及实体间关系、跨文档实体关联或多跳推断（如"X 与 Y 的关系"、"与 X 相关的实体"）时，' +
        '在 search_kb 之后再调用 search_graph 查询知识图谱补充实体网络（图谱信息单独呈现，不作 [n] 引用）。',
      );
    } else {
      capabilities.push(
        '当前会话未关联知识库，无法提供企业知识库资料。请基于常识直接回答，并提示用户先关联知识库以获得更准确的回答。',
      );
    }
    return [
      '你是 OhMyDocAgent 智能助手，基于企业知识库检索增强回答。工作方式：',
      ...capabilities,
      '基于工具返回的资料回答，回答中标注引用 [n]（n 为资料编号）；资料不足时明确说明，不要编造。',
      '回答前可以深入思考（思考过程会自动展示，无需在回答中说明）。',
    ].join('\n');
  }

  /**
   * 上下文记忆压缩（LLM 摘要，参考 WeKnora 历史截断 + 增强为「压缩而非丢弃」）：
   * - 窗口 = 最近 AGENT_HISTORY_LIMIT 条（滑动的对话上下文）
   * - 窗口外 = 更早的历史（若总历史超过窗口）——经 LLM 压缩成一段记忆
   * - 增量：session.memorySummary 存 `{summary, count}`（count = 已摘要消息数）；
   *   窗口外消息数变化（新消息滚出窗口）→ 重新摘要；未变 → 复用（省 LLM 调用）
   * - 返回注入 system prompt 的文本（无记忆 → 空串）
   * 失败降级：压缩失败仅日志，返回空（对话不受阻，历史窗口仍可用）
   */
  private async buildMemorySummary(
    sessionId: string,
    history: Array<{ role: string; content: string }>,
    signal: AbortSignal,
    userId?: string,
  ): Promise<string> {
    try {
      const chatMessages = history.filter(
        (m) => m.role === 'user' || m.role === 'assistant',
      );
      // 窗口外 = 总历史 - 窗口
      if (chatMessages.length <= AGENT_HISTORY_LIMIT) return '';
      const outside = chatMessages.slice(0, -AGENT_HISTORY_LIMIT);
      // 读已有记忆（增量判断）
      let saved: { summary?: string; count?: number } | null = null;
      try {
        const sess = await this.sessionRepo.findOne({
          where: { id: sessionId },
          select: { memorySummary: true },
        });
        if (sess?.memorySummary) saved = JSON.parse(sess.memorySummary);
      } catch { /* 解析失败按无记忆处理 */ }
      if (saved?.summary && (saved.count ?? 0) === outside.length) {
        return `\n[对话记忆] ${saved.summary}\n`;
      }
      if (signal.aborted) return '';
      // LLM 压缩窗口外历史（简短提示 → 一段摘要）
      const text = outside
        .map((m) => `${m.role === 'user' ? '用户' : '助手'}: ${m.content.slice(0, 200)}`)
        .join('\n');
      if (text.length === 0) return '';
      const summary = await this.chatModel.chat(
        [
          {
            role: 'system',
            content:
              '你是对话记忆压缩器。把给定的早期对话压缩成一段简明的中文记忆摘要（保留关键事实、用户偏好、未决问题、已提及的实体），200 字以内。只输出摘要。',
          },
          { role: 'user', content: text.slice(0, 8000) },
        ],
        { temperature: 0.2, maxTokens: 300 },
        userId,
      );
      if (summary) {
        await this.sessionRepo.update(sessionId, {
          memorySummary: JSON.stringify({ summary, count: outside.length }),
        }).catch(() => {});
      }
      return summary ? `\n[对话记忆] ${summary}\n` : '';
    } catch (err) {
      this.logger.warn(
        `对话记忆压缩失败（降级为无记忆）: ${err instanceof Error ? err.message : String(err)}`,
      );
      return '';
    }
  }
}
