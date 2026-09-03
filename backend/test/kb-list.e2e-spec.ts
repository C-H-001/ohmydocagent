// 知识库列表聚合 e2e（Task 1.10）：
// - 视图筛选 view=all|mine|favorite|recent（非法 400）
// - 收藏 PUT /kbs/:id/favorite（toggle，与 pin 同形态）+ 用户维度隔离
// - 最近访问 GET /kbs/:id 详情时自动记录（visitedAt upsert，同用户同 KB 仅一条）
// - 统计 GET /kbs/stats（totalKbs/mine/favorite/totalDocs/totalChunks）
// - 列表项丰富化：docCount（knowledge 计数）/ chunkCount（chunks 计数）/
//   pinned/favorite 当前用户视角字段
// - Task 1.1 回归：置顶分组在 view=all 下仍生效（pinned 排最前）
// 前置：KB-A/KB-B（owner 创建）、KB-C（admin 创建，区分 view=mine）；KB-A 上传
// 1 个 md 文档并等解析分块完成（用于 docCount/chunkCount 计数断言）。
// 说明：沿用既有约定 beforeAll 显式 TRUNCATE 全部相关表——本任务新增
// user_kb_favorites / user_kb_recents 必须显式列入清单（先于 knowledge_bases，
// 先清子表再清主表），避免 CASCADE 静默清空造成隐性隔离失效。
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { DataSource, Repository } from 'typeorm';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { AppModule } from '../src/app.module.js';
import { withMockModels } from './mock-model-overrides.js';
import { prepareTestEnv } from './test-db.js';
import { configureApp } from '../src/app.setup.js';
import { waitFor } from './wait-for.js';
import { User } from '../src/modules/users/user.entity.js';
import { Knowledge } from '../src/modules/knowledge/knowledge.entity.js';
import { UserKbFavorite } from '../src/modules/kb/user-kb-favorite.entity.js';
import { UserKbRecent } from '../src/modules/kb/user-kb-recent.entity.js';
import { RedisService } from '../src/redis/redis.service.js';

describe('KB 列表聚合 (e2e)', () => {
  let app: INestApplication;
  let server: any;
  let dataSource: DataSource;
  let favoriteRepo: Repository<UserKbFavorite>;
  let recentRepo: Repository<UserKbRecent>;
  let knowledgeRepo: Repository<Knowledge>;
  const ownerEmail = 'kb-list-owner@ohmydocagent.local';
  let ownerToken = '';
  let ownerId = '';
  const adminEmail = 'kb-list-admin@ohmydocagent.local';
  let adminToken = '';
  // 本文件创建的邮箱：afterAll 统一清理其 rt:* 键（共享 Redis 隔离，沿用既有约定）
  const testEmails = [ownerEmail, adminEmail];
  // 三个知识库：KB-A/KB-B 归 owner，KB-C 归 admin（区分 view=mine）
  let kbAId = '';
  let kbBId = '';
  let kbCId = '';
  // 创建成功后才 push 的 KB id 清单（与 chunk.e2e/knowledge.e2e 同款）：
  // afterAll 只清理已成功创建的 uploads 子目录，杜绝 beforeAll 中途失败时
  // （kbAId 仍为空串）误删整个 uploads 目录
  const kbIds: string[] = [];
  /** md 上传内容：多段文本保证默认分块配置下至少产生 1 个分块 */
  const mdContent = [
    '# 知识库列表聚合测试文档',
    '',
    '这是第一段内容，用于验证 docCount 与 chunkCount 聚合计数。',
    'OhMyDocAgent 知识库列表聚合 API 覆盖收藏、最近访问与视图筛选。',
    '',
    '## 第二节',
    '',
    '第二段文本确保文本长度足以触发默认分块逻辑产生至少一个分块。',
    '聚合查询按 kbId 分组统计文档数与分块数，避免 N+1 次查询。',
  ].join('\n');

  /** 上传助手：multipart 内存 buffer + 文件名 */
  function uploadFile(
    kbId: string,
    filename: string,
    buffer: Buffer,
    token = ownerToken,
  ) {
    return request(server)
      .post(`/api/v1/kbs/${kbId}/file`)
      .set('Authorization', `Bearer ${token}`)
      .attach('file', buffer, { filename });
  }

  /** 创建知识库助手 */
  function createKb(token: string, name: string) {
    return request(server)
      .post('/api/v1/kbs')
      .set('Authorization', `Bearer ${token}`)
      .send({ name });
  }

  beforeAll(async () => {
    await prepareTestEnv();
    const moduleRef = await withMockModels(
      Test.createTestingModule({
        imports: [AppModule],
      }),
    ).compile();
    dataSource = moduleRef.get(DataSource);
    // 测试隔离：本任务新增 user_kb_favorites / user_kb_recents 必须显式列入
    // 清单（先于 knowledge_bases，先清子表再清主表）
    await dataSource.query(
      'TRUNCATE TABLE users, invitations, user_kb_pins, user_kb_favorites, user_kb_recents, knowledge, chunk_revisions, chunks, knowledge_bases CASCADE',
    );
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    server = app.getHttpServer();
    favoriteRepo = app.get(getRepositoryToken(UserKbFavorite));
    recentRepo = app.get(getRepositoryToken(UserKbRecent));
    knowledgeRepo = app.get(getRepositoryToken(Knowledge));
    // 前置：init 创建 Owner + 注册一个 admin（角色隔离：C 库归 admin）
    const initRes = await request(server).post('/api/v1/auth/init').send({
      email: ownerEmail,
      password: 'Owner123456',
      name: '列表聚合测试所有者',
    });
    expect(initRes.status).toBe(201);
    ownerToken = initRes.body.accessToken as string;
    ownerId = initRes.body.user.id as string;
    const regRes = await request(server).post('/api/v1/auth/register').send({
      email: adminEmail,
      password: 'Admin123456',
      name: '列表聚合测试管理员',
    });
    expect(regRes.status).toBe(201);
    adminToken = regRes.body.accessToken as string;
    // 前置：三个知识库 + KB-A 上传一个 md 文档并等解析分块完成
    const a = await createKb(ownerToken, '列表聚合 A 库');
    expect(a.status).toBe(201);
    kbAId = a.body.id as string;
    kbIds.push(kbAId);
    const b = await createKb(ownerToken, '列表聚合 B 库');
    expect(b.status).toBe(201);
    kbBId = b.body.id as string;
    kbIds.push(kbBId);
    const c = await createKb(adminToken, '列表聚合 C 库');
    expect(c.status).toBe(201);
    kbCId = c.body.id as string;
    kbIds.push(kbCId);
    const up = await uploadFile(kbAId, '聚合计数.md', Buffer.from(mdContent));
    expect(up.status).toBe(201);
    const docId = up.body.id as string;
    // 等队列处理完成：status=ready 且分块已产生（chunkCount>0 由解析管线写入）
    await waitFor(
      async () => {
        const k = await knowledgeRepo.findOne({ where: { id: docId } });
        return k !== null && k.status === 'ready' && k.chunkCount > 0;
      },
      { description: 'KB-A 文档解析分块完成（ready + chunkCount>0）' },
    );
  });

  afterAll(async () => {
    // 清理本文件创建的 KB 上传目录（uploads/{kbId}，不动开发数据）：
    // 只遍历创建成功后才入列的 kbIds，空数组时不做任何删除
    for (const id of kbIds) {
      await rm(path.join(process.cwd(), 'uploads', id), {
        recursive: true,
        force: true,
      }).catch(() => undefined);
    }
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

  it('GET /api/v1/kbs?view=all 全部（分页，三个库都在且带丰富化字段）', async () => {
    const res = await request(server)
      .get('/api/v1/kbs?view=all&page=1&pageSize=10')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    const ids = res.body.items.map((i: any) => i.id);
    expect(ids).toContain(kbAId);
    expect(ids).toContain(kbBId);
    expect(ids).toContain(kbCId);
    // 丰富化字段：每个列表项都带 pinned/favorite/docCount/chunkCount
    for (const item of res.body.items) {
      expect(typeof item.pinned).toBe('boolean');
      expect(typeof item.favorite).toBe('boolean');
      expect(typeof item.docCount).toBe('number');
      expect(typeof item.chunkCount).toBe('number');
    }
  });

  it('GET /api/v1/kbs?view=mine 我创建的（creatorId=当前用户）', async () => {
    const res = await request(server)
      .get('/api/v1/kbs?view=mine')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    // owner 只创建了 A/B；C 是 admin 创建，不出现在 mine 视图
    const ids = res.body.items.map((i: any) => i.id);
    expect(ids).toContain(kbAId);
    expect(ids).toContain(kbBId);
    expect(ids).not.toContain(kbCId);
    expect(res.body.total).toBe(2);
    for (const item of res.body.items) {
      expect(item.creatorId).toBe(res.body.items[0].creatorId);
    }
  });

  it('PUT /api/v1/kbs/:id/favorite 收藏开关（toggle，与 pin 同形态）', async () => {
    // 未收藏 → 收藏
    const on = await request(server)
      .put(`/api/v1/kbs/${kbAId}/favorite`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(on.status).toBe(200);
    expect(on.body.favorite).toBe(true);
    // 再调 → 取消收藏（toggle 语义）
    const off = await request(server)
      .put(`/api/v1/kbs/${kbAId}/favorite`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(off.status).toBe(200);
    expect(off.body.favorite).toBe(false);
    // 第三次 → 重新收藏（留态：后续 favorite 视图/统计用例依赖 A 处于收藏态）
    const re = await request(server)
      .put(`/api/v1/kbs/${kbAId}/favorite`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(re.status).toBe(200);
    expect(re.body.favorite).toBe(true);
    // 用户维度隔离：admin 收藏 C 不影响 owner 的 favorite 视角
    const adminFav = await request(server)
      .put(`/api/v1/kbs/${kbCId}/favorite`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(adminFav.status).toBe(200);
    expect(adminFav.body.favorite).toBe(true);
    // 落库校验：owner 收藏记录只有 A 一条
    const ownerRows = await favoriteRepo.find({ where: { userId: ownerId } });
    expect(ownerRows.map((r) => r.kbId)).toEqual([kbAId]);
  });

  it('GET /api/v1/kbs?view=favorite 收藏的（仅当前用户收藏的 KB）', async () => {
    const res = await request(server)
      .get('/api/v1/kbs?view=favorite')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    // owner 只收藏了 A；B/C 不在 favorite 视图（C 是 admin 收藏的，与 owner 隔离）
    const ids = res.body.items.map((i: any) => i.id);
    expect(ids).toEqual([kbAId]);
    expect(res.body.total).toBe(1);
  });

  it('GET /api/v1/kbs/:id 访问 KB 详情后出现在 recent（自动记录访问时间）', async () => {
    const res = await request(server)
      .get(`/api/v1/kbs/${kbAId}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    // 详情访问触发 recordVisit：user_kb_recents 落一条 (owner, A) 记录
    const rows = await recentRepo.find({ where: { userId: ownerId } });
    const hit = rows.find((r) => r.kbId === kbAId);
    expect(hit).toBeDefined();
    expect(hit!.visitedAt).toBeInstanceOf(Date);
    // 用户维度隔离：admin 访问 C 不会给 owner 的 recent 增加记录
    await request(server)
      .get(`/api/v1/kbs/${kbCId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    const ownerRows = await recentRepo.find({ where: { userId: ownerId } });
    expect(ownerRows.find((r) => r.kbId === kbCId)).toBeUndefined();
  });

  it('GET /api/v1/kbs?view=recent 最近访问的（按访问时间倒序）', async () => {
    // 先访问 B（较早），再访问 A（较晚）→ recent 顺序应为 [A, B]
    await request(server)
      .get(`/api/v1/kbs/${kbBId}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    // 间隔 50ms 保证两次 visitedAt 可区分（timestamptz 微秒精度，HTTP 往返足够）
    await new Promise((r) => setTimeout(r, 50));
    await request(server)
      .get(`/api/v1/kbs/${kbAId}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    const res = await request(server)
      .get('/api/v1/kbs?view=recent')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    const ids = res.body.items.map((i: any) => i.id);
    expect(ids).toEqual([kbAId, kbBId]);
    // admin 只访问过 C（上文用例 GET /kbs/C）→ recent 仅含 C（用户维度隔离）
    const adminRes = await request(server)
      .get('/api/v1/kbs?view=recent')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(adminRes.status).toBe(200);
    expect(adminRes.body.items.map((i: any) => i.id)).toEqual([kbCId]);
    expect(adminRes.body.total).toBe(1);
  });

  it('列表项含 docCount/chunkCount（KB-A 有 1 文档 N 分块，B/C 为 0）', async () => {
    const res = await request(server)
      .get('/api/v1/kbs?view=all&pageSize=20')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    const a = res.body.items.find((i: any) => i.id === kbAId);
    const b = res.body.items.find((i: any) => i.id === kbBId);
    const c = res.body.items.find((i: any) => i.id === kbCId);
    // KB-A：上传 1 个文档且解析分块完成（beforeAll 已 waitFor chunkCount>0）
    expect(a.docCount).toBe(1);
    expect(a.chunkCount).toBeGreaterThan(0);
    // KB-B/KB-C：未上传文档 → 两个计数均为 0
    expect(b.docCount).toBe(0);
    expect(b.chunkCount).toBe(0);
    expect(c.docCount).toBe(0);
    expect(c.chunkCount).toBe(0);
  });

  it('列表项含 pinned/favorite 当前用户视角字段', async () => {
    // owner 置顶 B（favorite 已在上文用例置 A）→ view=all 中 B pinned、A favorite
    const pin = await request(server)
      .put(`/api/v1/kbs/${kbBId}/pin`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(pin.status).toBe(200);
    expect(pin.body.pinned).toBe(true);
    const res = await request(server)
      .get('/api/v1/kbs?view=all&pageSize=20')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    const a = res.body.items.find((i: any) => i.id === kbAId);
    const b = res.body.items.find((i: any) => i.id === kbBId);
    expect(a.favorite).toBe(true);
    expect(a.pinned).toBe(false);
    expect(b.pinned).toBe(true);
    expect(b.favorite).toBe(false);
    // 用户维度隔离：admin 视角 A/B 均未置顶未收藏
    const adminView = await request(server)
      .get('/api/v1/kbs?view=all&pageSize=20')
      .set('Authorization', `Bearer ${adminToken}`);
    const adminA = adminView.body.items.find((i: any) => i.id === kbAId);
    const adminB = adminView.body.items.find((i: any) => i.id === kbBId);
    expect(adminA.pinned).toBe(false);
    expect(adminA.favorite).toBe(false);
    expect(adminB.pinned).toBe(false);
    expect(adminB.favorite).toBe(false);
  });

  it('GET /api/v1/kbs/stats 返回统计（totalKbs/mine/favorite/totalDocs/totalChunks）', async () => {
    // 路由顺序验证：/kbs/stats 必须先于 /kbs/:id 匹配（否则 'stats' 撞 22P02 → 404）
    const res = await request(server)
      .get('/api/v1/kbs/stats')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.totalKbs).toBe(3);
    expect(res.body.mine).toBe(2); // owner 创建了 A/B
    expect(res.body.favorite).toBe(1); // owner 收藏了 A
    expect(res.body.totalDocs).toBeGreaterThanOrEqual(1);
    expect(res.body.totalChunks).toBeGreaterThanOrEqual(1);
    // admin 视角：mine=1（仅 C），favorite=1（admin 收藏了 C）
    const adminStats = await request(server)
      .get('/api/v1/kbs/stats')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(adminStats.status).toBe(200);
    expect(adminStats.body.mine).toBe(1);
    expect(adminStats.body.favorite).toBe(1);
    // 全局统计不受视角影响（totalKbs/totalDocs/totalChunks 是全量口径）
    expect(adminStats.body.totalKbs).toBe(3);
  });

  it('置顶分组在 view=all 下仍生效（回归 Task 1.1）', async () => {
    // B 已置顶（上文用例）；无论 A 的 updatedAt 是否更晚，置顶的 B 必须排最前
    const res = await request(server)
      .get('/api/v1/kbs?view=all&pageSize=20')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.items[0].id).toBe(kbBId);
    expect(res.body.items[0].pinned).toBe(true);
    // 其余项均为未置顶（owner 仅置顶过 B）
    for (const item of res.body.items.slice(1)) {
      expect(item.pinned).toBe(false);
    }
  });

  it('非法 view 参数返回 400', async () => {
    const res = await request(server)
      .get('/api/v1/kbs?view=invalid')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(400);
  });
});
