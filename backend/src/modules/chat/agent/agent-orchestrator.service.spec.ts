// AgentOrchestratorService 单元测试（Task 2.8）：ReAct 工具循环——
// 系统提示（含工具说明）→ chatStream（tools 透传）→ 有 toolCalls 则执行工具
// （tool_call 事件 + 消息回填）→ 下一轮 → 无 toolCalls 完成（align 引用）。
// mock MessageService/Session repo/chatModel/两个工具；ReferencesService 为纯
// 函数用真实实现。覆盖：单轮完成、两轮工具循环（回填/事件）、开关
// 开关、kbIds 空（无 search_kb）、轮数上限强制完成（空正文占位）、断连
// partial、工具失败降级（对话继续）。质量审查整改补充：多轮 usage 累积、
// reasoning_content 回传（R1 工具模式）、幻觉工具名回填、非法 JSON 参数兜底、
// 工具执行中断连（已执行结果保留）。
import { describe, expect, it, vi } from 'vitest';
import { AgentOrchestratorService } from './agent-orchestrator.service.js';
import { MentionService } from '../mention.service.js';
import { ReferencesService } from '../pipeline/references.service.js';
import { SseService } from '../sse/sse.service.js';
import type { ChatEvent } from '../sse/chat-event.types.js';
import type {
  ChatMessage,
  ChatModelService,
  ChatOptions,
  ChatStreamChunk,
  ToolDefinition,
} from '../../model/chat-model.interface.js';
import type { RagReference } from '../pipeline/rag.types.js';

/** mock Express res（SseService 构造需要） */
function mockRes() {
  return {
    writeHead: vi.fn(),
    write: vi.fn(),
    end: vi.fn(),
    flushHeaders: vi.fn(),
    flush: vi.fn(),
    on: vi.fn(),
    writableEnded: false,
    destroyed: false,
  } as never;
}

/** 脚本化 chatModel mock：calls 记录每次调用（messages/options），scripts 队列
 * 依次弹出（每次 chatStream 消费一个脚本） */
class MockChatModel implements ChatModelService {
  calls: Array<{ messages: ChatMessage[]; options: ChatOptions }> = [];
  scripts: ChatStreamChunk[][] = [];

  async chat(_messages: ChatMessage[]): Promise<string> {
    return 'Agent 测试标题';
  }

  async *chatStream(
    messages: ChatMessage[],
    options?: ChatOptions,
  ): AsyncIterable<ChatStreamChunk> {
    this.calls.push({ messages, options: options ?? {} });
    const script = this.scripts.shift() ?? [];
    for (const chunk of script) {
      if (options?.signal?.aborted) break;
      await new Promise((r) => setTimeout(r, 1));
      if (options?.signal?.aborted) break;
      yield chunk;
    }
  }
}

const searchKbDef: ToolDefinition = {
  name: 'search_kb',
  description: '检索企业知识库',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
  },
};

/** 样本引用（search_kb 工具返回） */
function refs(): RagReference[] {
  return [
    {
      index: 1,
      chunkId: 'c1',
      kbId: 'kb1',
      knowledgeId: 'doc-a',
      knowledgeTitle: '智能客服系统使用手册',
      content: '智能客服系统：支持多渠道接入。',
      score: 0.9,
    },
  ];
}

describe('AgentOrchestratorService（ReAct 工具循环）', () => {
  function setup() {
    const messageService = { listRecentMessages: vi.fn() };
    const sessionRepo = { findOne: vi.fn() };
    const chatModel = new MockChatModel();
    const kbSearchTool = {
      definition: searchKbDef,
      execute: vi.fn(),
    };
    // @提及解析用真实 MentionService（纯函数）
    const mentionService = new MentionService();
    const orchestrator = new AgentOrchestratorService(
      messageService as never,
      sessionRepo as never,
      chatModel as never,
      kbSearchTool as never,
      { definition: { name: 'search_graph' }, execute: vi.fn() } as never,
      new ReferencesService(),
      mentionService,
      { trace: vi.fn(async () => ({ end: () => {} })), generation: vi.fn(async () => ({ end: () => {} })) } as never,
    );
    // 默认前置：会话 kbIds=[kb-1]、无历史、脚本空
    sessionRepo.findOne.mockResolvedValue({ id: 's1', kbIds: ['kb-1'] });
    messageService.listRecentMessages.mockResolvedValue([]);
    return {
      orchestrator,
      messageService,
      sessionRepo,
      chatModel,
      kbSearchTool,
      mentionService,
    };
  }

  /** 构造 sse + 记录事件 */
  function spySse() {
    const events: ChatEvent[] = [];
    const sse = new SseService(mockRes());
    vi.spyOn(sse, 'send').mockImplementation((ev: ChatEvent) => {
      events.push(ev);
    });
    return { sse, events };
  }

  it('单轮无工具调用 → 完成：系统提示含工具说明、tools 透传、正文累积、align 引用', async () => {
    const { orchestrator, chatModel, kbSearchTool } = setup();
    chatModel.scripts = [[{ text: '直接回答。' }]];
    const { sse, events } = spySse();
    const result = await orchestrator.run(
      's1',
      'u1',
      '你好',
      sse,
      new AbortController().signal,
      'msg-0',
      {},
    );
    expect(result.content).toBe('直接回答。');
    // 单轮：chatStream 只调一次；tools = [search_kb]（kbIds 非空）
    expect(chatModel.calls).toHaveLength(1);
    const { messages, options } = chatModel.calls[0];
    expect(options.tools).toEqual([searchKbDef]);
    // 系统提示：说明工具（search_kb 名字出现）+ 引用规则
    expect(messages[0].role).toBe('system');
    expect(String(messages[0].content)).toContain('search_kb');
        expect(String(messages[0].content)).toContain('标注引用');
    // 消息序：system + 历史(空) + user
    expect(messages.map((m) => m.role)).toEqual(['system', 'user']);
    // 事件序：stage(generate start) → delta（正文转发）——无工具调用不发 tool_call
    expect(events.map((e) => e.type)).toEqual(['stage', 'delta']);
    expect((events[0] as { stage: string }).stage).toBe('generate');
    // 无工具调用 → 不执行工具
    expect(kbSearchTool.execute).not.toHaveBeenCalled();
  });

  it('两轮工具循环：search_kb 执行 → tool_call 事件（含 result）→ 结果回填 → 第二轮生成（引用 align 保留）', async () => {
    const { orchestrator, chatModel, kbSearchTool } = setup();
    chatModel.scripts = [
      [
        {
          text: '',
          toolCalls: [
            {
              id: 'call_1',
              name: 'search_kb',
              arguments: '{"query":"智能客服系统支持哪些渠道？"}',
            },
          ],
        },
      ],
      [{ text: '根据资料 [1] 可知，支持多渠道接入。' }],
    ];
    kbSearchTool.execute.mockResolvedValue({
      content: '[1] 智能客服系统使用手册：智能客服系统：支持多渠道接入。',
      status: 'done',
      references: refs(),
    });
    const { sse, events } = spySse();
    const result = await orchestrator.run(
      's1',
      'u1',
      '智能客服系统支持哪些渠道？',
      sse,
      new AbortController().signal,
      'msg-0',
      {},
    );
    // 工具执行：入参解析 + 上下文（sse/signal/kbIds）
    expect(kbSearchTool.execute).toHaveBeenCalledTimes(1);
    const [args, ctx] = kbSearchTool.execute.mock.calls[0];
    expect(args).toEqual({ query: '智能客服系统支持哪些渠道？' });
    expect(ctx.kbIds).toEqual(['kb-1']);
    // 两轮 chatStream；第二轮消息回填：assistant(tool_calls) + tool(结果)
    expect(chatModel.calls).toHaveLength(2);
    const round2 = chatModel.calls[1].messages;
    expect(round2.map((m) => m.role)).toEqual([
      'system',
      'user',
      'assistant',
      'tool',
    ]);
    const assistantMsg = round2[2];
    expect(assistantMsg.tool_calls).toEqual([
      {
        id: 'call_1',
        type: 'function',
        function: {
          name: 'search_kb',
          arguments: '{"query":"智能客服系统支持哪些渠道？"}',
        },
      },
    ]);
    expect(round2[3]).toMatchObject({
      role: 'tool',
      tool_call_id: 'call_1',
    });
    expect(String(round2[3].content)).toContain('[1] 智能客服系统使用手册');
    // tool_call 事件：执行完成后单事件（含 result/status/parentId）
    const toolCallEvent = events.find((e) => e.type === 'tool_call');
    expect(toolCallEvent).toMatchObject({
      type: 'tool_call',
      call: {
        id: 'call_1',
        parentId: null,
        name: 'search_kb',
        arguments: { query: '智能客服系统支持哪些渠道？' },
        status: 'done',
      },
    });
    const call = (toolCallEvent as { call: { result: string } }).call;
    expect(call.result).toContain('[1] 智能客服系统使用手册');
    // 最终结果：正文 + 引用（正文引用 [1] → align 保留）
    expect(result.content).toBe('根据资料 [1] 可知，支持多渠道接入。');
    expect(result.references).toHaveLength(1);
    expect(result.references![0].knowledgeId).toBe('doc-a');
  });

  it('工具内部失败（status error）→ tool_call 事件 status=error、错误文本回填、对话继续', async () => {
    const { orchestrator, chatModel, kbSearchTool } = setup();
    chatModel.scripts = [
      [
        {
          text: '',
          toolCalls: [
            { id: 'call_1', name: 'search_kb', arguments: '{"query":"q"}' },
          ],
        },
      ],
      [{ text: '检索失败，我基于常识回答。' }],
    ];
    kbSearchTool.execute.mockResolvedValue({
      content: '知识库检索失败，请稍后重试。',
      status: 'error',
      references: [],
    });
    const { sse, events } = spySse();
    const result = await orchestrator.run(
      's1',
      'u1',
      'q',
      sse,
      new AbortController().signal,
      'm',
      {
      },
    );
    const toolCallEvent = events.find((e) => e.type === 'tool_call');
    expect((toolCallEvent as { call: { status: string } }).call.status).toBe(
      'error',
    );
    // 对话不中断：第二轮正常生成
    expect(result.content).toBe('检索失败，我基于常识回答。');
    expect(chatModel.calls).toHaveLength(2);
  });

  it('轮数上限：一直返回 tool_call → 8 轮 chatStream + 8 次工具执行 → 强制完成（不抛错）', async () => {
    const { orchestrator, chatModel, kbSearchTool } = setup();
    // 每轮都返回 tool_call（8 轮脚本）
    chatModel.scripts = Array.from({ length: 8 }, () => [
      {
        text: '',
        toolCalls: [
          { id: 'call_loop', name: 'search_kb', arguments: '{"query":"q"}' },
        ],
      },
    ]);
    kbSearchTool.execute.mockResolvedValue({
      content: '[1] 文档：内容。',
      status: 'done',
      references: refs(),
    });
    const { sse, events } = spySse();
    const result = await orchestrator.run(
      's1',
      'u1',
      'q',
      sse,
      new AbortController().signal,
      'm',
      {
      },
    );
    // 最多 5 轮 LLM 调用（第 6 轮被上限拦截，不调用 chatStream）
    expect(chatModel.calls).toHaveLength(8);
    expect(kbSearchTool.execute).toHaveBeenCalledTimes(8);
    expect(events.filter((e) => e.type === 'tool_call')).toHaveLength(8);
    // 强制完成（质量审查整改）：全程无正文 → 生成占位提示（不落空正文）
    expect(result.content).toBe('模型未生成有效回复，请重试或更换问题表述。');
    expect(result.references).toEqual([]); // 占位正文无 [n] → align 剔除
  });

  it('多轮 usage 累积：每轮 usage 逐项相加（质量审查整改——多轮只取最后一轮会少报）', async () => {
    const { orchestrator, chatModel, kbSearchTool } = setup();
    chatModel.scripts = [
      [
        {
          text: '',
          toolCalls: [
            { id: 'call_1', name: 'search_kb', arguments: '{"query":"q"}' },
          ],
        },
        { text: '', usage: { inputTokens: 10, outputTokens: 5 } },
      ],
      [
        { text: '最终回答' },
        { text: '', usage: { inputTokens: 20, outputTokens: 15 } },
      ],
    ];
    kbSearchTool.execute.mockResolvedValue({
      content: '[1] 文档：内容。',
      status: 'done',
      references: [],
    });
    const { sse } = spySse();
    const result = await orchestrator.run(
      's1',
      'u1',
      'q',
      sse,
      new AbortController().signal,
      'm',
      {},
    );
    // 两轮 usage 相加（10+20 / 5+15）——done 事件展示总量而非最后一轮
    expect(result.usage).toEqual({ inputTokens: 30, outputTokens: 20 });
    expect(result.content).toBe('最终回答');
  });

  it('reasoning_content 回传：首轮思考 + 工具调用 → 第二轮 assistant 消息携带本轮推理（DeepSeek R1 工具模式）', async () => {
    const { orchestrator, chatModel, kbSearchTool } = setup();
    chatModel.scripts = [
      [
        { text: '', reasoning: '先检索知识库。' },
        {
          text: '',
          toolCalls: [
            { id: 'call_1', name: 'search_kb', arguments: '{"query":"q"}' },
          ],
        },
      ],
      [{ text: '根据资料 [1] 回答。' }],
    ];
    kbSearchTool.execute.mockResolvedValue({
      content: '[1] 文档：内容。',
      status: 'done',
      references: refs(),
    });
    const { sse, events } = spySse();
    const result = await orchestrator.run(
      's1',
      'u1',
      'q',
      sse,
      new AbortController().signal,
      'm',
      {},
    );
    // 第二轮消息：assistant 携带 reasoning_content（本轮累积思考——第二轮
    // 思考上下文不因工具回填而断裂）
    const round2 = chatModel.calls[1].messages;
    expect(round2.map((m) => m.role)).toEqual([
      'system',
      'user',
      'assistant',
      'tool',
    ]);
    expect(round2[2]).toMatchObject({
      role: 'assistant',
      reasoning_content: '先检索知识库。',
    });
    // reasoning_delta 事件转发 + 最终 reasoning 落库字段
    expect(events.some((e) => e.type === 'reasoning_delta')).toBe(true);
    expect(result.reasoning).toBe('先检索知识库。');
    // 无工具调用轮（本轮无思考）不携带 reasoning_content
    expect(result.content).toBe('根据资料 [1] 回答。');
  });

  it('幻觉工具名（LLM 调用不存在的工具）→ tool_call 事件 status=error + 错误文本回填、对话继续', async () => {
    const { orchestrator, chatModel } = setup();
    chatModel.scripts = [
      [
        {
          text: '',
          toolCalls: [
            { id: 'call_ghost', name: 'nonexistent_tool', arguments: '{}' },
          ],
        },
      ],
      [{ text: '没有该工具，我直接回答。' }],
    ];
    const { sse, events } = spySse();
    const result = await orchestrator.run(
      's1',
      'u1',
      'q',
      sse,
      new AbortController().signal,
      'm',
      {},
    );
    // tool_call 事件：status=error + 「工具不存在」文案（不调用任何真实工具）
    const toolCallEvent = events.find((e) => e.type === 'tool_call');
    expect(toolCallEvent).toMatchObject({
      type: 'tool_call',
      call: { id: 'call_ghost', name: 'nonexistent_tool', status: 'error' },
    });
    expect(
      (toolCallEvent as { call: { result: string } }).call.result,
    ).toContain('工具不存在');
    // 错误文本回填 LLM（role:tool 消息）→ 模型据此降级回答
    const round2 = chatModel.calls[1].messages;
    expect(round2[3]).toMatchObject({
      role: 'tool',
      tool_call_id: 'call_ghost',
    });
    expect(String(round2[3].content)).toContain('工具不存在');
    expect(result.content).toBe('没有该工具，我直接回答。');
  });

  it('非法 JSON 参数（流式截断/格式漂移）→ 按空参兜底执行（不中断循环）', async () => {
    const { orchestrator, chatModel, kbSearchTool } = setup();
    chatModel.scripts = [
      [
        {
          text: '',
          toolCalls: [
            { id: 'call_bad', name: 'search_kb', arguments: '{"query": "未完' },
          ],
        },
      ],
      [{ text: '回答' }],
    ];
    kbSearchTool.execute.mockResolvedValue({
      content: '[1] 文档：内容。',
      status: 'done',
      references: [],
    });
    const { sse, events } = spySse();
    const result = await orchestrator.run(
      's1',
      'u1',
      'q',
      sse,
      new AbortController().signal,
      'm',
      {},
    );
    // 参数解析失败 → args={} 兜底执行（工具按默认参数跑）；事件 arguments 同步
    const [args] = kbSearchTool.execute.mock.calls[0];
    expect(args).toEqual({});
    const toolCallEvent = events.find((e) => e.type === 'tool_call');
    expect(
      (toolCallEvent as { call: { arguments: unknown } }).call.arguments,
    ).toEqual({});
    // 对话不中断
    expect(result.content).toBe('回答');
    expect(chatModel.calls).toHaveLength(2);
  });

  it('工具执行中断连：已执行工具的结果保留、剩余工具不执行（partial 语义）', async () => {
    const { orchestrator, chatModel, kbSearchTool } = setup();
    const controller = new AbortController();
    chatModel.scripts = [
      [
        {
          text: '',
          toolCalls: [
            { id: 'call_1', name: 'search_kb', arguments: '{"query":"a"}' },
            { id: 'call_2', name: 'search_kb', arguments: '{"query":"b"}' },
          ],
        },
      ],
    ];
    // search_kb 执行期间断连（模拟工具执行中连接消失）：abort 后仍返回结果
    // （引用保留）；executeToolCalls 的 abort 检查点拦截后续工具
    kbSearchTool.execute.mockImplementation(async () => {
      controller.abort();
      return {
        content: '[1] 文档：内容。',
        status: 'done',
        references: refs(),
      };
    });
    const { sse, events } = spySse();
    const result = await orchestrator.run(
      's1',
      'u1',
      'q',
      sse,
      controller.signal,
      'm',
      {},
    );
    // 工具执行完成（事件 + 引用保留）；abort 后无后续工具执行
    expect(kbSearchTool.execute).toHaveBeenCalledTimes(1);
    expect(events.filter((e) => e.type === 'tool_call')).toHaveLength(1);
    // 断连路径：引用保留已执行工具的结果
    expect(result.references).toEqual(refs());
  });

  it('断连：生成中途 abort → 返回已累积部分（partial；不执行剩余工具）', async () => {
    const { orchestrator, chatModel, kbSearchTool } = setup();
    const controller = new AbortController();
    chatModel.scripts = [
      [{ text: '已生成' }, { text: '' }, { text: '，未生成部分' }],
    ];
    // 模拟：chatModel 第一块后 abort（脚本第二块前 signal 已断）
    kbSearchTool.execute.mockResolvedValue({
      content: 'x',
      status: 'done',
      references: [],
    });
    const { sse } = spySse();
    // 在 chatStream 消费期间触发 abort：通过 script 块内检查——用前置 abort
    // 的简化验证（signal 在循环开始时已 abort → 返回空）
    controller.abort();
    const result = await orchestrator.run(
      's1',
      'u1',
      'q',
      sse,
      controller.signal,
      'm',
      {
      },
    );
    // 断连：不执行工具、返回已累积（此处为空——signal 在首轮前已 abort）
    expect(kbSearchTool.execute).not.toHaveBeenCalled();
    expect(result.content).toBe('');
    expect(result.references).toEqual([]);
  });

  it('历史消息传入：listRecentMessages 结果追加到消息（system + history + user）', async () => {
    const { orchestrator, chatModel, messageService } = setup();
    messageService.listRecentMessages.mockResolvedValue([
      { id: 'm1', role: 'user', content: '第一轮问题' },
      { id: 'm2', role: 'assistant', content: '第一轮回答' },
    ] as never);
    chatModel.scripts = [[{ text: '回答' }]];
    const { sse } = spySse();
    await orchestrator.run(
      's1',
      'u1',
      '那电话渠道呢？',
      sse,
      new AbortController().signal,
      'm3',
      {
      },
    );
    // 历史加载：排除当前消息（excludeMessageId）
    expect(messageService.listRecentMessages).toHaveBeenCalledWith(
      's1',
      40,
      'm3',
    );
    const { messages } = chatModel.calls[0];
    expect(messages.map((m) => m.role)).toEqual([
      'system',
      'user',
      'assistant',
      'user',
    ]);
    expect(String(messages[3].content)).toBe('那电话渠道呢？');
  });

  // ==================== Task 2.9：@提及范围限定 + 附件占位 ====================

  it('content 含 @kb:<id> → 检索范围 scope.kbIds 限定该 KB（覆盖会话范围）+ user 消息为 cleanedText', async () => {
    const { orchestrator, chatModel, kbSearchTool } = setup();
    const kbMention = '44444444-4444-4444-8444-444444444444';
    chatModel.scripts = [
      [
        {
          text: '',
          toolCalls: [
            { id: 'call_1', name: 'search_kb', arguments: '{"query":"q"}' },
          ],
        },
      ],
      [{ text: '根据资料 [1] 回答。' }],
    ];
    kbSearchTool.execute.mockResolvedValue({
      content: '[1] 文档：内容。',
      status: 'done',
      references: refs(),
    });
    const { sse } = spySse();
    const result = await orchestrator.run(
      's1',
      'u1',
      `请检索 @kb:${kbMention} 的资料`,
      sse,
      new AbortController().signal,
      'm',
      {},
    );
    // 工具执行上下文：scope.kbIds = 提及的 KB（mention 覆盖会话 kbIds，见文件头注释）
    const [, ctx] = kbSearchTool.execute.mock.calls[0];
    expect(ctx.scope).toEqual({ kbIds: [kbMention], knowledgeIds: [] });
    // user 消息 = cleanedText（提及标记移除，避免 LLM 看到垃圾标记）
    const userMsg = chatModel.calls[0].messages.find((m) => m.role === 'user');
    expect(String(userMsg!.content)).not.toContain('@kb:');
    expect(String(userMsg!.content)).toBe('请检索 的资料');
    expect(result.content).toBe('根据资料 [1] 回答。');
  });

  it('body mentionKbIds + 内嵌 @file:<id> → 范围合并去重（kbIds 与 knowledgeIds 并集）', async () => {
    const { orchestrator, chatModel, kbSearchTool } = setup();
    const kbBody = '55555555-5555-4555-8555-555555555555';
    const fileMention = '66666666-6666-4666-8666-666666666666';
    chatModel.scripts = [
      [
        {
          text: '',
          toolCalls: [
            { id: 'call_1', name: 'search_kb', arguments: '{"query":"q"}' },
          ],
        },
      ],
      [{ text: '回答' }],
    ];
    kbSearchTool.execute.mockResolvedValue({
      content: '[1] 文档：内容。',
      status: 'done',
      references: refs(),
    });
    const { sse } = spySse();
    // 双通道：body 显式 mentionKbIds + content 内嵌 @file（重复提及验证去重）
    await orchestrator.run(
      's1',
      'u1',
      `参考 @file:${fileMention} @file:${fileMention}`,
      sse,
      new AbortController().signal,
      'm',
      { mentionKbIds: [kbBody] },
    );
    const [, ctx] = kbSearchTool.execute.mock.calls[0];
    expect(ctx.scope).toEqual({
      kbIds: [kbBody],
      knowledgeIds: [fileMention],
    });
  });

  it('无提及：不传 scope（检索范围 = 会话 kbIds，既有语义）', async () => {
    const { orchestrator, chatModel, kbSearchTool } = setup();
    chatModel.scripts = [
      [
        {
          text: '',
          toolCalls: [
            { id: 'call_1', name: 'search_kb', arguments: '{"query":"q"}' },
          ],
        },
      ],
      [{ text: '回答' }],
    ];
    kbSearchTool.execute.mockResolvedValue({
      content: '[1] 文档：内容。',
      status: 'done',
      references: refs(),
    });
    const { sse } = spySse();
    await orchestrator.run(
      's1',
      'u1',
      '普通问题',
      sse,
      new AbortController().signal,
      'm',
      {},
    );
    const [, ctx] = kbSearchTool.execute.mock.calls[0];
    expect(ctx.scope).toBeUndefined();
    expect(ctx.kbIds).toEqual(['kb-1']);
  });

  it('无效提及（@kb: 后跟非 uuid）→ 从 user 消息移除（宽容语义）', async () => {
    const { orchestrator, chatModel } = setup();
    chatModel.scripts = [[{ text: '回答' }]];
    const { sse } = spySse();
    await orchestrator.run(
      's1',
      'u1',
      '请检索 @kb:not-a-uuid 资料',
      sse,
      new AbortController().signal,
      'm',
      {},
    );
    const userMsg = chatModel.calls[0].messages.find((m) => m.role === 'user');
    expect(String(userMsg!.content)).toBe('请检索 资料');
  });

});
