// 系统管理 e2e（Task 4.3~4.6）：任务队列仪表盘 / 审计日志 / 平台 API Keys /
// 全局设置 + 系统信息 + 个人资料。
// 测试隔离约定（沿用本仓库模式）：beforeAll TRUNCATE 本文件涉及的既有表
// （users/invitations）+ 新增管理表（audit_logs/platform_api_keys/system_settings），
// 表清单显式化——后续新增相关表时必须继续显式扩展。
// 队列任务存 Redis（跨测试文件共享实例）：本文件创建的任务带唯一标识，断言按
// 自己的 job id 定位（不断言全局计数），afterAll 逐个 remove 清理。
// 权限说明：系统仅 Owner/Admin 两种角色（@Roles(Owner, Admin) 即「任意登录
// 用户」），「非管理员访问管理端点」的拒绝路径由全局 JwtAuthGuard 以 401 呈现
// ——403 只对角色集合外的用户可达（本角色模型下不存在，RolesGuard 403 语义
// 由 rbac.e2e 的 Owner-only 端点覆盖），故各节拒绝用例断言 401 并注释说明。
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { getQueueToken } from '@nestjs/bullmq';
import request from 'supertest';
import { DataSource } from 'typeorm';
import type { Queue } from 'bullmq';
import { createHash } from 'node:crypto';
import { AppModule } from '../src/app.module.js';
import { prepareTestEnv } from './test-db.js';
import { configureApp } from '../src/app.setup.js';
import { User } from '../src/modules/users/user.entity.js';
import { RedisService } from '../src/redis/redis.service.js';
import { PlatformApiKey } from '../src/modules/admin/api-key/platform-api-key.entity.js';
import { PARSE_QUEUE } from '../src/modules/parse/parse-queue.constants.js';
import { ADMIN_QUEUES } from '../src/modules/admin/queue/queue-admin.service.js';

/** 无效 knowledgeId（不存在 → ParseProcessor 快速失败 → job failed） */
const GHOST_KNOWLEDGE_ID = '00000000-0000-4000-8000-000000000000';

/** 轮询等待 job 进入指定状态（BullMQ worker 异步消费，短轮询收敛） */
async function waitJobState(
  queue: Queue,
  jobId: string,
  state: string,
  timeoutMs = 15000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = await queue.getJob(jobId);
    if (job && (await job.getState()) === state) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`job ${jobId} 未在 ${timeoutMs}ms 内进入 ${state} 状态`);
}

describe('系统管理（Task 4.3~4.6）', () => {
  let app: INestApplication;
  let server: any;
  let dataSource: DataSource;
  const ownerEmail = 'admin-owner@ohmydocagent.local';
  const adminEmail = 'admin-operator@ohmydocagent.local';
  const userEmails = [ownerEmail, adminEmail];
  let ownerToken = '';
  let adminToken = '';
  let ownerId = '';
  let parseQueue: Queue;
  // 本文件创建的队列任务（afterAll 清理）
  const createdJobIds: string[] = [];

  beforeAll(async () => {
    await prepareTestEnv();
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    dataSource = moduleRef.get(DataSource);
    // 隔离：清空用户/邀请 + 新增管理表（表清单显式化，见文件头注释）
    await dataSource.query(
      'TRUNCATE TABLE users, invitations, audit_logs, platform_api_keys, system_settings CASCADE',
    );
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    server = app.getHttpServer();
    parseQueue = app.get(getQueueToken(PARSE_QUEUE));

    // 前置：init 创建 Owner + register 创建普通 Admin
    const initRes = await request(server).post('/api/v1/auth/init').send({
      email: ownerEmail,
      password: 'Owner123456',
      name: '系统所有者',
    });
    expect(initRes.status).toBe(201);
    ownerToken = initRes.body.accessToken as string;
    const regRes = await request(server).post('/api/v1/auth/register').send({
      email: adminEmail,
      password: 'Admin123456',
      name: '运维管理员',
    });
    expect(regRes.status).toBe(201);
    adminToken = regRes.body.accessToken as string;
    const userRepo = app.get(getRepositoryToken(User));
    ownerId = (await userRepo.findOneOrFail({ where: { email: ownerEmail } }))
      .id;
  });

  afterAll(async () => {
    // 清理本文件创建的队列任务（Redis 共享实例，避免污染其他测试/开发数据）
    for (const id of createdJobIds) {
      try {
        const job = await parseQueue.getJob(id);
        if (job) await job.remove();
      } catch {
        // 清理失败忽略（不影响测试结论）
      }
    }
    // 清理本文件产生的 rt:* 键（沿用 rbac.e2e 约定）
    const userRepo = app.get(getRepositoryToken(User));
    const redis = app.get(RedisService);
    const client = redis.getClient();
    for (const email of userEmails) {
      const u = await userRepo.findOne({ where: { email } });
      if (u) {
        const keys = await client.keys(`rt:${u.id}:*`);
        if (keys.length > 0) await client.del(...keys);
      }
    }
    await app.close();
  });

  // ============ 4.3 任务队列仪表盘 ============
  describe('4.3 任务队列仪表盘', () => {
    it('GET /admin/queues 概览：五队列 getJobCounts（含 waiting/active/completed/failed/delayed 计数）', async () => {
      const res = await request(server)
        .get('/api/v1/admin/queues')
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(ADMIN_QUEUES.length);
      expect(res.body.map((q: any) => q.name).sort()).toEqual(
        [...ADMIN_QUEUES].sort(),
      );
      for (const q of res.body) {
        expect(q.counts).toEqual(
          expect.objectContaining({
            waiting: expect.any(Number),
            active: expect.any(Number),
            completed: expect.any(Number),
            failed: expect.any(Number),
            delayed: expect.any(Number),
          }),
        );
      }
    });

    it('GET /admin/queues/:name/jobs 列表：延迟任务按 state=delayed 分页返回', async () => {
      // 延迟 60s：worker 不会消费，状态确定（delayed）
      const job = await parseQueue.add(
        PARSE_QUEUE,
        { knowledgeId: 'delayed-list-test' },
        { delay: 60000, removeOnComplete: { count: 1000 } },
      );
      createdJobIds.push(job.id as string);
      const res = await request(server)
        .get('/api/v1/admin/queues/parse/jobs?state=delayed&page=1&pageSize=20')
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.total).toBeGreaterThanOrEqual(1);
      expect(res.body.items.map((i: any) => i.id)).toEqual(
        expect.arrayContaining([job.id]),
      );
      expect(res.body.items.find((i: any) => i.id === job.id)?.data).toEqual({
        knowledgeId: 'delayed-list-test',
      });
    });

    it('GET /admin/queues/:name/jobs/:id 详情：payload/progress/failedReason 字段齐备', async () => {
      const job = await parseQueue.add(
        PARSE_QUEUE,
        { knowledgeId: GHOST_KNOWLEDGE_ID },
        { attempts: 1, removeOnFail: { count: 1000 } },
      );
      createdJobIds.push(job.id as string);
      await waitJobState(parseQueue, job.id as string, 'failed');
      const res = await request(server)
        .get(`/api/v1/admin/queues/parse/jobs/${job.id}`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        id: job.id,
        state: 'failed',
        data: { knowledgeId: GHOST_KNOWLEDGE_ID },
      });
      expect(res.body.failedReason).toContain('文档不存在');
    });

    it('POST /admin/queues/:name/jobs/:id/retry 重试失败任务 → 200', async () => {
      const job = await parseQueue.add(
        PARSE_QUEUE,
        { knowledgeId: GHOST_KNOWLEDGE_ID },
        { attempts: 1, removeOnFail: { count: 1000 } },
      );
      createdJobIds.push(job.id as string);
      await waitJobState(parseQueue, job.id as string, 'failed');
      const res = await request(server)
        .post(`/api/v1/admin/queues/parse/jobs/${job.id}/retry`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ retried: true });
    });

    it('POST /admin/queues/:name/jobs/:id/cancel 取消延迟任务 → 200，之后详情 404', async () => {
      const job = await parseQueue.add(
        PARSE_QUEUE,
        { knowledgeId: 'cancel-test' },
        { delay: 60000, removeOnComplete: { count: 1000 } },
      );
      createdJobIds.push(job.id as string);
      const res = await request(server)
        .post(`/api/v1/admin/queues/parse/jobs/${job.id}/cancel`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ canceled: true });
      const after = await request(server)
        .get(`/api/v1/admin/queues/parse/jobs/${job.id}`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(after.status).toBe(404);
    });

    it('未知队列名 → 404；未知任务 → 404；未登录 → 401（角色模型下管理端点拒绝统一为 401，见文件头注释）', async () => {
      const unknownQueue = await request(server)
        .get('/api/v1/admin/queues/no-such/jobs')
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(unknownQueue.status).toBe(404);
      const unknownJob = await request(server)
        .get(
          '/api/v1/admin/queues/parse/jobs/ffffffff-ffff-4fff-8fff-ffffffffffff',
        )
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(unknownJob.status).toBe(404);
      const noToken = await request(server).get('/api/v1/admin/queues');
      expect(noToken.status).toBe(401);
    });
  });

  // ============ 4.4 审计日志 ============
  describe('4.4 审计日志', () => {
    it('登录成功触发审计：action=auth.login 过滤出当前用户的记录（含 resourceId=userId）', async () => {
      const loginRes = await request(server).post('/api/v1/auth/login').send({
        email: adminEmail,
        password: 'Admin123456',
      });
      expect(loginRes.status).toBe(201);
      const userRepo = app.get(getRepositoryToken(User));
      const admin = await userRepo.findOneOrFail({
        where: { email: adminEmail },
      });
      const res = await request(server)
        .get(`/api/v1/admin/audit-logs?action=auth.login&userId=${admin.id}`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.items.length).toBeGreaterThan(0);
      for (const item of res.body.items) {
        expect(item).toMatchObject({
          action: 'auth.login',
          resourceType: 'user',
          resourceId: admin.id,
          userId: admin.id,
        });
        expect(item.detail).toEqual(expect.any(Object));
      }
    });

    it('注册触发审计：action=auth.register 存在且 detail 含 email', async () => {
      const res = await request(server)
        .get('/api/v1/admin/audit-logs?action=auth.register&page=1&pageSize=50')
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      const items = res.body.items;
      expect(items.length).toBeGreaterThan(0);
      expect(items[0]).toMatchObject({
        action: 'auth.register',
        resourceType: 'user',
      });
      expect(items[0].detail.email).toBe(adminEmail);
    });

    it('GET /admin/audit-logs/:id 单条详情：取列表首条按 id 查询返回一致', async () => {
      const list = await request(server)
        .get('/api/v1/admin/audit-logs?page=1&pageSize=1')
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(list.status).toBe(200);
      const first = list.body.items[0];
      const detail = await request(server)
        .get(`/api/v1/admin/audit-logs/${first.id}`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(detail.status).toBe(200);
      expect(detail.body.id).toBe(first.id);
      // 非法 id（非 UUID）→ 404（22P02 兜底，见 audit.service.ts）
      const bad = await request(server)
        .get('/api/v1/admin/audit-logs/not-a-uuid')
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(bad.status).toBe(404);
    });

    it('未登录访问审计接口 → 401', async () => {
      const res = await request(server).get('/api/v1/admin/audit-logs');
      expect(res.status).toBe(401);
    });
  });

  // ============ 4.5 平台 API Keys ============
  describe('4.5 平台 API Keys', () => {
    let createdKeyId = '';
    let plaintextKey = '';

    it('POST /admin/api-keys 创建：返回明文一次（dm_ + 32hex），DB 只存 sha256 哈希', async () => {
      const res = await request(server)
        .post('/api/v1/admin/api-keys')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ name: '运维脚本' });
      expect(res.status).toBe(201);
      expect(res.body.apiKey).toMatch(/^dm_[0-9a-f]{32}$/);
      expect(res.body.hasApiKey).toBe(true);
      createdKeyId = res.body.id;
      plaintextKey = res.body.apiKey;
      // DB 断言：keyHash = sha256(明文)，绝无明文
      const keyRepo = app.get(getRepositoryToken(PlatformApiKey));
      const row = await keyRepo.findOneOrFail({ where: { id: createdKeyId } });
      expect(row.keyHash).toBe(
        createHash('sha256').update(plaintextKey, 'utf8').digest('hex'),
      );
      expect(JSON.stringify(row)).not.toContain(plaintextKey);
    });

    it('GET /admin/api-keys 列表：脱敏（无 apiKey/keyHash 字段），hasApiKey=true', async () => {
      const res = await request(server)
        .get('/api/v1/admin/api-keys')
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      const item = res.body.find((k: any) => k.id === createdKeyId);
      expect(item).toBeDefined();
      expect(item.hasApiKey).toBe(true);
      expect(item.apiKey).toBeUndefined();
      expect(item.keyHash).toBeUndefined();
      expect(JSON.stringify(res.body)).not.toContain(plaintextKey);
    });

    it('GET /admin/api-keys/self：携带 X-API-Key → 注入 admin 身份（示例受保护端点）', async () => {
      const res = await request(server)
        .get('/api/v1/admin/api-keys/self')
        .set('X-API-Key', plaintextKey);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        id: createdKeyId,
        name: '运维脚本',
        type: 'api-key',
        role: 'member',
      });
    });

    it('GET /admin/api-keys/self：无 key/无效 key → 401', async () => {
      const missing = await request(server).get('/api/v1/admin/api-keys/self');
      expect(missing.status).toBe(401);
      const invalid = await request(server)
        .get('/api/v1/admin/api-keys/self')
        .set('X-API-Key', 'dm_' + '0'.repeat(32));
      expect(invalid.status).toBe(401);
    });

    it('DELETE /admin/api-keys/:id 吊销 → 200，之后 self 401、列表不再包含', async () => {
      const revoke = await request(server)
        .delete(`/api/v1/admin/api-keys/${createdKeyId}`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(revoke.status).toBe(200);
      expect(revoke.body).toEqual({ revoked: true });
      const self = await request(server)
        .get('/api/v1/admin/api-keys/self')
        .set('X-API-Key', plaintextKey);
      expect(self.status).toBe(401);
      const list = await request(server)
        .get('/api/v1/admin/api-keys')
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(list.body.find((k: any) => k.id === createdKeyId)).toBeUndefined();
    });

    it('未登录创建 API Key → 401；吊销不存在 → 404', async () => {
      const noToken = await request(server)
        .post('/api/v1/admin/api-keys')
        .send({ name: 'x' });
      expect(noToken.status).toBe(401);
      const missing = await request(server)
        .delete('/api/v1/admin/api-keys/ffffffff-ffff-4fff-8fff-ffffffffffff')
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(missing.status).toBe(404);
    });
  });

  // ============ 4.6 全局设置 / 系统信息 / 个人资料 ============
  describe('4.6 全局设置 / 系统信息 / 个人资料', () => {
    it('GET /admin/settings 读取：返回全部注册表 key（默认值合并）', async () => {
      const res = await request(server)
        .get('/api/v1/admin/settings')
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        registration_enabled: true,
        invite_enabled: true,
        default_chat_model_id: '',
        default_embedding_model_id: '',
        web_search_enabled: true,
        max_upload_mb: 20,
      });
    });

    it('PUT /admin/settings 更新：合法值落库并读回；类型错误 → 400；未知 key → 400', async () => {
      const put = await request(server)
        .put('/api/v1/admin/settings')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ values: { registration_enabled: false, max_upload_mb: 100 } });
      expect(put.status).toBe(200);
      expect(put.body).toMatchObject({
        registration_enabled: false,
        max_upload_mb: 100,
      });
      const badType = await request(server)
        .put('/api/v1/admin/settings')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ values: { registration_enabled: 'yes' } });
      expect(badType.status).toBe(400);
      const unknown = await request(server)
        .put('/api/v1/admin/settings')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ values: { no_such_key: true } });
      expect(unknown.status).toBe(400);
      // 复位默认，避免影响其他测试
      await request(server)
        .put('/api/v1/admin/settings')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ values: { registration_enabled: true } });
    });

    it('GET /system/info：版本号 + PG/Redis/Neo4j 三服务健康均 up', async () => {
      const res = await request(server)
        .get('/api/v1/system/info')
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(res.body.services).toEqual({
        postgres: 'up',
        redis: 'up',
        neo4j: 'up',
      });
      expect(res.body.timestamp).toBeDefined();
    });

    it('个人资料：GET/PUT /settings/profile 读取与更新昵称', async () => {
      const getRes = await request(server)
        .get('/api/v1/settings/profile')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(getRes.status).toBe(200);
      expect(getRes.body).toMatchObject({ email: adminEmail });
      expect(getRes.body.passwordHash).toBeUndefined();
      const putRes = await request(server)
        .put('/api/v1/settings/profile')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: '新昵称' });
      expect(putRes.status).toBe(200);
      expect(putRes.body).toMatchObject({ email: adminEmail, name: '新昵称' });
    });

    it('修改密码：旧密码错误 → 400；正确 → 200 且新密码可登录', async () => {
      const wrong = await request(server)
        .post('/api/v1/settings/change-password')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ oldPassword: 'Wrong1234', newPassword: 'NewPass123' });
      expect(wrong.status).toBe(400);
      const ok = await request(server)
        .post('/api/v1/settings/change-password')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ oldPassword: 'Admin123456', newPassword: 'NewPass123' });
      expect(ok.status).toBe(200);
      expect(ok.body).toEqual({ changed: true });
      const relogin = await request(server).post('/api/v1/auth/login').send({
        email: adminEmail,
        password: 'NewPass123',
      });
      expect(relogin.status).toBe(201);
      // 复位密码，避免影响本文件其他用例（4.4 登录审计用例已跑完，此处仅复位）
      await request(server)
        .post('/api/v1/settings/change-password')
        .set('Authorization', `Bearer ${relogin.body.accessToken}`)
        .send({ oldPassword: 'NewPass123', newPassword: 'Admin123456' });
    });

    it('未登录访问设置/系统信息 → 401', async () => {
      expect((await request(server).get('/api/v1/admin/settings')).status).toBe(
        401,
      );
      expect((await request(server).get('/api/v1/system/info')).status).toBe(
        401,
      );
    });
  });
});
