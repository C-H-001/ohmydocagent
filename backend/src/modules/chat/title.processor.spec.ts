// TitleProcessor 单元测试（Task 2.2）：mock 仓库 + ChatModelService，覆盖——
// - 默认标题「新会话」→ 调 LLM 生成并更新（chat 参数断言：中文 system 提示
//   含首条消息内容；首条消息按 createdAt ASC + id 决胜键取）
// - 手动重命名标题 → 不调 chat、不更新（不覆盖手动值）
// - 超长输出 → trim + 双字节安全截断 50 字（防御 LLM 超长；含 emoji 标题
//   截断不劈开代理对，质量审查整改补测）
// - 超长首条消息 → 发送前截断到 TITLE_INPUT_MAX_LENGTH（LLM 输入无上限
//   防御，质量审查整改补测）
// - 空回复（空白）→ 保持原标题、不落库
// - 会话不存在 / 无首条消息 → no-op（不调 chat、不更新）
// - LLM 失败 → 抛错触发 BullMQ 重试（重试耗尽仅记日志，标题缺失不影响会话）
// 用 mock 依赖直接实例化（@Processor 装饰器仅影响 DI 元数据，与
// summary.processor.spec.ts 同模式）。
import { Logger } from '@nestjs/common';
import { describe, beforeEach, expect, it, vi } from 'vitest';
import {
  TitleProcessor,
  TITLE_MAX_LENGTH,
  TITLE_INPUT_MAX_LENGTH,
} from './title.processor.js';

/** 检测字符串中是否含孤立代理（低代理前无高代理 / 高代理后无低代理 /
 * 高代理在串尾）——与 test/chunking.spec.ts 同一实现，直接复制（公共断言
 * 工具属测试域，暂不收敛到共享文件，避免测试基建过度设计）。 */
function hasOrphanSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      const prev = s.charCodeAt(i - 1);
      if (!(prev >= 0xd800 && prev <= 0xdbff)) return true;
    }
  }
  return false;
}

/** 组装 mock 依赖：sessionRepo.findOne 返回会话（null = 已删除）；
 * messageRepo.findOne 返回首条用户消息（null = 异常态无消息）；
 * chatModel.chat 可注入失败/超长实现 */
function buildProcessor(options: {
  session?: object | null;
  firstMessage?: object | null;
  chatImpl?: () => Promise<string>;
}) {
  const {
    session = { id: 's1', title: '新会话', userId: 'u-owner' },
    firstMessage = { content: '第一条提问内容' },
    chatImpl,
  } = options;
  const sessionRepo = {
    findOne: vi.fn().mockResolvedValue(session),
    save: vi.fn(async (entity: object) => entity),
  };
  const messageRepo = { findOne: vi.fn().mockResolvedValue(firstMessage) };
  const chatModel = {
    chat: vi.fn(chatImpl ?? (() => Promise.resolve('生成的标题'))),
  };
  const processor = new TitleProcessor(
    sessionRepo as never,
    messageRepo as never,
    chatModel as never,
  );
  return { processor, sessionRepo, messageRepo, chatModel };
}

describe('TitleProcessor', () => {
  // 服务内部 new Logger() 自建实例：spy 原型方法拦截所有实例的 warn 输出
  const warnSpy = vi
    .spyOn(Logger.prototype, 'warn')
    .mockImplementation(() => undefined);

  beforeEach(() => {
    warnSpy.mockClear();
  });

  it('默认标题「新会话」→ 调 LLM 生成并更新 title（中文提示含首条消息内容）', async () => {
    const { processor, sessionRepo, messageRepo, chatModel } = buildProcessor(
      {},
    );
    const job = { data: { sessionId: 's1' } } as never;
    await expect(processor.process(job)).resolves.toEqual({ titled: true });
    // 首条用户消息按 createdAt ASC + id 决胜键取（与消息列表同排序语义）
    expect(messageRepo.findOne).toHaveBeenCalledWith({
      where: { sessionId: 's1', role: 'user' },
      order: { createdAt: 'ASC', id: 'ASC' },
    });
    // chat 参数：中文 system 提示 + 首条消息内容
    expect(chatModel.chat).toHaveBeenCalledTimes(1);
    expect(chatModel.chat).toHaveBeenCalledWith([
      {
        role: 'system',
        content: expect.stringContaining('标题'),
      },
      { role: 'user', content: '第一条提问内容' },
    ]);
    // 更新 title 并落库
    const saved = sessionRepo.save.mock.calls[0]?.[0] as {
      title: string;
    };
    expect(saved.title).toBe('生成的标题');
  });

  it('手动重命名后的会话 → 不调 chat、不更新（不覆盖手动标题）', async () => {
    const { processor, sessionRepo, chatModel } = buildProcessor({
      session: { id: 's1', title: '手动标题', userId: 'u-owner' },
    });
    const job = { data: { sessionId: 's1' } } as never;
    await expect(processor.process(job)).resolves.toEqual({ titled: false });
    expect(chatModel.chat).not.toHaveBeenCalled();
    expect(sessionRepo.save).not.toHaveBeenCalled();
  });

  it('超长输出 → trim + 截断 50 字（防御 LLM 超长）', async () => {
    const long = '超'.repeat(60);
    const { processor, sessionRepo, chatModel } = buildProcessor({
      chatImpl: () => Promise.resolve(`  ${long}  `),
    });
    const job = { data: { sessionId: 's1' } } as never;
    await expect(processor.process(job)).resolves.toEqual({ titled: true });
    const saved = sessionRepo.save.mock.calls[0]?.[0] as { title: string };
    // trim 掉环绕空白后再截断
    expect(saved.title.length).toBe(TITLE_MAX_LENGTH);
    expect(saved.title).toBe('超'.repeat(50));
    expect(chatModel.chat).toHaveBeenCalledTimes(1);
  });

  it('含 emoji 的标题截断不劈开代理对（截断点落在代理对中间 → 回退丢弃整个 emoji）', async () => {
    // 构造截断点恰落在代理对中间的输出：49 个 'a' + 1 个 emoji（'a' 占 1 码元、
    // emoji 占 2 码元，总长 51 > 50）——直接 slice(0, 50) 会切在 emoji 的
    // 低代理上，产生孤立低代理（乱码）；clampSurrogateBoundary 回退到 49，
    // 配对整体被丢弃（不劈开）
    const { processor, sessionRepo } = buildProcessor({
      chatImpl: () => Promise.resolve(`${'a'.repeat(49)}😀`),
    });
    const job = { data: { sessionId: 's1' } } as never;
    await expect(processor.process(job)).resolves.toEqual({ titled: true });
    const saved = sessionRepo.save.mock.calls[0]?.[0] as { title: string };
    expect(saved.title.length).toBeLessThanOrEqual(TITLE_MAX_LENGTH);
    expect(hasOrphanSurrogate(saved.title)).toBe(false);
    // 回退到代理对起点：整个 emoji 被丢弃而非劈成两半
    expect(saved.title).toBe('a'.repeat(49));
  });

  it('纯 emoji 标题截断：截断点恰好落在代理对起点也不劈开配对', async () => {
    const { processor, sessionRepo } = buildProcessor({
      // 120 码元 > 50；截断点 50 恰为第 25 个 emoji 的高代理（代理对起点）
      chatImpl: () => Promise.resolve('😀'.repeat(60)),
    });
    const job = { data: { sessionId: 's1' } } as never;
    await expect(processor.process(job)).resolves.toEqual({ titled: true });
    const saved = sessionRepo.save.mock.calls[0]?.[0] as { title: string };
    expect(saved.title.length).toBe(TITLE_MAX_LENGTH);
    expect(hasOrphanSurrogate(saved.title)).toBe(false);
    expect(saved.title).toBe('😀'.repeat(25)); // 50 码元 = 25 个完整 emoji
  });

  it('超长首条消息 → chat 收到的 content 截断到 TITLE_INPUT_MAX_LENGTH 且无孤立代理', async () => {
    // 2000 码元截断点恰落在 emoji 低代理上（1999 个 'a' + emoji 占 2 码元，
    // 再加 500 个 'x' 共 2501 码元）——截断必须回退到 1999 丢弃整个 emoji
    const { processor, chatModel } = buildProcessor({
      firstMessage: {
        content: `${'a'.repeat(TITLE_INPUT_MAX_LENGTH - 1)}😀`.concat(
          'x'.repeat(500),
        ),
      },
    });
    const job = { data: { sessionId: 's1' } } as never;
    await expect(processor.process(job)).resolves.toEqual({ titled: true });
    // chat mock 是零参签名，calls 元组无索引元素：先整体断言再取参（as
    // unknown 绕过 vi.fn 元组类型——测试访问 mock 实参的惯用法）
    const calls = chatModel.chat.mock.calls as unknown as [
      { role: string; content: string }[],
    ][];
    const userMsg = calls[0]?.[0].find((m) => m.role === 'user');
    expect(userMsg!.content.length).toBeLessThanOrEqual(TITLE_INPUT_MAX_LENGTH);
    expect(hasOrphanSurrogate(userMsg!.content)).toBe(false);
    expect(userMsg!.content).toBe('a'.repeat(TITLE_INPUT_MAX_LENGTH - 1));
  });

  it('超长 emoji 首条消息 → chat 内容截断后仍为完整 emoji（无孤立代理）', async () => {
    const { processor, chatModel } = buildProcessor({
      firstMessage: { content: '😀'.repeat(TITLE_INPUT_MAX_LENGTH) }, // 4000 码元
    });
    const job = { data: { sessionId: 's1' } } as never;
    await expect(processor.process(job)).resolves.toEqual({ titled: true });
    const calls = chatModel.chat.mock.calls as unknown as [
      { role: string; content: string }[],
    ][];
    const userMsg = calls[0]?.[0].find((m) => m.role === 'user');
    expect(userMsg!.content.length).toBe(TITLE_INPUT_MAX_LENGTH);
    expect(hasOrphanSurrogate(userMsg!.content)).toBe(false);
    expect(userMsg!.content).toBe('😀'.repeat(1000)); // 2000 码元 = 1000 个 emoji
  });

  it('空回复（纯空白）→ 保持原标题、不落库', async () => {
    const { processor, sessionRepo, chatModel } = buildProcessor({
      chatImpl: () => Promise.resolve('   '),
    });
    const job = { data: { sessionId: 's1' } } as never;
    await expect(processor.process(job)).resolves.toEqual({ titled: false });
    expect(chatModel.chat).toHaveBeenCalledTimes(1);
    expect(sessionRepo.save).not.toHaveBeenCalled();
  });

  it('会话不存在（已删除）→ no-op：不调 chat、不更新、记日志跳过', async () => {
    const { processor, sessionRepo, chatModel } = buildProcessor({
      session: null,
    });
    const job = { data: { sessionId: 's1' } } as never;
    await expect(processor.process(job)).resolves.toEqual({ titled: false });
    expect(chatModel.chat).not.toHaveBeenCalled();
    expect(sessionRepo.save).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('不存在'));
  });

  it('无首条用户消息（异常中间态）→ no-op：不调 chat、不更新', async () => {
    const { processor, sessionRepo, chatModel } = buildProcessor({
      firstMessage: null,
    });
    const job = { data: { sessionId: 's1' } } as never;
    await expect(processor.process(job)).resolves.toEqual({ titled: false });
    expect(chatModel.chat).not.toHaveBeenCalled();
    expect(sessionRepo.save).not.toHaveBeenCalled();
  });

  it('LLM 失败 → 抛错触发 BullMQ 重试（重试耗尽仅记日志）', async () => {
    const { processor, sessionRepo, chatModel } = buildProcessor({
      chatImpl: () => Promise.reject(new Error('LLM 超时')),
    });
    const job = { data: { sessionId: 's1' } } as never;
    await expect(processor.process(job)).rejects.toThrow('LLM 超时');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('LLM 超时'));
    expect(sessionRepo.save).not.toHaveBeenCalled();
    expect(chatModel.chat).toHaveBeenCalledTimes(1);
  });
});
