import 'reflect-metadata';
import assert from 'node:assert/strict';
import { before, test } from 'node:test';

let EmbeddingIndexingService;
before(async () => {
  ({ EmbeddingIndexingService } =
    await import('../dist/modules/vector/embedding-indexing.service.js'));
});

const errorMessage = '向量化失败，请检查模型配置或重试';
const profiles = [
  { id: 'active', dimension: 2 },
  { id: 'pending', dimension: 3 },
  { id: 'previous', dimension: 4 },
];
const vector = (d) => Array(d).fill(1);
const chunk = (id, overrides = {}) => ({
  id,
  kbId: 'kb',
  knowledgeId: 'doc',
  content: id,
  contentRevision: 0,
  indexStatus: 'failed',
  ...overrides,
});

// SQL boundary model only: PostgreSQL locking, casts and uniqueness require the
// controller's real PG suite. Here we exercise retries and races at await points.
function setup(options = {}) {
  const state = {
    job: {
      id: 'job',
      kbId: 'kb',
      knowledgeId: null,
      chunkId: null,
      profileId: null,
      status: 'pending',
      ...options.job,
    },
    kb: {
      id: 'kb',
      activeEmbeddingProfileId: 'active',
      pendingEmbeddingProfileId: 'pending',
      previousEmbeddingProfileId: 'previous',
      ...options.kb,
    },
    chunks: options.chunks ?? [chunk('a'), chunk('b')],
    embeddings: new Map(),
    calls: [],
    ensured: [],
    transactions: 0,
    inTransaction: false,
    kbLocked: false,
    chunksLocked: false,
    embeds: [],
    continuations: [],
    writableCalls: 0,
    beforeEmbed: null,
    beforeChunkLock: null,
    failEmbedAt: null,
    failProfiles: new Set(),
    failIndexDimension: null,
    queryFailure: null,
    beforeJobUpdate: null,
  };
  const bound = (id) =>
    state.kb &&
    [
      'activeEmbeddingProfileId',
      'pendingEmbeddingProfileId',
      'previousEmbeddingProfileId',
    ].some((k) => state.kb[k] === id);
  const missing = (kbId, profileId, knowledgeId, chunkId, limit) =>
    state.chunks
      .filter(
        (c) =>
          c.kbId === kbId &&
          (!knowledgeId || c.knowledgeId === knowledgeId) &&
          (!chunkId || c.id === chunkId) &&
          state.embeddings.get(`${c.id}/${profileId}`)?.contentRevision !==
            c.contentRevision,
      )
      .slice(0, limit)
      .map((c) => ({ ...c }));
  const query = async (sql, params = []) => {
    const text = sql.replace(/\s+/g, ' ').trim();
    state.calls.push({ text, params, inTransaction: state.inTransaction });
    if (state.queryFailure?.(text, params)) throw new Error('database secret');
    if (/^SELECT .*FROM embedding_jobs/i.test(text))
      return state.job ? [{ ...state.job }] : [];
    if (/^UPDATE embedding_jobs/i.test(text)) {
      assert.match(
        text,
        /status\s*(?:<>|!=)\s*'done'/,
        'cancelled jobs must remain done',
      );
      state.beforeJobUpdate?.();
      state.beforeJobUpdate = null;
      // PostgresQueryRunner returns [rows, affected] for UPDATE, even RETURNING.
      if (!state.job || state.job.status === 'done') return [[], 0];
      state.job.status = text.match(/SET status\s*=\s*'(\w+)'/i)[1];
      if (state.job.status === 'failed') {
        assert.ok(params.includes(errorMessage));
        state.job.error = errorMessage;
      }
      return [[{ id: state.job.id }], 1];
    }
    if (/^SELECT .*FROM knowledge_bases/i.test(text)) {
      if (/FOR SHARE/i.test(text)) {
        assert.ok(state.inTransaction);
        state.kbLocked = true;
      }
      return state.kb ? [{ ...state.kb }] : [];
    }
    if (/^SELECT .*FROM chunks/i.test(text) && /FOR UPDATE/i.test(text)) {
      assert.ok(state.kbLocked, 'lock KB before chunks');
      state.chunksLocked = true;
      state.beforeChunkLock?.();
      state.beforeChunkLock = null;
      return state.chunks
        .filter((c) => c.kbId === params[0] && params[1].includes(c.id))
        .map((c) => ({ ...c }));
    }
    if (/^SELECT .*FROM chunks/i.test(text)) {
      assert.match(text, /LEFT JOIN chunk_embeddings/i);
      assert.match(text, /"contentRevision"\s*=\s*c\."contentRevision"/);
      assert.match(text, /"profileId"\s*=\s*\$2/);
      assert.doesNotMatch(text, /indexStatus/);
      assert.match(text, /LIMIT/);
      return missing(...params);
    }
    if (/INSERT INTO chunk_embeddings/i.test(text)) {
      assert.ok(state.inTransaction && state.kbLocked && state.chunksLocked);
      assert.match(text, /jsonb_to_recordset/);
      assert.match(text, /ON CONFLICT\s*\("chunkId",\s*"profileId"\)/i);
      assert.match(
        text,
        /chunk_embeddings\."contentRevision"\s*<\s*EXCLUDED\."contentRevision"/i,
      );
      assert.match(text, /c\."contentRevision"\s*=\s*\w+\."contentRevision"/);
      assert.match(text, /c\."kbId"\s*=\s*\$1/);
      const [kbId, profileId, dimension, payload] = params;
      const written = [];
      for (const item of JSON.parse(payload)) {
        const c = state.chunks.find(
          (c) =>
            c.id === item.chunkId &&
            c.kbId === kbId &&
            c.contentRevision === item.contentRevision,
        );
        const existing = state.embeddings.get(`${item.chunkId}/${profileId}`);
        if (
          !c ||
          (existing && existing.contentRevision >= item.contentRevision)
        )
          continue;
        state.embeddings.set(`${item.chunkId}/${profileId}`, {
          ...item,
          dimension,
          kbId,
          profileId,
        });
        written.push({
          chunkId: item.chunkId,
          contentRevision: item.contentRevision,
        });
      }
      return written;
    }
    if (/^UPDATE chunks/i.test(text)) {
      assert.ok(state.kbLocked && state.chunksLocked);
      assert.match(text, /"contentRevision"/);
      for (const item of JSON.parse(params[1])) {
        const c = state.chunks.find(
          (c) =>
            c.id === item.chunkId &&
            c.kbId === params[0] &&
            c.contentRevision === item.contentRevision,
        );
        if (c) c.indexStatus = 'ready';
      }
      return [];
    }
    if (/^INSERT INTO embedding_jobs/i.test(text)) {
      assert.ok(state.inTransaction && state.kbLocked);
      assert.match(
        text,
        /ON CONFLICT\s*\("kbId",\s*"knowledgeId"\)\s*WHERE "profileId" IS NULL AND status\s*=\s*'pending'/i,
      );
      assert.match(text, /DO UPDATE/i);
      assert.match(
        text,
        /"chunkId".*NULL/i,
        'conflicting document jobs must coalesce source scope',
      );
      state.continuations.push(params);
      return [];
    }
    assert.fail(`Unexpected SQL: ${text}`);
  };
  const dataSource = {
    query,
    transaction: async (callback) => {
      assert.equal(state.inTransaction, false);
      const snapshot = structuredClone({
        chunks: state.chunks,
        embeddings: state.embeddings,
        job: state.job,
        continuations: state.continuations,
      });
      state.inTransaction = true;
      state.transactions++;
      try {
        return await callback({ query });
      } catch (error) {
        Object.assign(state, snapshot);
        throw error;
      } finally {
        state.inTransaction = state.kbLocked = state.chunksLocked = false;
      }
    },
  };
  const profileService = {
    getProfile: async (id) => profiles.find((p) => p.id === id),
    embed: async (id, texts) => {
      assert.equal(
        state.inTransaction,
        false,
        'upstream call outside transaction',
      );
      assert.ok(texts.length <= 10);
      assert.ok(
        state.ensured.includes(profiles.find((p) => p.id === id).dimension),
      );
      state.embeds.push({ id, texts });
      await state.beforeEmbed?.(id, texts);
      if (
        state.embeds.length === state.failEmbedAt ||
        state.failProfiles.has(id)
      )
        throw new Error('https://secret.local sk-private upstream response');
      return {
        vectors: texts.map(() =>
          vector(profiles.find((p) => p.id === id).dimension),
        ),
        totalTokens: texts.length,
      };
    },
  };
  const bindings = {
    ensureWritableProfiles: async () => {
      state.writableCalls++;
      return profiles.filter((p) => bound(p.id));
    },
  };
  const indexes = {
    ensure: async (d) => {
      assert.equal(state.inTransaction, false);
      state.ensured.push(d);
      if (d === state.failIndexDimension)
        throw new Error('index database secret');
    },
  };
  return {
    state,
    service: new EmbeddingIndexingService(
      dataSource,
      profileService,
      bindings,
      indexes,
    ),
  };
}

test('missing and completed jobs are no-ops', async () => {
  for (const job of [null, { id: 'job', status: 'done' }]) {
    const { state, service } = setup();
    state.job = job;
    assert.deepEqual(await service.processJob('job'), { embedded: 0 });
    assert.equal(state.embeds.length, 0);
    assert.equal(state.writableCalls, 0);
  }
});

test('cancellation between initial read and running update is a no-op', async () => {
  const { state, service } = setup();
  state.beforeJobUpdate = () => {
    state.job.status = 'done';
  };
  assert.deepEqual(await service.processJob('job'), { embedded: 0 });
  assert.equal(state.writableCalls, 0);
  assert.equal(state.embeds.length, 0);
});

test('failed update with zero affected rows respects cancellation even if binding remains', async () => {
  const { state, service } = setup({ job: { profileId: 'active' } });
  state.beforeEmbed = () => {
    state.job.status = 'done';
  };
  state.failEmbedAt = 1;
  assert.deepEqual(await service.processJob('job'), { embedded: 0 });
  assert.equal(state.job.status, 'done');
});

test('continuation insertion failure rolls back completion and retry reuses vectors', async () => {
  const { state, service } = setup({
    job: { profileId: 'active' },
    chunks: Array.from({ length: 1001 }, (_, i) => chunk(`c${i}`)),
  });
  state.queryFailure = (sql) => /^INSERT INTO embedding_jobs/.test(sql);
  await assert.rejects(service.processJob('job'), { message: errorMessage });
  assert.equal(state.job.status, 'failed');
  assert.equal(state.embeddings.size, 1000);
  assert.equal(state.continuations.length, 0);
  state.queryFailure = null;
  assert.deepEqual(await service.processJob('job'), { embedded: 1 });
  assert.equal(state.job.status, 'done');
});

test('4000 dimensions are supported without legacy vector storage', async () => {
  const { state, service } = setup();
  assert.equal(
    await service.writeBatch('kb', 'active', 4000, [
      { chunkId: 'a', contentRevision: 0, vector: vector(4000) },
    ]),
    1,
  );
  assert.equal(state.embeddings.get('a/active').dimension, 4000);
  assert.ok(
    state.calls.every((c) => !/UPDATE chunks.*SET embedding/.test(c.text)),
  );
});

test('active, pending and previous dimensions write separately; failed chunks are retried', async () => {
  const { state, service } = setup();
  assert.deepEqual(await service.processJob('job'), { embedded: 6 });
  assert.deepEqual(state.ensured, [2, 3, 4]);
  assert.equal(state.embeddings.size, 6);
  assert.equal(state.job.status, 'done');
  assert.ok(state.chunks.every((c) => c.indexStatus === 'ready'));
});

for (const failedProfile of ['active', 'pending', 'previous']) {
  test(`${failedProfile} failure is isolated; retry only embeds its missing vectors`, async () => {
    const { state, service } = setup();
    state.failProfiles.add(failedProfile);
    await assert.rejects(service.processJob('job'), { message: errorMessage });
    assert.deepEqual(
      state.embeds.map((e) => e.id),
      ['active', 'pending', 'previous'],
    );
    assert.equal(state.embeddings.size, 4);
    assert.equal(state.job.status, 'failed');
    assert.equal(state.job.error, errorMessage);
    assert.ok(
      state.chunks.every(
        (c) =>
          c.indexStatus === (failedProfile === 'active' ? 'failed' : 'ready'),
      ),
    );
    state.failProfiles.clear();
    const priorCalls = state.embeds.length;
    assert.deepEqual(await service.processJob('job'), { embedded: 2 });
    assert.deepEqual(
      state.embeds.slice(priorCalls).map((e) => e.id),
      [failedProfile],
    );
    assert.equal(state.embeddings.size, 6);
    assert.equal(state.job.status, 'done');
  });
}

test('active index failure does not prevent pending and previous indexing', async () => {
  const { state, service } = setup();
  state.failIndexDimension = 2;
  await assert.rejects(service.processJob('job'), { message: errorMessage });
  assert.deepEqual(
    state.embeds.map((e) => e.id),
    ['pending', 'previous'],
  );
  assert.equal(state.embeddings.size, 4);
  assert.equal(state.job.status, 'failed');
});

test('active write failure rolls back its batch and continues other profiles', async () => {
  const { state, service } = setup();
  state.queryFailure = (sql, params) =>
    /INSERT INTO chunk_embeddings/.test(sql) && params[1] === 'active';
  await assert.rejects(service.processJob('job'), { message: errorMessage });
  assert.deepEqual(
    state.embeds.map((e) => e.id),
    ['active', 'pending', 'previous'],
  );
  assert.equal(state.embeddings.size, 4);
  assert.ok(state.chunks.every((c) => c.indexStatus === 'failed'));
});

test('failure of a removed profile does not discard the remaining generic job targets', async () => {
  const { state, service } = setup();
  state.failProfiles.add('active');
  state.beforeEmbed = (id) => {
    if (id === 'active') state.kb.activeEmbeddingProfileId = null;
  };
  assert.deepEqual(await service.processJob('job'), { embedded: 4 });
  assert.deepEqual(
    state.embeds.map((e) => e.id),
    ['active', 'pending', 'previous'],
  );
  assert.equal(state.job.status, 'done');
});

test('removed last profile cannot mask an earlier still-bound failure', async () => {
  const { state, service } = setup();
  state.failProfiles.add('active');
  state.failProfiles.add('previous');
  state.beforeEmbed = (id) => {
    if (id === 'previous') state.kb.previousEmbeddingProfileId = null;
  };
  await assert.rejects(service.processJob('job'), { message: errorMessage });
  assert.deepEqual(
    state.embeds.map((e) => e.id),
    ['active', 'pending', 'previous'],
  );
  assert.equal(state.embeddings.size, 2);
  assert.equal(state.job.status, 'failed');
});

test('earlier failure removed during later profile work no longer fails the job', async () => {
  const { state, service } = setup();
  state.failProfiles.add('active');
  state.beforeEmbed = (id) => {
    if (id === 'previous') state.kb.activeEmbeddingProfileId = null;
  };
  assert.deepEqual(await service.processJob('job'), { embedded: 4 });
  assert.equal(state.job.status, 'done');
});

test('isolated failures still count toward the shared 100-batch budget', async () => {
  const { state, service } = setup({
    chunks: Array.from({ length: 501 }, (_, i) => chunk(`c${i}`)),
  });
  state.failProfiles.add('active');
  await assert.rejects(service.processJob('job'), { message: errorMessage });
  assert.equal(state.embeds.length, 100);
  assert.equal(state.embeddings.size, 981);
  assert.equal(state.job.status, 'failed');
  assert.equal(
    state.continuations.length,
    0,
    'failed job retries itself without a duplicate continuation',
  );
  const priorCalls = state.embeds.length;
  await assert.rejects(service.processJob('job'), { message: errorMessage });
  assert.deepEqual(
    state.embeds.slice(priorCalls).map((e) => e.id),
    ['active', 'previous', 'previous', 'previous'],
  );
  assert.equal(state.embeddings.size, 1002);
});

test('job scope intersects kb, document and chunk', async () => {
  const { state, service } = setup({
    job: { knowledgeId: 'doc', chunkId: 'a', profileId: 'active' },
    chunks: [chunk('a'), chunk('b'), chunk('c', { kbId: 'elsewhere' })],
  });
  assert.deepEqual(await service.processJob('job'), { embedded: 1 });
  assert.deepEqual(
    state.embeds.map((e) => e.texts),
    [['a']],
  );
  assert.equal(state.writableCalls, 0);
});

test('successful batches survive failure and retry skips current revisions', async () => {
  const { state, service } = setup({
    job: { profileId: 'active' },
    chunks: Array.from({ length: 12 }, (_, i) => chunk(`c${i}`)),
  });
  state.failEmbedAt = 2;
  await assert.rejects(service.processJob('job'), { message: errorMessage });
  assert.equal(state.embeddings.size, 10);
  assert.equal(state.job.status, 'failed');
  assert.equal(state.job.error, errorMessage);
  state.failEmbedAt = null;
  assert.deepEqual(await service.processJob('job'), { embedded: 2 });
  assert.equal(state.embeds.at(-1).texts.length, 2);
  assert.equal(state.embeddings.size, 12);
});

test('cancelled fixed profile never calls ensureWritableProfiles or embed', async () => {
  const { state, service } = setup({ job: { profileId: 'removed' } });
  assert.deepEqual(await service.processJob('job'), { embedded: 0 });
  assert.equal(state.writableCalls, 0);
  assert.equal(state.embeds.length, 0);
  assert.equal(state.job.status, 'done');
});

test('unbind during external call discards results safely', async () => {
  const { state, service } = setup({ job: { profileId: 'pending' } });
  state.beforeEmbed = () => {
    state.kb.pendingEmbeddingProfileId = null;
    state.job.status = 'done';
  };
  assert.deepEqual(await service.processJob('job'), { embedded: 0 });
  assert.equal(state.embeddings.size, 0);
  assert.equal(state.job.status, 'done');
});

test('upstream failure after cancellation does not resurrect a failed job', async () => {
  const { state, service } = setup({ job: { profileId: 'pending' } });
  state.failEmbedAt = 1;
  state.beforeEmbed = () => {
    state.kb.pendingEmbeddingProfileId = null;
    state.job.status = 'done';
  };
  assert.deepEqual(await service.processJob('job'), { embedded: 0 });
  assert.equal(state.job.status, 'done');
});

test('100 batch job limit applies across profiles and creates scoped continuation', async () => {
  const { state, service } = setup({
    job: { knowledgeId: 'doc' },
    chunks: Array.from({ length: 501 }, (_, i) => chunk(`c${i}`)),
  });
  const result = await service.processJob('job');
  assert.equal(state.embeds.length, 100);
  assert.equal(result.embedded, 991);
  assert.equal(state.continuations.length, 1);
  assert.deepEqual(state.continuations[0], ['kb', 'doc', null, null]);
  assert.equal(state.job.status, 'done');
});

test('fixed-profile continuation keeps all original source fields', async () => {
  const { state, service } = setup({
    job: { knowledgeId: 'doc', profileId: 'active' },
    chunks: Array.from({ length: 1001 }, (_, i) => chunk(`c${i}`)),
  });
  assert.deepEqual(await service.processJob('job'), { embedded: 1000 });
  assert.deepEqual(state.continuations, [['kb', 'doc', null, 'active']]);
});

test('exactly 100 batches with no gap does not create continuation', async () => {
  const { state, service } = setup({
    job: { profileId: 'active' },
    chunks: Array.from({ length: 1000 }, (_, i) => chunk(`c${i}`)),
  });
  assert.deepEqual(await service.processJob('job'), { embedded: 1000 });
  assert.equal(state.continuations.length, 0);
});

test('writeBatch skips edited, deleted and wrong-KB chunks', async () => {
  const { state, service } = setup({
    chunks: [
      chunk('old', { contentRevision: 2, indexStatus: 'ready' }),
      chunk('other', { kbId: 'other' }),
      chunk('valid'),
    ],
  });
  const items = ['old', 'deleted', 'other', 'valid'].map((chunkId) => ({
    chunkId,
    contentRevision: 0,
    vector: [1, 2],
  }));
  assert.equal(await service.writeBatch('kb', 'active', 2, items), 1);
  assert.equal(state.embeddings.size, 1);
  assert.equal(state.chunks[0].indexStatus, 'ready');
});

test('chunk lock rechecks revision changed after batch preparation', async () => {
  const { state, service } = setup();
  state.beforeChunkLock = () => {
    state.chunks[0].contentRevision = 1;
  };
  assert.equal(
    await service.writeBatch('kb', 'active', 2, [
      { chunkId: 'a', contentRevision: 0, vector: [1, 2] },
    ]),
    0,
  );
});

test('equal/newer stored revision is never overwritten', async () => {
  const { state, service } = setup();
  const items = [{ chunkId: 'a', contentRevision: 0, vector: [1, 2] }];
  assert.equal(await service.writeBatch('kb', 'active', 2, items), 1);
  assert.equal(
    await service.writeBatch('kb', 'active', 2, [
      { ...items[0], vector: [9, 9] },
    ]),
    0,
  );
  assert.equal(JSON.parse(state.embeddings.get('a/active').vector)[0], 1);
});

for (const id of ['pending', 'previous']) {
  test(`${id} writes never mark chunks ready`, async () => {
    const { state, service } = setup();
    const d = profiles.find((p) => p.id === id).dimension;
    assert.equal(
      await service.writeBatch('kb', id, d, [
        { chunkId: 'a', contentRevision: 0, vector: vector(d) },
      ]),
      1,
    );
    assert.equal(state.chunks[0].indexStatus, 'failed');
  });
}

test('removed binding skips writes and all chunk locks', async () => {
  const { state, service } = setup();
  assert.equal(
    await service.writeBatch('kb', 'removed', 2, [
      { chunkId: 'a', contentRevision: 0, vector: [1, 2] },
    ]),
    0,
  );
  assert.equal(
    state.calls.some((c) => /FOR UPDATE/.test(c.text)),
    false,
  );
});

test('insert and active ready update roll back together', async () => {
  const { state, service } = setup();
  state.queryFailure = (sql) => /^UPDATE chunks/.test(sql);
  await assert.rejects(
    service.writeBatch('kb', 'active', 2, [
      { chunkId: 'a', contentRevision: 0, vector: [1, 2] },
    ]),
  );
  assert.equal(state.embeddings.size, 0);
  assert.equal(state.chunks[0].indexStatus, 'failed');
});

for (const [dimension, v] of [
  [0, []],
  [4001, [1]],
  [1.5, [1]],
  [2, [1]],
  [2, [0, 0]],
  [2, [NaN, 1]],
  [2, [Infinity, 1]],
  [2, ['1', 2]],
  [2, Array(2)],
  // eslint-disable-next-line no-sparse-arrays -- 明确验证不完整的向量不能写入。
  [2, [1, ,]],
]) {
  test(`writeBatch rejects invalid dimension/vector ${String(dimension)}:${String(v)}`, async () => {
    const { state, service } = setup();
    await assert.rejects(
      service.writeBatch('kb', 'active', dimension, [
        { chunkId: 'a', contentRevision: 0, vector: v },
      ]),
    );
    assert.equal(state.transactions, 0);
  });
}

test('empty write batch performs no transaction', async () => {
  const { state, service } = setup();
  assert.equal(await service.writeBatch('kb', 'active', 2, []), 0);
  assert.equal(state.transactions, 0);
});
