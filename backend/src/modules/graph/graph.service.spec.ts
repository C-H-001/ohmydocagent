// GraphService 单元测试（Task 3.3）：不连 Neo4j/PG，Mock GraphRepository +
// DataSource 验证服务层装配语义：
// - 可视化 size = degree（GraphNode.degree → 响应 size）
// - 跨库反查装配（Neo4j chunkIds/chunks → PG knowledge 标题 + chunks 片段）：
//   片段取前 2 条、孤儿 knowledge 行跳过（历史删除残留，Task 3.2 已接线清理但
//   存量孤儿仍可能——查不到的行跳过是既定语义，见 graph.service.ts 注释）
// - direction 透传（关联实体含 out/in 方向）
// - 404 语义（KB 不存在 / 实体不存在）
// - 覆盖统计装配（totalKnowledge 来自 PG 计数 + 图谱统计来自仓储）
import { NotFoundException } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { GraphRepository } from './graph.repository.js';
import { GraphService } from './graph.service.js';
import type { KnowledgeBase } from '../kb/kb.entity.js';
import type { Knowledge } from '../knowledge/knowledge.entity.js';
import type { Chunk } from '../chunk/chunk.entity.js';

/** Mock 仓储：全部方法 vi.fn（用例内按需设置返回值） */
function createMocks(): {
  service: GraphService;
  graphRepo: {
    getSubgraph: ReturnType<typeof vi.fn>;
    searchEntities: ReturnType<typeof vi.fn>;
    getEntityDetail: ReturnType<typeof vi.fn>;
    getKbGraphStats: ReturnType<typeof vi.fn>;
  };
  kbRepo: { count: ReturnType<typeof vi.fn> };
  knowledgeRepo: {
    count: ReturnType<typeof vi.fn>;
    find: ReturnType<typeof vi.fn>;
  };
  chunkRepo: { find: ReturnType<typeof vi.fn> };
} {
  const graphRepo = {
    getSubgraph: vi.fn(),
    searchEntities: vi.fn(),
    getEntityDetail: vi.fn(),
    getKbGraphStats: vi.fn(),
  };
  const kbRepo = { count: vi.fn(async () => 1) };
  const knowledgeRepo = { count: vi.fn(), find: vi.fn() };
  const chunkRepo = { find: vi.fn() };
  const dataSource = {
    getRepository: vi.fn((entity: { name: string }) => {
      if (entity.name === 'KnowledgeBase') return kbRepo;
      if (entity.name === 'Knowledge') return knowledgeRepo;
      if (entity.name === 'Chunk') return chunkRepo;
      throw new Error(`未预期的实体: ${entity.name}`);
    }),
  };
  const service = new GraphService(
    graphRepo as unknown as GraphRepository,
    dataSource as unknown as DataSource,
  );
  return { service, graphRepo, kbRepo, knowledgeRepo, chunkRepo };
}

describe('GraphService 装配（Task 3.3）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('getSubgraph：size = degree（可视化节点大小 = 关联边数），edges 透传', async () => {
    const { service, graphRepo } = createMocks();
    graphRepo.getSubgraph.mockResolvedValue({
      nodes: [
        {
          id: '张三',
          name: '张三',
          attributes: ['人物'],
          chunkIds: ['c1'],
          degree: 2,
        },
        {
          id: '孤立实体',
          name: '孤立实体',
          attributes: [],
          chunkIds: [],
          degree: 0,
        },
      ],
      edges: [
        { source: '张三', target: 'OhMyDocAgent 平台', type: '开发', weight: 1 },
      ],
    });
    const result = await service.getSubgraph('kb-1');
    // size 来自 degree（前端节点大小 = 关联边数）
    expect(result.nodes[0]).toEqual({
      id: '张三',
      name: '张三',
      attributes: ['人物'],
      chunkIds: ['c1'],
      size: 2,
    });
    expect(result.nodes[1].size).toBe(0); // 无边的实体 size=0 仍参与返回
    expect(result.edges).toEqual([
      { source: '张三', target: 'OhMyDocAgent 平台', type: '开发', weight: 1 },
    ]);
  });

  it('getSubgraph：KB 不存在 → 404', async () => {
    const { service, kbRepo } = createMocks();
    kbRepo.count.mockResolvedValue(0);
    await expect(service.getSubgraph('kb-1')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('searchEntities：委托仓储（keyword 透传），KB 存在性先校验', async () => {
    const { service, graphRepo, kbRepo } = createMocks();
    graphRepo.searchEntities.mockResolvedValue([
      { name: '张三', attributes: ['人物'], chunkIds: ['c1'] },
    ]);
    const result = await service.searchEntities('kb-1', '张');
    expect(kbRepo.count).toHaveBeenCalledWith({ where: { id: 'kb-1' } });
    expect(graphRepo.searchEntities).toHaveBeenCalledWith('kb-1', '张');
    expect(result).toEqual([
      { name: '张三', attributes: ['人物'], chunkIds: ['c1'] },
    ]);
  });

  it('getEntityDetail：反查文档跨库装配（chunk → PG knowledge 标题 + chunks 前 2 条片段）', async () => {
    const { service, graphRepo, knowledgeRepo, chunkRepo } = createMocks();
    // Neo4j 侧：实体 + 关联 chunk（含 knowledgeId）
    graphRepo.getEntityDetail.mockResolvedValue({
      name: '张三',
      attributes: ['人物'],
      chunkIds: ['c1', 'c2', 'c3'],
      related: [
        {
          name: 'OhMyDocAgent 平台',
          type: '开发',
          weight: 1,
          direction: 'out',
        },
      ],
      chunks: [
        { id: 'c1', knowledgeId: 'k1', content: '（镜像内容）' },
        { id: 'c2', knowledgeId: 'k1', content: '（镜像内容）' },
        // 孤儿 chunk：knowledgeId=k2 的文档已从 PG 删除（Task 3.2 清理已接线，
        // 历史残留仍可能）——装配时查不到的行跳过
        { id: 'c3', knowledgeId: 'k2', content: '（镜像内容）' },
      ],
    });
    // PG 侧：knowledge 标题（k2 无行 = 孤儿，跳过）
    knowledgeRepo.find.mockResolvedValue([{ id: 'k1', title: '文档一' }]);
    // PG 侧：chunks 内容（按 chunkIndex 升序，取每文档前 2 条作片段）
    chunkRepo.find.mockResolvedValue([
      { id: 'c1', knowledgeId: 'k1', content: '片段A' },
      { id: 'c2', knowledgeId: 'k1', content: '片段B' },
    ]);
    const result = await service.getEntityDetail('kb-1', '张三');
    expect(result.name).toBe('张三');
    expect(result.attributes).toEqual(['人物']);
    expect(result.chunkIds).toEqual(['c1', 'c2', 'c3']);
    // 关联实体含 direction（透传仓储语义：out = 实体指向对方）
    expect(result.relatedEntities).toEqual([
      { name: 'OhMyDocAgent 平台', type: '开发', weight: 1, direction: 'out' },
    ]);
    // 反查文档：knowledgeId + 标题 + 片段（c1/c2 归属 k1；孤儿 k2 跳过）
    expect(result.relatedKnowledge).toEqual([
      {
        knowledgeId: 'k1',
        knowledgeTitle: '文档一',
        chunkSnippets: ['片段A', '片段B'],
      },
    ]);
  });

  it('getEntityDetail：片段截断为每文档前 2 条（chunkIndex 升序）', async () => {
    const { service, graphRepo, knowledgeRepo, chunkRepo } = createMocks();
    graphRepo.getEntityDetail.mockResolvedValue({
      name: '张三',
      attributes: [],
      chunkIds: ['c1', 'c2', 'c3'],
      related: [],
      chunks: [
        { id: 'c1', knowledgeId: 'k1', content: '' },
        { id: 'c2', knowledgeId: 'k1', content: '' },
        { id: 'c3', knowledgeId: 'k1', content: '' },
      ],
    });
    knowledgeRepo.find.mockResolvedValue([{ id: 'k1', title: '文档一' }]);
    // 3 个 chunk 同文档：只取 chunkIndex 前 2 条
    chunkRepo.find.mockResolvedValue([
      { id: 'c1', knowledgeId: 'k1', content: '第一段' },
      { id: 'c2', knowledgeId: 'k1', content: '第二段' },
      { id: 'c3', knowledgeId: 'k1', content: '第三段' },
    ]);
    const result = await service.getEntityDetail('kb-1', '张三');
    expect(result.relatedKnowledge[0].chunkSnippets).toEqual([
      '第一段',
      '第二段',
    ]);
  });

  it('getEntityDetail：实体不存在 → 404（仓储返回 null）', async () => {
    const { service, graphRepo } = createMocks();
    graphRepo.getEntityDetail.mockResolvedValue(null);
    await expect(service.getEntityDetail('kb-1', '幽灵实体')).rejects.toThrow(
      new NotFoundException('实体不存在'),
    );
  });

  it('getCoverage：totalKnowledge（PG 文档数）+ 图谱统计装配', async () => {
    const { service, knowledgeRepo, graphRepo } = createMocks();
    knowledgeRepo.count.mockResolvedValue(5);
    graphRepo.getKbGraphStats.mockResolvedValue({
      coveredKnowledge: 3,
      entities: 10,
      relationships: 8,
      chunks: 20,
    });
    const result = await service.getCoverage('kb-1');
    expect(result).toEqual({
      totalKnowledge: 5,
      coveredKnowledge: 3,
      entities: 10,
      relationships: 8,
      chunks: 20,
    });
  });

  it('ensureKbExists：KB 不存在 → 404（全部 kb 维度接口的前置校验）', async () => {
    const { service, kbRepo } = createMocks();
    kbRepo.count.mockResolvedValue(0);
    await expect(service.getCoverage('kb-1')).rejects.toThrow(
      new NotFoundException('知识库不存在'),
    );
  });
});
