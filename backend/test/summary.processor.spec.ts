// SummaryProcessor 单元测试（Task 1.7 质量审查补测）：
// - 成功：chatModel.chat 生成摘要 → 先追加 summary running（chat 前），再
//   summary + done 阶段同一条 UPDATE 原子写（不出现「摘要已写但阶段缺失」
//   的中间态，见 summary.processor.ts process() 注释）
// - 文档不存在（404 语义）：记日志跳过 no-op（不查 chat、不写状态——与
//   EmbedProcessor 的删除跳过同一语义，重试只会空转）
// - 空文本（无 parsedText）：no-op（与 ParseProcessor「有 parsedText 才入队」
//   双保险，见 process() 注释）
// - 失败：仅记日志 + 抛错触发 BullMQ 重试（不写 status=failed、不追加
//   summary failed 阶段——摘要失败 ≠ 文档失败，时间线不误伤，见
//   summary.processor.ts 文件头决策注释）
// 用 mock 依赖直接实例化（@Processor 装饰器仅影响 DI 元数据，与
// embed-processor.spec.ts 同模式）。
import { Logger } from '@nestjs/common';
import { describe, beforeEach, expect, it, vi } from 'vitest';
import { SummaryProcessor } from '../src/modules/parse/summary.processor.js';

/**
 * 组装 mock 依赖：repo.findOne 返回 knowledge（null = 文档已删）；
 * progress.updateProgress 记录每次写回；chatModel.chat 可注入失败实现。
 * knowledge 的 parsedText 可覆盖（空文本分支）。
 */
function buildProcessor(options: {
  knowledge?: object | null;
  chatImpl?: () => Promise<string>;
}) {
  const { knowledge = { id: 'doc-1', parsedText: '文档正文' }, chatImpl } =
    options;
  const repo = { findOne: vi.fn().mockResolvedValue(knowledge) };
  const progress = { updateProgress: vi.fn().mockResolvedValue(undefined) };
  const chatModel = {
    chat: vi.fn(chatImpl ?? (() => Promise.resolve('生成的中文摘要'))),
  };
  const processor = new SummaryProcessor(
    repo as never,
    progress as never,
    { query: vi.fn() } as never,
    chatModel as never,
  );
  return { processor, repo, progress, chatModel };
}

describe('SummaryProcessor', () => {
  // 服务内部 new Logger() 自建实例：spy 原型方法拦截所有实例的 warn 输出
  const warnSpy = vi
    .spyOn(Logger.prototype, 'warn')
    .mockImplementation(() => undefined);

  beforeEach(() => {
    warnSpy.mockClear();
  });

  it('成功：LLM 生成摘要 → running + done 两次原子写（summary 与 done 阶段同一条 UPDATE）', async () => {
    const { processor, progress, chatModel } = buildProcessor({});
    const job = { data: { knowledgeId: 'doc-1' } } as never;
    await expect(processor.process(job)).resolves.toEqual({ summarized: true });
    // 调用链：chat 一次（system 提示 + user 正文，截断保护由 process 内处理）
    expect(chatModel.chat).toHaveBeenCalledTimes(1);
    expect(chatModel.chat).toHaveBeenCalledWith([
      expect.objectContaining({ role: 'system' }),
      expect.objectContaining({ role: 'user', content: '文档正文' }),
    ]);
    // 时间线：先 running（chat 前）→ done（保存 summary 时，同一条 UPDATE）
    const stages = progress.updateProgress.mock.calls.map(
      (call: unknown[]) =>
        (call[1] as { stage: { status: string } }).stage.status,
    );
    expect(stages).toEqual(['running', 'done']);
    // done 调用携带 summary（与阶段原子写——不会出现「摘要已写但阶段缺失」）
    const doneCall = progress.updateProgress.mock.calls[1] as [
      string,
      { summary: string; stage: object },
    ];
    expect(doneCall[1].summary).toBe('生成的中文摘要');
    expect(doneCall[1].stage).toMatchObject({
      stage: 'summary',
      status: 'done',
    });
  });

  it('文档不存在（404 语义）→ 记日志跳过 no-op：不查 chat、不写状态', async () => {
    const { processor, progress, chatModel } = buildProcessor({
      knowledge: null,
    });
    const job = { data: { knowledgeId: 'doc-1' } } as never;
    await expect(processor.process(job)).resolves.toEqual({
      summarized: false,
    });
    expect(chatModel.chat).not.toHaveBeenCalled();
    expect(progress.updateProgress).not.toHaveBeenCalled();
    // 记日志跳过（非抛错重试：删除场景下重试无意义，见文件头注释）
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('不存在'));
  });

  it('空文本（无 parsedText）→ no-op：不查 chat、不写状态（与「有 parsedText 才入队」双保险）', async () => {
    const { processor, progress, chatModel } = buildProcessor({
      knowledge: { id: 'doc-1', parsedText: '' },
    });
    const job = { data: { knowledgeId: 'doc-1' } } as never;
    await expect(processor.process(job)).resolves.toEqual({
      summarized: false,
    });
    expect(chatModel.chat).not.toHaveBeenCalled();
    expect(progress.updateProgress).not.toHaveBeenCalled();
  });

  it('失败：仅记日志 + 抛错触发 BullMQ 重试（不写 failed 状态/阶段）', async () => {
    const { processor, progress, chatModel } = buildProcessor({
      chatImpl: () => Promise.reject(new Error('LLM 超时')),
    });
    const job = { data: { knowledgeId: 'doc-1' } } as never;
    // 抛错 → BullMQ 按 attempts=2 + backoff 重试（重试耗尽仅记日志，见文件头）
    await expect(processor.process(job)).rejects.toThrow('LLM 超时');
    // 仅记日志：失败原因记录（不写 status=failed、不追加 summary failed 阶段
    // ——摘要失败 ≠ 文档失败，文档已 ready 可用，时间线不误伤）
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('LLM 超时'));
    // 时间线只有 running（失败不追加 failed 阶段；running 悬挂如实反映尝试轨迹）
    const stages = progress.updateProgress.mock.calls.map(
      (call: unknown[]) =>
        (call[1] as { stage: { status: string } }).stage.status,
    );
    expect(stages).toEqual(['running']);
    expect(chatModel.chat).toHaveBeenCalledTimes(1);
  });
});
