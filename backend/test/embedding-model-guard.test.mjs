import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelService } from '../dist/modules/model/model.service.js';
const owner = '00000000-0000-4000-8000-000000000001';
function fixture() {
  let model = {
    id: '00000000-0000-4000-8000-000000000002',
    name: '向量模型',
    modelName: 'embed',
    provider: 'openai-compatible',
    baseUrl: 'https://example.com',
    apiKeyEncrypted: '',
    type: 'embedding',
    userId: owner,
    enabled: true,
    isDefault: true,
    extraConfig: { dimensions: 1024 },
  };
  let writes = 0;
  const repo = {
    findOne: async () => structuredClone(model),
    save: async (value) => {
      writes++;
      model = value;
      return value;
    },
    delete: async () => {
      writes++;
    },
  };
  const ds = {
    query: async () => [{ id: 'profile' }],
    transaction: async (fn) =>
      fn({
        findOne: repo.findOne,
        save: repo.save,
        update: async () => {
          writes++;
        },
      }),
  };
  const service = new ModelService(
    repo,
    ds,
    { encrypt: () => 'encrypted' },
    { create: () => ({}) },
    { log: async () => {} },
  );
  return { service, writes: () => writes, model: () => model };
}
test('已有向量配置引用的模型不能原地变更维度或上游模型', async () => {
  for (const dto of [
    { modelName: 'other' },
    { baseUrl: 'https://other.example.com' },
    { extraConfig: { dimensions: 1536 } },
    { type: 'chat' },
  ]) {
    const f = fixture();
    await assert.rejects(f.service.update(f.model().id, dto, owner), {
      status: 409,
    });
    assert.equal(f.writes(), 0);
  }
});
test('已有配置引用的模型允许凭据轮换，但不允许删除', async () => {
  const f = fixture();
  await f.service.update(f.model().id, { apiKey: 'test-key' }, owner);
  assert.equal(f.model().apiKeyEncrypted, 'encrypted');
  await assert.rejects(f.service.remove(f.model().id, owner), { status: 409 });
  assert.equal(f.writes(), 1);
});

test('用户不能把其他用户的私有模型设为默认', async () => {
  const f = fixture();
  await assert.rejects(
    f.service.setDefault(f.model().id, '00000000-0000-4000-8000-000000000003'),
    { status: 404 },
  );
  assert.equal(f.writes(), 0);
});
