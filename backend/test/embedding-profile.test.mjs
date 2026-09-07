import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, test } from 'node:test';
import { DataSource, getMetadataArgsStorage } from 'typeorm';
import { Model } from '../dist/modules/model/model.entity.js';
import { LLMProviderFactory } from '../dist/modules/model/providers/llm-provider.factory.js';

let EmbeddingProfile;
let EmbeddingProfileService;
before(async () => {
  const entity =
    await import('../dist/modules/model/embedding-profile.entity.js').catch(
      () => null,
    );
  const service =
    await import('../dist/modules/model/embedding-profile.service.js').catch(
      () => null,
    );
  assert.ok(
    entity?.EmbeddingProfile && service?.EmbeddingProfileService,
    '主控需 build 新增的 EmbeddingProfile 实体和服务到 dist',
  );
  ({ EmbeddingProfile } = entity);
  ({ EmbeddingProfileService } = service);
});

const ownerId = '11111111-1111-4111-8111-111111111111';
const modelId = '22222222-2222-4222-8222-222222222222';
const sensitive =
  'https://private.example/v1?api_key=secret upstream-body sk-secret';
function fixture(overrides = {}, withUsage = true) {
  const state = {
    model: Object.assign(
      new Model(),
      {
        id: modelId,
        userId: ownerId,
        name: '显示名',
        provider: 'openai-compatible',
        baseUrl: 'https://embedding.example/v1',
        modelName: 'embedding-v1',
        apiKeyEncrypted: 'encrypted-old',
        type: 'embedding',
        enabled: true,
        isDefault: false,
        extraConfig: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      overrides,
    ),
    rows: [],
    calls: [],
    configs: [],
    result: undefined,
    failure: undefined,
    race: false,
    conflicts: 0,
    saveFailure: undefined,
  };
  const profiles = {
    create: (value) => Object.assign(new EmbeddingProfile(), value),
    findOne: async ({ where }) =>
      state.rows.find((row) =>
        Object.entries(where).every(([key, value]) => row[key] === value),
      ) ?? null,
    save: async (profile) => {
      if (state.saveFailure) throw state.saveFailure;
      if (
        state.race ||
        state.rows.some(
          (row) =>
            row.ownerId === profile.ownerId &&
            row.fingerprint === profile.fingerprint,
        )
      ) {
        if (state.race) {
          state.rows.push(
            Object.assign(new EmbeddingProfile(), profile, {
              id: randomUUID(),
              createdAt: new Date(),
            }),
          );
          state.race = false;
        }
        state.conflicts++;
        throw Object.assign(new Error(sensitive), {
          driverError: { code: '23505' },
        });
      }
      const row = Object.assign(new EmbeddingProfile(), profile, {
        id: randomUUID(),
        createdAt: new Date(),
      });
      state.rows.push(row);
      return row;
    },
  };
  const models = {
    findOne: async ({ where }) =>
      state.model &&
      Object.entries(where).every(([k, v]) => state.model[k] === v)
        ? state.model
        : null,
  };
  const request = async (texts, modelName) => {
    state.calls.push({ texts, modelName });
    if (state.failure) throw state.failure;
    return (
      state.result ?? { vectors: texts.map(() => [1, 2, 3]), totalTokens: 7 }
    );
  };
  const factory = {
    create: (model) => {
      state.configs.push(structuredClone(model));
      return withUsage
        ? {
            embedWithUsage: request,
            embed: async () => assert.fail('应优先使用 embedWithUsage'),
          }
        : { embed: async (...args) => (await request(...args)).vectors };
    },
  };
  const dataSource = {
    getRepository: (entity) => {
      if (entity === Model) return models;
      assert.equal(entity, EmbeddingProfile);
      return profiles;
    },
  };
  return {
    state,
    service: new EmbeddingProfileService(dataSource, factory),
    profiles,
  };
}

async function safeFailure(promise) {
  await assert.rejects(promise, (error) => {
    assert.match(error.message, /[\u4e00-\u9fff]/u);
    assert.doesNotMatch(
      JSON.stringify(error) + error.message,
      /https?:|private\.example|secret|upstream-body|encrypted-old/,
    );
    return true;
  });
}

test('entity maps immutable snapshot fields, uuid ids and owner/fingerprint uniqueness; DI metadata is emitted', () => {
  const metadata = getMetadataArgsStorage();
  assert.equal(
    metadata.tables.find((t) => t.target === EmbeddingProfile)?.name,
    'embedding_profiles',
  );
  const columns = metadata.columns.filter((c) => c.target === EmbeddingProfile);
  assert.deepEqual(
    columns.map((c) => c.propertyName).sort(),
    [
      'id',
      'ownerId',
      'modelId',
      'provider',
      'baseUrl',
      'modelName',
      'dimension',
      'extraConfig',
      'fingerprint',
      'createdAt',
    ].sort(),
  );
  for (const name of ['ownerId', 'modelId'])
    assert.equal(
      columns.find((c) => c.propertyName === name).options.type,
      'uuid',
    );
  assert.equal(
    metadata.generations.find((g) => g.target === EmbeddingProfile)?.strategy,
    'uuid',
  );
  assert.equal(
    columns.find((c) => c.propertyName === 'dimension').options.type,
    'integer',
  );
  assert.equal(
    columns.find((c) => c.propertyName === 'extraConfig').options.type,
    'jsonb',
  );
  assert.ok(
    metadata.checks.some(
      (c) =>
        c.target === EmbeddingProfile &&
        /dimension/.test(c.expression) &&
        /4000/.test(c.expression),
    ),
  );
  for (const column of columns.filter((c) => c.propertyName !== 'id')) {
    assert.equal(column.options.update, false);
  }
  assert.ok(
    [...metadata.indices, ...metadata.uniques].some(
      (i) =>
        i.target === EmbeddingProfile &&
        JSON.stringify(i.columns) ===
          JSON.stringify(['ownerId', 'fingerprint']) &&
        (i.options?.unique || i.unique || metadata.uniques.includes(i)),
    ),
  );
  assert.deepEqual(
    Reflect.getMetadata('design:paramtypes', EmbeddingProfileService),
    [DataSource, LLMProviderFactory],
  );
});

test('create probes once, discovers dimension, filters secrets and returns retrievable snapshot', async () => {
  const { service, state } = fixture({
    extraConfig: {
      supportsDimensionOverride: true,
      apiKey: 'sk-secret',
      nested: { token: 'secret' },
      temperature: 0.4,
    },
  });
  const profile = await service.createProfile(modelId, ownerId);
  assert.equal(profile.dimension, 3);
  assert.equal(profile.ownerId, ownerId);
  assert.equal(profile.modelId, modelId);
  assert.deepEqual(profile.extraConfig, { supportsDimensionOverride: true });
  assert.deepEqual(state.calls, [
    { texts: ['向量配置验证'], modelName: 'embedding-v1' },
  ]);
  assert.doesNotMatch(
    JSON.stringify(profile),
    /secret|apiKey|temperature|encrypted/,
  );
  assert.deepEqual(await service.getProfile(profile.id), profile);
  state.model.extraConfig.supportsDimensionOverride = false;
  assert.equal(profile.extraConfig.supportsDimensionOverride, true);
});

for (const change of [
  { userId: null },
  { userId: 'other' },
  { enabled: false },
  { type: 'chat' },
  { type: 'rerank' },
]) {
  test(`create rejects ineligible model ${JSON.stringify(change)} before requesting`, async () => {
    const { service, state } = fixture(change);
    await safeFailure(service.createProfile(modelId, ownerId));
    assert.equal(state.calls.length, 0);
    assert.equal(state.rows.length, 0);
  });
}
test('missing model and profile fail safely', async () => {
  const { service, state } = fixture();
  state.model = null;
  await safeFailure(service.createProfile(modelId, ownerId));
  await safeFailure(service.getProfile('missing'));
});

for (const dimensions of [0, 4001, 1.5, '3', null, NaN]) {
  test(`invalid configured dimension ${String(dimensions)} rejects before probe`, async () => {
    const { service, state } = fixture({ extraConfig: { dimensions } });
    await safeFailure(service.createProfile(modelId, ownerId));
    assert.equal(state.calls.length, 0);
  });
}
test('configured dimension must match probe', async () => {
  const { service, state } = fixture({ extraConfig: { dimensions: 2 } });
  await safeFailure(service.createProfile(modelId, ownerId));
  assert.equal(state.rows.length, 0);
});
for (const dimension of [1, 4000]) {
  test(`accepts dimension boundary ${dimension}`, async () => {
    const { service, state } = fixture({
      extraConfig: { dimensions: dimension },
    });
    state.result = { vectors: [Array(dimension).fill(1)], totalTokens: 0 };
    assert.equal(
      (await service.createProfile(modelId, ownerId)).dimension,
      dimension,
    );
  });
}

const invalidVectors = [
  null,
  [],
  [[1], [2]],
  [[]],
  [[0, 0, 0]],
  [[NaN, 1, 2]],
  [[Infinity, 1, 2]],
  [['1', 2, 3]],
  [Array(3)],
  // eslint-disable-next-line no-sparse-arrays -- 明确验证上游稀疏数组会被拒绝。
  [[1, , 2]],
  Array(1),
  [Array(4001).fill(1)],
];
for (const [index, vectors] of invalidVectors.entries()) {
  test(`probe independently rejects malformed vectors ${index}`, async () => {
    const { service, state } = fixture();
    state.result = { vectors, totalTokens: 0 };
    await safeFailure(service.createProfile(modelId, ownerId));
    assert.equal(state.rows.length, 0);
  });
}

test('stable fingerprint ignores display name, credential rotation and unapproved extras', async () => {
  const { service, state } = fixture({
    extraConfig: { dimensions: 3, supportsDimensionOverride: true },
  });
  const first = await service.createProfile(modelId, ownerId);
  state.model.extraConfig = {
    apiKey: 'secret',
    supportsDimensionOverride: true,
    dimensions: 3,
  };
  state.model.name = '新显示名';
  state.model.apiKeyEncrypted = 'encrypted-new';
  assert.equal((await service.createProfile(modelId, ownerId)).id, first.id);
  assert.equal(state.rows.length, 1);
});
for (const change of [
  { id: 'another-model' },
  { userId: 'another-owner' },
  { provider: 'ollama' },
  { baseUrl: 'https://different.example/v1' },
  { modelName: 'embedding-v2' },
  { extraConfig: { supportsDimensionOverride: true } },
]) {
  test(`fingerprint distinguishes identity/config ${JSON.stringify(change)}`, async () => {
    const { service, state } = fixture();
    const first = await service.createProfile(modelId, ownerId);
    Object.assign(state.model, change);
    const second = await service.createProfile(
      state.model.id,
      state.model.userId,
    );
    assert.notEqual(second.fingerprint, first.fingerprint);
  });
}
test('fingerprint distinguishes discovered dimensions', async () => {
  const { service, state } = fixture();
  const first = await service.createProfile(modelId, ownerId);
  state.result = { vectors: [[1, 2]], totalTokens: 0 };
  assert.notEqual(
    (await service.createProfile(modelId, ownerId)).fingerprint,
    first.fingerprint,
  );
});
test('unique violation rereads the winning immutable snapshot', async () => {
  const { service, state } = fixture();
  state.race = true;
  const profile = await service.createProfile(modelId, ownerId);
  assert.equal(state.conflicts, 1);
  assert.equal(profile.id, state.rows[0].id);
  assert.equal(state.rows.length, 1);
});
test('concurrent identical creates converge on one snapshot', async () => {
  const { service, state } = fixture();
  const profiles = await Promise.all(
    Array.from({ length: 6 }, () => service.createProfile(modelId, ownerId)),
  );
  assert.equal(new Set(profiles.map((p) => p.id)).size, 1);
  assert.equal(state.rows.length, 1);
});

test('embed uses snapshot space, latest referenced credentials, and real usage', async () => {
  const { service, state } = fixture({ extraConfig: { dimensions: 3 } });
  const profile = await service.createProfile(modelId, ownerId);
  Object.assign(state.model, {
    provider: 'ollama',
    baseUrl: 'https://changed.example',
    modelName: 'changed',
    extraConfig: { dimensions: 99 },
    apiKeyEncrypted: 'encrypted-new',
  });
  assert.deepEqual(await service.embed(profile.id, ['甲', '乙']), {
    vectors: [
      [1, 2, 3],
      [1, 2, 3],
    ],
    totalTokens: 7,
  });
  const config = state.configs.at(-1);
  assert.equal(config.id, modelId);
  assert.equal(config.apiKeyEncrypted, 'encrypted-new');
  assert.equal(config.provider, 'openai-compatible');
  assert.equal(config.baseUrl, 'https://embedding.example/v1');
  assert.equal(config.modelName, 'embedding-v1');
  assert.deepEqual(config.extraConfig, { dimensions: 3 });
  assert.equal(state.calls.at(-1).modelName, 'embedding-v1');
});
test('fallback embed reports zero usage and empty texts make no provider request', async () => {
  const { service, state } = fixture({}, false);
  const profile = await service.createProfile(modelId, ownerId);
  assert.deepEqual(await service.embed(profile.id, ['甲']), {
    vectors: [[1, 2, 3]],
    totalTokens: 0,
  });
  const calls = state.calls.length;
  const configs = state.configs.length;
  assert.deepEqual(await service.embed(profile.id, []), {
    vectors: [],
    totalTokens: 0,
  });
  assert.equal(state.calls.length, calls);
  assert.equal(state.configs.length, configs);
});
for (const change of [
  null,
  { userId: null },
  { userId: 'other' },
  { enabled: false },
  { type: 'chat' },
]) {
  test(`embed rechecks referenced model eligibility ${JSON.stringify(change)}`, async () => {
    const { service, state } = fixture();
    const profile = await service.createProfile(modelId, ownerId);
    if (change === null) state.model = null;
    else Object.assign(state.model, change);
    await safeFailure(service.embed(profile.id, ['甲']));
    assert.equal(state.calls.length, 1);
  });
}
for (const [index, vectors] of [...invalidVectors, [[1, 2]]].entries()) {
  test(`embed rejects malformed or wrong-dimension vectors ${index}`, async () => {
    const { service, state } = fixture();
    const profile = await service.createProfile(modelId, ownerId);
    state.result = { vectors, totalTokens: 0 };
    await safeFailure(service.embed(profile.id, ['甲']));
  });
}
test('upstream and persistence failures never expose credentials, URLs or response bodies', async () => {
  const { service, state } = fixture();
  state.failure = new Error(sensitive);
  await safeFailure(service.createProfile(modelId, ownerId));
  state.failure = undefined;
  const profile = await service.createProfile(modelId, ownerId);
  state.failure = new Error(sensitive);
  await safeFailure(service.embed(profile.id, ['甲']));
  state.failure = undefined;
  state.model.modelName = 'new-space';
  state.saveFailure = new Error(sensitive);
  await safeFailure(service.createProfile(modelId, ownerId));
});
