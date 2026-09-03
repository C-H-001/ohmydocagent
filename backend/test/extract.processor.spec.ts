// ExtractProcessor 单测（Task 3.2）：mock 依赖直接实例化（@Processor 装饰器仅
// 影响 DI 元数据，同 parse-processor.spec.ts 模式），验证 GRAPH_QUEUE 消费编排：
// - knowledge 404 / parsedText 空 / KB 缺失 / extractConfig.enabled=false /
//   chunks 空 / chunks 读取后文档被删（存在性复查）→ no-op（不调 LLM、不写阶段、
//   不写图、不抛错——图谱是非关键路径，见 extract.processor.ts 文件头注释）
// - 正常路径：graph running 阶段 → 读图谱既有实体集合（跨文档端点判定）→
//   并行抽取 → deleteKnowledgeSubgraph（reparse 清理旧 chunk 关联/镜像）→
//   upsertDocumentGraphInTx → graph done 阶段
// - 抽取失败（全部 chunk）：抛错（触发 BullMQ attempts=2 + backoff 2s 重试，
//   重试耗尽仅日志、不写 status=failed——图谱缺失不影响文档可用，与摘要同语义）
import { describe, expect, it, vi } from 'vitest';
import { ExtractProcessor } from '../src/modules/graph/extract.processor.js';

describe('ExtractProcessor GRAPH_QUEUE 消费编排', () => {
  const knowledge = { id: 'doc-1', kbId: 'kb-1', parsedText: '文档正文' };

  /** 组装 processor（可注入各依赖的返回形态） */
  function buildProcessor(
    options: {
      knowledge?: Record<string, unknown> | null;
      kb?: Record<string, unknown> | null;
      chunks?: Array<{ id: string; content: string }>;
      extractionError?: Error;
    } = {},
  ) {
    const knowledgeRepo = {
      findOne: vi
        .fn()
        .mockResolvedValue(
          options.knowledge === undefined ? knowledge : options.knowledge,
        ),
    };
    const kbRepo = {
      findOne: vi
        .fn()
        .mockResolvedValue(
          options.kb === undefined ? { extractConfig: {} } : options.kb,
        ),
    };
    const chunkRepo = {
      find: vi
        .fn()
        .mockResolvedValue(options.chunks ?? [{ id: 'c1', content: '块一' }]),
    };
    const progress = { updateProgress: vi.fn().mockResolvedValue(undefined) };
    const extraction = {
      extractAll: vi.fn().mockResolvedValue({
        entities: [{ name: '甲', attributes: ['人物'], chunkId: 'c1' }],
        relationships: [],
        chunks: [{ id: 'c1', content: '块一' }],
      }),
    };
    if (options.extractionError) {
      extraction.extractAll.mockRejectedValue(options.extractionError);
    }
    const graph = {
      deleteKnowledgeSubgraph: vi.fn().mockResolvedValue(undefined),
      upsertDocumentGraphInTx: vi.fn().mockResolvedValue(undefined),
      listEntityNames: vi.fn().mockResolvedValue([]),
    };
    const processor = new ExtractProcessor(
      knowledgeRepo as never,
      kbRepo as never,
      chunkRepo as never,
      progress as never,
      extraction as never,
      graph as never,
    );
    return { processor, progress, extraction, graph, chunkRepo };
  }

  it('knowledge 不存在（已删除）→ no-op：不调 LLM、不写阶段、不写图、不抛错', async () => {
    const { processor, extraction, graph, progress } = buildProcessor({
      knowledge: null,
    });
    await expect(
      processor.process({ data: { knowledgeId: 'doc-x' } } as never),
    ).resolves.toEqual({ extracted: false });
    expect(extraction.extractAll).not.toHaveBeenCalled();
    expect(graph.upsertDocumentGraphInTx).not.toHaveBeenCalled();
    expect(progress.updateProgress).not.toHaveBeenCalled();
  });

  it('parsedText 空（图片占位/异常中间态）→ no-op', async () => {
    const { processor, extraction, graph } = buildProcessor({
      knowledge: { id: 'doc-1', kbId: 'kb-1', parsedText: null },
    });
    await expect(
      processor.process({ data: { knowledgeId: 'doc-1' } } as never),
    ).resolves.toEqual({ extracted: false });
    expect(extraction.extractAll).not.toHaveBeenCalled();
    expect(graph.upsertDocumentGraphInTx).not.toHaveBeenCalled();
  });

  it('KB 缺失（KB 被并发删除）→ no-op', async () => {
    const { processor, extraction, graph } = buildProcessor({ kb: null });
    await expect(
      processor.process({ data: { knowledgeId: 'doc-1' } } as never),
    ).resolves.toEqual({ extracted: false });
    expect(extraction.extractAll).not.toHaveBeenCalled();
    expect(graph.upsertDocumentGraphInTx).not.toHaveBeenCalled();
  });

  it('KB extractConfig.enabled=false → no-op（消费侧 KB 级开关双保险）', async () => {
    const { processor, extraction, graph } = buildProcessor({
      kb: { extractConfig: { enabled: false } },
    });
    await expect(
      processor.process({ data: { knowledgeId: 'doc-1' } } as never),
    ).resolves.toEqual({ extracted: false });
    expect(extraction.extractAll).not.toHaveBeenCalled();
    expect(graph.upsertDocumentGraphInTx).not.toHaveBeenCalled();
  });

  it('chunks 为空（文档删除竞态后的中间态）→ no-op', async () => {
    const { processor, extraction, graph } = buildProcessor({ chunks: [] });
    await expect(
      processor.process({ data: { knowledgeId: 'doc-1' } } as never),
    ).resolves.toEqual({ extracted: false });
    expect(extraction.extractAll).not.toHaveBeenCalled();
    expect(graph.upsertDocumentGraphInTx).not.toHaveBeenCalled();
  });

  it('chunks 读取后文档被删除（存在性复查）→ no-op（不写图、不抛错）', async () => {
    // knowledgeRepo.findOne 第二次返回 null（第一次加载成功、复查时已删）
    const { extraction, graph, progress } = buildProcessor();
    const processor2 = new ExtractProcessor(
      {
        findOne: vi
          .fn()
          .mockResolvedValueOnce(knowledge)
          .mockResolvedValueOnce(null),
      } as never,
      { findOne: vi.fn().mockResolvedValue({ extractConfig: {} }) } as never,
      {
        find: vi.fn().mockResolvedValue([{ id: 'c1', content: '块一' }]),
      } as never,
      progress as never,
      extraction as never,
      graph as never,
    );
    await expect(
      processor2.process({ data: { knowledgeId: 'doc-1' } } as never),
    ).resolves.toEqual({ extracted: false });
    expect(extraction.extractAll).not.toHaveBeenCalled();
    expect(graph.upsertDocumentGraphInTx).not.toHaveBeenCalled();
    expect(progress.updateProgress).not.toHaveBeenCalled();
  });

  it('正常路径：graph running → 读图谱既有实体集合 → 抽取（传 chunk 内容）→ 清理旧子图 → 批量写入 → graph done', async () => {
    const { processor, progress, extraction, graph, chunkRepo } =
      buildProcessor();
    const result = await processor.process({
      data: { knowledgeId: 'doc-1' },
    } as never);
    expect(result).toEqual({ extracted: true });
    // chunk 按 knowledgeId 读取（content 为当前内容——Task 1.9 编辑后取编辑内容）
    expect(chunkRepo.find).toHaveBeenCalledWith(
      expect.objectContaining({ where: { knowledgeId: 'doc-1' } }),
    );
    // 跨文档端点判定：抽取前读图谱既有实体集合（Task 3.2 质量审查整改）
    expect(graph.listEntityNames).toHaveBeenCalledWith('kb-1');
    // 抽取入参：chunk id + content + 既有实体集合
    expect(extraction.extractAll).toHaveBeenCalledWith(
      [{ id: 'c1', content: '块一' }],
      [],
      'doc-1',
    );
    // 阶段写回：先 running 后 done（两次调用均为 graph 阶段，携带 at 时间戳）
    const stageCalls = progress.updateProgress.mock.calls.map(
      (c: unknown[]) =>
        (c[1] as { stage: { stage: string; status: string; at: string } })
          .stage,
    );
    expect(stageCalls.map(({ stage, status }) => ({ stage, status }))).toEqual([
      { stage: 'graph', status: 'running' },
      { stage: 'graph', status: 'done' },
    ]);
    // at 时间戳形态与 extract/chunk/summary 阶段一致（Task 3.2 质量审查整改）
    for (const s of stageCalls) {
      expect(s.at).toEqual(expect.any(String));
    }
    // reparse 幂等：写入前清理该文档旧 chunk 关联/镜像（实体/边保留），再单事务批量写
    expect(graph.deleteKnowledgeSubgraph).toHaveBeenCalledWith('kb-1', 'doc-1');
    expect(graph.upsertDocumentGraphInTx).toHaveBeenCalledWith(
      'kb-1',
      'doc-1',
      expect.objectContaining({
        entities: [{ name: '甲', attributes: ['人物'], chunkId: 'c1' }],
      }),
    );
  });

  it('抽取失败（全部 chunk 失败）→ process 抛错（触发 BullMQ 重试），不写 done、不写图', async () => {
    const { processor, progress, graph } = buildProcessor({
      extractionError: new Error('JSON 解析失败'),
    });
    await expect(
      processor.process({ data: { knowledgeId: 'doc-1' } } as never),
    ).rejects.toThrow('JSON 解析失败');
    expect(graph.upsertDocumentGraphInTx).not.toHaveBeenCalled();
    // 只写了 running（done 未写）；不写 status=failed（文档本身可用，重试耗尽仅日志）
    const stages = progress.updateProgress.mock.calls.map(
      (c: unknown[]) =>
        (c[1] as { stage: { stage: string; status: string; at: string } })
          .stage,
    );
    expect(stages.map(({ stage, status }) => ({ stage, status }))).toEqual([
      { stage: 'graph', status: 'running' },
    ]);
  });
});
