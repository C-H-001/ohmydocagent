// ChatOrchestratorService 单元测试（Task 2.4 + Task 2.5 适配 + Task 2.8 改造）：
// mock MessageService 与 AgentOrchestratorService（Agent 内部发 stage/delta/
// tool_call 事件，编排器只管落库/事件收尾/错误事件——职责划分见
// agent-orchestrator.service.ts 注释），用真实 SseService + mock Express res
// （可触发 close 模拟断连）。覆盖——
// - 正常回路（整改 #3）：agentOrchestrator.run 返回生成结果 → 先落库 assistant
//   （content/references/reasoning）再 stage(generate done)/done（messageId）——
//   落库失败走 error(persist_failed)，无假成功
// - 断连（整改 #1）：客户端断开 → abort signal 传入 Agent → Agent 返回已累积
//   部分（break 路径）→ 编排器落库 partial assistant、不写 error/done
// - 断连竞态：close 早于 onDisconnect 注册 → abort 立即生效 → Agent 返回空 →
//   partial 落库（空内容，与 Task 2.4 语义一致）
// - 错误脱敏（整改 #4）：error 事件 message 为固定友好文案、不含原始 err.message
// - 错误码映射（整改 #6）：TimeoutError → chat_timeout；「连接供应商失败」→
//   chat_network_error；503 → no_default_model；其余 → chat_model_error
//   （Task 2.8 变更：search_failed 不再经编排器映射——检索失败降级为工具级
//   错误，见 chat-orchestrator.service.ts 文件头注释）
// - createUserMessage 移入 try（整改 #5）：404/403（并发竞态兜底）与非 404/403
//   错误都转 SSE error 事件，且不启动 Agent
// - 停止生成（Task 2.10）：registry.stop → abort（socket 仍开）→ 落库 partial
//   （interrupted=true）→ 发 stage(generate done) + done（interrupted=true）；
//   与断连区分（断连 socket 已关 → 不发事件）；落库失败 → error persist_failed；
//   register/unregister 成对（finally 注销，防泄漏）
// - stop/断连与管线真实错误竞态（Task 2.10 质量审查整改）：中止信号触发时管线
//   抛真实错误（工具 DB 故障等）→ 已流式转发的 delta 不丢——错误挂载的累积
//   部分（PARTIAL_ON_ERROR_KEY）落库 partial（interrupted=true）；stop（socket
//   仍开）→ 降级发 error generation_stopped（区别于正常 stop 路径的 done）；
//   断连 → 不发事件、累积部分仍尽力落库；日志措辞区分（stop「生成被用户
//   停止」/断连「客户端断开，生成中止」）
import {
  ForbiddenException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { ChatOrchestratorService } from './chat-orchestrator.service.js';
import { GenerationRegistry } from './sse/generation-registry.service.js';
import { MentionService } from './mention.service.js';
import { PARTIAL_ON_ERROR_KEY } from './agent/agent.types.js';
import type { RagPipelineResult } from './pipeline/rag.types.js';
import { SseService } from './sse/sse.service.js';
import type { ChatEvent } from './sse/chat-event.types.js';
import type { Message } from './message.entity.js';

/** mock Express res：on 捕获 close 监听器，emitClose 手动触发（模拟断连） */
function mockRes() {
  const listeners: Record<string, () => void> = {};
  const res = {
    writeHead: vi.fn(),
    write: vi.fn(),
    end: vi.fn(),
    flushHeaders: vi.fn(),
    flush: vi.fn(),
    on: vi.fn((event: string, cb: () => void) => {
      listeners[event] = cb;
    }),
    writableEnded: false,
    destroyed: false,
  };
  return {
    res: res as never,
    emitClose() {
      listeners['close']?.();
    },
  };
}

/** 正常管线结果样本 */
function result(overrides: Partial<RagPipelineResult> = {}): RagPipelineResult {
  return {
    content: '你好，OhMyDocAgent',
    reasoning: null,
    references: [],
    usage: { inputTokens: 3, outputTokens: 5 },
    ...overrides,
  };
}

describe('ChatOrchestratorService（对话生成编排）', () => {
  function setup() {
    const messageService = {
      createUserMessage: vi.fn(),
      createAssistantMessage: vi.fn(),
    };
    const agentOrchestrator = {
      run: vi.fn(),
    };
    const orchestrator = new ChatOrchestratorService(
      messageService as never,
      agentOrchestrator as never,
      // 质量审查整改 #5a：@提及解析（纯函数）——落库前清理提及标记
      new MentionService(),
      // Task 2.10：生成注册表（stop 端点经 registry 触发 abort；真实实例——
      // 本单测直接经 registry 触发 stop，验证编排器侧的区分逻辑）
      new GenerationRegistry(),
      // 模型用量记录（mock：断言不阻断生成流程）
      { record: vi.fn() } as never,
      // 默认对话模型（recordUsage 内部使用）
      { getDefault: vi.fn(async () => ({ id: 'm1', name: 'Mock', type: 'chat' })) } as never,
      // Langfuse 观测（关闭态 no-op mock）
      { trace: vi.fn(async () => ({ end: () => {} })) } as never,
    );
    return { orchestrator, messageService, agentOrchestrator };
  }

  /** 记录 sse.send 的事件类型序列 */
  function spyEvents(sse: SseService): string[] {
    const types: string[] = [];
    vi.spyOn(sse, 'send').mockImplementation((ev: ChatEvent) => {
      types.push(ev.type);
    });
    return types;
  }

  it('正常回路：管线返回结果 → 先落库 assistant（含 references）再 stage(generate done) → done(messageId+usage)', async () => {
    const { orchestrator, messageService, agentOrchestrator } = setup();
    const { res } = mockRes();
    const sse = new SseService(res);
    const endSpy = vi.spyOn(sse, 'end');
    // 事件序：send 与落库共用一条时间线（整改 #3 断言落库先于 stage done/done）
    const order: string[] = [];
    vi.spyOn(sse, 'send').mockImplementation((ev: ChatEvent) => {
      order.push(`send:${ev.type}`);
    });
    const persistSpy = vi
      .fn()
      .mockImplementation(
        async (_sid: string, _content: string): Promise<Message> => {
          order.push('persist-assistant');
          return { id: 'assistant-1' } as Message;
        },
      );
    messageService.createAssistantMessage.mockImplementation(persistSpy);
    messageService.createUserMessage.mockResolvedValue({ id: 'user-1' });
    const refs = [
      {
        index: 1,
        chunkId: 'c1',
        kbId: 'kb1',
        knowledgeId: 'kb-1',
        knowledgeTitle: '文档',
        content: '内容',
        score: 0.9,
      },
    ];
    // 管线返回生成结果（stage/delta 事件由管线内部发送，编排器不参与）
    agentOrchestrator.run.mockResolvedValue(
      result({ content: '你好，OhMyDocAgent', references: refs }),
    );
    await orchestrator.runStream('s1', 'u1', '你好', sse);
    // 事件序（协议收尾）：stage(generate done) → done（管线已发 generate start）
    expect(
      order
        .filter((s) => s.startsWith('send:'))
        .map((s) => s.slice('send:'.length)),
    ).toEqual(['stage', 'done']);
    // 整改 #3：assistant 落库发生在 stage(done) 与 done 之前（先落库再通知）
    expect(order.indexOf('persist-assistant')).toBeLessThan(
      order.indexOf('send:stage'),
    );
    expect(order.indexOf('persist-assistant')).toBeLessThan(
      order.indexOf('send:done'),
    );
    // 落库入参：content + references（RAG 引用随 assistant 落库，Task 2.5）
    expect(persistSpy).toHaveBeenCalledWith('s1', '你好，OhMyDocAgent', {
      reasoning: null,
      references: refs,
    });
    // done 事件：messageId 引用落库消息 + usage 透传
    const doneEvent = (sse.send as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0] as ChatEvent)
      .find((e) => e.type === 'done');
    expect(doneEvent).toMatchObject({
      type: 'done',
      messageId: 'assistant-1',
      usage: { inputTokens: 3, outputTokens: 5 },
    });
    // finally 正常收尾：end 被调用
    expect(endSpy).toHaveBeenCalledTimes(1);
  });

  it('质量审查整改 #5a：content 含 @kb: 标记 → 落库 cleanedText，Agent 拿原始 content（提及只在当次请求消费）', async () => {
    const { orchestrator, messageService, agentOrchestrator } = setup();
    const { res } = mockRes();
    const sse = new SseService(res);
    const kbId = '44444444-4444-4444-8444-444444444444';
    messageService.createUserMessage.mockResolvedValue({ id: 'user-1' });
    agentOrchestrator.run.mockResolvedValue(result());
    const content = `请检索 @kb:${kbId} 的资料`;
    await orchestrator.runStream('s1', 'u1', content, sse);
    // 落库 content = cleanedText（提及标记移除，历史回放无垃圾标记）
    expect(messageService.createUserMessage).toHaveBeenCalledWith(
      's1',
      '请检索 的资料',
      'u1',
    );
    // Agent 侧仍拿原始 content（当次请求解析 @提及检索范围）
    expect(agentOrchestrator.run).toHaveBeenCalledWith(
      's1',
      'u1',
      content,
      expect.anything(),
      expect.anything(),
      'user-1',
      expect.anything(),
    );
  });

  it('质量审查整改 #5b：纯提及消息（cleanedText 空）→ 落库占位文案（不落空串）', async () => {
    const { orchestrator, messageService, agentOrchestrator } = setup();
    const { res } = mockRes();
    const sse = new SseService(res);
    const kbId = '44444444-4444-4444-8444-444444444444';
    messageService.createUserMessage.mockResolvedValue({ id: 'user-1' });
    agentOrchestrator.run.mockResolvedValue(result());
    await orchestrator.runStream('s1', 'u1', `@kb:${kbId}`, sse);
    // 落库用占位（provider 拒绝空 content 的防御，历史回放同样不出现空串）
    expect(messageService.createUserMessage).toHaveBeenCalledWith(
      's1',
      '请根据上述知识库内容回答',
      'u1',
    );
    // 无提及标记落库
    expect(agentOrchestrator.run).toHaveBeenCalled();
  });

  it('断连契约：abort 信号传入管线（AbortSignal 实例）', async () => {
    const { orchestrator, messageService, agentOrchestrator } = setup();
    const { res } = mockRes();
    const sse = new SseService(res);
    messageService.createUserMessage.mockResolvedValue({ id: 'user-1' });
    // 落库 mock（正常完成路径需要返回实体；缺省 vi.fn() 返回 undefined 会
    // 在 done 事件组装时抛 TypeError——测试本身能过但产生误导性错误日志）
    messageService.createAssistantMessage.mockResolvedValue({
      id: 'assistant-1',
    } as Message);
    let capturedSignal: AbortSignal | undefined;
    agentOrchestrator.run.mockImplementation(
      async (
        _sid: string,
        _uid: string,
        _content: string,
        _sse: unknown,
        signal: AbortSignal,
        _excludeId: string,
      ) => {
        capturedSignal = signal;
        return result();
      },
    );
    await orchestrator.runStream('s1', 'u1', '你好', sse);
    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    expect(capturedSignal?.aborted).toBe(false);
  });

  it('断连：管线返回部分内容（生成中途断开）→ partial assistant 落库、不写 error/done', async () => {
    const { orchestrator, messageService, agentOrchestrator } = setup();
    const { res, emitClose } = mockRes();
    const sse = new SseService(res);
    const sent = spyEvents(sse);
    const persistSpy = vi.fn().mockResolvedValue({ id: 'assistant-partial' });
    messageService.createAssistantMessage.mockImplementation(persistSpy);
    messageService.createUserMessage.mockResolvedValue({ id: 'user-1' });
    // 管线生成中途断连：run 在生成循环内检测到 abort，返回已累积部分
    let capturedSignal: AbortSignal | undefined;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    agentOrchestrator.run.mockImplementation(
      async (
        _sid: string,
        _uid: string,
        _content: string,
        _sse: unknown,
        signal: AbortSignal,
      ) => {
        capturedSignal = signal;
        await gate;
        // 断连后管线返回已累积部分（真实管线：生成循环内 abort 检查）
        return result({ content: '部分', references: [], usage: undefined });
      },
    );
    const runPromise = orchestrator.runStream('s1', 'u1', '断连', sse);
    // 模拟客户端断开：close 且响应未结束 → onDisconnect → controller.abort()
    await vi.waitFor(() => expect(capturedSignal).toBeDefined());
    emitClose();
    expect(capturedSignal?.aborted).toBe(true); // abort 已传递到管线
    release();
    await runPromise;
    // 已累积部分落库（断连不丢已生成部分）；Task 2.10 决策：断连与 stop 都
    // 标 interrupted=true（生成未完成，见编排器文件头注释）
    expect(persistSpy).toHaveBeenCalledTimes(1);
    expect(persistSpy).toHaveBeenCalledWith('s1', '部分', {
      reasoning: null,
      references: [],
      interrupted: true,
    });
    // 不再发 error/done（客户端已消失——断连不发收尾事件，与 stop 区分）
    expect(sent).toEqual([]);
    expect(sse.isDisconnected()).toBe(true);
  });

  it('断连竞态：close 早于 onDisconnect 注册 → abort 立即生效，管线返回空 → partial 落库（空内容）', async () => {
    const { orchestrator, messageService, agentOrchestrator } = setup();
    const { res, emitClose } = mockRes();
    const sse = new SseService(res);
    const sent = spyEvents(sse);
    const persistSpy = vi.fn().mockResolvedValue({ id: 'assistant-empty' });
    messageService.createAssistantMessage.mockImplementation(persistSpy);
    messageService.createUserMessage.mockResolvedValue({ id: 'user-1' });
    let capturedSignal: AbortSignal | undefined;
    agentOrchestrator.run.mockImplementation(
      async (
        _sid: string,
        _uid: string,
        _content: string,
        _sse: unknown,
        signal: AbortSignal,
      ) => {
        capturedSignal = signal;
        // 管线首检查点检测到已 abort → 直接返回空结果（不发事件）
        return result({ content: '', references: [], usage: undefined });
      },
    );
    // 客户端在编排器注册断连监听前就断开（SseService 构造后立即 close）
    emitClose();
    await orchestrator.runStream('s1', 'u1', '内容', sse);
    // signal 已 abort：管线收到即中止（与 Task 2.4 断连竞态语义一致）
    expect(capturedSignal?.aborted).toBe(true);
    expect(sent).toEqual([]); // 断连后不发事件（与 stop 区分，见文件头注释）
    // 空内容 partial 落库（user 消息已落库，成对语义不被断连打破）；
    // interrupted=true（生成未完成，Task 2.10 决策）
    expect(persistSpy).toHaveBeenCalledWith('s1', '', {
      reasoning: null,
      references: [],
      interrupted: true,
    });
  });

  it('落库失败（assistant persist 失败）→ error 事件 persist_failed（无假成功：无 stage done/done）', async () => {
    const { orchestrator, messageService, agentOrchestrator } = setup();
    const { res } = mockRes();
    const sse = new SseService(res);
    const sent: ChatEvent[] = [];
    vi.spyOn(sse, 'send').mockImplementation((ev: ChatEvent) => {
      sent.push(ev);
    });
    messageService.createUserMessage.mockResolvedValue({ id: 'user-1' });
    agentOrchestrator.run.mockResolvedValue(result());
    messageService.createAssistantMessage.mockRejectedValue(
      new Error('insert into messages failed: connection pool exhausted'),
    );
    await orchestrator.runStream('s1', 'u1', '内容', sse);
    const errEvent = sent.find((e) => e.type === 'error');
    expect(sent.map((e) => e.type)).toEqual(['error']);
    expect(errEvent).toMatchObject({
      type: 'error',
      code: 'persist_failed',
      message: '消息保存失败，请稍后重试',
    });
    // 脱敏：原始 DB 错误细节不进 error 事件
    expect((errEvent as { message: string }).message).not.toContain(
      'connection pool',
    );
  });

  it('错误脱敏：管线/上游错误含内部细节 → error 事件为固定文案、不含原始 err.message', async () => {
    const { orchestrator, messageService, agentOrchestrator } = setup();
    const { res } = mockRes();
    const sse = new SseService(res);
    const sent: ChatEvent[] = [];
    vi.spyOn(sse, 'send').mockImplementation((ev: ChatEvent) => {
      sent.push(ev);
    });
    messageService.createUserMessage.mockResolvedValue({ id: 'user-1' });
    // 管线（生成阶段）抛出含 DB 连接串/内网地址的错误
    agentOrchestrator.run.mockRejectedValue(
      new Error(
        'postgres://admin:hunter2@10.0.0.5:5432/ohmydocagent: connection refused',
      ),
    );
    await orchestrator.runStream('s1', 'u1', '内容', sse);
    const errEvent = sent.find((e) => e.type === 'error');
    expect(errEvent).toMatchObject({
      type: 'error',
      code: 'chat_model_error',
      message: '模型调用失败，请稍后重试',
    });
    expect((errEvent as { message: string }).message).not.toContain(
      'postgres://',
    );
    expect((errEvent as { message: string }).message).not.toContain('10.0.0.5');
  });

  it('错误码映射：TimeoutError → chat_timeout（模型响应超时）', async () => {
    const { orchestrator, messageService, agentOrchestrator } = setup();
    const { res } = mockRes();
    const sse = new SseService(res);
    const sent: ChatEvent[] = [];
    vi.spyOn(sse, 'send').mockImplementation((ev: ChatEvent) => {
      sent.push(ev);
    });
    messageService.createUserMessage.mockResolvedValue({ id: 'user-1' });
    agentOrchestrator.run.mockRejectedValue(
      new DOMException(
        'The operation was aborted due to timeout',
        'TimeoutError',
      ),
    );
    await orchestrator.runStream('s1', 'u1', '内容', sse);
    expect(sent.find((e) => e.type === 'error')).toMatchObject({
      type: 'error',
      code: 'chat_timeout',
      message: '模型响应超时，请稍后重试',
    });
  });

  it('错误码映射：网络层失败（「连接供应商失败」包装）→ chat_network_error', async () => {
    const { orchestrator, messageService, agentOrchestrator } = setup();
    const { res } = mockRes();
    const sse = new SseService(res);
    const sent: ChatEvent[] = [];
    vi.spyOn(sse, 'send').mockImplementation((ev: ChatEvent) => {
      sent.push(ev);
    });
    messageService.createUserMessage.mockResolvedValue({ id: 'user-1' });
    agentOrchestrator.run.mockRejectedValue(
      new Error('连接供应商失败（网络错误）: fetch failed'),
    );
    await orchestrator.runStream('s1', 'u1', '内容', sse);
    expect(sent.find((e) => e.type === 'error')).toMatchObject({
      type: 'error',
      code: 'chat_network_error',
      message: '网络连接异常，请稍后重试',
    });
  });

  it('错误码映射：未配置默认模型（503）→ no_default_model', async () => {
    const { orchestrator, messageService, agentOrchestrator } = setup();
    const { res } = mockRes();
    const sse = new SseService(res);
    const sent: ChatEvent[] = [];
    vi.spyOn(sse, 'send').mockImplementation((ev: ChatEvent) => {
      sent.push(ev);
    });
    messageService.createUserMessage.mockResolvedValue({ id: 'user-1' });
    agentOrchestrator.run.mockRejectedValue(
      new ServiceUnavailableException(
        '未配置默认对话模型（请先在模型管理中设置）',
      ),
    );
    await orchestrator.runStream('s1', 'u1', '内容', sse);
    expect(sent.find((e) => e.type === 'error')).toMatchObject({
      type: 'error',
      code: 'no_default_model',
    });
  });

  it('createUserMessage 非 404/403 错误（DB 故障）→ error 事件 persist_failed、不启动管线', async () => {
    const { orchestrator, messageService, agentOrchestrator } = setup();
    const { res } = mockRes();
    const sse = new SseService(res);
    const sent: ChatEvent[] = [];
    vi.spyOn(sse, 'send').mockImplementation((ev: ChatEvent) => {
      sent.push(ev);
    });
    messageService.createUserMessage.mockRejectedValue(
      new Error('ECONNREFUSED 127.0.0.1:5432'),
    );
    await orchestrator.runStream('s1', 'u1', '内容', sse);
    const errEvent = sent.find((e) => e.type === 'error');
    expect(errEvent).toMatchObject({
      type: 'error',
      code: 'persist_failed',
      message: '消息保存失败，请稍后重试',
    });
    // 不启动生成（user 消息都没落库成功）
    expect(agentOrchestrator.run).not.toHaveBeenCalled();
  });

  it('createUserMessage 404/403（预检后到落库间的并发竞态兜底）→ error 事件「会话不存在或无权访问」', async () => {
    const { orchestrator, messageService, agentOrchestrator } = setup();
    const { res } = mockRes();
    const sse = new SseService(res);
    const sent: ChatEvent[] = [];
    vi.spyOn(sse, 'send').mockImplementation((ev: ChatEvent) => {
      sent.push(ev);
    });
    // 404：会话被并发删除（控制器预检通过后、落库前被删）——编排器按
    // NotFoundException 实例识别（并发竞态兜底，见服务文件头注释）
    messageService.createUserMessage.mockRejectedValue(
      new NotFoundException('会话不存在'),
    );
    await orchestrator.runStream('s1', 'u1', '内容', sse);
    expect(sent.find((e) => e.type === 'error')).toMatchObject({
      type: 'error',
      message: '会话不存在或无权访问，请刷新后重试',
    });
    expect(agentOrchestrator.run).not.toHaveBeenCalled();

    // 403：他人会话（权限竞态）
    const {
      orchestrator: o2,
      messageService: ms2,
      agentOrchestrator: rp2,
    } = setup();
    const { res: res2 } = mockRes();
    const sse2 = new SseService(res2);
    const sent2: ChatEvent[] = [];
    vi.spyOn(sse2, 'send').mockImplementation((ev: ChatEvent) => {
      sent2.push(ev);
    });
    ms2.createUserMessage.mockRejectedValue(
      new ForbiddenException('无权访问该会话'),
    );
    await o2.runStream('s1', 'u1', '内容', sse2);
    expect(sent2.find((e) => e.type === 'error')).toMatchObject({
      type: 'error',
      message: '会话不存在或无权访问，请刷新后重试',
    });
    expect(rp2.run).not.toHaveBeenCalled();
  });

  it('stop（socket 仍开）：registry.stop → abort → 落库 partial（interrupted=true）→ 发 stage(generate done) + done（interrupted=true）', async () => {
    const { orchestrator, messageService, agentOrchestrator } = setup();
    const { res } = mockRes();
    const sse = new SseService(res);
    const sent: ChatEvent[] = [];
    vi.spyOn(sse, 'send').mockImplementation((ev: ChatEvent) => {
      sent.push(ev);
    });
    const persistSpy = vi.fn().mockResolvedValue({ id: 'assistant-stop' });
    messageService.createAssistantMessage.mockImplementation(persistSpy);
    messageService.createUserMessage.mockResolvedValue({ id: 'user-1' });
    let capturedSignal: AbortSignal | undefined;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    // 生成中途 stop：管线在生成循环内检测到 abort，返回已累积部分
    agentOrchestrator.run.mockImplementation(
      async (
        _sid: string,
        _uid: string,
        _content: string,
        _sse: unknown,
        signal: AbortSignal,
      ) => {
        capturedSignal = signal;
        await gate;
        return result({ content: '部分', references: [], usage: undefined });
      },
    );
    const runPromise = orchestrator.runStream('s1', 'u1', '停止', sse);
    // 等生成开始（run 已拿到 signal）后模拟 stop 端点：registry.stop → abort
    await vi.waitFor(() => expect(capturedSignal).toBeDefined());
    const registry = (
      orchestrator as unknown as {
        generationRegistry: GenerationRegistry;
      }
    ).generationRegistry;
    expect(registry.isActive('s1')).toBe(true);
    expect(registry.stop('s1')).toEqual({ stopped: true });
    expect(capturedSignal?.aborted).toBe(true);
    release();
    await runPromise;
    // 落库：partial + interrupted=true（生成未完成标记）
    expect(persistSpy).toHaveBeenCalledTimes(1);
    expect(persistSpy).toHaveBeenCalledWith('s1', '部分', {
      reasoning: null,
      references: [],
      interrupted: true,
    });
    // socket 仍开 → 发收尾事件：stage(generate done) → done（interrupted=true）
    expect(sent.map((e) => e.type)).toEqual(['stage', 'done']);
    const doneEvent = sent.find((e) => e.type === 'done');
    expect(doneEvent).toMatchObject({
      type: 'done',
      messageId: 'assistant-stop',
      interrupted: true,
    });
    expect(sse.isDisconnected()).toBe(false);
    // 注册表已注销（finally）：stop 后不再有活动生成（防泄漏）
    expect(registry.isActive('s1')).toBe(false);
  });

  it('stop 后 partial 落库失败 → error persist_failed（客户端不 hang——等待收尾事件）', async () => {
    const { orchestrator, messageService, agentOrchestrator } = setup();
    const { res } = mockRes();
    const sse = new SseService(res);
    const sent: ChatEvent[] = [];
    vi.spyOn(sse, 'send').mockImplementation((ev: ChatEvent) => {
      sent.push(ev);
    });
    messageService.createUserMessage.mockResolvedValue({ id: 'user-1' });
    messageService.createAssistantMessage.mockRejectedValue(
      new Error('insert into messages failed: pool exhausted'),
    );
    let capturedSignal: AbortSignal | undefined;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    agentOrchestrator.run.mockImplementation(
      async (
        _sid: string,
        _uid: string,
        _content: string,
        _sse: unknown,
        signal: AbortSignal,
      ) => {
        capturedSignal = signal;
        await gate;
        return result({ content: '部分', references: [], usage: undefined });
      },
    );
    const runPromise = orchestrator.runStream('s1', 'u1', '停止', sse);
    await vi.waitFor(() => expect(capturedSignal).toBeDefined());
    const registry = (
      orchestrator as unknown as {
        generationRegistry: GenerationRegistry;
      }
    ).generationRegistry;
    registry.stop('s1');
    release();
    await runPromise;
    // 落库失败 → error persist_failed（不能静默挂起——stop 后 socket 仍开，
    // 客户端等不到 done/error 会一直转圈）
    expect(sent.map((e) => e.type)).toEqual(['error']);
    expect(sent[0]).toMatchObject({
      type: 'error',
      code: 'persist_failed',
      message: '消息保存失败，请稍后重试',
    });
  });

  it('runStream 生命周期：register → finally unregister（注册/注销成对，防泄漏）', async () => {
    const { orchestrator, messageService, agentOrchestrator } = setup();
    const { res } = mockRes();
    const sse = new SseService(res);
    messageService.createUserMessage.mockResolvedValue({ id: 'user-1' });
    agentOrchestrator.run.mockResolvedValue(result());
    const registry = (
      orchestrator as unknown as {
        generationRegistry: GenerationRegistry;
      }
    ).generationRegistry;
    const registerSpy = vi.spyOn(registry, 'register');
    const unregisterSpy = vi.spyOn(registry, 'unregister');
    await orchestrator.runStream('s1', 'u1', '内容', sse);
    expect(registerSpy).toHaveBeenCalledTimes(1);
    expect(registerSpy).toHaveBeenCalledWith('s1', expect.any(AbortController));
    expect(unregisterSpy).toHaveBeenCalledTimes(1);
    expect(registry.isActive('s1')).toBe(false);
  });

  it('断连后管线抛错（真实错误 + 连接已关）→ 不写 error 事件（客户端已消失）', async () => {
    const { orchestrator, messageService, agentOrchestrator } = setup();
    const { res, emitClose } = mockRes();
    const sse = new SseService(res);
    const sent = spyEvents(sse);
    messageService.createUserMessage.mockResolvedValue({ id: 'user-1' });
    agentOrchestrator.run.mockRejectedValue(new Error('检索服务异常'));
    // 客户端已断开（close 早于 runStream）——管线若抛错，连接已关不写事件
    emitClose();
    await orchestrator.runStream('s1', 'u1', '内容', sse);
    expect(agentOrchestrator.run).toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it('质量审查整改：stop 与管线真实错误竞态 → 落库 partial（interrupted=true）+ error(generation_stopped），日志措辞「生成被用户停止」', async () => {
    const { orchestrator, messageService, agentOrchestrator } = setup();
    const { res } = mockRes();
    const sse = new SseService(res);
    const sent: ChatEvent[] = [];
    vi.spyOn(sse, 'send').mockImplementation((ev: ChatEvent) => {
      sent.push(ev);
    });
    const warnSpy = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const persistSpy = vi.fn().mockResolvedValue({ id: 'assistant-stop-race' });
    messageService.createAssistantMessage.mockImplementation(persistSpy);
    messageService.createUserMessage.mockResolvedValue({ id: 'user-1' });
    let capturedSignal: AbortSignal | undefined;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    // 模拟真实 Agent 的降级路径（agent-orchestrator run catch）：管线抛真实
    // 错误（工具 DB 故障）时累积部分已挂到错误上（PARTIAL_ON_ERROR_KEY）再抛
    agentOrchestrator.run.mockImplementation(
      async (
        _sid: string,
        _uid: string,
        _content: string,
        _sse: unknown,
        signal: AbortSignal,
      ) => {
        capturedSignal = signal;
        await gate;
        const err = new Error('search_kb db: connection pool exhausted');
        (err as unknown as Record<string, unknown>)[PARTIAL_ON_ERROR_KEY] = {
          content: '已生成部分',
          reasoning: '思考中',
          references: [],
        };
        throw err;
      },
    );
    const runPromise = orchestrator.runStream('s1', 'u1', '停止', sse);
    await vi.waitFor(() => expect(capturedSignal).toBeDefined());
    const registry = (
      orchestrator as unknown as {
        generationRegistry: GenerationRegistry;
      }
    ).generationRegistry;
    registry.stop('s1'); // stop：socket 仍开（与断连区分）
    expect(capturedSignal?.aborted).toBe(true);
    release();
    await runPromise;
    // 已流式转发的部分落库（interrupted=true——生成未完成标记，与正常 stop
    // 路径同一语义）
    expect(persistSpy).toHaveBeenCalledTimes(1);
    expect(persistSpy).toHaveBeenCalledWith('s1', '已生成部分', {
      reasoning: '思考中',
      references: [],
      interrupted: true,
    });
    // 降级收尾：error generation_stopped（区别于正常 stop 路径的 done——该
    // 路径是 stop+异常同时发生的降级，见 runStream catch 注释）
    expect(sent.map((e) => e.type)).toEqual(['error']);
    expect(sent[0]).toMatchObject({
      type: 'error',
      code: 'generation_stopped',
      message: '生成已停止',
    });
    // 日志措辞区分：stop → 「生成被用户停止」（而非误导性的「客户端断开」）
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('生成被用户停止'),
    );
    warnSpy.mockRestore();
  });

  it('质量审查整改：断连与管线真实错误竞态 → 不写 error 事件、累积部分仍落库，日志措辞「客户端断开」', async () => {
    const { orchestrator, messageService, agentOrchestrator } = setup();
    const { res, emitClose } = mockRes();
    const sse = new SseService(res);
    const sent: ChatEvent[] = [];
    vi.spyOn(sse, 'send').mockImplementation((ev: ChatEvent) => {
      sent.push(ev);
    });
    const warnSpy = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const persistSpy = vi.fn().mockResolvedValue({ id: 'assistant-disc-race' });
    messageService.createAssistantMessage.mockImplementation(persistSpy);
    messageService.createUserMessage.mockResolvedValue({ id: 'user-1' });
    let capturedSignal: AbortSignal | undefined;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    agentOrchestrator.run.mockImplementation(
      async (
        _sid: string,
        _uid: string,
        _content: string,
        _sse: unknown,
        signal: AbortSignal,
      ) => {
        capturedSignal = signal;
        await gate;
        const err = new Error('检索服务异常');
        (err as unknown as Record<string, unknown>)[PARTIAL_ON_ERROR_KEY] = {
          content: '已生成部分',
          reasoning: null,
          references: [],
        };
        throw err;
      },
    );
    const runPromise = orchestrator.runStream('s1', 'u1', '断连', sse);
    await vi.waitFor(() => expect(capturedSignal).toBeDefined());
    emitClose(); // 断连（连接已关）
    expect(capturedSignal?.aborted).toBe(true);
    release();
    await runPromise;
    // 断连：不写 error 事件（连接已关，写了会触发未处理 error，既有行为）
    expect(sent).toEqual([]);
    // 累积部分仍尽力落库（断连不丢已生成部分，与正常断连路径一致）
    expect(persistSpy).toHaveBeenCalledTimes(1);
    expect(persistSpy).toHaveBeenCalledWith('s1', '已生成部分', {
      reasoning: null,
      references: [],
      interrupted: true,
    });
    // 日志措辞区分：断连 → 「客户端断开，生成中止」（与 stop 的「生成被用户
    // 停止」区分，见 runStream catch 注释；第二参为错误 message 上下文）
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('客户端断开，生成中止'),
      expect.anything(),
    );
    warnSpy.mockRestore();
  });

  it('质量审查整改：stop 竞态但错误未挂载累积部分（非 Agent 管线错误）→ 仅发 error(generation_stopped)，不落库', async () => {
    const { orchestrator, messageService, agentOrchestrator } = setup();
    const { res } = mockRes();
    const sse = new SseService(res);
    const sent: ChatEvent[] = [];
    vi.spyOn(sse, 'send').mockImplementation((ev: ChatEvent) => {
      sent.push(ev);
    });
    messageService.createUserMessage.mockResolvedValue({ id: 'user-1' });
    let capturedSignal: AbortSignal | undefined;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    agentOrchestrator.run.mockImplementation(
      async (
        _sid: string,
        _uid: string,
        _content: string,
        _sse: unknown,
        signal: AbortSignal,
      ) => {
        capturedSignal = signal;
        await gate;
        throw new Error('sse write failed'); // 未挂载累积部分
      },
    );
    const runPromise = orchestrator.runStream('s1', 'u1', '停止', sse);
    await vi.waitFor(() => expect(capturedSignal).toBeDefined());
    const registry = (
      orchestrator as unknown as {
        generationRegistry: GenerationRegistry;
      }
    ).generationRegistry;
    registry.stop('s1');
    release();
    await runPromise;
    // 无累积部分可落库：仅收尾 error（客户端不 hang——等不到 done/error 会
    // 一直转圈）
    expect(messageService.createAssistantMessage).not.toHaveBeenCalled();
    expect(sent.map((e) => e.type)).toEqual(['error']);
    expect(sent[0]).toMatchObject({
      type: 'error',
      code: 'generation_stopped',
    });
  });
});
