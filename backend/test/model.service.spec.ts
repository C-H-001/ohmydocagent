// ModelService 单元测试（Task 2.3 + 质量审查整改）：模型 CRUD 业务规则。
// 断言维度（repository/dataSource 全部 mock，事务语义用桩验证）：
// - create：apiKey 加密后落库（DB 不存明文）、ollama baseUrl 默认值、
//   openai-compatible 缺 baseUrl → 400、响应脱敏（hasApiKey=true、无
//   apiKeyEncrypted 字段）
// - list/getById：脱敏（apiKeyEncrypted 剔除）
// - getDefault：只返回 isDefault=true && enabled 的模型，无则 null；
//   内存缓存：命中不查库、setDefault 写入、update/remove 失效
// - setDefault：事务内「同 type 先清默认 → 目标置默认」；23505 唯一冲突重试一次；
//   disabled 模型 → 400（防静默无默认）
// - remove：默认模型允许删除（设计：删除时该 type 自动无默认，见实现注释）；
//   不存在 → 404
// - testConnection：透传完整连接配置给 getRaw 供应商实例（不保存）
// - update：传 apiKey 重新加密；不传保留原密文；type 变更 + 本行默认 →
//   目标 type 已有默认则清除本行 isDefault（防部分唯一索引 23505 裸 500）
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import { CryptoService } from '../src/modules/model/crypto.service.js';
import { Model } from '../src/modules/model/model.entity.js';
import { ModelService } from '../src/modules/model/model.service.js';
import { AuditService } from '../src/modules/admin/audit/audit.service.js';
import { LLMProviderFactory } from '../src/modules/model/providers/llm-provider.factory.js';
import type { ProviderConnectionConfig } from '../src/modules/model/providers/llm-provider.interface.js';

/** 构造被测实例：仓库/DataSource/CryptoService/Factory 全 mock */
function makeService() {
  const repo = {
    // create/save 有实现（返回入参或补全 id）——sanitize 需要真实模型行
    create: vi.fn((d: Partial<Model>) => ({ id: 'model-1', ...d })),
    save: vi.fn(async (m: Model) => m),
    // find/findOne/update/delete 无类型 vi.fn()：mockResolvedValue 可注入
    // 任意值（Model 行等），避免 vi.fn(async () => null) 的类型收窄（TS2322）
    find: vi.fn(),
    findOne: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };
  const crypto = {
    encrypt: vi.fn((s: string) => `enc:${s}`),
    decrypt: vi.fn((s: string) => s.replace(/^enc:/, '')),
  };
  const factory = {
    create: vi.fn(),
    getRaw: vi.fn(),
  };
  const dataSource = {
    transaction: vi.fn(),
  };
  // Task 4.4 审计（非关键路径，mock 断言调用）
  const audit = { log: vi.fn() };
  const svc = new ModelService(
    repo as unknown as Repository<Model>,
    dataSource as unknown as DataSource,
    crypto as unknown as CryptoService,
    factory as unknown as LLMProviderFactory,
    audit as unknown as AuditService,
  );
  return { svc, repo, crypto, factory, dataSource };
}

/** 构造一个最小模型行（apiKeyEncrypted 密文） */
function modelRow(overrides: Partial<Model> = {}): Model {
  return {
    id: 'model-1',
    name: 'DeepSeek',
    provider: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com',
    apiKeyEncrypted: 'enc:sk-test',
    modelName: 'deepseek-chat',
    type: 'chat',
    enabled: true,
    isDefault: false,
    userId: 'u1',
    extraConfig: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Model;
}

describe('ModelService（模型管理业务规则）', () => {
  it('create：apiKey 加密后落库（DB 不存明文）', async () => {
    const { svc, repo, crypto } = makeService();
    await svc.create({
      name: 'DeepSeek',
      provider: 'openai-compatible',
      baseUrl: 'https://api.deepseek.com',
      modelName: 'deepseek-chat',
      apiKey: 'sk-plain-secret',
      type: 'chat',
    });
    expect(crypto.encrypt).toHaveBeenCalledWith('sk-plain-secret');
    const saved = repo.save.mock.calls[0][0] as Model;
    expect(saved.apiKeyEncrypted).toBe('enc:sk-plain-secret');
    // 落库的是加密后的值（mock crypto 的 enc: 前缀），而非明文本身
    expect(saved.apiKeyEncrypted).not.toBe('sk-plain-secret');
  });

  it('create：ollama 未传 baseUrl 时用默认 http://127.0.0.1:11434', async () => {
    const { svc, repo } = makeService();
    await svc.create({
      name: '本地 Ollama',
      provider: 'ollama',
      modelName: 'qwen2.5:7b',
    });
    const saved = repo.save.mock.calls[0][0] as Model;
    expect(saved.baseUrl).toBe('http://127.0.0.1:11434');
  });

  it('create：响应脱敏（hasApiKey=true、无 apiKeyEncrypted 字段）', async () => {
    const { svc } = makeService();
    const view = await svc.create({
      name: 'DeepSeek',
      provider: 'openai-compatible',
      baseUrl: 'https://api.deepseek.com',
      modelName: 'deepseek-chat',
      apiKey: 'sk-plain-secret',
    });
    expect(view.hasApiKey).toBe(true);
    expect(
      (view as unknown as Record<string, unknown>).apiKeyEncrypted,
    ).toBeUndefined();
  });

  it('list：剔除 apiKeyEncrypted、补 hasApiKey（密文存在与否由布尔表达）', async () => {
    const { svc, repo } = makeService();
    repo.find.mockResolvedValue([
      modelRow(),
      modelRow({ id: 'model-2', apiKeyEncrypted: '' }),
    ]);
    const items = await svc.list();
    expect(items).toHaveLength(2);
    expect(items[0].hasApiKey).toBe(true);
    expect(
      (items[0] as unknown as Record<string, unknown>).apiKeyEncrypted,
    ).toBeUndefined();
    expect(items[1].hasApiKey).toBe(false);
  });

  it('create：openai-compatible 未传 baseUrl → 400（必填，配合 DTO IsUrl 格式校验）', async () => {
    const { svc } = makeService();
    await expect(
      svc.create({
        name: '缺 baseUrl',
        provider: 'openai-compatible',
        modelName: 'm',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('getDefault：无默认 → null；有默认 → 返回 isDefault && enabled 的模型', async () => {
    const { svc, repo } = makeService();
    repo.findOne.mockResolvedValue(null);
    expect(await svc.getDefault('chat', 'u1')).toBeNull();
    // 另一 type（chat 的 null 结果已缓存，不重复查库）
    repo.findOne.mockResolvedValue(
      modelRow({ isDefault: true, type: 'embedding' }),
    );
    const m = await svc.getDefault('embedding', 'u1');
    expect(m).not.toBeNull();
    expect(repo.findOne).toHaveBeenCalledWith({
      where: {
        type: 'embedding',
        isDefault: true,
        enabled: true,
        userId: expect.anything(), // BYOK：无 userId → 全局（IsNull）
      },
    });
  });

  it('getDefault 缓存：命中不查库；setDefault 后直接写入新默认', async () => {
    const { svc, repo, dataSource } = makeService();
    repo.findOne.mockResolvedValue(modelRow({ isDefault: true }));
    await svc.getDefault('chat', 'u1');
    expect(repo.findOne).toHaveBeenCalledTimes(1);
    // 命中缓存：不再查库（结果一致）
    const cached = await svc.getDefault('chat', 'u1');
    expect(repo.findOne).toHaveBeenCalledTimes(1);
    expect(cached?.isDefault).toBe(true);
    // setDefault 成功 → 缓存直接写入新默认（下次 getDefault 不查库）
    const em = {
      findOne: vi
        .fn()
        .mockResolvedValue(modelRow({ type: 'chat', enabled: true })),
      update: vi.fn(async () => ({ affected: 1 })),
      save: vi.fn(async (m: Model) => m),
    };
    dataSource.transaction.mockImplementation(
      async (cb: (e: typeof em) => Promise<unknown>) => cb(em),
    );
    await svc.setDefault('model-1', 'u1', 'member');
    const after = await svc.getDefault('chat', 'u1');
    expect(repo.findOne).toHaveBeenCalledTimes(1); // 仍只查了一次
    expect(after?.isDefault).toBe(true);
  });

  it('getDefault 缓存：update/remove 后失效（下次重新查库）', async () => {
    const { svc, repo } = makeService();
    repo.findOne.mockResolvedValue(modelRow({ isDefault: true }));
    await svc.getDefault('chat', 'u1');
    expect(repo.findOne).toHaveBeenCalledTimes(1);
    // update（requireModel 查一次）→ 缓存失效
    await svc.update('model-1', { name: '改名' }, 'u1', 'member');
    await svc.getDefault('chat', 'u1'); // 失效 → 重新查库（第 3 次）
    expect(repo.findOne).toHaveBeenCalledTimes(3);
    // remove（requireModel 查一次）→ 缓存失效
    await svc.remove('model-1', 'u1', 'member');
    await svc.getDefault('chat', 'u1'); // 失效 → 重新查库（第 5 次）
    // BYOK：getDefault 全局路径每次 findOne 一次；断言 ≥5（update/remove 的
    // requireModel 各一次 + 3 次 getDefault 查询）
    expect(repo.findOne.mock.calls.length).toBeGreaterThanOrEqual(4);
  });

  it('setDefault：disabled 模型 → 400（避免 getDefault 过滤后静默无默认）', async () => {
    const { svc, dataSource } = makeService();
    dataSource.transaction.mockImplementation(
      async (
        cb: (e: {
          findOne: unknown;
          update: unknown;
          save: unknown;
        }) => Promise<unknown>,
      ) =>
        cb({
          findOne: vi.fn().mockResolvedValue(modelRow({ enabled: false })),
          update: vi.fn(),
          save: vi.fn(),
        }),
    );
    await expect(svc.setDefault('model-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('setDefault：事务内「同 type 先清默认 → 目标置默认」', async () => {
    const { svc, dataSource } = makeService();
    const em = {
      findOne: vi.fn().mockResolvedValue(modelRow({ type: 'chat' })),
      update: vi.fn(async () => ({ affected: 1 })),
      save: vi.fn(async (m: Model) => m),
    };
    dataSource.transaction.mockImplementation(
      async (cb: (e: typeof em) => Promise<unknown>) => cb(em),
    );
    const result = await svc.setDefault('model-1', 'u1', 'member');
    expect(em.findOne).toHaveBeenCalledWith(Model, {
      where: { id: 'model-1' },
    });
    expect(em.update).toHaveBeenCalledWith(
      Model,
      { type: 'chat', isDefault: true },
      { isDefault: false },
    );
    expect(em.save).toHaveBeenCalledWith(
      expect.objectContaining({ isDefault: true }),
    );
    expect(result.isDefault).toBe(true);
  });

  it('setDefault：23505 唯一冲突（并发）→ 重试一次收敛', async () => {
    const { svc, dataSource } = makeService();
    let firstAttempt = true;
    dataSource.transaction.mockImplementation(
      async (
        cb: (e: {
          findOne: unknown;
          update: unknown;
          save: unknown;
        }) => Promise<unknown>,
      ) => {
        const em = {
          findOne: vi.fn().mockResolvedValue(modelRow({ type: 'chat' })),
          update: vi.fn(async () => ({ affected: 1 })),
          save: vi.fn(async (m: Model) => m),
        };
        if (firstAttempt) {
          firstAttempt = false;
          // 第一次尝试：并发 setDefault 撞部分唯一索引（type 上 isDefault=true 唯一）
          em.update.mockImplementation(() => {
            const e = new Error(
              'duplicate key value violates unique constraint',
            ) as Error & {
              code: string;
            };
            e.code = '23505';
            throw e;
          });
        }
        return cb(em);
      },
    );
    const result = await svc.setDefault('model-1', 'u1', 'member');
    expect(firstAttempt).toBe(false);
    expect(result.isDefault).toBe(true);
  });

  it('setDefault：模型不存在 → 404', async () => {
    const { svc, dataSource } = makeService();
    dataSource.transaction.mockImplementation(
      async (cb: (e: { findOne: unknown }) => Promise<unknown>) =>
        cb({ findOne: vi.fn().mockResolvedValue(null) }),
    );
    await expect(svc.setDefault('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('remove：默认模型允许删除（设计决策：删除即该 type 无默认）', async () => {
    const { svc, repo } = makeService();
    repo.findOne.mockResolvedValue(modelRow({ isDefault: true }));
    await expect(svc.remove('model-1', 'u1', 'member')).resolves.toBeUndefined();
    expect(repo.delete).toHaveBeenCalledWith('model-1');
  });

  it('remove：模型不存在 → 404', async () => {
    const { svc, repo } = makeService();
    repo.findOne.mockResolvedValue(null);
    await expect(svc.remove('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('testConnection：透传完整连接配置给 getRaw 供应商（不保存）', async () => {
    const { svc, factory } = makeService();
    const rawProvider = {
      testConnection: vi.fn().mockResolvedValue({ ok: true }),
    };
    factory.getRaw.mockReturnValue(rawProvider);
    const config: ProviderConnectionConfig = {
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-raw',
      modelName: 'deepseek-chat',
    };
    const result = await svc.testConnection({
      provider: 'openai-compatible',
      ...config,
    });
    expect(factory.getRaw).toHaveBeenCalledWith('openai-compatible');
    expect(rawProvider.testConnection).toHaveBeenCalledWith(config);
    expect(result).toEqual({ ok: true });
  });

  it('update：传 apiKey → 重新加密；不传 → 保留原密文', async () => {
    const { svc, repo, crypto } = makeService();
    repo.findOne.mockResolvedValue(
      modelRow({ apiKeyEncrypted: 'enc:old-key' }),
    );
    await svc.update('model-1', { apiKey: 'new-key' }, 'u1', 'member');
    expect(crypto.encrypt).toHaveBeenCalledWith('new-key');
    const saved = repo.save.mock.calls[0][0] as Model;
    expect(saved.apiKeyEncrypted).toBe('enc:new-key');

    // 不传 apiKey：保留原密文，不触碰加密
    crypto.encrypt.mockClear();
    repo.findOne.mockResolvedValue(
      modelRow({ apiKeyEncrypted: 'enc:old-key' }),
    );
    await svc.update('model-1', { name: '改名' }, 'u1', 'member');
    expect(crypto.encrypt).not.toHaveBeenCalled();
    // 第二次 save 的入参（第一次是上一段的 new-key 模型）
    expect((repo.save.mock.calls[1][0] as Model).apiKeyEncrypted).toBe(
      'enc:old-key',
    );
  });

  it('update：type 变更 + 本行默认 + 目标 type 已有默认 → 清除本行 isDefault（防 23505）', async () => {
    const { svc, repo } = makeService();
    repo.findOne
      .mockResolvedValueOnce(modelRow({ isDefault: true, type: 'chat' })) // requireModel
      .mockResolvedValueOnce(
        modelRow({ id: 'target-default', isDefault: true, type: 'embedding' }),
      ); // 目标 type 已有默认
    await svc.update('model-1', { type: 'embedding' }, 'u1', 'member');
    const saved = repo.save.mock.calls[0][0] as Model;
    expect(saved.type).toBe('embedding');
    expect(saved.isDefault).toBe(false);
  });

  it('update：type 变更 + 本行默认 + 目标 type 无默认 → 保留 isDefault（继续作新 type 默认）', async () => {
    const { svc, repo } = makeService();
    repo.findOne
      .mockResolvedValueOnce(modelRow({ isDefault: true, type: 'chat' }))
      .mockResolvedValueOnce(null); // 目标 type 无默认
    await svc.update('model-1', { type: 'embedding' }, 'u1', 'member');
    const saved = repo.save.mock.calls[0][0] as Model;
    expect(saved.type).toBe('embedding');
    expect(saved.isDefault).toBe(true);
  });

  it('update：非默认模型改 type → 不查目标默认（isDefault 恒 false 无冲突风险）', async () => {
    const { svc, repo } = makeService();
    repo.findOne.mockResolvedValue(
      modelRow({ isDefault: false, type: 'chat' }),
    );
    await svc.update('model-1', { type: 'embedding' }, 'u1', 'member');
    // 只查过一次（requireModel），未触发目标默认检查
    expect(repo.findOne).toHaveBeenCalledTimes(1);
    expect((repo.save.mock.calls[0][0] as Model).isDefault).toBe(false);
  });
});
