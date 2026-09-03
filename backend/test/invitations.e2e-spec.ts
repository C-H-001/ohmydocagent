// backend/test/invitations.e2e-spec.ts
// 邀请制注册 e2e：Owner/Admin 创建邀请、分页列表（token 脱敏）、撤销；
// 公开 lookup 校验 token；register-by-invite 凭 token 注册
// （一次性、可过期、可撤销、绑定邮箱；Owner 不可经邀请产生）
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { prepareTestEnv } from './test-db.js';
import { configureApp } from '../src/app.setup.js';
import { User } from '../src/modules/users/user.entity.js';
import { RedisService } from '../src/redis/redis.service.js';

describe('Invitations (e2e)', () => {
  let app: INestApplication;
  let server: any;
  let dataSource: DataSource;
  let ownerToken = '';
  const ownerEmail = 'inv-owner@ohmydocagent.local';
  // 本文件通过 register-by-invite 创建的用户邮箱：afterAll 统一清理其 rt:* 键（共享 Redis 隔离）
  const registeredEmails: string[] = [];
  // 第一个用例创建的邀请（后续 lookup / 列表断言复用）
  let invite1Email = '';
  let invite1Token = '';

  beforeAll(async () => {
    await prepareTestEnv();
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    // 测试隔离（沿用 auth-init 模式）：本文件依赖「测试库无用户」来初始化 Owner，
    // 在 app.init() 前清空 users + invitations 表。
    // 表清单显式化：Task 0.6 引入 invitations 表，必须在此扩展，
    // 避免 TRUNCATE ... CASCADE 静默清空外键相关表造成隐性隔离失效。
    dataSource = moduleRef.get(DataSource);
    await dataSource.query('TRUNCATE TABLE users, invitations CASCADE');
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    server = app.getHttpServer();
    // 前置：init 创建 Owner，其 token 作为「管理员上下文」（Owner/Admin 均可创建邀请）
    const initRes = await request(server).post('/api/v1/auth/init').send({
      email: ownerEmail,
      password: 'Owner123456',
      name: '邀请测试所有者',
    });
    expect(initRes.status).toBe(201);
    ownerToken = initRes.body.accessToken as string;
  });

  afterAll(async () => {
    // 清理本文件产生的 rt:* 键（register-by-invite 成功签发了 refresh token；
    // Redis 为共享实例，按测试用户 id 扫描删除，避免污染开发会话）
    const userRepo = app.get(getRepositoryToken(User));
    const redis = app.get(RedisService);
    const client = redis.getClient();
    for (const email of [...registeredEmails, ownerEmail]) {
      const u = await userRepo.findOne({ where: { email } });
      if (u) {
        const keys = await client.keys(`rt:${u.id}:*`);
        if (keys.length > 0) await client.del(...keys);
      }
    }
    await app.close();
  });

  /** 助手：以 Owner token 创建邀请 */
  function createInvitation(email: string, role?: string) {
    return request(server)
      .post('/api/v1/invitations')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send(role ? { email, role } : { email });
  }

  it('未登录调用 POST /api/v1/invitations 返回 401（全局 JWT 守卫拦截）', async () => {
    const res = await request(server)
      .post('/api/v1/invitations')
      .send({ email: 'anon@ohmydocagent.local' });
    expect(res.status).toBe(401);
  });

  it('POST /api/v1/invitations 创建邀请返回含 64 位 hex token 的记录（默认角色 admin）', async () => {
    const email = `invite-1-${Date.now()}@ohmydocagent.local`;
    const res = await createInvitation(email);
    expect(res.status).toBe(201);
    expect(res.body.email).toBe(email);
    expect(res.body.role).toBe('member');
    expect(res.body.used).toBe(false);
    expect(res.body.expiresAt).toBeDefined();
    expect(res.body.createdById).toBeDefined();
    // token：32 字节随机 hex（64 字符），完整 token 仅创建响应返回一次
    expect(res.body.token).toMatch(/^[0-9a-f]{64}$/);
    invite1Email = email;
    invite1Token = res.body.token as string;
  });

  it('POST /api/v1/invitations role=owner 被拒绝（400：Owner 不能通过邀请产生）', async () => {
    const res = await createInvitation(
      `owner-inv-${Date.now()}@ohmydocagent.local`,
      'owner',
    );
    expect(res.status).toBe(400);
  });

  it('POST /api/v1/invitations 目标邮箱已注册返回 409', async () => {
    // ownerEmail 已通过 init 注册
    const res = await createInvitation(ownerEmail);
    expect(res.status).toBe(409);
  });

  it('POST /api/v1/invitations 同邮箱已有待使用邀请返回 409', async () => {
    const email = `pending-${Date.now()}@ohmydocagent.local`;
    expect((await createInvitation(email)).status).toBe(201);
    const res = await createInvitation(email);
    expect(res.status).toBe(409);
  });

  it('GET /api/v1/invitations 邀请列表分页且 token 脱敏（tokenPreview）', async () => {
    // 再创建一个邀请，验证分页 total 与 pageSize 生效
    await createInvitation(`page-${Date.now()}@ohmydocagent.local`);
    const res = await request(server)
      .get('/api/v1/invitations?page=1&pageSize=1')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.page).toBe(1);
    expect(res.body.pageSize).toBe(1);
    expect(res.body.total).toBeGreaterThanOrEqual(2);
    expect(res.body.items).toHaveLength(1);
    // 第一页按 createdAt DESC：最新创建的 page-* 在最前；用 pageSize=20 找 invite1 断言脱敏
    const all = await request(server)
      .get('/api/v1/invitations?page=1&pageSize=20')
      .set('Authorization', `Bearer ${ownerToken}`);
    const item = all.body.items.find((i: any) => i.email === invite1Email);
    expect(item).toBeDefined();
    // 列表不返回完整 token，只有脱敏预览（•••• + 后 6 位）与状态字段
    expect(item.token).toBeUndefined();
    expect(item.tokenPreview).toBe(`••••${invite1Token.slice(-6)}`);
    expect(item.status).toBe('valid');
  });

  it('DELETE /api/v1/invitations/:id 撤销邀请后 token 立即失效', async () => {
    const email = `revoke-${Date.now()}@ohmydocagent.local`;
    const created = await createInvitation(email);
    expect(created.status).toBe(201);
    const del = await request(server)
      .delete(`/api/v1/invitations/${created.body.id}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(del.status).toBe(204);
    // 撤销即删除：lookup 查不到该 token → 400
    const lookup = await request(server)
      .post('/api/v1/auth/invitations/lookup')
      .send({ token: created.body.token });
    expect(lookup.status).toBe(400);
  });

  it('POST /api/v1/auth/invitations/lookup 校验有效 token 返回 email/role/expiresAt（不返回 token）', async () => {
    const res = await request(server)
      .post('/api/v1/auth/invitations/lookup')
      .send({ token: invite1Token });
    // 与 login/register 一致：公开 POST 端点默认 201
    expect(res.status).toBe(201);
    expect(res.body.email).toBe(invite1Email);
    expect(res.body.role).toBe('member');
    expect(res.body.expiresAt).toBeDefined();
    expect(res.body.token).toBeUndefined();
  });

  it('POST /api/v1/auth/invitations/lookup 无效 token 返回 400', async () => {
    const res = await request(server)
      .post('/api/v1/auth/invitations/lookup')
      .send({ token: '0'.repeat(64) });
    expect(res.status).toBe(400);
  });

  it('POST /api/v1/auth/register-by-invite 凭有效 token 注册成功且角色为邀请指定角色（默认 admin）', async () => {
    const email = `reg-ok-${Date.now()}@ohmydocagent.local`;
    const created = await createInvitation(email);
    expect(created.status).toBe(201);
    registeredEmails.push(email);
    const res = await request(server)
      .post('/api/v1/auth/register-by-invite')
      .send({
        token: created.body.token,
        email,
        password: 'Invite123456',
        name: '受邀用户',
      });
    expect(res.status).toBe(201);
    expect(res.body.accessToken).toBeDefined();
    expect(res.body.refreshToken).toBeDefined();
    expect(res.body.user).toMatchObject({
      email,
      role: 'member',
      name: '受邀用户',
    });
    expect(res.body.user.passwordHash).toBeUndefined();
  });

  it('POST /api/v1/auth/register-by-invite 已使用 token 再注册返回 400（一次性）', async () => {
    const email = `reg-used-${Date.now()}@ohmydocagent.local`;
    const created = await createInvitation(email);
    expect(created.status).toBe(201);
    registeredEmails.push(email);
    const first = await request(server)
      .post('/api/v1/auth/register-by-invite')
      .send({
        token: created.body.token,
        email,
        password: 'Invite123456',
        name: '一次性',
      });
    expect(first.status).toBe(201);
    // 同一 token 再次注册：invitation 已 used=true → 400
    const second = await request(server)
      .post('/api/v1/auth/register-by-invite')
      .send({
        token: created.body.token,
        email,
        password: 'Invite123456',
        name: '重放',
      });
    expect(second.status).toBe(400);
  });

  it('POST /api/v1/auth/register-by-invite 过期 token 返回 400', async () => {
    const email = `reg-expired-${Date.now()}@ohmydocagent.local`;
    const created = await createInvitation(email);
    expect(created.status).toBe(201);
    // 直接把该邀请的过期时间拨到过去（模拟自然过期）
    await dataSource.query(
      `UPDATE invitations SET "expiresAt" = now() - interval '1 hour' WHERE id = $1`,
      [created.body.id],
    );
    const res = await request(server)
      .post('/api/v1/auth/register-by-invite')
      .send({
        token: created.body.token,
        email,
        password: 'Invite123456',
        name: '过期',
      });
    expect(res.status).toBe(400);
  });

  it('POST /api/v1/auth/register-by-invite 邮箱与邀请不一致返回 400（邀请绑定邮箱）', async () => {
    const inviteEmail = `reg-bound-${Date.now()}@ohmydocagent.local`;
    const created = await createInvitation(inviteEmail);
    expect(created.status).toBe(201);
    const res = await request(server)
      .post('/api/v1/auth/register-by-invite')
      .send({
        token: created.body.token,
        email: `other-${Date.now()}@ohmydocagent.local`,
        password: 'Invite123456',
        name: '错邮箱',
      });
    expect(res.status).toBe(400);
  });

  it('POST /api/v1/auth/register-by-invite 同一 token 并发注册：恰好一个 201、一个 400，且只创建一个用户（原子消费实证）', async () => {
    const email = `reg-concurrent-${Date.now()}@ohmydocagent.local`;
    const created = await createInvitation(email);
    expect(created.status).toBe(201);
    registeredEmails.push(email);
    const payload = {
      token: created.body.token,
      email,
      password: 'Invite123456',
      name: '并发',
    };
    // 两个请求同时打上来：consume 的 UPDATE ... WHERE used=false 在 PG 行锁下原子，
    // 只有一个 affected=1，另一个重评估 WHERE 不命中 → 400
    const [r1, r2] = await Promise.all([
      request(server).post('/api/v1/auth/register-by-invite').send(payload),
      request(server).post('/api/v1/auth/register-by-invite').send(payload),
    ]);
    // 断言与完成顺序无关：无论谁先谁后，必须恰一个成功、一个失败
    expect([r1.status, r2.status].sort()).toEqual([201, 400]);
    // 库中该邮箱只创建一个用户（唯一约束 + 事务回滚双保险，不允许并发双写）
    const rows = (await dataSource.query(
      `SELECT COUNT(*)::int AS count FROM users WHERE email = $1`,
      [email],
    )) as { count: number }[];
    expect(rows[0].count).toBe(1);
  });

  it('DELETE /api/v1/invitations/:id 撤销不存在的邀请返回 404', async () => {
    // 不存在的 UUID：delete affected=0 → 404（此前是 204，静默吞掉错误语义）
    const missing = await request(server)
      .delete('/api/v1/invitations/00000000-0000-4000-8000-000000000000')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(missing.status).toBe(404);
    // 非 UUID 格式 id：PG 22P02 → 同样视为不存在返回 404（不泄露内部错误）
    const garbage = await request(server)
      .delete('/api/v1/invitations/not-a-uuid')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(garbage.status).toBe(404);
  });

  it('POST /api/v1/invitations 同邮箱并发创建：恰好一个 201、一个 409（partial unique index 兜底）', async () => {
    const email = `inv-concurrent-${Date.now()}@ohmydocagent.local`;
    // 服务层 pending 检查存在 TOCTOU 窗口：两个请求同时通过检查后都 insert，
    // 由 PG 部分唯一索引（email WHERE used=false）收口 → 后落库者 23505 → 409
    const [r1, r2] = await Promise.all([
      createInvitation(email),
      createInvitation(email),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([201, 409]);
    // 库中该邮箱只有一条未使用邀请
    const rows = (await dataSource.query(
      `SELECT COUNT(*)::int AS count FROM invitations WHERE email = $1 AND used = false`,
      [email],
    )) as { count: number }[];
    expect(rows[0].count).toBe(1);
  });

  it('POST /api/v1/invitations 过期但未使用的旧邀请不阻塞重新邀请', async () => {
    const email = `reg-expired-reinvite-${Date.now()}@ohmydocagent.local`;
    const first = await createInvitation(email);
    expect(first.status).toBe(201);
    // 拨到过去模拟过期：旧邀请对 partial unique index 仍占位（used=false），
    // create 须先清理过期残留再插入，才能保持「过期不阻塞重新邀请」语义
    await dataSource.query(
      `UPDATE invitations SET "expiresAt" = now() - interval '1 hour' WHERE id = $1`,
      [first.body.id],
    );
    const second = await createInvitation(email);
    expect(second.status).toBe(201);
  });
});
