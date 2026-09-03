// 知识图谱仓储单测（Task 3.1 质量审查补充）：不连 Neo4j，用 Mock Neo4jService
// 捕获 Cypher 文本/事务调用形态，断言防御性片段存在——真实语义由
// test/graph-repo.e2e-spec.ts 覆盖（null 守卫行为、批量事务原子性、边数上限）。
import { GraphRepository } from './graph.repository.js';
import type { Neo4jService } from '../../neo4j/neo4j.service.js';

/** Mock Neo4jService：run 捕获查询文本；withWriteTransaction 用假 tx 执行回调 */
function createRepo(options?: {
  matched?: number;
  /** 节点查询（getSubgraph 第一步）返回的记录，空数组会触发子图短路 */
  nodeRecords?: Array<Record<string, unknown>>;
}): {
  repo: GraphRepository;
  run: ReturnType<typeof vi.fn>;
  txRun: ReturnType<typeof vi.fn>;
  withWriteTransaction: ReturnType<typeof vi.fn>;
} {
  const nodeRecords =
    options?.nodeRecords ?? ([] as Array<Record<string, unknown>>);
  const run = vi.fn(async (cypher: string) => {
    // 节点查询：以 LIMIT $limit（非 $edgeLimit）区分，返回可投影的假记录
    if (cypher.includes('LIMIT $limit') && !cypher.includes('$edgeLimit')) {
      return { records: nodeRecords };
    }
    return { records: [] };
  });
  const txRun = vi.fn(async (cypher: string) => ({
    records: cypher.includes('RETURN count(*)')
      ? [{ get: () => options?.matched ?? 0 }]
      : [],
  }));
  const withWriteTransaction = vi.fn(
    async (work: (tx: unknown) => Promise<void>) => work({ run: txRun }),
  );
  const repo = new GraphRepository({
    run,
    withWriteTransaction,
  } as unknown as Neo4jService);
  return { repo, run, txRun, withWriteTransaction };
}

describe('GraphRepository 防御性 Cypher', () => {
  it('upsertEntity ON MATCH 含 null 列表守卫（null 时初始化而非抹除）', async () => {
    const { repo, run } = createRepo();
    await repo.upsertEntity({
      kbId: 'kb',
      name: '甲',
      attributes: ['人物'],
      chunkId: 'c1',
    });
    const cypher = run.mock.calls[0][0] as string;
    // e.chunkIds 为 null 时先初始化 [$chunkId]（否则 `null + [$chunkId]` 恒为 null）
    expect(cypher).toContain('WHEN e.chunkIds IS NULL THEN [$chunkId]');
    expect(cypher).toContain('WHEN $chunkId IN e.chunkIds THEN e.chunkIds');
    // attributes 同理：null 时直接取 $attributes
    expect(cypher).toContain('WHEN e.attributes IS NULL THEN $attributes');
  });

  it('upsertDocumentGraphInTx 在单个写事务内执行实体/边/chunk 三条语句', async () => {
    const { repo, txRun, withWriteTransaction } = createRepo({ matched: 1 });
    await repo.upsertDocumentGraphInTx('kb', 'kid', {
      entities: [
        { name: '甲', attributes: ['人物'], chunkId: 'c1' },
        { name: '乙', attributes: ['人物'], chunkId: 'c1' },
      ],
      relationships: [
        { from: '甲', to: '乙', type: '合作', weight: 1, chunkId: 'c1' },
      ],
      chunks: [{ id: 'c1', content: '内容' }],
    });
    // 只开一次写事务，回调内三条 tx.run（实体/边/chunk 各一条 UNWIND）
    expect(withWriteTransaction).toHaveBeenCalledTimes(1);
    expect(txRun).toHaveBeenCalledTimes(3);
    // 边语句带 count(*) 端点守卫
    const edgeCypher = txRun.mock.calls[1][0] as string;
    expect(edgeCypher).toContain('RETURN count(*) AS matched');
    expect(edgeCypher).toContain(
      'ON MATCH SET r.weight = r.weight + row.weight',
    );
  });

  it('upsertDocumentGraphInTx 关系端点缺失 → 抛错（供事务回滚）', async () => {
    const { repo } = createRepo({ matched: 1 }); // 2 行只匹配 1 行 → 缺失
    await expect(
      repo.upsertDocumentGraphInTx('kb', 'kid', {
        entities: [],
        relationships: [
          { from: '甲', to: '乙', type: '合作', weight: 1, chunkId: 'c1' },
          { from: '丙', to: '丁', type: '合作', weight: 1, chunkId: 'c1' },
        ],
        chunks: [],
      }),
    ).rejects.toThrow(/端点实体不存在/);
  });

  it('upsertDocumentGraphInTx 空输入短路（不开启事务）', async () => {
    const { repo, withWriteTransaction } = createRepo();
    await repo.upsertDocumentGraphInTx('kb', 'kid', {
      entities: [],
      relationships: [],
      chunks: [],
    });
    expect(withWriteTransaction).not.toHaveBeenCalled();
  });

  it('getSubgraph 边查询带 LIMIT（EDGE_LIMIT_MAX 常量）', async () => {
    const { repo, run } = createRepo({
      nodeRecords: [
        {
          get: (key: string) =>
            ({ name: '甲', attributes: [], chunkIds: [], degree: 0 })[key],
        } as unknown as Record<string, unknown>,
      ],
    });
    await repo.getSubgraph('kb');
    // 第一次调用是节点查询，第二次是边查询
    const edgeCypher = run.mock.calls[1][0] as string;
    expect(edgeCypher).toContain('LIMIT $edgeLimit');
    const edgeParams = run.mock.calls[1][1] as {
      edgeLimit: { toNumber?: () => number };
    };
    expect(edgeParams.edgeLimit.toNumber?.()).toBe(3000);
  });
});
