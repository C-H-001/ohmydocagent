// backend/test/rbac.e2e-spec.ts
// RBAC e2e：角色守卫（@Roles + RolesGuard 全局生效）、用户列表（Owner/Admin 均可访问）、
// 角色调整（仅 Owner，唯一 Owner 不变量保护）、所有权转移（事务原子交换 + FOR UPDATE 并发兜底）。
// 覆盖设计语义（见 Task 0.7）：
// - 系统恒有且仅有一个 Owner（init 产生；transfer 原子交换；任何操作不得出现 0 或 2 个 Owner）
// - PUT /users/:id/role 仅允许幂等设置（破坏唯一 Owner 的变更一律 400，提升引导走所有权转移）
// - POST /users/transfer-ownership 事务内锁定原 Owner 与目标两行（pessimistic_write），
//   并发双转移只有一个成功，另一个 403/400，杜绝双 Owner
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

describe('RBAC (e2e)', () => {
  let app: INestApplication;
  let server: any;
  let dataSource: DataSource;
  // 三个测试账号：Owner（init 创建）+ 两个普通 Admin（register 创建，转移目标）
  const ownerEmail = 'rbac-owner@ohmydocagent.local';
  const admin1Email = 'rbac-admin1@ohmydocagent.local';
  const admin2Email = 'rbac-admin2@ohmydocagent.local';
  const userEmails = [ownerEmail, admin1Email, admin2Email];
  let ownerToken = '';
  let admin1Token = '';
  let admin2Token = '';
  let ownerId = '';
  let admin1Id = '';
  let admin2Id = '';

  beforeAll(async () => {
    await prepareTestEnv();
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    // 测试隔离（沿用 auth-init/invitations 模式）：本文件依赖「测试库无用户」来 init 创建 Owner，
    // 在 app.init() 前清空 users + invitations 表。表清单显式化（本仓库约定）：
    // 后续新增与用户/邀请相关的表时必须继续显式扩展，避免 CASCADE 静默清空造成隐性隔离失效。
    dataSource = moduleRef.get(DataSource);
    await dataSource.query('TRUNCATE TABLE users, invitations CASCADE');
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    server = app.getHttpServer();

    // 前置：init 创建 Owner（ownerToken 作为「仅 Owner 可操作」上下文的凭证）
    const initRes = await request(server).post('/api/v1/auth/init').send({
      email: ownerEmail,
      password: 'Owner123456',
      name: 'RBAC 所有者',
    });
    expect(initRes.status).toBe(201);
    ownerToken = initRes.body.accessToken as string;

    // register 创建两个普通 admin（Admin123456：同时含字母与数字，通过 RegisterDto 校验）
    for (const [email, name] of [
      [admin1Email, '管理员甲'],
      [admin2Email, '管理员乙'],
    ] as const) {
      const res = await request(server).post('/api/v1/auth/register').send({
        email,
        password: 'Admin123456',
        name,
      });
      expect(res.status).toBe(201);
      if (email === admin1Email) admin1Token = res.body.accessToken as string;
      else admin2Token = res.body.accessToken as string;
    }
    const userRepo = app.get(getRepositoryToken(User));
    const owner = await userRepo.findOneOrFail({
      where: { email: ownerEmail },
    });
    ownerId = owner.id;
    admin1Id = (await userRepo.findOneOrFail({ where: { email: admin1Email } }))
      .id;
    admin2Id = (await userRepo.findOneOrFail({ where: { email: admin2Email } }))
      .id;
  });

  afterAll(async () => {
    // 清理本文件产生的 rt:* 键（register/init 成功签发 refresh token；Redis 为共享实例，
    // 与既有约定一致：按测试用户 id 扫描删除，避免污染开发会话）
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

  it('GET /api/v1/users 未登录返回 401（全局 JWT 守卫拦截）', async () => {
    const res = await request(server).get('/api/v1/users');
    expect(res.status).toBe(401);
  });

  it('GET /api/v1/users Owner 可访问：分页返回用户列表（含 email/role，不含 passwordHash）', async () => {
    const res = await request(server)
      .get('/api/v1/users?page=1&pageSize=20')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.page).toBe(1);
    expect(res.body.pageSize).toBe(20);
    expect(res.body.total).toBe(3);
    expect(res.body.items).toHaveLength(3);
    // 每条记录公开形态：email/role 齐全，绝不泄露 passwordHash
    for (const item of res.body.items) {
      expect(item.email).toBeDefined();
      expect(item.role).toBeDefined();
      expect(item.passwordHash).toBeUndefined();
    }
    const emails = res.body.items.map((i: any) => i.email);
    expect(emails).toEqual(
      expect.arrayContaining([ownerEmail, admin1Email, admin2Email]),
    );
  });

  it('GET /api/v1/users 普通 member 访问 → 403（用户管理是 super 专属）', async () => {
    const res = await request(server)
      .get('/api/v1/users')
      .set('Authorization', `Bearer ${admin1Token}`);
    expect(res.status).toBe(403);
  });

  it('PUT /api/v1/users/:id/role 幂等设置 Admin 角色为 admin（200，返回公开用户，role 不变）', async () => {
    const res = await request(server)
      .put(`/api/v1/users/${admin1Id}/role`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ role: 'member' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: admin1Id,
      email: admin1Email,
      role: 'member',
    });
    expect(res.body.passwordHash).toBeUndefined();
  });

  it('PUT /api/v1/users/:id/role Owner 尝试把 Admin 提升为 Owner 返回 400（系统只能有一个 Owner，请走所有权转移）', async () => {
    const res = await request(server)
      .put(`/api/v1/users/${admin1Id}/role`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ role: 'super' });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('只能有一个 Owner');
  });

  it('PUT /api/v1/users/:id/role Owner 尝试把自己降级返回 400（系统必须保留一个 Owner）', async () => {
    const res = await request(server)
      .put(`/api/v1/users/${ownerId}/role`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ role: 'member' });
    expect(res.status).toBe(400);
  });

  it('PUT /api/v1/users/:id/role 非法角色值返回 400（DTO 校验）', async () => {
    const res = await request(server)
      .put(`/api/v1/users/${admin1Id}/role`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ role: 'superuser' });
    expect(res.status).toBe(400);
  });

  it('PUT /api/v1/users/:id/role 普通 Admin 操作返回 403（RolesGuard 拦截）', async () => {
    const res = await request(server)
      .put(`/api/v1/users/${admin2Id}/role`)
      .set('Authorization', `Bearer ${admin1Token}`)
      .send({ role: 'member' });
    expect(res.status).toBe(403);
  });

  it('PUT /api/v1/users/:id/role 目标用户不存在返回 404', async () => {
    const res = await request(server)
      .put('/api/v1/users/00000000-0000-4000-8000-000000000000/role')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ role: 'member' });
    expect(res.status).toBe(404);
  });

  it('PUT /api/v1/users/:id/role id 非 UUID 格式返回 404（PG 22P02 映射路径覆盖）', async () => {
    // 服务层 updateRole 对非 UUID id 捕获 PG 22P02 并转 404（与「不存在」同语义，
    // 不泄露内部错误；该路径只能靠 e2e 打真库验证，见 users.service.ts updateRole 注释）
    const res = await request(server)
      .put('/api/v1/users/not-a-uuid/role')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ role: 'member' });
    expect(res.status).toBe(404);
  });

  it('POST /api/v1/users/transfer-ownership 普通 Admin 操作返回 403（RolesGuard 拦截）', async () => {
    const res = await request(server)
      .post('/api/v1/users/transfer-ownership')
      .set('Authorization', `Bearer ${admin1Token}`)
      .send({ targetUserId: admin2Id });
    expect(res.status).toBe(403);
  });

  it('POST /api/v1/users/transfer-ownership 转移给不存在用户返回 404', async () => {
    const res = await request(server)
      .post('/api/v1/users/transfer-ownership')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ targetUserId: '00000000-0000-4000-8000-000000000000' });
    expect(res.status).toBe(404);
  });

  it('POST /api/v1/users/transfer-ownership 转移给自己返回 400', async () => {
    const res = await request(server)
      .post('/api/v1/users/transfer-ownership')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ targetUserId: ownerId });
    expect(res.status).toBe(400);
  });

  it('POST /api/v1/users/transfer-ownership targetUserId 非 UUID 返回 400（DTO 校验）', async () => {
    const res = await request(server)
      .post('/api/v1/users/transfer-ownership')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ targetUserId: 'not-a-uuid' });
    expect(res.status).toBe(400);
  });

  it('POST /api/v1/users/transfer-ownership Owner→Admin 原子交换：原 Owner 降为 Admin，目标升为 Owner', async () => {
    const res = await request(server)
      .post('/api/v1/users/transfer-ownership')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ targetUserId: admin2Id });
    expect(res.status).toBe(200);
    expect(res.body.previousOwner).toMatchObject({
      id: ownerId,
      email: ownerEmail,
      role: 'member',
    });
    expect(res.body.newOwner).toMatchObject({
      id: admin2Id,
      email: admin2Email,
      role: 'super',
    });
    expect(res.body.previousOwner.passwordHash).toBeUndefined();
    expect(res.body.newOwner.passwordHash).toBeUndefined();
    // 唯一 Owner 不变量：全库恰一条 role=owner
    const rows = (await dataSource.query(
      `SELECT COUNT(*)::int AS count FROM users WHERE role = 'super'`,
    )) as { count: number }[];
    expect(rows[0].count).toBe(1);
  });

  it('POST /api/v1/users/transfer-ownership 转移后原 Owner 的 token 仍有效但已降为 Admin（再转移返回 403，JWT 策略每次查库取最新角色）', async () => {
    const res = await request(server)
      .post('/api/v1/users/transfer-ownership')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ targetUserId: admin1Id });
    expect(res.status).toBe(403);
    // 库中角色确认：原 Owner 已是 admin
    const rows = (await dataSource.query(
      `SELECT role FROM users WHERE id = $1`,
      [ownerId],
    )) as { role: string }[];
    expect(rows[0].role).toBe('member');
  });

  it('POST /api/v1/users/transfer-ownership 新 Owner（原 Admin2）可再次转移给 Admin1：角色再次原子交换', async () => {
    const res = await request(server)
      .post('/api/v1/users/transfer-ownership')
      .set('Authorization', `Bearer ${admin2Token}`)
      .send({ targetUserId: admin1Id });
    expect(res.status).toBe(200);
    expect(res.body.previousOwner).toMatchObject({
      id: admin2Id,
      role: 'member',
    });
    expect(res.body.newOwner).toMatchObject({
      id: admin1Id,
      email: admin1Email,
      role: 'super',
    });
    const rows = (await dataSource.query(
      `SELECT COUNT(*)::int AS count FROM users WHERE role = 'super'`,
    )) as { count: number }[];
    expect(rows[0].count).toBe(1);
  });

  it('POST /api/v1/users/transfer-ownership 并发双转移不变量校验（结果层面）：恰一个成功、一个 400/403，全库仍只有一个 Owner', async () => {
    // 诚实标注：本用例只断言「结果不变量」——并发双转移后恰一个成功、全库一个 Owner。
    // 该断言在两种串行化路径下都成立：①守卫层先读库取到已降级角色 → 403；
    // ②事务内 FOR UPDATE 行锁串行化后重读判定。它不能实证行锁路径本身；
    // 行锁（pessimistic_write + 锁序/重读判定）由单元测试的 setLock 断言覆盖
    // （见 users.service.spec.ts transferOwnership describe），e2e 只做端到端不变量回归。
    // 当前状态：admin1 是 Owner（admin1Token 经 JWT 查库取最新角色），
    // ownerEmail 与 admin2 均为 Admin。同一 Owner 并发向两个不同目标转移。
    const [r1, r2] = await Promise.all([
      request(server)
        .post('/api/v1/users/transfer-ownership')
        .set('Authorization', `Bearer ${admin1Token}`)
        .send({ targetUserId: admin2Id }),
      request(server)
        .post('/api/v1/users/transfer-ownership')
        .set('Authorization', `Bearer ${admin1Token}`)
        .send({ targetUserId: ownerId }),
    ]);
    const statuses = [r1.status, r2.status].sort((a, b) => a - b);
    expect(statuses[0]).toBe(200);
    expect([400, 403]).toContain(statuses[1]);
    const rows = (await dataSource.query(
      `SELECT COUNT(*)::int AS count FROM users WHERE role = 'super'`,
    )) as { count: number }[];
    expect(rows[0].count).toBe(1);
  });
});
