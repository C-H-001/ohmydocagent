// MessageService 单元测试（Task 2.2）：mock DataSource.transaction（事务管理器
// 转发到 manager mock）+ TITLE 队列，覆盖——
// - createUserMessage 事务内：查会话（404/403 归属 + 22P02 兜底 404）→
//   首条用户消息判定（count）→ 创建 user 消息（role/content 断言）
// - 首条判定：第 1 条入队 TITLE、第 2 条不入队（count>0 不入队）
// - 入队在事务提交后（事务未提交不触发入队）
// - 入队失败（Redis 抖动）不阻断消息创建（fire-and-forget + 日志）
import { ForbiddenException, Logger, NotFoundException } from '@nestjs/common';
import { describe, beforeEach, expect, it, vi } from 'vitest';
import { MessageService } from './message.service.js';
import { TITLE_QUEUE } from './chat-queue.constants.js';
import { Message } from './message.entity.js';
import { Session } from './session.entity.js';

/** 组装 mock 依赖：dataSource.transaction 把回调转发到 manager mock
 * （findOne/count/create/save 可分别 stub）；queue.add 记录入队调用 */
function buildService(options: {
  session?: object | null;
  userMessageCount?: number;
  addImpl?: () => Promise<unknown>;
}) {
  const {
    session = { id: 's1', userId: 'u-owner', title: '新会话' },
    userMessageCount = 0,
    addImpl,
  } = options;
  const manager = {
    findOne: vi.fn().mockResolvedValue(session),
    count: vi.fn().mockResolvedValue(userMessageCount),
    create: vi.fn((_entity: unknown, data: object) => data),
    save: vi.fn(async (_entity: unknown, entity: object) => entity),
  };
  const dataSource = {
    transaction: vi.fn(async (fn: (m: unknown) => Promise<unknown>) =>
      fn(manager),
    ),
  };
  const queue = {
    add: vi.fn(addImpl ?? (async () => ({}))),
  };
  // Task 2.4：MessageService 新增 @InjectRepository(Message)（createAssistantMessage
  // 单条插入不走事务）；repo.create 返回入参、save 返回实体（与 manager 同形态）
  const repo = {
    create: vi.fn((data: object) => data),
    save: vi.fn(async (entity: object) => entity),
  };
  const service = new MessageService(
    dataSource as never,
    queue as never,
    repo as never,
  );
  return { service, manager, queue, dataSource, repo };
}

describe('MessageService', () => {
  // 服务内部 new Logger() 自建实例：spy 原型方法拦截所有实例的 warn 输出
  const warnSpy = vi
    .spyOn(Logger.prototype, 'warn')
    .mockImplementation(() => undefined);

  beforeEach(() => {
    warnSpy.mockClear();
  });

  it('首条用户消息：事务内创建 user 消息 + 入队 TITLE（载荷 { sessionId } + attempts=2）', async () => {
    const { service, manager, queue } = buildService({ userMessageCount: 0 });
    const msg = await service.createUserMessage(
      's1',
      'AI 助手如何添加知识库？',
      'u-owner',
    );
    // 事务内调用链：归属校验（findOne）→ 首条判定（count role=user）→ 创建保存
    expect(manager.findOne).toHaveBeenCalledWith(Session, {
      where: { id: 's1' },
    });
    expect(manager.count).toHaveBeenCalledWith(Message, {
      where: { sessionId: 's1', role: 'user' },
    });
    expect(manager.create).toHaveBeenCalledWith(Message, {
      sessionId: 's1',
      role: 'user',
      content: 'AI 助手如何添加知识库？',
    });
    // 返回保存后的消息（role/content）
    expect(msg.role).toBe('user');
    expect(msg.content).toBe('AI 助手如何添加知识库？');
    // 首条 → 入队标题生成（配置走 addQueueJob 单点：attempts=2 + 指数退避）
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(queue.add).toHaveBeenCalledWith(
      TITLE_QUEUE,
      { sessionId: 's1' },
      expect.objectContaining({ attempts: 2 }),
    );
  });

  it('第二条用户消息：count>0 不入队 TITLE（只创建消息）', async () => {
    const { service, queue } = buildService({ userMessageCount: 1 });
    const msg = await service.createUserMessage('s1', '第二个问题', 'u-owner');
    expect(msg.content).toBe('第二个问题');
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('入队在事务提交后：事务未提交不触发入队', async () => {
    const { manager, queue } = buildService({});
    // 事务 mock 挂闸门：fn(manager) 完成后不立即返回（模拟提交中），
    // 释放后才 resolve——断言释放前未入队、释放后入队一次
    let releaseTx!: () => void;
    const gate = new Promise<void>((r) => (releaseTx = r));
    const dataSource = {
      transaction: vi.fn(async (fn: (m: unknown) => Promise<unknown>) => {
        const result = await fn(manager);
        await gate; // 模拟事务提交延迟
        return result;
      }),
    };
    const service = new MessageService(
      dataSource as never,
      queue as never,
      {} as never,
    );
    const p = service.createUserMessage('s1', '内容', 'u-owner');
    // 让事务回调先跑完（微任务/宏任务让出）
    await new Promise((r) => setTimeout(r, 10));
    expect(queue.add).not.toHaveBeenCalled();
    releaseTx();
    await p;
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('入队失败（Redis 抖动）不阻断消息创建（fire-and-forget + 日志）', async () => {
    const { service, queue } = buildService({
      addImpl: () => Promise.reject(new Error('Redis 不可用')),
    });
    // 消息创建成功（入队失败仅记日志，标题缺失不影响会话可用）
    const msg = await service.createUserMessage('s1', '内容', 'u-owner');
    expect(msg.content).toBe('内容');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('入队失败'),
      expect.any(Error),
    );
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('createAssistantMessage：插入 assistant 消息（content + reasoning；不触发标题入队）', async () => {
    const { service, repo, queue } = buildService({});
    const msg = await service.createAssistantMessage('s1', '完整回复内容', {
      reasoning: '思考过程',
    });
    // 单条插入：repo.create + repo.save（不走事务管理器）；references 缺省为空
    // 数组（非 RAG 路径，见 createAssistantMessage 注释）；interrupted 缺省
    // false（正常完成，Task 2.10）
    expect(repo.create).toHaveBeenCalledWith({
      sessionId: 's1',
      role: 'assistant',
      content: '完整回复内容',
      reasoning: '思考过程',
      references: [],
      interrupted: false,
    });
    expect(repo.save).toHaveBeenCalledTimes(1);
    expect(msg.content).toBe('完整回复内容');
    // assistant 消息不触发标题生成（标题只由首条 user 消息触发）
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('createAssistantMessage：reasoning 缺省 → null（无深度思考的模型）', async () => {
    const { service, repo } = buildService({});
    const msg = await service.createAssistantMessage('s1', '普通回复');
    expect(repo.create).toHaveBeenCalledWith({
      sessionId: 's1',
      role: 'assistant',
      content: '普通回复',
      reasoning: null,
      references: [],
      interrupted: false,
    });
    expect(msg.reasoning).toBeNull();
  });

  it('createAssistantMessage：references 透传落库（Task 2.5 RAG 引用）', async () => {
    const { service, repo } = buildService({});
    const refs = [
      {
        index: 1,
        chunkId: 'c1',
        kbId: 'kb1',
        knowledgeId: 'kb-1',
        knowledgeTitle: '文档标题',
        content: '分块内容',
        score: 0.9,
      },
    ];
    const msg = await service.createAssistantMessage('s1', '回答', {
      reasoning: null,
      references: refs,
    });
    expect(repo.create).toHaveBeenCalledWith({
      sessionId: 's1',
      role: 'assistant',
      content: '回答',
      reasoning: null,
      references: refs,
      interrupted: false,
    });
    expect(msg.references).toEqual(refs);
  });

  it('他人会话 → 403（无权访问该会话），不创建、不入队', async () => {
    const { service, manager, queue } = buildService({
      session: { id: 's1', userId: 'u-other' },
    });
    await expect(
      service.createUserMessage('s1', '内容', 'u-owner'),
    ).rejects.toThrow(ForbiddenException);
    expect(manager.count).not.toHaveBeenCalled();
    expect(manager.create).not.toHaveBeenCalled();
    expect(manager.save).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('会话不存在 → 404（会话不存在），不创建、不入队', async () => {
    const { service, manager, queue } = buildService({ session: null });
    await expect(
      service.createUserMessage('s1', '内容', 'u-owner'),
    ).rejects.toThrow(NotFoundException);
    expect(manager.count).not.toHaveBeenCalled();
    expect(manager.save).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('非 UUID 格式 id：22P02 兜底转 404（不泄露 500）', async () => {
    const pgError = new Error('invalid input syntax for type uuid');
    (pgError as { driverError?: { code?: string } }).driverError = {
      code: '22P02',
    };
    const { service, manager, queue } = buildService({});
    manager.findOne.mockRejectedValue(pgError);
    await expect(
      service.createUserMessage('not-a-uuid', '内容', 'u-owner'),
    ).rejects.toThrow(NotFoundException);
    expect(manager.count).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });
});
