// ParseProcessor 单测（Task 1.5 质量修复 + Task 1.6/1.7 入队断言）：
// 1. 分块事务删除竞态：文档在解析期间被删除 → 分块事务内 knowledge 存在性
//    复查（SELECT ... FOR UPDATE）读到行已删 → 抛错回滚、不插块（无孤儿块，
//    Task 1.6 向量化不会消费）。
// 2. 分块成功后入队 EMBED（Task 1.6 向量化）+ SUMMARY（Task 1.7 自动摘要，
//    有 parsedText 才入队——空文本不入队，见「空文本」用例）。
// 用 mock 依赖直接实例化 processor（@Processor 装饰器仅影响 DI 元数据），
// 验证事务回调首句先复查、不存在即抛错、replaceChunksInTx 不被调用。
// 竞态的另一半（remove 的事务化删行 + 删块）由 chunk.e2e-spec 的删除用例覆盖。
import { describe, expect, it, vi } from 'vitest';
import { ParseProcessor } from '../src/modules/parse/parse.processor.js';
import { ChunkingService } from '../src/modules/chunk/chunking.service.js';

describe('ParseProcessor 分块事务删除竞态', () => {
  const knowledge = {
    id: 'doc-1',
    kbId: 'kb-1',
    fileType: 'md',
    filePath: '',
    sourceUrl: '',
    manualContent: null,
  };

  /** 组装 mock 依赖（transaction 回调透传 fake manager；query 可注入行存在性） */
  function buildProcessor(aliveRows: Array<{ id: string }>) {
    const manager = {
      query: vi.fn().mockResolvedValue(aliveRows),
    };
    const progress = {
      markParsing: vi.fn().mockResolvedValue(undefined),
      saveParsedText: vi.fn().mockResolvedValue(undefined),
      markFailed: vi.fn().mockResolvedValue(undefined),
      updateProgress: vi.fn().mockResolvedValue(undefined),
    };
    const parser = { parse: vi.fn().mockResolvedValue({ text: '文档正文' }) };
    const chunkService = { replaceChunksInTx: vi.fn().mockResolvedValue([]) };
    const dataSource = {
      transaction: vi
        .fn()
        .mockImplementation(async (cb: (m: typeof manager) => Promise<void>) =>
          cb(manager),
        ),
    };
    const repo = { findOne: vi.fn().mockResolvedValue(knowledge) };
    const kbRepo = {
      findOne: vi.fn().mockResolvedValue({ chunkingConfig: null }),
    };
    // 向量化队列 mock（Task 1.6）：分块成功后入队 EMBED，断言入队参数用
    const embedQueue = { add: vi.fn().mockResolvedValue(undefined) };
    // 摘要队列 mock（Task 1.7）：分块成功后入队 SUMMARY（有 parsedText 才入队）
    const summaryQueue = { add: vi.fn().mockResolvedValue(undefined) };
    // 图谱抽取队列 mock（Task 3.2）：分块成功后按 KB extractConfig 入队 GRAPH
    const graphQueue = { add: vi.fn().mockResolvedValue(undefined) };
    const processor = new ParseProcessor(
      repo as never,
      kbRepo as never,
      progress as never,
      null as never,
      parser as never,
      { get: () => 'mineru' } as never,
      dataSource as never,
      new ChunkingService(),
      chunkService as never,
      embedQueue as never,
      summaryQueue as never,
      graphQueue as never,
    );
    return {
      processor,
      progress,
      chunkService,
      manager,
      dataSource,
      embedQueue,
      summaryQueue,
      graphQueue,
      parser,
    };
  }

  it('知识行已删（竞态）→ 事务内复查抛错回滚，不插块', async () => {
    const { processor, progress, chunkService } = buildProcessor([]);
    const job = { data: { knowledgeId: 'doc-1' } } as never;
    await expect(processor.process(job)).rejects.toThrow(/删除/);
    // 复查是事务首句：失败后不写块、不写 chunk 阶段
    expect(chunkService.replaceChunksInTx).not.toHaveBeenCalled();
    expect(progress.updateProgress).not.toHaveBeenCalled();
    // 失败标记走 chunk 阶段（分块位置失败）
    expect(progress.markFailed).toHaveBeenCalledWith(
      'doc-1',
      expect.any(String),
      'chunk',
    );
  });

  it('知识行存在 → 正常分块落库（replaceChunksInTx 被调用）', async () => {
    const {
      processor,
      chunkService,
      manager,
      embedQueue,
      summaryQueue,
      graphQueue,
    } = buildProcessor([{ id: 'doc-1' }]);
    const job = { data: { knowledgeId: 'doc-1' } } as never;
    await expect(processor.process(job)).resolves.toEqual({ textLength: 4 });
    // 复查 SQL 带 FOR UPDATE 行锁（与 remove 的事务化行删除互斥）
    expect(manager.query).toHaveBeenCalledWith(
      'SELECT id FROM knowledge WHERE id = $1 FOR UPDATE',
      ['doc-1'],
    );
    expect(chunkService.replaceChunksInTx).toHaveBeenCalled();
    // Task 1.6：分块成功后入队向量化（EMBED_QUEUE，载荷只带 knowledgeId）
    expect(embedQueue.add).toHaveBeenCalledWith(
      'embed',
      { knowledgeId: 'doc-1' },
      expect.objectContaining({ attempts: 2 }),
    );
    // Task 1.7：有 parsedText → 分块成功后同样入队摘要（SUMMARY_QUEUE）
    expect(summaryQueue.add).toHaveBeenCalledWith(
      'summary',
      { knowledgeId: 'doc-1' },
      expect.objectContaining({ attempts: 2 }),
    );
    // Task 3.2：KB extractConfig 缺省（默认开启）→ 分块成功后入队图谱抽取
    expect(graphQueue.add).toHaveBeenCalledWith(
      'graph',
      { knowledgeId: 'doc-1' },
      expect.objectContaining({ attempts: 2 }),
    );
  });

  it('KB extractConfig.enabled=false → 不入队图谱抽取（KB 级开关）', async () => {
    const { embedQueue, summaryQueue, graphQueue } = buildProcessor([
      { id: 'doc-1' },
    ]);
    // KB 显式关闭抽取：入队侧检查 extractConfig（消费侧 ExtractProcessor 双保险）
    const kbRepo = {
      findOne: vi.fn().mockResolvedValue({ extractConfig: { enabled: false } }),
    };
    // 重新组装 processor：kbRepo 需在构造时传入（buildProcessor 固定返回）
    const manager = {
      query: vi.fn().mockResolvedValue([{ id: 'doc-1' }]),
    };
    const progress = {
      markParsing: vi.fn().mockResolvedValue(undefined),
      saveParsedText: vi.fn().mockResolvedValue(undefined),
      markFailed: vi.fn().mockResolvedValue(undefined),
      updateProgress: vi.fn().mockResolvedValue(undefined),
    };
    const parser2 = { parse: vi.fn().mockResolvedValue({ text: '文档正文' }) };
    const chunkService = { replaceChunksInTx: vi.fn().mockResolvedValue([]) };
    const dataSource2 = {
      transaction: vi
        .fn()
        .mockImplementation(async (cb: (m: typeof manager) => Promise<void>) =>
          cb(manager),
        ),
    };
    const repo2 = { findOne: vi.fn().mockResolvedValue(knowledge) };
    const processor2 = new ParseProcessor(
      repo2 as never,
      kbRepo as never,
      progress as never,
      null as never,
      parser2 as never,
      { get: () => 'mineru' } as never,
      dataSource2 as never,
      new ChunkingService(),
      chunkService as never,
      embedQueue as never,
      summaryQueue as never,
      graphQueue as never,
    );
    await expect(
      processor2.process({ data: { knowledgeId: 'doc-1' } } as never),
    ).resolves.toEqual({
      textLength: 4,
    });
    // 向量化/摘要正常入队，图谱抽取被 KB 开关拦下
    expect(embedQueue.add).toHaveBeenCalled();
    expect(summaryQueue.add).toHaveBeenCalled();
    expect(graphQueue.add).not.toHaveBeenCalled();
  });

  it('空文本 → ready + chunkCount=0，不入队 SUMMARY（有 parsedText 才入队）', async () => {
    const {
      processor,
      parser,
      progress,
      embedQueue,
      summaryQueue,
      graphQueue,
    } = buildProcessor([{ id: 'doc-1' }]);
    // 空文本（图片占位返回 ''）：不分块、不入队摘要/向量化/图谱抽取
    parser.parse.mockResolvedValue({ text: '' });
    const job = { data: { knowledgeId: 'doc-1' } } as never;
    await expect(processor.process(job)).resolves.toEqual({ textLength: 0 });
    expect(embedQueue.add).not.toHaveBeenCalled();
    expect(summaryQueue.add).not.toHaveBeenCalled();
    expect(graphQueue.add).not.toHaveBeenCalled();
    // 单条原子写置 ready + chunkCount=0 + chunk done 阶段（空文本分支）
    expect(progress.updateProgress).toHaveBeenCalledWith(
      'doc-1',
      expect.objectContaining({
        status: 'ready',
        chunkCount: 0,
        stage: expect.objectContaining({ stage: 'chunk', status: 'done' }),
      }),
    );
  });
});
