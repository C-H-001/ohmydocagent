import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
test('空检索范围不会退化成全库查询', async () => {
  const module =
    await import('../dist/modules/vector/search-scope.service.js').catch(
      () => ({}),
    );
  assert.equal(typeof module.SearchScopeService, 'function');
  const service = new module.SearchScopeService({
    query: () => assert.fail('空范围不应查询数据库'),
  });
  assert.deepEqual(await service.resolve([], [], id(1)), {
    fullKbIds: [],
    knowledgeIds: [],
    bindings: [],
  });
});
test('指定文档的知识库必须通过权限校验，拒绝时不返回任何绑定', async () => {
  const module =
    await import('../dist/modules/vector/search-scope.service.js').catch(
      () => ({}),
    );
  assert.equal(typeof module.SearchScopeService, 'function');
  const calls = [];
  const service = new module.SearchScopeService({
    query: async (sql, params) => {
      calls.push(params);
      if (sql.includes('FROM knowledge WHERE'))
        return [{ id: id(2), kbId: id(3) }];
      return [];
    },
  });
  await assert.rejects(service.resolve([], [id(2)], id(1)), { status: 404 });
  assert.equal(calls.length, 2);
  assert.ok(calls[1].includes(id(1)));
});
test('授权文档仅补充归属绑定，不扩展成整个知识库检索', async () => {
  const module =
    await import('../dist/modules/vector/search-scope.service.js').catch(
      () => ({}),
    );
  assert.equal(typeof module.SearchScopeService, 'function');
  const binding = {
    id: id(3),
    creatorId: id(4),
    activeEmbeddingProfileId: id(5),
    hasLegacy: false,
  };
  const service = new module.SearchScopeService({
    query: async (sql) =>
      sql.includes('FROM knowledge WHERE')
        ? [{ id: id(2), kbId: id(3) }]
        : [binding],
  });
  const result = await service.resolve([], [id(2), id(2)], id(1));
  assert.deepEqual(result.fullKbIds, []);
  assert.deepEqual(result.knowledgeIds, [id(2)]);
  assert.deepEqual(result.bindings, [binding]);
});
