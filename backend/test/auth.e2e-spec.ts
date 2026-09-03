// backend/test/auth.e2e-spec.ts
// 认证全链路 e2e：注册/登录/刷新/登出/鉴权
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { prepareTestEnv } from './test-db.js';
import { configureApp } from '../src/app.setup.js';
import { User } from '../src/modules/users/user.entity.js';
import { RedisService } from '../src/redis/redis.service.js';

describe('Auth (e2e)', () => {
  let app: INestApplication;
  let server: any;
  const email = `auth-test-${Date.now()}@ohmydocagent.local`;

  beforeAll(async () => {
    await prepareTestEnv();
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    server = app.getHttpServer();
  });

  afterAll(async () => {
    // 清理本测试用户产生的 refresh token 键（Redis 为共享实例，避免污染开发会话）
    const userRepo = app.get(getRepositoryToken(User));
    const testUser = await userRepo.findOne({ where: { email } });
    if (testUser) {
      const redis = app.get(RedisService);
      const client = redis.getClient();
      const keys = await client.keys(`rt:${testUser.id}:*`);
      if (keys.length > 0) await client.del(...keys);
    }
    await app.close();
  });

  it('POST /api/v1/auth/register 注册用户并返回 token', async () => {
    const res = await request(server)
      .post('/api/v1/auth/register')
      .send({ email, password: 'Test123456', name: '测试用户' });
    expect(res.status).toBe(201);
    expect(res.body.accessToken).toBeDefined();
    expect(res.body.user).toMatchObject({ email, name: '测试用户' });
    expect(res.body.user.passwordHash).toBeUndefined();
  });

  it('POST /api/v1/auth/login 用新用户凭证登录成功', async () => {
    const res = await request(server)
      .post('/api/v1/auth/login')
      .send({ email, password: 'Test123456' });
    expect(res.status).toBe(201);
    expect(res.body.accessToken).toBeDefined();
    expect(res.body.refreshToken).toBeDefined();
  });

  it('POST /api/v1/auth/login 错误密码返回 401', async () => {
    const res = await request(server)
      .post('/api/v1/auth/login')
      .send({ email, password: 'WrongPass123' });
    expect(res.status).toBe(401);
  });

  it('GET /api/v1/auth/me 无 token 返回 401', async () => {
    const res = await request(server).get('/api/v1/auth/me');
    expect(res.status).toBe(401);
  });

  it('GET /api/v1/auth/me 带 token 返回用户信息（不含密码哈希）', async () => {
    const login = await request(server)
      .post('/api/v1/auth/login')
      .send({ email, password: 'Test123456' });
    const res = await request(server)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${login.body.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ email });
    expect(res.body.passwordHash).toBeUndefined();
  });

  it('POST /api/v1/auth/refresh 用 refreshToken 换新 accessToken', async () => {
    const login = await request(server)
      .post('/api/v1/auth/login')
      .send({ email, password: 'Test123456' });
    const res = await request(server)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: login.body.refreshToken });
    expect(res.status).toBe(201);
    expect(res.body.accessToken).toBeDefined();
  });

  it('POST /api/v1/auth/logout 使 refreshToken 失效', async () => {
    const login = await request(server)
      .post('/api/v1/auth/login')
      .send({ email, password: 'Test123456' });
    await request(server)
      .post('/api/v1/auth/logout')
      .send({ refreshToken: login.body.refreshToken });
    const res = await request(server)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: login.body.refreshToken });
    expect(res.status).toBe(401);
  });

  it('POST /api/v1/auth/refresh 旋转后旧 refreshToken 重放返回 401（C1 防重放）', async () => {
    const login = await request(server)
      .post('/api/v1/auth/login')
      .send({ email, password: 'Test123456' });
    const first = await request(server)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: login.body.refreshToken });
    expect(first.status).toBe(201);
    expect(first.body.refreshToken).toBeDefined();
    // 旋转后旧 refreshToken 的 jti 已被原子删除，重放必须 401
    const replay = await request(server)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: login.body.refreshToken });
    expect(replay.status).toBe(401);
  });

  it('GET /api/v1/auth/me 非法签名 token 返回 401', async () => {
    const res = await request(server)
      .get('/api/v1/auth/me')
      .set('Authorization', 'Bearer invalid.token.here');
    expect(res.status).toBe(401);
  });

  it('用户被删除后旧 accessToken 立即失效（JwtStrategy 查库）', async () => {
    const deletedEmail = `deleted-${Date.now()}@ohmydocagent.local`;
    const reg = await request(server).post('/api/v1/auth/register').send({
      email: deletedEmail,
      password: 'Test123456',
      name: '将被删除',
    });
    expect(reg.status).toBe(201);
    const userRepo = app.get(getRepositoryToken(User));
    const deletedUser = await userRepo.findOne({
      where: { email: deletedEmail },
    });
    expect(deletedUser).not.toBeNull();
    // 从数据库删除用户后，旧 accessToken 应立即失效（策略每次请求查库）
    await userRepo.delete({ email: deletedEmail });
    const res = await request(server)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${reg.body.accessToken}`);
    expect(res.status).toBe(401);
    // 清理该用户残留的 refresh token 键（与 afterAll 同样理由，避免污染共享 Redis）
    const redis = app.get(RedisService);
    const client = redis.getClient();
    const keys = await client.keys(`rt:${deletedUser!.id}:*`);
    if (keys.length > 0) await client.del(...keys);
  });

  it('POST /api/v1/auth/register 重复邮箱返回 409', async () => {
    const res = await request(server)
      .post('/api/v1/auth/register')
      .send({ email, password: 'Test123456', name: '重复' });
    expect(res.status).toBe(409);
  });

  it('POST /api/v1/auth/register 弱密码被 ValidationPipe 拒绝（400）', async () => {
    const res = await request(server)
      .post('/api/v1/auth/register')
      .send({
        email: `weak-${Date.now()}@ohmydocagent.local`,
        password: '123',
        name: '弱密码',
      });
    expect(res.status).toBe(400);
  });
});
