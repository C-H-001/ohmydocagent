import 'reflect-metadata';
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { DataSource } from 'typeorm';

let EmbeddingBindingService;
let EmbeddingProfileService;
let EmbeddingIndexService;
before(async () => {
  const module =
    await import('../dist/modules/vector/embedding-binding.service.js').catch(
      (error) => {
        if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
        throw error;
      },
    );
  assert.equal(
    typeof module.EmbeddingBindingService,
    'function',
    '需主控编译新增 EmbeddingBindingService',
  );
  ({ EmbeddingBindingService } = module);
  ({ EmbeddingProfileService } =
    await import('../dist/modules/model/embedding-profile.service.js'));
  ({ EmbeddingIndexService } =
    await import('../dist/modules/vector/embedding-index.service.js'));
});

const kbId = '00000000-0000-4000-8000-000000000001';
const ownerId = '00000000-0000-4000-8000-000000000002';
const secret = 'https://private.example sk-secret provider-response';
const profiles = {
  a: {
    id: 'a',
    ownerId,
    modelId: 'model-a',
    modelName: '模型A',
    dimension: 3,
    baseUrl: secret,
    extraConfig: {},
  },
  b: {
    id: 'b',
    ownerId,
    modelId: 'model-b',
    modelName: '模型B',
    dimension: 4,
    baseUrl: secret,
    extraConfig: {},
  },
  c: {
    id: 'c',
    ownerId,
    modelId: 'model-c',
    modelName: '模型C',
    dimension: 5,
    baseUrl: secret,
    extraConfig: {},
  },
};
const summary = (p) =>
  p && {
    id: p.id,
    modelId: p.modelId,
    modelName: p.modelName,
    dimension: p.dimension,
  };

// SQL 边界替身：验证参数、事务锁和写入效果；真实 PG 的执行语义由主控集成验证。
function setup(bindings = {}) {
  const state = {
    kb: {
      id: kbId,
      creatorId: ownerId,
      embeddingModelId: null,
      activeEmbeddingProfileId: null,
      pendingEmbeddingProfileId: null,
      previousEmbeddingProfileId: null,
      ...bindings,
    },
    counts: {
      totalChunks: 2,
      indexedChunks: 2,
      pendingIndexedChunks: 0,
      legacyChunks: 0,
      unsettledKnowledge: 0,
    },
    queryLog: [],
    creates: [],
    loaded: [],
    jobs: [],
    failure: null,
    ready: true,
    defaultModelId: 'model-a',
    candidate: null,
    locked: false,
    transactionCount: 0,
    beforeLock: null,
    createFailure: null,
    readyUpdates: [],
    readyFailure: null,
  };
  const query = async (sql, params = []) => {
    const text = sql.replace(/\s+/g, ' ').trim();
    state.queryLog.push({ sql: text, params, locked: state.locked });
    if (/SELECT .*FROM knowledge_bases/i.test(text) && !/count\(/i.test(text)) {
      if (/FOR UPDATE/i.test(text)) {
        assert.ok(state.inTransaction, '写绑定前必须在事务中锁 KB');
        if (state.beforeLock) {
          state.beforeLock();
          state.beforeLock = null;
        }
        state.locked = true;
      }
      assert.equal(params[0], kbId);
      return state.kb ? [{ ...state.kb }] : [];
    }
    if (/FROM chunks/i.test(text) && /AS "totalChunks"/i.test(text)) {
      assert.match(text, /"contentRevision"\s*=\s*c\."contentRevision"/);
      assert.match(text, /"profileId"\s*=/);
      assert.match(text, /"kbId"\s*=/);
      assert.match(text, /dimension\s*=/);
      return [{ ...state.counts }];
    }
    if (/^SELECT count\(\*\)::int AS "legacyChunks" FROM chunks/i.test(text)) {
      return [{ legacyChunks: state.counts.legacyChunks }];
    }
    if (/SELECT .*FROM models/i.test(text)) {
      assert.match(text, /"userId"\s*=\s*\$1/);
      assert.match(text, /enabled\s*=\s*true/i);
      assert.match(text, /type\s*=\s*'embedding'/i);
      assert.match(text, /"isDefault"\s*=\s*true/i);
      assert.deepEqual(params, [ownerId]);
      return state.defaultModelId ? [{ id: state.defaultModelId }] : [];
    }
    if (/^SELECT .*FROM embedding_jobs/i.test(text)) {
      assert.match(text, /status\s*=\s*'failed'/);
      assert.match(text, /NOT EXISTS/);
      assert.match(text, /"contentRevision"/);
      assert.match(text, /ORDER BY/);
      return state.failure ? [{ id: 'failed-job', error: secret }] : [];
    }
    if (/UPDATE knowledge_bases/i.test(text)) {
      assert.ok(state.locked, '所有绑定写入必须持有 KB 行锁');
      assert.equal(params[0], kbId);
      const assignments = text.split(/SET /i)[1].split(/ WHERE /i)[0];
      const old = { ...state.kb };
      for (const match of assignments.matchAll(
        /"(\w+)"\s*=\s*(\$\d+|NULL|"\w+")/g,
      )) {
        const [, field, value] = match;
        state.kb[field] =
          value === 'NULL'
            ? null
            : value[0] === '$'
              ? params[Number(value.slice(1)) - 1]
              : old[value.slice(1, -1)];
      }
      return [];
    }
    if (/^UPDATE chunks/i.test(text)) {
      assert.ok(
        state.locked && state.inTransaction,
        '恢复分块状态必须与绑定切换处于同一锁事务',
      );
      assert.match(text, /"indexStatus"\s*=\s*'ready'/);
      assert.match(text, /c\."kbId"\s*=\s*\$1/);
      assert.match(text, /e\."chunkId"\s*=\s*c\.id/);
      assert.match(text, /e\."kbId"\s*=\s*c\."kbId"/);
      assert.match(text, /e\."profileId"\s*=\s*\$2/);
      assert.match(text, /e\.dimension\s*=\s*\$3/);
      assert.match(text, /e\."contentRevision"\s*=\s*c\."contentRevision"/);
      assert.match(text, /e\.embedding IS NOT NULL/);
      assert.equal(
        state.kb.activeEmbeddingProfileId,
        params[1],
        '应在切换到新 active 后恢复状态',
      );
      if (state.readyFailure) throw state.readyFailure;
      state.readyUpdates.push(params);
      return [];
    }
    if (/INSERT INTO embedding_jobs/i.test(text)) {
      assert.ok(state.locked);
      assert.match(text, /"knowledgeId"/);
      assert.match(text, /"profileId"/);
      assert.deepEqual(params.slice(0, 1), [kbId]);
      state.jobs.push({
        kbId: params[0],
        profileId: params[1],
        status: 'pending',
      });
      return [];
    }
    if (/UPDATE embedding_jobs/i.test(text)) {
      assert.ok(state.locked);
      assert.match(text, /status\s*=\s*'done'/);
      assert.match(text, /"profileId"\s*=\s*\$2/);
      for (const job of state.jobs)
        if (job.kbId === params[0] && job.profileId === params[1])
          job.status = 'done';
      return [];
    }
    assert.fail(`未预期 SQL: ${text}`);
  };
  const dataSource = {
    query,
    transaction: async (...args) => {
      const callback = args.at(-1);
      const snapshot = structuredClone({
        kb: state.kb,
        jobs: state.jobs,
        readyUpdates: state.readyUpdates,
      });
      state.inTransaction = true;
      state.transactionCount++;
      try {
        return await callback({ query });
      } catch (error) {
        Object.assign(state, snapshot);
        throw error;
      } finally {
        state.inTransaction = false;
        state.locked = false;
      }
    },
  };
  const profileService = {
    getProfile: async (id) => {
      state.loaded.push(id);
      return profiles[id];
    },
    createProfile: async (modelId, userId) => {
      state.creates.push({ modelId, userId });
      if (state.createFailure) throw state.createFailure;
      return (
        state.candidate ??
        Object.values(profiles).find((p) => p.modelId === modelId)
      );
    },
  };
  const index = {
    isReady: async () => state.ready,
    ensure: async () => assert.fail('DDL 由后台 worker 负责'),
  };
  return {
    state,
    service: new EmbeddingBindingService(dataSource, profileService, index),
  };
}
async function rejectsSafely(promise, status) {
  await assert.rejects(promise, (error) => {
    assert.match(error.message, /[\u4e00-\u9fff]/u);
    assert.doesNotMatch(
      JSON.stringify(error) + error.message,
      /private\.example|sk-secret|provider-response/,
    );
    if (status) assert.equal(error.getStatus(), status);
    return true;
  });
}

test('emits constructor metadata for the three registered services', () => {
  assert.deepEqual(
    Reflect.getMetadata('design:paramtypes', EmbeddingBindingService),
    [DataSource, EmbeddingProfileService, EmbeddingIndexService],
  );
});
test('getState exposes summaries and latest-revision coverage without provider config', async () => {
  const { service } = setup({
    activeEmbeddingProfileId: 'a',
    pendingEmbeddingProfileId: 'b',
    previousEmbeddingProfileId: 'c',
  });
  assert.deepEqual(await service.getState(kbId), {
    active: summary(profiles.a),
    pending: summary(profiles.b),
    previous: summary(profiles.c),
    totalChunks: 2,
    indexedChunks: 2,
    pendingIndexedChunks: 0,
    legacyChunks: 0,
    error: null,
    status: 'building',
  });
});
test('unbound KB with legacy vectors remains unbound', async () => {
  const { service, state } = setup();
  state.counts.legacyChunks = 2;
  const result = await service.getState(kbId);
  assert.equal(result.status, 'unbound');
  assert.equal(result.legacyChunks, 2);
  assert.equal(state.creates.length, 0);
});
test('fully repaired active space is ready and ignores historical failures', async () => {
  const { service, state } = setup({ activeEmbeddingProfileId: 'a' });
  state.failure = true;
  const result = await service.getState(kbId);
  assert.equal(result.status, 'ready');
  assert.equal(result.error, null);
});
test('incomplete current space shows a safe current failure', async () => {
  const { service, state } = setup({ activeEmbeddingProfileId: 'a' });
  state.counts.indexedChunks = 1;
  state.failure = true;
  const result = await service.getState(kbId);
  assert.equal(result.status, 'failed');
  assert.match(result.error, /[\u4e00-\u9fff]/u);
  assert.doesNotMatch(JSON.stringify(result), /private\.example|sk-secret/);
});
test('missing index or unfinished parsing reports building', async () => {
  const { service, state } = setup({ activeEmbeddingProfileId: 'a' });
  state.ready = false;
  assert.equal((await service.getState(kbId)).status, 'building');
  state.ready = true;
  state.counts.unsettledKnowledge = 1;
  assert.equal((await service.getState(kbId)).status, 'building');
});

for (const method of ['startRebuild', 'activate', 'rollback', 'cancel']) {
  test(`${method} rejects other users before credential probing or writes`, async () => {
    const { service, state } = setup({
      activeEmbeddingProfileId: 'a',
      pendingEmbeddingProfileId: 'b',
      previousEmbeddingProfileId: 'c',
    });
    await rejectsSafely(service[method](kbId, 'super-user', 'model-b'), 403);
    assert.equal(state.creates.length, 0);
    assert.equal(state.jobs.length, 0);
    assert.equal(state.kb.activeEmbeddingProfileId, 'a');
  });
}
test('startRebuild binds pending and durably queues a whole-KB job for that fixed profile', async () => {
  const { service, state } = setup({ activeEmbeddingProfileId: 'a' });
  const result = await service.startRebuild(kbId, ownerId, 'model-b');
  assert.deepEqual(state.creates, [{ modelId: 'model-b', userId: ownerId }]);
  assert.equal(result.pending.id, 'b');
  assert.equal(state.kb.activeEmbeddingProfileId, 'a');
  assert.deepEqual(state.jobs, [{ kbId, profileId: 'b', status: 'pending' }]);
  assert.equal(
    state.readyUpdates.length,
    0,
    'pending 构建不能提前恢复分块状态',
  );
});
test('active repair queues active profile without pending=active', async () => {
  const { service, state } = setup({ activeEmbeddingProfileId: 'a' });
  state.candidate = profiles.a;
  await service.startRebuild(kbId, ownerId, 'model-a');
  assert.equal(state.kb.pendingEmbeddingProfileId, null);
  assert.equal(state.jobs[0].profileId, 'a');
});
test('different pending profile rejects rebuild without overwriting binding', async () => {
  const { service, state } = setup({
    activeEmbeddingProfileId: 'a',
    pendingEmbeddingProfileId: 'c',
  });
  await rejectsSafely(service.startRebuild(kbId, ownerId, 'model-b'), 409);
  assert.equal(state.kb.pendingEmbeddingProfileId, 'c');
  assert.equal(state.jobs.length, 0);
});
test('rebuild rechecks owner after probing when the KB is locked', async () => {
  const { service, state } = setup();
  state.beforeLock = () => {
    state.kb.creatorId = 'new-owner';
  };
  await rejectsSafely(service.startRebuild(kbId, ownerId, 'model-b'), 403);
  assert.equal(state.jobs.length, 0);
});

test('activate atomically switches complete pending space and records previous/model', async () => {
  const { service, state } = setup({
    activeEmbeddingProfileId: 'a',
    pendingEmbeddingProfileId: 'b',
  });
  state.counts.pendingIndexedChunks = 2;
  // 覆盖检查使用目标 profile 放在 active 参数位。
  await service.activate(kbId, ownerId);
  assert.equal(state.kb.activeEmbeddingProfileId, 'b');
  assert.equal(state.kb.previousEmbeddingProfileId, 'a');
  assert.equal(state.kb.pendingEmbeddingProfileId, null);
  assert.equal(state.kb.embeddingModelId, 'model-b');
});
for (const reason of [
  'missing-index',
  'stale-revision',
  'parsing',
  'missing-pending',
]) {
  test(`activate rejects ${reason} and retains active`, async () => {
    const { service, state } = setup({
      activeEmbeddingProfileId: 'a',
      pendingEmbeddingProfileId: reason === 'missing-pending' ? null : 'b',
    });
    if (reason === 'missing-index') state.ready = false;
    if (reason === 'stale-revision') state.counts.indexedChunks = 1;
    if (reason === 'parsing') state.counts.unsettledKnowledge = 1;
    await rejectsSafely(service.activate(kbId, ownerId), 409);
    assert.equal(state.kb.activeEmbeddingProfileId, 'a');
  });
}
test('rollback verifies previous then swaps active and previous', async () => {
  const { service, state } = setup({
    activeEmbeddingProfileId: 'b',
    previousEmbeddingProfileId: 'a',
  });
  await service.rollback(kbId, ownerId);
  assert.equal(state.kb.activeEmbeddingProfileId, 'a');
  assert.equal(state.kb.previousEmbeddingProfileId, 'b');
  assert.equal(state.kb.embeddingModelId, 'model-a');
});
for (const method of ['activate', 'rollback']) {
  test(`${method} restores ready for only the new active profile and current revision in the same transaction`, async () => {
    const { service, state } = setup({
      activeEmbeddingProfileId: 'a',
      pendingEmbeddingProfileId: method === 'activate' ? 'b' : null,
      previousEmbeddingProfileId: method === 'rollback' ? 'b' : null,
    });
    await service[method](kbId, ownerId);
    assert.deepEqual(state.readyUpdates, [[kbId, 'b', 4]]);
  });
  test(`${method} rolls back the binding when restoring chunk status fails`, async () => {
    const { service, state } = setup({
      activeEmbeddingProfileId: 'a',
      embeddingModelId: 'model-a',
      pendingEmbeddingProfileId: method === 'activate' ? 'b' : null,
      previousEmbeddingProfileId: method === 'rollback' ? 'b' : null,
    });
    const initial = { ...state.kb };
    state.readyFailure = new Error(secret);
    await rejectsSafely(service[method](kbId, ownerId), 503);
    assert.deepEqual(state.kb, initial);
    assert.deepEqual(state.readyUpdates, []);
  });
}
for (const reason of [
  'pending',
  'stale-revision',
  'missing-index',
  'parsing',
  'missing-previous',
]) {
  test(`rollback rejects ${reason}`, async () => {
    const { service, state } = setup({
      activeEmbeddingProfileId: 'b',
      previousEmbeddingProfileId: reason === 'missing-previous' ? null : 'a',
    });
    if (reason === 'pending') state.kb.pendingEmbeddingProfileId = 'c';
    if (reason === 'stale-revision') state.counts.indexedChunks = 1;
    if (reason === 'missing-index') state.ready = false;
    if (reason === 'parsing') state.counts.unsettledKnowledge = 1;
    await rejectsSafely(service.rollback(kbId, ownerId), 409);
    assert.equal(state.kb.activeEmbeddingProfileId, 'b');
  });
}
test('cancel clears only pending and finishes only that profile tasks without deletions', async () => {
  const { service, state } = setup({
    activeEmbeddingProfileId: 'a',
    pendingEmbeddingProfileId: 'b',
    previousEmbeddingProfileId: 'c',
  });
  state.jobs = ['a', 'b', null].map((profileId) => ({
    kbId,
    profileId,
    status: 'pending',
  }));
  await service.cancel(kbId, ownerId);
  assert.equal(state.kb.activeEmbeddingProfileId, 'a');
  assert.equal(state.kb.previousEmbeddingProfileId, 'c');
  assert.equal(state.kb.pendingEmbeddingProfileId, null);
  assert.deepEqual(
    state.jobs.map((j) => j.status),
    ['pending', 'done', 'pending'],
  );
  assert.ok(state.queryLog.every((q) => !/DELETE/i.test(q.sql)));
});

test('ensureWritableProfiles returns distinct active/pending/previous full profiles', async () => {
  const { service, state } = setup({
    activeEmbeddingProfileId: 'a',
    pendingEmbeddingProfileId: 'b',
    previousEmbeddingProfileId: 'a',
  });
  assert.deepEqual(await service.ensureWritableProfiles(kbId), [
    profiles.a,
    profiles.b,
  ]);
  assert.equal(state.creates.length, 0);
});
test('legacy vectors block automatic inference before probing credentials', async () => {
  const { service, state } = setup();
  state.counts.legacyChunks = 1;
  await rejectsSafely(service.ensureWritableProfiles(kbId), 409);
  assert.equal(state.creates.length, 0);
});
test('explicit KB model takes precedence over owner default', async () => {
  const { service, state } = setup({ embeddingModelId: 'model-b' });
  assert.deepEqual(await service.ensureWritableProfiles(kbId), [profiles.b]);
  assert.deepEqual(state.creates, [{ modelId: 'model-b', userId: ownerId }]);
  assert.equal(state.kb.activeEmbeddingProfileId, 'b');
  assert.ok(state.queryLog.every((q) => !/FROM models/.test(q.sql)));
});
test('automatic binding resolves only the enabled owner default embedding model', async () => {
  const { service, state } = setup();
  state.candidate = profiles.a;
  assert.deepEqual(await service.ensureWritableProfiles(kbId), [profiles.a]);
  assert.deepEqual(state.creates, [{ modelId: 'model-a', userId: ownerId }]);
});
test('missing private default never falls back to global or visitor credentials', async () => {
  const { service, state } = setup();
  state.defaultModelId = null;
  await rejectsSafely(service.ensureWritableProfiles(kbId), 409);
  assert.equal(state.creates.length, 0);
});
test('concurrent binding wins over the auto-probed candidate', async () => {
  const { service, state } = setup();
  state.beforeLock = () => {
    state.kb.activeEmbeddingProfileId = 'a';
    state.kb.previousEmbeddingProfileId = 'c';
  };
  assert.deepEqual(await service.ensureWritableProfiles(kbId), [
    profiles.a,
    profiles.c,
  ]);
  assert.equal(state.kb.activeEmbeddingProfileId, 'a');
});
test('legacy vectors appearing during probe prevent automatic binding after lock', async () => {
  const { service, state } = setup();
  state.beforeLock = () => {
    state.counts.legacyChunks = 1;
  };
  await rejectsSafely(service.ensureWritableProfiles(kbId), 409);
  assert.equal(state.kb.activeEmbeddingProfileId, null);
});
test('untrusted dependency errors are replaced with safe Chinese errors', async () => {
  const { service, state } = setup();
  state.createFailure = new Error(secret);
  await rejectsSafely(service.startRebuild(kbId, ownerId, 'model-b'));
  await rejectsSafely(service.ensureWritableProfiles(kbId));
  assert.equal(state.kb.activeEmbeddingProfileId, null);
});
