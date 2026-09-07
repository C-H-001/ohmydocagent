import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { VectorService } from '../dist/modules/vector/vector.service.js';

for (const dimensions of [
  [768, 1536],
  [1024, 1024],
]) {
  test(`不同配置 ${dimensions.join('/')} 维各自向量化，关键词只查一次`, async () => {
    const calls = [];
    let keywords = 0;
    const ds = {
      query: async () => {
        keywords++;
        return [];
      },
      transaction: async (fn) =>
        fn({
          query: async (sql, params) => {
            if (sql.startsWith('SET LOCAL')) return [];
            calls.push({ sql, params });
            return [
              {
                id: `chunk-${calls.length}`,
                kbId: `kb-${calls.length}`,
                knowledgeId: 'doc',
                content: '命中',
                score: 0.9,
              },
            ];
          },
        }),
    };
    const embedded = [];
    const profiles = {
      getProfile: async (id) => ({
        id,
        dimension: dimensions[id === 'p1' ? 0 : 1],
      }),
      embed: async (id, texts) => {
        embedded.push({ id, texts });
        return {
          vectors: [[1, ...Array(dimensions[id === 'p1' ? 0 : 1] - 1).fill(0)]],
          totalTokens: 1,
        };
      },
    };
    const scopes = {
      resolve: async () => ({
        fullKbIds: ['kb-1', 'kb-2'],
        knowledgeIds: [],
        bindings: [
          { id: 'kb-1', creatorId: 'owner-a', activeEmbeddingProfileId: 'p1' },
          { id: 'kb-2', creatorId: 'owner-b', activeEmbeddingProfileId: 'p2' },
        ],
      }),
    };
    const service = new VectorService(ds, profiles, scopes);
    const result = await service.hybridSearch(
      ['kb-1', 'kb-2'],
      '问题',
      5,
      undefined,
      0.05,
      'visitor',
    );
    assert.deepEqual(new Set(embedded.map((c) => c.id)), new Set(['p1', 'p2']));
    assert.equal(keywords, 1);
    assert.equal(calls.length, 2);
    assert.equal(result.length, 2);
    assert.ok(
      calls.some(
        (c) =>
          c.sql.includes(`halfvec(${dimensions[0]})`) &&
          c.params.includes('p1'),
      ),
    );
    assert.ok(
      calls.some(
        (c) =>
          c.sql.includes(`halfvec(${dimensions[1]})`) &&
          c.params.includes('p2'),
      ),
    );
  });
}
test('相同配置跨知识库复用查询向量，拒绝权限后不请求模型', async () => {
  let embeds = 0;
  const profiles = {
    getProfile: async () => ({ id: 'p', dimension: 768 }),
    embed: async () => {
      embeds++;
      return { vectors: [[1, ...Array(767).fill(0)]] };
    },
  };
  const ds = {
    query: async () => [],
    transaction: async (fn) => fn({ query: async () => [] }),
  };
  const scope = {
    fullKbIds: ['a', 'b'],
    knowledgeIds: [],
    bindings: [
      { id: 'a', activeEmbeddingProfileId: 'p' },
      { id: 'b', activeEmbeddingProfileId: 'p' },
    ],
  };
  const service = new VectorService(ds, profiles, {
    resolve: async () => scope,
  });
  await service.hybridSearch(['a', 'b'], '问题', 5, undefined, 0.05, 'u');
  assert.equal(embeds, 1);
  const denied = new VectorService(ds, profiles, {
    resolve: async () => {
      throw new Error('无权访问');
    },
  });
  await assert.rejects(
    denied.hybridSearch(['a'], '问题', 5, undefined, 0.05, 'u'),
    /无权访问/,
  );
  assert.equal(embeds, 1);
});

test('来源未知的旧向量只走关键词，不能用当前默认模型猜测向量空间', async () => {
  const row = {
    id: 'legacy',
    kbId: 'kb',
    knowledgeId: 'doc',
    content: '已有正文',
    score: 1,
  };
  const ds = { query: async () => [row] };
  const scopes = {
    resolve: async () => ({
      fullKbIds: ['kb'],
      knowledgeIds: [],
      bindings: [
        {
          id: 'kb',
          creatorId: 'owner',
          activeEmbeddingProfileId: null,
          hasLegacy: true,
        },
      ],
    }),
  };
  const service = new VectorService(
    ds,
    { embed: () => assert.fail('未绑定配置不得向量化') },
    scopes,
  );
  assert.equal(
    (
      await service.hybridSearch(
        ['kb'],
        '正文',
        5,
        undefined,
        undefined,
        'viewer',
      )
    )[0].chunkId,
    'legacy',
  );
});
