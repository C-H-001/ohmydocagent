// graph-search.service.spec.ts
// 图谱召回（GraphRAG）核心路径单测：命中/邻居扩展/上下文/去重/空范围/降级。
import { describe, expect, it, vi } from 'vitest';
import { GraphSearchService } from './graph-search.service.js';

function setup() {
  const graphRepository = {
    searchEntitiesWithNeighbors: vi.fn(),
    findChunkIdsForEntities: vi.fn(),
  };
  const service = new GraphSearchService(graphRepository as never);
  return { service, graphRepository };
}

describe('GraphSearchService（图谱召回 GraphRAG）', () => {
  it('命中实体 → 返回实体/chunkIds + 一跳邻居扩展 + 关系上下文', async () => {
    const { service, graphRepository } = setup();
    graphRepository.searchEntitiesWithNeighbors.mockResolvedValue([
      {
        entity: 'OhMyDocAgent 平台',
        chunkIds: ['c1', 'c2'],
        neighbors: [
          { name: '知识管理', chunkIds: ['c3'], relationType: '属于' },
        ],
      },
    ]);
    const result = await service.graphRetrieve('OhMyDocAgent 平台是什么', ['kb1']);
    expect(result.hitEntities).toEqual(['OhMyDocAgent 平台']);
    // 命中 + 邻居 chunk 全部聚合
    expect(result.chunkIds).toEqual(['c1', 'c2', 'c3']);
    expect(result.relatedEntities).toEqual(['知识管理']);
    expect(result.relations).toEqual(['OhMyDocAgent 平台 -[属于]-> 知识管理']);
    // 实体上下文（GraphRAG 注入 LLM）
    expect(result.entityContext).toContain('OhMyDocAgent 平台');
    expect(result.entityContext).toContain('属于');
  });

  it('未命中实体 → 空结果（静默降级）', async () => {
    const { service, graphRepository } = setup();
    graphRepository.searchEntitiesWithNeighbors.mockResolvedValue([]);
    const result = await service.graphRetrieve('完全无关的查询词', ['kb1']);
    expect(result).toEqual({
      hitEntities: [],
      relatedEntities: [],
      relations: [],
      chunkIds: [],
      entityContext: '',
    });
  });

  it('空 query 或空 kbIds → 直接返回空（不查图）', async () => {
    const { service, graphRepository } = setup();
    expect(await service.graphRetrieve('', ['kb1'])).toMatchObject({
      chunkIds: [],
    });
    expect(await service.graphRetrieve('查询', [])).toMatchObject({
      chunkIds: [],
    });
    expect(
      graphRepository.searchEntitiesWithNeighbors,
    ).not.toHaveBeenCalled();
  });

  it('分词：按空白/标点切分，取前 3 个 token 参与实体匹配', async () => {
    const { service, graphRepository } = setup();
    graphRepository.searchEntitiesWithNeighbors.mockResolvedValue([]);
    await service.graphRetrieve('OhMyDocAgent 平台，知识管理 工具 好用的', ['kb1']);
    const [kbId, keywords] =
      graphRepository.searchEntitiesWithNeighbors.mock.calls[0];
    expect(kbId).toBe('kb1');
    expect(keywords).toEqual(['OhMyDocAgent', '平台', '知识管理']); // 前 3，标点切分
  });

  it('图查询失败 → 静默降级为空结果（不阻断检索）', async () => {
    const { service, graphRepository } = setup();
    graphRepository.searchEntitiesWithNeighbors.mockRejectedValue(
      new Error('Neo4j 不可用'),
    );
    const result = await service.graphRetrieve('OhMyDocAgent', ['kb1']);
    expect(result.chunkIds).toEqual([]);
    expect(result.entityContext).toBe('');
  });

  it('expand（兼容旧接口）：仅直接命中实体 chunk（不含邻居/上下文）', async () => {
    const { service, graphRepository } = setup();
    graphRepository.searchEntitiesWithNeighbors.mockResolvedValue([
      { entity: '甲', chunkIds: ['c1'], neighbors: [] },
    ]);
    const r = await service.expand('甲', ['kb1']);
    expect(r).toEqual({ hitEntities: ['甲'], chunkIds: ['c1'] });
  });
});
