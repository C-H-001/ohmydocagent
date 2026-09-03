// 知识库 CRUD e2e（Task 1.1）：
// 创建（默认 type=document）/分页列表（当前用户视角 pinned）/详情/更新/删除、
// 用户级置顶开关（toggle 语义 + 当前用户维度隔离）、复制（配置复制 + 副本独立性）、
// 删除后置顶记录同步清理（UserKbPin 无残留）。
// 说明：本文件不依赖「测试库无用户」来判定初始化状态之外的全局状态，
// 但仍沿用既有约定：beforeAll 显式 TRUNCATE 全部相关表（含本任务新增的
// knowledge_bases / user_kb_pins，先清子表再清主表），保证与其它 e2e 文件互不污染。
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { prepareTestEnv } from './test-db.js';
import { configureApp } from '../src/app.setup.js';
import { User } from '../src/modules/users/user.entity.js';
import { UserKbPin } from '../src/modules/kb/user-kb-pin.entity.js';
import { RedisService } from '../src/redis/redis.service.js';

describe('KnowledgeBase (e2e)', () => {
  let app: INestApplication;
  let server: any;
  let dataSource: DataSource;
  const ownerEmail = 'kb-owner@ohmydocagent.local';
  let ownerToken = '';
  // 备用 admin（公开 register 默认角色 admin）：验证「任何登录用户都可建库」
  // 与置顶的用户维度隔离（admin 的置顶不影响 owner 视角，反之亦然）
  const adminEmail = 'kb-admin@ohmydocagent.local';
  let adminToken = '';
  // 本文件创建的用户邮箱：afterAll 统一清理其 rt:* 键（共享 Redis 隔离，沿用既有约定）
  const testEmails = [ownerEmail, adminEmail];
  // 首个用例创建的知识库：后续详情/更新/置顶/复制用例复用（避免用例间重新查询耦合）
  let kbId1 = '';
  let kb1Name = '研发知识库';
  // kbId1 的分块配置：创建时显式传入，复制用例断言「配置被复制」
  const kb1Chunking = { chunkSize: 800, chunkOverlap: 100 };
  // 复制用例产生的副本 id：独立性用例复用
  let duplicateId = '';

  beforeAll(async () => {
    await prepareTestEnv();
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    // 测试隔离（沿用 auth-init/invitations 模式）：
    // users/invitations 清空以初始化 Owner；本任务新增 knowledge_bases /
    // user_kb_pins 必须显式列入清单（先清子表 user_kb_pins 再清主表 knowledge_bases），
    // 避免 CASCADE 静默清空外键相关表造成隐性隔离失效。
    dataSource = moduleRef.get(DataSource);
    await dataSource.query(
      'TRUNCATE TABLE users, invitations, user_kb_pins, knowledge_bases CASCADE',
    );
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    server = app.getHttpServer();
    // 前置：init 创建 Owner（全局守卫要求所有 KB 路由登录）
    const initRes = await request(server).post('/api/v1/auth/init').send({
      email: ownerEmail,
      password: 'Owner123456',
      name: '知识库测试所有者',
    });
    expect(initRes.status).toBe(201);
    ownerToken = initRes.body.accessToken as string;
    // 前置：公开注册一个普通 admin（默认角色 admin，见 AuthService.register）
    const regRes = await request(server).post('/api/v1/auth/register').send({
      email: adminEmail,
      password: 'Admin123456',
      name: '知识库测试管理员',
    });
    expect(regRes.status).toBe(201);
    adminToken = regRes.body.accessToken as string;
  });

  afterAll(async () => {
    // 清理本文件产生的 rt:* 键（init/register 成功签发了 refresh token；
    // Redis 为共享实例，按测试用户 id 扫描删除，避免污染开发会话）
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

  /** 助手：以指定 token 创建知识库 */
  function createKb(token: string, body: Record<string, unknown>) {
    return request(server)
      .post('/api/v1/kbs')
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  }

  it('POST /api/v1/kbs 创建知识库（默认 type=document，201）', async () => {
    const res = await createKb(ownerToken, {
      name: kb1Name,
      description: '产品与研发文档',
      chunkingConfig: kb1Chunking,
    });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.name).toBe(kb1Name);
    expect(res.body.description).toBe('产品与研发文档');
    expect(res.body.type).toBe('document');
    expect(res.body.creatorId).toBeDefined();
    // 显式传入的分块配置原样保存；embeddingModelId P1 未选模型 → null
    expect(res.body.chunkingConfig).toEqual(kb1Chunking);
    expect(res.body.embeddingModelId).toBeNull();
    kbId1 = res.body.id as string;
  });

  it('POST /api/v1/kbs 未登录返回 401', async () => {
    const res = await request(server)
      .post('/api/v1/kbs')
      .send({ name: '匿名知识库' });
    expect(res.status).toBe(401);
  });

  it('POST /api/v1/kbs 空名称返回 400', async () => {
    const empty = await createKb(ownerToken, { name: '' });
    expect(empty.status).toBe(400);
    const missing = await createKb(ownerToken, {});
    expect(missing.status).toBe(400);
  });

  it('POST /api/v1/kbs 纯空白名称返回 400', async () => {
    // 质量审查项：IsNotEmpty 拦不住纯空格（'   '），\S 匹配保证名称至少含一个非空白字符
    const blank = await createKb(ownerToken, { name: '   ' });
    expect(blank.status).toBe(400);
  });

  it('GET /api/v1/kbs 列表（分页，含 pinned 字段）', async () => {
    const res = await request(server)
      .get('/api/v1/kbs?page=1&pageSize=10')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.page).toBe(1);
    expect(res.body.pageSize).toBe(10);
    expect(res.body.total).toBeGreaterThanOrEqual(1);
    const item = res.body.items.find((i: any) => i.id === kbId1);
    expect(item).toBeDefined();
    // 当前用户视角：刚创建未置顶 → pinned=false
    expect(item.pinned).toBe(false);
    expect(item.creatorId).toBeDefined();
  });

  it('GET /api/v1/kbs/:id 详情', async () => {
    const res = await request(server)
      .get(`/api/v1/kbs/${kbId1}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(kbId1);
    expect(res.body.name).toBe(kb1Name);
    expect(res.body.type).toBe('document');
  });

  it('PUT /api/v1/kbs/:id 更新名称/描述（200）', async () => {
    kb1Name = '研发知识库-已改名';
    const res = await request(server)
      .put(`/api/v1/kbs/${kbId1}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: kb1Name, description: '更新后的描述' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe(kb1Name);
    expect(res.body.description).toBe('更新后的描述');
    // 未传 chunkingConfig：保持原值（只更新传入字段的语义）
    expect(res.body.chunkingConfig).toEqual(kb1Chunking);
  });

  it('PUT /api/v1/kbs/:id 不存在返回 404', async () => {
    const res = await request(server)
      .put('/api/v1/kbs/00000000-0000-4000-8000-000000000000')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: '不存在' });
    expect(res.status).toBe(404);
  });

  it('GET/PUT/DELETE/pin/duplicate：非 UUID 格式 id 一律 404（不泄露 500）', async () => {
    // 非 UUID 撞 PG 22P02，服务层统一转 404（见 KbService.getById 注释）
    const get = await request(server)
      .get('/api/v1/kbs/not-a-uuid')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(get.status).toBe(404);
    const put = await request(server)
      .put('/api/v1/kbs/not-a-uuid')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: '改名' });
    expect(put.status).toBe(404);
    const del = await request(server)
      .delete('/api/v1/kbs/not-a-uuid')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(del.status).toBe(404);
    const pin = await request(server)
      .put('/api/v1/kbs/not-a-uuid/pin')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(pin.status).toBe(404);
    const dup = await request(server)
      .post('/api/v1/kbs/not-a-uuid/duplicate')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(dup.status).toBe(404);
  });

  it('DELETE /api/v1/kbs/:id 删除（204）', async () => {
    const created = await createKb(ownerToken, { name: '待删除知识库' });
    expect(created.status).toBe(201);
    const res = await request(server)
      .delete(`/api/v1/kbs/${created.body.id}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(204);
  });

  it('DELETE /api/v1/kbs/:id 后 GET 详情 404', async () => {
    const created = await createKb(ownerToken, { name: '删后即查' });
    expect(created.status).toBe(201);
    const del = await request(server)
      .delete(`/api/v1/kbs/${created.body.id}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(del.status).toBe(204);
    const res = await request(server)
      .get(`/api/v1/kbs/${created.body.id}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(404);
  });

  it('PUT /api/v1/kbs/:id/pin 置顶（当前用户维度，200）', async () => {
    const res = await request(server)
      .put(`/api/v1/kbs/${kbId1}/pin`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.pinned).toBe(true);
    // 用户维度隔离：owner 置顶后，admin 视角该 KB 仍为未置顶
    const adminList = await request(server)
      .get('/api/v1/kbs')
      .set('Authorization', `Bearer ${adminToken}`);
    const adminView = adminList.body.items.find((i: any) => i.id === kbId1);
    expect(adminView.pinned).toBe(false);
  });

  it('PUT /api/v1/kbs/:id/pin 再调取消置顶（toggle 语义，200）', async () => {
    const res = await request(server)
      .put(`/api/v1/kbs/${kbId1}/pin`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.pinned).toBe(false);
  });

  it('GET /api/v1/kbs 置顶的知识库排在最前（列表断言 pinned=true 在前）', async () => {
    // 重新置顶 kbId1，再新建一个对照库：无论谁更新更晚，置顶的必须排最前
    const pinRes = await request(server)
      .put(`/api/v1/kbs/${kbId1}/pin`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(pinRes.status).toBe(200);
    expect(pinRes.body.pinned).toBe(true);
    const newer = await createKb(ownerToken, { name: '排序对照库' });
    expect(newer.status).toBe(201);
    const res = await request(server)
      .get('/api/v1/kbs?page=1&pageSize=20')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    const first = res.body.items[0];
    expect(first.id).toBe(kbId1);
    expect(first.pinned).toBe(true);
    // 其余项均为未置顶（本文件仅 owner 置顶过 kbId1）
    for (const item of res.body.items.slice(1)) {
      expect(item.pinned).toBe(false);
    }
  });

  it('POST /api/v1/kbs/:id/duplicate 复制知识库（新 KB 名称带「副本」后缀，配置复制）', async () => {
    const res = await request(server)
      .post(`/api/v1/kbs/${kbId1}/duplicate`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(201);
    expect(res.body.id).not.toBe(kbId1);
    expect(res.body.name).toBe(`${kb1Name} 副本`);
    expect(res.body.description).toBe('更新后的描述');
    // 配置复制：chunkingConfig 深拷贝（值相等且与原件独立）
    expect(res.body.chunkingConfig).toEqual(kb1Chunking);
    duplicateId = res.body.id as string;
  });

  it('POST /api/v1/kbs/:id/duplicate 后原 KB 与副本独立（改副本名称不影响原）', async () => {
    const renamed = await request(server)
      .put(`/api/v1/kbs/${duplicateId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: '副本-独立改名' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.name).toBe('副本-独立改名');
    const original = await request(server)
      .get(`/api/v1/kbs/${kbId1}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(original.status).toBe(200);
    expect(original.body.name).toBe(kb1Name);
  });

  it('DELETE /api/v1/kbs/:id 删除后置顶记录同步清理（UserKbPin 无残留）', async () => {
    // kbId1 当前处于置顶状态（排序用例重新置顶后未取消）
    const pinRepo = app.get(getRepositoryToken(UserKbPin));
    const before = await pinRepo.find({ where: { kbId: kbId1 } });
    expect(before.length).toBeGreaterThanOrEqual(1);
    const del = await request(server)
      .delete(`/api/v1/kbs/${kbId1}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(del.status).toBe(204);
    const after = await pinRepo.find({ where: { kbId: kbId1 } });
    expect(after).toHaveLength(0);
    // 删除后详情 404（硬删除语义）
    const res = await request(server)
      .get(`/api/v1/kbs/${kbId1}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(404);
  });

  it('PUT /api/v1/kbs/:id/pin 不存在的知识库返回 404', async () => {
    const res = await request(server)
      .put('/api/v1/kbs/00000000-0000-4000-8000-000000000000/pin')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(404);
  });
});
