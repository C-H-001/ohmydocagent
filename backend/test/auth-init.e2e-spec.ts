// backend/test/auth-init.e2e-spec.ts
// 首次部署初始化 e2e：无用户时创建 Owner，有用户后拒绝（409）
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

describe('Auth Init (e2e)', () => {
  let app: INestApplication;
  let server: any;
  let dataSource: DataSource;
  // init 创建的所有者邮箱：afterAll 按此邮箱查用户 id，再扫描清理其 rt:* 键
  const ownerEmail = 'owner-init@ohmydocagent.local';
  // 并发 init 用例的两个邮箱（赢家签发了 refresh token，同样需要 afterAll 清理）
  const concurrentEmails = [
    'conc-init-a@ohmydocagent.local',
    'conc-init-b@ohmydocagent.local',
  ];
  const allEmails = [ownerEmail, ...concurrentEmails];

  beforeAll(async () => {
    await prepareTestEnv();
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    // 测试隔离（方案 A）：本用例依赖「测试库无用户」来判定初始化状态，而
    // auth.e2e-spec.ts 会在同一 ohmydocagent_test 库创建用户（vitest 串行执行，顺序不定），
    // 因此在 app.init() 前清空相关表。TypeORM 连接在 get(DataSource) 时已建立
    // （含 synchronize 建表），无需先 app.init() 即可执行 SQL。
    // 表清单显式化：users + invitations（本仓库约定：显式列出全部相关表）。
    // 后续新增与初始化判定或本用例数据相关的外键表（如 org_members）时必须继续
    // 显式扩展此清单，避免 CASCADE 静默清空外键相关表造成隐性隔离失效。
    dataSource = moduleRef.get(DataSource);
    await dataSource.query('TRUNCATE TABLE users, invitations CASCADE');
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    server = app.getHttpServer();
  });
  afterAll(async () => {
    // 清理本文件产生的 rt:* 键（init/并发 init 成功时签发了 refresh token；
    // Redis 为共享实例，与 auth.e2e-spec.ts 既有约定一致：按测试用户 id 扫描删除，
    // 避免污染开发会话）
    const userRepo = app.get(getRepositoryToken(User));
    const redis = app.get(RedisService);
    const client = redis.getClient();
    for (const email of allEmails) {
      const testUser = await userRepo.findOne({ where: { email } });
      if (testUser) {
        const keys = await client.keys(`rt:${testUser.id}:*`);
        if (keys.length > 0) await client.del(...keys);
      }
    }
    await app.close();
  });

  describe('并发 init（DB 唯一 Owner 约束兜底）', () => {
    it('两个并发 init（不同邮箱）恰一个 201、一个 409，全库恰一个 Owner', async () => {
      // 无用户前置由 beforeAll 的 TRUNCATE 保证（本 describe 是文件内首个用例）。
      // 两个请求并发：即使服务层 isInitialized 的 TOCTOU 窗口让两者同时通过检查，
      // DB 层部分唯一索引（idx_users_single_owner）收口——后落库者撞 23505 → 服务层转 409；
      // 若某一请求的 isInitialized 已读到对方提交的 Owner，则直接 409。
      // 两条路径都保证恰一个 201、一个 409，绝无双 Owner（见 user.entity.ts 索引注释）。
      const [r1, r2] = await Promise.all([
        request(server).post('/api/v1/auth/init').send({
          email: concurrentEmails[0],
          password: 'Owner123456',
          name: '并发甲',
        }),
        request(server).post('/api/v1/auth/init').send({
          email: concurrentEmails[1],
          password: 'Owner123456',
          name: '并发乙',
        }),
      ]);
      const statuses = [r1.status, r2.status].sort((a, b) => a - b);
      expect(statuses[0]).toBe(201);
      expect(statuses[1]).toBe(409);
      // 唯一 super 不变量：全库恰一条 role=super（部分唯一索引兜底）
      const rows = (await dataSource.query(
        `SELECT COUNT(*)::int AS count FROM users WHERE role = 'super'`,
      )) as { count: number }[];
      expect(rows[0].count).toBe(1);
      // 清理赢家（201）签发的 refresh token 的 rt:{id}:* 键：用户 id 取响应体——
      // 本用例 TRUNCATE 了 users 表，afterAll 按 email 查库会查不到该用户，
      // 若不在此清理，该 rt 键将成为共享 Redis 中的孤儿（见任务书 0.7 复审）。
      const winner = r1.status === 201 ? r1 : r2;
      const redisClient = app.get(RedisService).getClient();
      const rtKeys = await redisClient.keys(`rt:${winner.body.user.id}:*`);
      if (rtKeys.length > 0) await redisClient.del(...rtKeys);
      // 恢复无用户状态：后续 init 用例依赖「测试库无用户」的初始判定
      await dataSource.query('TRUNCATE TABLE users, invitations CASCADE');
    });
  });

  it('GET /api/v1/auth/init-status 初始状态返回 { initialized: false }', async () => {
    const res = await request(server).get('/api/v1/auth/init-status');
    expect(res.status).toBe(200);
    expect(res.body.initialized).toBe(false);
  });

  it('POST /api/v1/auth/init 创建 Owner 账号并返回 token', async () => {
    const res = await request(server)
      .post('/api/v1/auth/init')
      .send({ email: ownerEmail, password: 'Owner123456', name: '初始所有者' });
    expect(res.status).toBe(201);
    expect(res.body.accessToken).toBeDefined();
    expect(res.body.refreshToken).toBeDefined();
    expect(res.body.user).toMatchObject({ email: ownerEmail, role: 'super' });
  });

  it('GET /api/v1/auth/init-status 初始化后返回 { initialized: true }', async () => {
    const res = await request(server).get('/api/v1/auth/init-status');
    expect(res.status).toBe(200);
    expect(res.body.initialized).toBe(true);
  });

  it('POST /api/v1/auth/init 已有用户时返回 409', async () => {
    const res = await request(server).post('/api/v1/auth/init').send({
      email: 'second-owner@ohmydocagent.local',
      password: 'Owner123456',
      name: '第二个',
    });
    expect(res.status).toBe(409);
  });
});
