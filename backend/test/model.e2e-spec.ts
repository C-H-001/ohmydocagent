// 模型管理 e2e（Task 2.3）：Model CRUD + API Key 加密存储 + 默认模型唯一性 +
// 连通性测试（mock fetch，不打真实 API）。
// 覆盖：
// - POST /models 新增（provider/baseUrl/modelName/type，201）
// - API Key 加密存储（响应脱敏：无 apiKeyEncrypted 字段 + hasApiKey 布尔；
//   DB 原生查列断言「查不到明文」，密文为 iv:tag:data base64 三段）
// - GET /models 列表（按 type 筛选：chat/embedding/rerank）
// - PUT /models/:id 更新（baseUrl/模型名/启用状态）
// - DELETE /models/:id 删除
// - PUT /models/:id/default 设为默认（每 type 唯一默认——设置新默认时旧默认清除）
// - 删除默认模型语义：允许删除，删除后该 type 无默认（设计决策见 model.service.ts）
// - POST /models/test 连通性测试（body 完整配置，不保存）
// - POST /models/:id/test 已保存模型的连通性测试（成功/失败两种）
// - POST /models/:id/debug 模型调试（固定测试消息，返回生成文本）
// - 非法 provider/type → 400；未登录 → 401
// - SSRF 防护（质量审查整改）：私网/元数据 baseUrl 的连通性测试 → { ok: false }
//   （provider fetch 前 assertSafeBaseUrl 拦截）；ftp:// 等非 http(s) 协议 → 400
//   （DTO @IsUrl）；openai-compatible 缺 baseUrl → 400；停用模型设默认 → 400；
//   改 type 撞目标 type 已有默认 → 自动清除本行默认（不 500）
//
// 说明：本文件用「真实 ModelModule」（不 override 模型服务）——被测对象就是
// 模型管理本身；供应商连通性测试统一 stub 全局 fetch（不打真实 API）。
// DNS mock：SSRF 防护（assertSafeBaseUrl）对域名做 dns.lookup——e2e 环境
// 统一 mock 成公网 IP（真实 DNS 不可靠且 api.example.com 在本机可能挂起），
// 防护逻辑本身在 src/common/ssrf.guard.spec.ts 覆盖。
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { DataSource, Repository } from 'typeorm';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

/** DNS 解析结果的可变持有者：SSRF 防护需要解析域名，统一 mock 公网 IP */
const dnsMock = vi.hoisted(() => ({
  addresses: ['93.184.216.34'],
}));
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () =>
    dnsMock.addresses.map((address) => ({ address, family: 4 })),
  ),
}));
import { configureApp } from '../src/app.setup.js';
import { AppModule } from '../src/app.module.js';
import { Model } from '../src/modules/model/model.entity.js';
import { User } from '../src/modules/users/user.entity.js';
import { RedisService } from '../src/redis/redis.service.js';
import { prepareTestEnv } from './test-db.js';

/** 模型行（含 DB 原生列 apiKeyEncrypted） */
interface ModelRow {
  id: string;
  apiKeyEncrypted: string;
  isDefault: boolean;
  type: string;
}

describe('Model (e2e)', () => {
  let app: INestApplication;
  let server: any;
  let dataSource: DataSource;
  let modelRepo: Repository<Model>;
  const ownerEmail = 'model-owner@ohmydocagent.local';
  let ownerToken = '';
  const testEmails = [ownerEmail];
  const auth = () => ({ Authorization: `Bearer ${ownerToken}` });

  /** stub 全局 fetch：连通性测试返回模拟的 chat 完成响应（不打真实 API） */
  function stubFetchOk(content = 'pong') {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ choices: [{ message: { content } }] }),
        text: async () =>
          JSON.stringify({ choices: [{ message: { content } }] }),
      } as Response),
    );
  }

  /** stub 全局 fetch：返回错误响应 */
  function stubFetchError(status: number, errorMessage: string) {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status,
        statusText: 'Error',
        json: async () => ({ error: { message: errorMessage } }),
        text: async () => JSON.stringify({ error: { message: errorMessage } }),
      } as Response),
    );
  }

  /** 读取 DB 原生行（apiKeyEncrypted 列）——验证「DB 查不到明文」 */
  async function rawRow(id: string): Promise<ModelRow> {
    const rows = await dataSource.query<ModelRow[]>(
      `SELECT id, "apiKeyEncrypted", "isDefault", type FROM models WHERE id = $1`,
      [id],
    );
    return rows[0];
  }

  beforeAll(async () => {
    await prepareTestEnv();
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    dataSource = moduleRef.get(DataSource);
    // 测试隔离（沿用既有模式）：models 无外键，与 users/invitations 一并清空
    await dataSource.query('TRUNCATE TABLE users, invitations, models CASCADE');
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    server = app.getHttpServer();
    modelRepo = dataSource.getRepository(Model);
    // 前置：init 创建 Owner
    const initRes = await request(server).post('/api/v1/auth/init').send({
      email: ownerEmail,
      password: 'Owner123456',
      name: '模型测试所有者',
    });
    expect(initRes.status).toBe(201);
    ownerToken = initRes.body.accessToken as string;
  });

  afterAll(async () => {
    // 清理本文件产生的 rt:* 键（共享 Redis 隔离，沿用既有约定）
    const userRepo = app.get(getRepositoryToken(User));
    const redis = app.get(RedisService);
    const client = redis.getClient();
    for (const email of testEmails) {
      const u = await userRepo.findOne({ where: { email } });
      if (u) {
        const keys = await client.keys(`rt:${u.id}:*`);
        if (keys.length > 0) await client.del(...keys);
      }
    }
    await app.close();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POST /api/v1/models 新增模型（provider/baseUrl/modelName/type，201）', async () => {
    const res = await request(server).post('/api/v1/models').set(auth()).send({
      name: 'DeepSeek V3',
      provider: 'openai-compatible',
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-test',
      modelName: 'deepseek-chat',
      type: 'chat',
    });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.name).toBe('DeepSeek V3');
    expect(res.body.provider).toBe('openai-compatible');
    expect(res.body.modelName).toBe('deepseek-chat');
    expect(res.body.type).toBe('chat');
    expect(res.body.enabled).toBe(true);
  });

  it('POST /api/v1/models API Key 加密存储（响应脱敏，DB 查不到明文）', async () => {
    const plainKey = 'sk-plaintext-秘密密钥-123';
    const res = await request(server).post('/api/v1/models').set(auth()).send({
      name: '加密验证',
      provider: 'openai-compatible',
      baseUrl: 'https://api.example.com',
      apiKey: plainKey,
      modelName: 'gpt-4o-mini',
      type: 'chat',
    });
    expect(res.status).toBe(201);
    // 响应脱敏：不出现明文，也不出现密文列——只有 hasApiKey 布尔
    expect(res.body.apiKeyEncrypted).toBeUndefined();
    expect(res.body.apiKey).toBeUndefined();
    expect(res.body.hasApiKey).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain(plainKey);
    // DB 查不到明文：列值是 iv:tag:data 三段 base64 密文
    const row = await rawRow(res.body.id as string);
    expect(row.apiKeyEncrypted).not.toBe(plainKey);
    expect(row.apiKeyEncrypted).not.toContain(plainKey);
    expect(row.apiKeyEncrypted).toMatch(
      /^[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/,
    );
  });

  it('GET /api/v1/models 列表（按 type 筛选：chat/embedding/rerank）', async () => {
    // 追加 embedding 与 rerank 模型（chat 已在上一用例创建）
    await request(server).post('/api/v1/models').set(auth()).send({
      name: '嵌入模型',
      provider: 'openai-compatible',
      baseUrl: 'https://api.example.com',
      modelName: 'text-embedding-3-small',
      type: 'embedding',
    });
    await request(server).post('/api/v1/models').set(auth()).send({
      name: '重排模型',
      provider: 'openai-compatible',
      baseUrl: 'https://api.example.com',
      modelName: 'rerank-model',
      type: 'rerank',
    });
    // 全量列表
    const all = await request(server).get('/api/v1/models').set(auth());
    expect(all.status).toBe(200);
    expect(Array.isArray(all.body)).toBe(true);
    expect(all.body.length).toBeGreaterThanOrEqual(3);
    // type 筛选
    const chats = await request(server)
      .get('/api/v1/models?type=chat')
      .set(auth());
    expect(chats.status).toBe(200);
    expect(chats.body.length).toBeGreaterThanOrEqual(1);
    for (const m of chats.body) {
      expect(m.type).toBe('chat');
      // 列表同样脱敏
      expect(m.apiKeyEncrypted).toBeUndefined();
    }
    const embeds = await request(server)
      .get('/api/v1/models?type=embedding')
      .set(auth());
    expect(embeds.body.length).toBeGreaterThanOrEqual(1);
    for (const m of embeds.body) {
      expect(m.type).toBe('embedding');
    }
    // 非法 type 筛选 → 400
    const bad = await request(server)
      .get('/api/v1/models?type=foo')
      .set(auth());
    expect(bad.status).toBe(400);
  });

  it('PUT /api/v1/models/:id 更新（改 baseUrl/模型名/启用状态）', async () => {
    const created = await request(server)
      .post('/api/v1/models')
      .set(auth())
      .send({
        name: '待更新',
        provider: 'openai-compatible',
        baseUrl: 'https://api.old.com',
        modelName: 'old-model',
        type: 'chat',
      });
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    const res = await request(server)
      .put(`/api/v1/models/${id}`)
      .set(auth())
      .send({
        name: '已更新模型',
        baseUrl: 'https://api.new.com',
        modelName: 'new-model',
        enabled: false,
      });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('已更新模型');
    expect(res.body.baseUrl).toBe('https://api.new.com');
    expect(res.body.modelName).toBe('new-model');
    expect(res.body.enabled).toBe(false);
    // 详情与更新响应一致（脱敏）
    const detail = await request(server)
      .get(`/api/v1/models/${id}`)
      .set(auth());
    expect(detail.status).toBe(200);
    expect(detail.body.baseUrl).toBe('https://api.new.com');
    expect(detail.body.apiKeyEncrypted).toBeUndefined();
  });

  it('DELETE /api/v1/models/:id 删除（204；再查 404）', async () => {
    const created = await request(server)
      .post('/api/v1/models')
      .set(auth())
      .send({
        name: '待删除',
        provider: 'ollama',
        baseUrl: 'http://127.0.0.1:11434',
        modelName: 'qwen2.5:7b',
        type: 'chat',
      });
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    const del = await request(server)
      .delete(`/api/v1/models/${id}`)
      .set(auth());
    expect(del.status).toBe(204);
    const detail = await request(server)
      .get(`/api/v1/models/${id}`)
      .set(auth());
    expect(detail.status).toBe(404);
  });

  it('PUT /api/v1/models/:id/default 设为默认（每 type 唯一默认——设置新默认时旧默认清除）', async () => {
    const a = await request(server).post('/api/v1/models').set(auth()).send({
      name: '默认 A',
      provider: 'openai-compatible',
      baseUrl: 'https://api.example.com',
      modelName: 'model-a',
      type: 'chat',
    });
    const b = await request(server).post('/api/v1/models').set(auth()).send({
      name: '默认 B',
      provider: 'openai-compatible',
      baseUrl: 'https://api.example.com',
      modelName: 'model-b',
      type: 'chat',
    });
    const idA = a.body.id as string;
    const idB = b.body.id as string;
    // A 设为默认
    const setA = await request(server)
      .put(`/api/v1/models/${idA}/default`)
      .set(auth());
    expect(setA.status).toBe(200);
    expect(setA.body.isDefault).toBe(true);
    // B 设为默认 → A 的默认被清除（每 type 唯一）
    const setB = await request(server)
      .put(`/api/v1/models/${idB}/default`)
      .set(auth());
    expect(setB.status).toBe(200);
    expect(setB.body.isDefault).toBe(true);
    const rowA = await rawRow(idA);
    const rowB = await rawRow(idB);
    expect(rowA.isDefault).toBe(false);
    expect(rowB.isDefault).toBe(true);
    // 全库该 type 恰一个默认（部分唯一索引 + 事务语义）
    const defaults = await dataSource.query<Array<{ count: string }>>(
      `SELECT count(*) AS count FROM models WHERE type = 'chat' AND "isDefault" = true`,
    );
    expect(Number(defaults[0].count)).toBe(1);
  });

  it('删除默认模型：允许删除，删除后该 type 无默认（设计：删除即清默认标记）', async () => {
    // 复用上一用例的默认模型 B 删除 → chat type 无默认
    const chats = await request(server)
      .get('/api/v1/models?type=chat')
      .set(auth());
    const defaultChat = chats.body.find(
      (m: { isDefault: boolean }) => m.isDefault,
    );
    expect(defaultChat).toBeDefined();
    const del = await request(server)
      .delete(`/api/v1/models/${defaultChat.id}`)
      .set(auth());
    expect(del.status).toBe(204);
    const defaults = await dataSource.query<Array<{ count: string }>>(
      `SELECT count(*) AS count FROM models WHERE type = 'chat' AND "isDefault" = true`,
    );
    expect(Number(defaults[0].count)).toBe(0);
  });

  it('POST /api/v1/models/test 连通性测试（body 完整配置，不保存；mock provider 返回 ok）', async () => {
    stubFetchOk();
    const before = await modelRepo.count();
    const res = await request(server)
      .post('/api/v1/models/test')
      .set(auth())
      .send({
        provider: 'openai-compatible',
        baseUrl: 'https://api.example.com',
        apiKey: 'sk-unsaved',
        modelName: 'deepseek-chat',
      });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ ok: true });
    // 不保存：表行数不变（连通性测试只探活，不落库）
    const after = await modelRepo.count();
    expect(after).toBe(before);
  });

  it('POST /api/v1/models/:id/test 已保存模型的连通性测试（成功 + 失败两种）', async () => {
    const created = await request(server)
      .post('/api/v1/models')
      .set(auth())
      .send({
        name: '连通测试',
        provider: 'openai-compatible',
        baseUrl: 'https://api.example.com',
        apiKey: 'sk-saved',
        modelName: 'deepseek-chat',
        type: 'chat',
      });
    const id = created.body.id as string;
    // 成功：mock 2xx
    stubFetchOk();
    const ok = await request(server)
      .post(`/api/v1/models/${id}/test`)
      .set(auth());
    expect(ok.status).toBe(201);
    expect(ok.body).toEqual({ ok: true });
    // 失败：mock 401 → { ok: false, error }
    stubFetchError(401, 'Invalid API key provided');
    const fail = await request(server)
      .post(`/api/v1/models/${id}/test`)
      .set(auth());
    expect(fail.status).toBe(201);
    expect(fail.body.ok).toBe(false);
    expect(fail.body.error).toMatch(/Invalid API key/);
  });

  it('POST /api/v1/models/:id/debug 模型调试（固定测试消息，返回生成文本）', async () => {
    const created = await request(server)
      .post('/api/v1/models')
      .set(auth())
      .send({
        name: '调试模型',
        provider: 'openai-compatible',
        baseUrl: 'https://api.example.com',
        apiKey: 'sk-debug',
        modelName: 'deepseek-chat',
        type: 'chat',
      });
    const id = created.body.id as string;
    stubFetchOk('你好，我是调试回复');
    const res = await request(server)
      .post(`/api/v1/models/${id}/debug`)
      .set(auth());
    expect(res.status).toBe(201);
    expect(res.body.output).toBe('你好，我是调试回复');
  });

  it('POST /api/v1/models 非法 provider 400；type 枚举 400；缺必填字段 400', async () => {
    const badProvider = await request(server)
      .post('/api/v1/models')
      .set(auth())
      .send({
        name: '非法供应商',
        provider: 'anthropic',
        baseUrl: 'https://x',
        modelName: 'claude',
      });
    expect(badProvider.status).toBe(400);
    const badType = await request(server)
      .post('/api/v1/models')
      .set(auth())
      .send({
        name: '非法类型',
        provider: 'openai-compatible',
        baseUrl: 'https://x',
        modelName: 'm',
        type: 'vision',
      });
    expect(badType.status).toBe(400);
    const missingName = await request(server)
      .post('/api/v1/models')
      .set(auth())
      .send({ provider: 'openai-compatible', modelName: 'm' });
    expect(missingName.status).toBe(400);
    const missingModelName = await request(server)
      .post('/api/v1/models')
      .set(auth())
      .send({ name: '缺模型名', provider: 'openai-compatible' });
    expect(missingModelName.status).toBe(400);
  });

  it('POST /api/v1/models 非法协议 baseUrl（ftp://）→ 400（DTO @IsUrl 校验）', async () => {
    const res = await request(server).post('/api/v1/models').set(auth()).send({
      name: '非法协议',
      provider: 'openai-compatible',
      baseUrl: 'ftp://files.example.com',
      modelName: 'm',
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body.message)).toMatch(/http\/https/);
  });

  it('POST /api/v1/models openai-compatible 缺 baseUrl → 400（服务层必填，配合 DTO IsUrl）', async () => {
    const res = await request(server).post('/api/v1/models').set(auth()).send({
      name: '缺 baseUrl',
      provider: 'openai-compatible',
      modelName: 'm',
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body.message)).toMatch(/必须配置 baseUrl/);
  });

  it('POST /api/v1/models/test SSRF 防护：私网/元数据 baseUrl → { ok: false }（不发起请求）', async () => {
    const res = await request(server)
      .post('/api/v1/models/test')
      .set(auth())
      .send({
        provider: 'openai-compatible',
        baseUrl: 'http://169.254.169.254/latest/meta-data/',
        apiKey: '',
        modelName: 'm',
      });
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/SSRF 防护/);
  });

  it('PUT /api/v1/models/:id/default 停用模型设为默认 → 400（先启用，避免静默无默认）', async () => {
    const created = await request(server)
      .post('/api/v1/models')
      .set(auth())
      .send({
        name: '停用模型',
        provider: 'openai-compatible',
        baseUrl: 'https://api.example.com',
        modelName: 'm',
        type: 'chat',
        enabled: false,
      });
    expect(created.status).toBe(201);
    const res = await request(server)
      .put(`/api/v1/models/${created.body.id}/default`)
      .set(auth());
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body.message)).toMatch(/先启用/);
    // 未落默认：DB 该模型 isDefault=false
    const row = await rawRow(created.body.id as string);
    expect(row.isDefault).toBe(false);
  });

  it('PUT /api/v1/models/:id 改 type 撞目标 type 已有默认 → 自动清除本行默认（不 500）', async () => {
    const chatDefault = await request(server)
      .post('/api/v1/models')
      .set(auth())
      .send({
        name: 'chat 默认',
        provider: 'openai-compatible',
        baseUrl: 'https://api.example.com',
        modelName: 'm-chat',
        type: 'chat',
      });
    const embDefault = await request(server)
      .post('/api/v1/models')
      .set(auth())
      .send({
        name: 'embed 默认',
        provider: 'openai-compatible',
        baseUrl: 'https://api.example.com',
        modelName: 'm-emb',
        type: 'embedding',
      });
    const setChat = await request(server)
      .put(`/api/v1/models/${chatDefault.body.id}/default`)
      .set(auth());
    expect(setChat.status).toBe(200);
    const setEmb = await request(server)
      .put(`/api/v1/models/${embDefault.body.id}/default`)
      .set(auth());
    expect(setEmb.status).toBe(200);
    // chat 默认改 type → embedding（该 type 已有默认）→ 200 且本行默认被清除
    const moved = await request(server)
      .put(`/api/v1/models/${chatDefault.body.id}`)
      .set(auth())
      .send({ type: 'embedding' });
    expect(moved.status).toBe(200);
    expect(moved.body.type).toBe('embedding');
    expect(moved.body.isDefault).toBe(false);
    const rowMoved = await rawRow(chatDefault.body.id as string);
    expect(rowMoved.isDefault).toBe(false);
    // embedding 默认仍是原默认（未被挤掉）
    const rowEmb = await rawRow(embDefault.body.id as string);
    expect(rowEmb.isDefault).toBe(true);
    // 全库 embedding type 恰一个默认（部分唯一索引约束不破）
    const defaults = await dataSource.query<Array<{ count: string }>>(
      `SELECT count(*) AS count FROM models WHERE type = 'embedding' AND "isDefault" = true`,
    );
    expect(Number(defaults[0].count)).toBe(1);
  });

  it('未登录 401（列表/详情/创建全拦截）', async () => {
    const list = await request(server).get('/api/v1/models');
    expect(list.status).toBe(401);
    const detail = await request(server).get(
      '/api/v1/models/00000000-0000-4000-8000-000000000000',
    );
    expect(detail.status).toBe(401);
    const create = await request(server)
      .post('/api/v1/models')
      .send({ name: 'x', provider: 'openai-compatible', modelName: 'm' });
    expect(create.status).toBe(401);
  });
});
