// 知识库组织共享权限 e2e（Task 4.2）：
// - 共享管理：POST /kbs/:id/shares（{ email, permission }，重复 409）、
//   GET /kbs/:id/shares（含 userName）、PUT 改权限（view↔edit↔admin）、DELETE 撤销
//   ——管理共享仅 KB full 权限（KB 创建者/系统 Owner），共享成员（view/edit）403
// - view 成员：可读 KB 详情（200），不可写（PUT /kbs/:id → 403）
// - edit 成员：可上传（POST /kbs/:id/manual → 201），不可删 KB（403）、
//   不可管理共享（403）
// - 非成员：404（资源隐藏，与组织「非成员 404」同语义）
// - Owner 全权限：系统 Owner（init 创建）可读可写任意 KB（绕过共享维度）
// 权限判定分级语义（kb-access.service.ts assertCan）：无访问权 → 404，
// 有访问权但档位不足 → 403。
// 简化决策登记：检索范围交集（GraphSearchService/VectorService 的 kbIds 过滤
// 与可见 KB 集合交集）在 P5 前端联调时收敛，本任务只验证 API 权限层。
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { withMockModels } from './mock-model-overrides.js';
import { prepareTestEnv } from './test-db.js';
import { configureApp } from '../src/app.setup.js';
import { User } from '../src/modules/users/user.entity.js';
import { RedisService } from '../src/redis/redis.service.js';

describe('知识库组织共享 (e2e, Task 4.2)', () => {
  let app: INestApplication;
  let server: any;
  let dataSource: DataSource;
  const sysOwnerEmail = 'share-sys-owner@ohmydocagent.local';
  const kbOwnerEmail = 'share-kb-owner@ohmydocagent.local';
  const memberEmail = 'share-member@ohmydocagent.local';
  const outsiderEmail = 'share-outsider@ohmydocagent.local';
  const testEmails = [sysOwnerEmail, kbOwnerEmail, memberEmail, outsiderEmail];
  let sysOwnerToken = '';
  let kbOwnerToken = '';
  let memberToken = '';
  let outsiderToken = '';
  let kbId = '';
  let memberInviteEmail = '';
  let shareId = '';

  beforeAll(async () => {
    await prepareTestEnv();
    const moduleRef = await withMockModels(
      Test.createTestingModule({ imports: [AppModule] }),
    ).compile();
    dataSource = moduleRef.get(DataSource);
    // 测试隔离：新增表（organizations/organization_members/knowledge_base_shares）
    // 显式列入清单（本仓库约定）
    await dataSource.query(
      'TRUNCATE TABLE users, invitations, knowledge_base_shares, knowledge, chunk_revisions, chunks, knowledge_bases CASCADE',
    );
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    server = app.getHttpServer();

    // 前置：系统 Owner（init）+ KB 创建者 / 共享成员 / 局外人（register）
    const initRes = await request(server).post('/api/v1/auth/init').send({
      email: sysOwnerEmail,
      password: 'Owner123456',
      name: '系统所有者',
    });
    expect(initRes.status).toBe(201);
    sysOwnerToken = initRes.body.accessToken as string;
    const kbOwnerRes = await request(server)
      .post('/api/v1/auth/register')
      .send({ email: kbOwnerEmail, password: 'Admin123456', name: '库主' });
    expect(kbOwnerRes.status).toBe(201);
    kbOwnerToken = kbOwnerRes.body.accessToken as string;
    const memberRes = await request(server).post('/api/v1/auth/register').send({
      email: memberEmail,
      password: 'Admin123456',
      name: '共享成员甲',
    });
    expect(memberRes.status).toBe(201);
    memberToken = memberRes.body.accessToken as string;
    const outsiderRes = await request(server)
      .post('/api/v1/auth/register')
      .send({ email: outsiderEmail, password: 'Admin123456', name: '局外人' });
    expect(outsiderRes.status).toBe(201);
    outsiderToken = outsiderRes.body.accessToken as string;

    // 前置：库主创建 KB（成员甲/乙/外人由全局 beforeAll 注册）
    const kbRes = await request(server)
      .post('/api/v1/kbs')
      .set('Authorization', `Bearer ${kbOwnerToken}`)
      .send({ name: '共享演示库' });
    expect(kbRes.status).toBe(201);
    kbId = kbRes.body.id as string;
    memberInviteEmail = memberRes.body.user.email as string;
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

  it('POST /api/v1/kbs/:id/shares 创建共享（view）；重复共享 409；非成员 404', async () => {
    const res = await request(server)
      .post(`/api/v1/kbs/${kbId}/shares`)
      .set('Authorization', `Bearer ${kbOwnerToken}`)
      .send({ email: memberInviteEmail, permission: 'view' });
    expect(res.status).toBe(201);
    shareId = res.body.id as string;
    expect(res.body.userId).toBeDefined();
    expect(res.body.permission).toBe('view');
    expect(res.body.createdById).toBeDefined();
    // 重复共享（kbId+userId 唯一）→ 409
    const dup = await request(server)
      .post(`/api/v1/kbs/${kbId}/shares`)
      .set('Authorization', `Bearer ${kbOwnerToken}`)
      .send({ email: memberInviteEmail, permission: 'edit' });
    expect(dup.status).toBe(409);
    // 非成员（无 KB 访问权）创建共享 → 404（资源隐藏）
    const hidden = await request(server)
      .post(`/api/v1/kbs/${kbId}/shares`)
      .set('Authorization', `Bearer ${outsiderToken}`)
      .send({ email: memberInviteEmail, permission: 'view' });
    expect(hidden.status).toBe(404);
  });

  it('GET /api/v1/kbs/:id/shares 共享列表（含 orgName）；view 成员不可管理共享 403', async () => {
    const res = await request(server)
      .get(`/api/v1/kbs/${kbId}/shares`)
      .set('Authorization', `Bearer ${kbOwnerToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(shareId);
    expect(res.body[0].userName).toBe(memberInviteEmail);
    // view 成员访问共享列表（管理共享是 full 专属）→ 403（有访问权但档位不足）
    const forbidden = await request(server)
      .get(`/api/v1/kbs/${kbId}/shares`)
      .set('Authorization', `Bearer ${memberToken}`);
    expect(forbidden.status).toBe(403);
  });

  it('view 成员可读不可写：GET 详情 200，PUT 改名 403', async () => {
    const read = await request(server)
      .get(`/api/v1/kbs/${kbId}`)
      .set('Authorization', `Bearer ${memberToken}`);
    expect(read.status).toBe(200);
    expect(read.body.name).toBe('共享演示库');
    const write = await request(server)
      .put(`/api/v1/kbs/${kbId}`)
      .set('Authorization', `Bearer ${memberToken}`)
      .send({ name: '越权改名' });
    expect(write.status).toBe(403);
  });

  it('非成员访问 KB 详情/文档列表 → 404（隐藏）', async () => {
    const detail = await request(server)
      .get(`/api/v1/kbs/${kbId}`)
      .set('Authorization', `Bearer ${outsiderToken}`);
    expect(detail.status).toBe(404);
    const docs = await request(server)
      .get(`/api/v1/kbs/${kbId}/knowledge`)
      .set('Authorization', `Bearer ${outsiderToken}`);
    expect(docs.status).toBe(404);
  });

  it('Owner 全权限：系统 Owner 可读任意 KB 详情（绕过共享维度）', async () => {
    const res = await request(server)
      .get(`/api/v1/kbs/${kbId}`)
      .set('Authorization', `Bearer ${sysOwnerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(kbId);
  });

  it('PUT /api/v1/kbs/:id/shares/:shareId 改权限 view→edit 后：成员可上传、不可删 KB、不可管理共享', async () => {
    const up = await request(server)
      .put(`/api/v1/kbs/${kbId}/shares/${shareId}`)
      .set('Authorization', `Bearer ${kbOwnerToken}`)
      .send({ permission: 'edit' });
    expect(up.status).toBe(200);
    expect(up.body.permission).toBe('edit');
    // edit 成员可上传文档（POST /kbs/:kbId/manual → 201）
    const manual = await request(server)
      .post(`/api/v1/kbs/${kbId}/manual`)
      .set('Authorization', `Bearer ${memberToken}`)
      .send({ title: '共享成员创建', content: 'edit 权限成员可创建文档' });
    expect(manual.status).toBe(201);
    // edit 成员不可删除 KB（删除是 full 专属）→ 403
    const del = await request(server)
      .delete(`/api/v1/kbs/${kbId}`)
      .set('Authorization', `Bearer ${memberToken}`);
    expect(del.status).toBe(403);
    // edit 成员不可管理共享 → 403
    const shares = await request(server)
      .get(`/api/v1/kbs/${kbId}/shares`)
      .set('Authorization', `Bearer ${memberToken}`);
    expect(shares.status).toBe(403);
  });

  it('DELETE /api/v1/kbs/:id/shares/:shareId 撤销共享后成员变非成员（详情 404）', async () => {
    const del = await request(server)
      .delete(`/api/v1/kbs/${kbId}/shares/${shareId}`)
      .set('Authorization', `Bearer ${kbOwnerToken}`);
    expect(del.status).toBe(204);
    const list = await request(server)
      .get(`/api/v1/kbs/${kbId}/shares`)
      .set('Authorization', `Bearer ${kbOwnerToken}`);
    expect(list.body).toHaveLength(0);
    // 撤销后：原 edit 成员失去访问权 → 404（资源隐藏）
    const gone = await request(server)
      .get(`/api/v1/kbs/${kbId}`)
      .set('Authorization', `Bearer ${memberToken}`);
    expect(gone.status).toBe(404);
  });
});
