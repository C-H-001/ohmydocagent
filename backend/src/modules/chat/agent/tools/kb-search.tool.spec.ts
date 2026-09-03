// KbSearchTool 单元测试（Task 2.8）：search_kb 工具 = Task 2.5 RAG 管线的
// 检索/重排/合并三段（query_understand 职责并入 LLM 工具调用参数）——
// hybridSearch（VectorService）→ score 截断（rerank）→ 标题补查 +
// ReferencesService.build（merge）→ 返回「编号+标题+摘要」文本（LLM 引用
// [n] 的依据）+ references 数据（Agent 累积后随 assistant 落库）。
// mock VectorService/Knowledge repo；ReferencesService 为纯函数用真实实现。
// 覆盖：kbIds 范围限定、topK 默认/截断、0 结果（无 merge 阶段事件 +
// search_nothing 文案）、检索失败（status error 不抛错）、断连检查点。
// 质量审查整改补充：query 参数校验（非字符串/空串/超长 → status error +
// 「检索参数无效」回填，不发起检索）。
import { describe, expect, it, vi } from 'vitest';
import { KbSearchTool } from './kb-search.tool.js';
import { ReferencesService } from '../../pipeline/references.service.js';
import {
  NO_RESULT_SYSTEM_PROMPT,
  QUERY_MAX_LENGTH,
  RAG_SEARCH_TOP_K,
} from './kb-search.tool.js';
import { SseService } from '../../sse/sse.service.js';
import type { ChatEvent } from '../../sse/chat-event.types.js';

/** mock Express res（SseService 构造需要 writeHead/flushHeaders/on/end） */
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

/** 记录 sse.send 的事件序列 */
function spySse() {
  const events: ChatEvent[] = [];
  const sse = new SseService(mockRes());
  vi.spyOn(sse, 'send').mockImplementation((ev: ChatEvent) => {
    events.push(ev);
  });
  return { sse, events };
}

/** 检索块样本（两个文档各一块，标题补查走 mock knowledgeRepo） */
function chunks() {
  return [
    {
      chunkId: 'c1',
      content: '智能客服系统：支持多渠道接入。',
      knowledgeId: 'doc-a',
      score: 0.9,
      vectorScore: 0.8,
      keywordScore: 0.7,
    },
    {
      chunkId: 'c2',
      content: '工单流转：支持自动路由。',
      knowledgeId: 'doc-b',
      score: 0.7,
      vectorScore: 0.6,
      keywordScore: 0.5,
    },
  ];
}

function setup() {
  const vectorService = { hybridSearch: vi.fn() as any };
  const knowledgeRepo = { find: vi.fn() as any };
  const referencesService = new ReferencesService();
  // Task 3.4：图谱增强检索注入（测试默认空实现，图谱增强用例单独 mock）
  // expandNeighbors 会拉取 chunk 链接与相邻块：默认空（无相邻/无扩展）
  const chunkRepo = { find: vi.fn().mockResolvedValue([]) as any };
  // 查询理解（实体+改写）+ 重排（参考 WeKnora）：默认空实现——测试默认
  // 走「无实体/无变体/无重排模型」的既有路径
  const chatModel = { chat: vi.fn().mockRejectedValue(new Error('no-op')) } as any;
  const rerankService = { rerank: vi.fn(async () => null) } as any;
  const fileGuard = { signUrl: (url: string) => `/api/v1/parser-files/mock-${url}` } as any;
  const tool = new KbSearchTool(
    vectorService as never,
    { findOne: vi.fn(async () => null) } as never,
    knowledgeRepo as never,
    referencesService,
    chunkRepo as never,
    chatModel,
    rerankService,
    fileGuard,
  );
  return { tool, vectorService, knowledgeRepo, chunkRepo, chatModel, rerankService };
}

describe('KbSearchTool（search_kb 工具：kbIds 内混合检索 + 重排 + 合并）', () => {
  it('execute：在会话 kbIds 内 hybridSearch（topK 默认 RAG_SEARCH_TOP_K），rerank 截断 + 标题补查 + 引用构建', async () => {
    const { tool, vectorService, knowledgeRepo } = setup();
    vectorService.hybridSearch.mockResolvedValue(chunks());
    knowledgeRepo.find.mockResolvedValue([
      {
        id: 'doc-a',
        title: '智能客服系统使用手册',
        type: 'file',
        sourceUrl: '',
      },
      { id: 'doc-b', title: '工单流转使用指南', type: 'file', sourceUrl: '' },
    ]);
    const { sse, events } = spySse();
    const result = await tool.execute(
      { query: '智能客服系统支持哪些渠道？' },
      { sse, signal: new AbortController().signal, kbIds: ['kb1', 'kb2'] },
    );
    // 检索范围限定：kbIds + query + topK（默认 RAG_SEARCH_TOP_K=10）
    expect(vectorService.hybridSearch).toHaveBeenCalledWith(
      ['kb1', 'kb2'],
      '智能客服系统支持哪些渠道？',
      RAG_SEARCH_TOP_K,
      undefined,
      0.05,
      undefined,
    );
    // 标题补查：批量 WHERE id IN（防 N+1）
    expect(knowledgeRepo.find).toHaveBeenCalledWith({
      where: { id: expect.objectContaining({ _value: ['doc-a', 'doc-b'] }) },
    });
    // 阶段事件：search/rerank/merge 各 start+done（query_understand 取消）
    expect(events.map((e) => e.type)).toEqual([
      'stage',
      'stage',
      'stage',
      'stage',
      'stage',
      'stage',
    ]);
    expect(
      events
        .filter((e) => e.type === 'stage')
        .map((e) => (e as { stage: string }).stage),
    ).toEqual(['search', 'search', 'rerank', 'rerank', 'merge', 'merge']);
    // 返回文本：编号 + 标题 + 摘要（LLM 引用 [n] 的依据）；references 供落库
    expect(result.status).toBe('done');
    expect(result.content).toContain('[1] 智能客服系统使用手册');
    expect(result.content).toContain('[2] 工单流转使用指南');
    expect(result.content).toContain('智能客服系统');
    expect(result.references).toHaveLength(2);
    expect(result.references![0].knowledgeId).toBe('doc-a');
  });

  it('execute：topK 入参透传（LLM 指定条数 → hybridSearch topK），且 rerank 截断到 RAG_RERANK_TOP_K', async () => {
    const { tool, vectorService, knowledgeRepo } = setup();
    vectorService.hybridSearch.mockResolvedValue(
      Array.from({ length: 8 }, (_, i) => ({
        chunkId: `c${i}`,
        content: `内容 ${i}`,
        knowledgeId: `doc-${i % 3}`,
        score: 1 - i / 10,
        vectorScore: 1 - i / 10,
        keywordScore: 0,
      })),
    );
    // knowledgeRepo.find 返回空（标题缺省「未知文档」路径）
    knowledgeRepo.find.mockResolvedValue([]);
    const { sse } = spySse();
    const result = await tool.execute(
      { query: 'q', topK: 8 },
      { sse, signal: new AbortController().signal, kbIds: ['kb'] },
    );
    expect(vectorService.hybridSearch).toHaveBeenCalledWith(['kb'], 'q', 8, undefined, 0.05, undefined);
    // 8 块 → rerank 截断 5 → 3 文档去重合并（doc-0/1/2 各一块保留）
    expect(result.references).toHaveLength(3);
  });

  it('execute：检索 0 结果 → 无 merge 阶段事件 + search_nothing 文案（不报错）', async () => {
    const { tool, vectorService, knowledgeRepo } = setup();
    vectorService.hybridSearch.mockResolvedValue([]);
    const { sse, events } = spySse();
    const result = await tool.execute(
      { query: '无关查询' },
      { sse, signal: new AbortController().signal, kbIds: ['kb'] },
    );
    expect(result.status).toBe('done');
    expect(result.content).toBe(NO_RESULT_SYSTEM_PROMPT);
    expect(result.references).toEqual([]);
    // 0 结果 → 跳过 merge（无引用可合并，同 Task 2.5 语义）
    expect(
      events
        .filter((e) => e.type === 'stage')
        .map((e) => (e as { stage: string }).stage),
    ).not.toContain('merge');
    expect(knowledgeRepo.find).not.toHaveBeenCalled();
  });

  it('execute：检索失败（VectorService 抛错）→ status error + 友好文案（不抛错——错误文本回填 LLM）', async () => {
    const { tool, vectorService } = setup();
    vectorService.hybridSearch.mockRejectedValue(new Error('vector db down'));
    const { sse, events } = spySse();
    const result = await tool.execute(
      { query: 'q' },
      { sse, signal: new AbortController().signal, kbIds: ['kb'] },
    );
    expect(result.status).toBe('error');
    expect(result.content).toContain('知识库检索失败');
    expect(result.references).toEqual([]);
    // stage(search error) 事件发出（前端可见检索阶段失败）
    const searchStages = events.filter(
      (e) => e.type === 'stage' && (e as { stage: string }).stage === 'search',
    );
    expect(searchStages).toHaveLength(2);
    expect((searchStages[1] as { status: string }).status).toBe('error');
  });

  it('execute：kbIds 空 → 直接返回无结果（防御——工具定义在 kbIds 空时不注入，双保险）', async () => {
    const { tool, vectorService } = setup();
    const { sse } = spySse();
    const result = await tool.execute(
      { query: 'q' },
      { sse, signal: new AbortController().signal, kbIds: [] },
    );
    expect(result.status).toBe('done');
    expect(result.content).toContain('未关联知识库');
    expect(vectorService.hybridSearch).not.toHaveBeenCalled();
  });

  it('execute：query 非字符串（LLM 传类型不匹配）→ status error + 「检索参数无效」回填（不发起检索）', async () => {
    const { tool, vectorService } = setup();
    const { sse } = spySse();
    const result = await tool.execute(
      { query: 12345 },
      { sse, signal: new AbortController().signal, kbIds: ['kb'] },
    );
    expect(result.status).toBe('error');
    expect(result.content).toBe('检索参数无效，请基于已有知识回答。');
    expect(result.references).toEqual([]);
    expect(vectorService.hybridSearch).not.toHaveBeenCalled();
  });

  it('execute：query 空串 → status error + 「检索参数无效」（不发检索）', async () => {
    const { tool, vectorService } = setup();
    const { sse } = spySse();
    const result = await tool.execute(
      { query: '' },
      { sse, signal: new AbortController().signal, kbIds: ['kb'] },
    );
    expect(result.status).toBe('error');
    expect(result.content).toContain('检索参数无效');
    expect(vectorService.hybridSearch).not.toHaveBeenCalled();
  });

  it('execute：query 超长（>200 字符）→ status error + 「检索参数无效」（防白烧 embedding/检索）', async () => {
    const { tool, vectorService } = setup();
    const { sse } = spySse();
    const result = await tool.execute(
      { query: 'x'.repeat(QUERY_MAX_LENGTH + 1) },
      { sse, signal: new AbortController().signal, kbIds: ['kb'] },
    );
    expect(result.status).toBe('error');
    expect(result.content).toContain('检索参数无效');
    expect(result.references).toEqual([]);
    expect(vectorService.hybridSearch).not.toHaveBeenCalled();
  });

  it('execute：query 恰为上限（200 字符）→ 正常检索（边界不误伤）', async () => {
    const { tool, vectorService } = setup();
    vectorService.hybridSearch.mockResolvedValue([]);
    const { sse } = spySse();
    const result = await tool.execute(
      { query: 'x'.repeat(QUERY_MAX_LENGTH) },
      { sse, signal: new AbortController().signal, kbIds: ['kb'] },
    );
    expect(result.status).toBe('done');
    expect(result.content).toBe(NO_RESULT_SYSTEM_PROMPT);
    expect(vectorService.hybridSearch).toHaveBeenCalledWith(
      ['kb'],
      'x'.repeat(QUERY_MAX_LENGTH),
      RAG_SEARCH_TOP_K,
      undefined,
      0.05,
      undefined,
    );
  });
});
