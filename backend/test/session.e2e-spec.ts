// 会话管理 e2e（Task 2.1）：
// 会话 CRUD（默认标题「新会话」/kbIds 宽松校验/重命名/更新 kbIds/置顶取消置顶）、
// 分页列表（置顶优先 + updatedAt DESC + 消息数聚合）、消息列表（createdAt 升序）、
// 批量删除（宽容：只删本人的，跨用户 id 跳过）、清空消息（会话保留）、
// 删除级联删消息、会话归属权限（用户 B 操作用户 A 的会话 → 403）、404 语义。
// 消息写入在 Task 2.2 之前没有公开端点，测试直接 SQL 插入 messages 行
// （与 vector.e2e 直插 chunks 同模式），验证列表消息数/消息列表/级联删除。
// 说明：kbIds 采用宽松校验（不校验知识库存在——UI 层 @提及/选择器保证有效，
// 见 SessionService.create 注释），测试用 randomUUID() 生成不存在的 kbId 即验证该语义。
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../src/app.module.js';
import { prepareTestEnv } from './test-db.js';
import { configureApp } from '../src/app.setup.js';
import { User } from '../src/modules/users/user.entity.js';
import { Session } from '../src/modules/chat/session.entity.js';
import { Message } from '../src/modules/chat/message.entity.js';
import { RedisService } from '../src/redis/redis.service.js';
import { getQueueToken } from '@nestjs/bullmq';
import { GRAPH_QUEUE } from '../src/modules/graph/graph-queue.constants.js';

describe('Chat Sessions (e2e)', () => {
  let app: INestApplication;
  let server: any;
  let dataSource: DataSource;
  const ownerEmail = 'chat-owner@ohmydocagent.local';
  const userBEmail = 'chat-userb@ohmydocagent.local';
  let ownerToken = '';
  let userBToken = '';
  // 本文件创建的用户邮箱：afterAll 统一清理其 rt:* 键（共享 Redis 隔离，沿用既有约定）
  const testEmails = [ownerEmail, userBEmail];
  // owner 的主会话（重命名/更新 kbIds/置顶/详情/归属 403 等用例复用）
  let sessionA = '';
  // userB 的会话：批量删除宽容语义（跨用户 id 跳过）与归属 403 用
  let sessionB = '';
  // kbIds 宽松校验：随机构造不存在的知识库 id（不校验存在性，见文件头注释）
  const kbId1 = randomUUID();
  const kbId2 = randomUUID();

  beforeAll(async () => {
    await prepareTestEnv();
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    // 测试隔离（沿用既有约定）：先清子表 messages 再清主表 sessions，
    // 与 users/invitations 一并显式列入清单（本任务新增两张表）；另加
    // knowledge 系列表 + GRAPH_QUEUE 清空（Task 3.2 同步：上一 e2e 文件的
    // 文档图谱 job 带 backoff 重试迟到时，knowledge 行被清 → ExtractProcessor
    // 404 no-op 不调 chat——本文件未 override ChatModelService，避免重试
    // 打到真实 LLM，见 extract.processor.ts 注释）
    dataSource = moduleRef.get(DataSource);
    await dataSource.query(
      'TRUNCATE TABLE users, invitations, messages, sessions, knowledge_bases, knowledge, chunk_revisions, chunks CASCADE',
    );
    const graphQueue = moduleRef.get(getQueueToken(GRAPH_QUEUE));
    await graphQueue.obliterate({ force: true });
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    server = app.getHttpServer();
    // 前置：init 创建 Owner（全局守卫要求所有会话路由登录）
    const initRes = await request(server).post('/api/v1/auth/init').send({
      email: ownerEmail,
      password: 'Owner123456',
      name: '会话测试所有者',
    });
    expect(initRes.status).toBe(201);
    ownerToken = initRes.body.accessToken as string;
    // 前置：公开注册第二个用户（默认角色 admin），用于会话归属权限验证
    const regRes = await request(server).post('/api/v1/auth/register').send({
      email: userBEmail,
      password: 'Admin123456',
      name: '会话测试用户乙',
    });
    expect(regRes.status).toBe(201);
    userBToken = regRes.body.accessToken as string;
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

  /** 助手：以指定 token 创建会话 */
  function createSession(token: string, body: Record<string, unknown>) {
    return request(server)
      .post('/api/v1/chat/sessions')
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  }

  /** 助手：直接 SQL 插入一条消息（Task 2.2 前无公开消息写入端点） */
  async function insertMessage(
    sessionId: string,
    content: string,
    ageSeconds: number,
  ): Promise<void> {
    await dataSource.query(
      `INSERT INTO messages (id, "sessionId", role, content, "createdAt")
       VALUES ($1, $2, 'user', $3, now() - ($4 || ' seconds')::interval)`,
      [randomUUID(), sessionId, content, ageSeconds],
    );
  }

  it('POST /api/v1/chat/sessions 创建会话（默认标题"新会话"，kbIds 可指定，201）', async () => {
    const res = await request(server)
      .post('/api/v1/chat/sessions')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({});
    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.title).toBe('新会话');
    expect(res.body.kbIds).toEqual([]);
    expect(res.body.pinned).toBe(false);
    expect(res.body.pinnedAt).toBeNull();
    expect(res.body.userId).toBeDefined();
    expect(res.body.createdAt).toBeDefined();
    expect(res.body.updatedAt).toBeDefined();
    sessionA = res.body.id as string;
  });

  it('POST /api/v1/chat/sessions 带 kbIds 创建（数组校验）', async () => {
    // 合法：uuid 数组原样保存（宽松校验，不校验知识库存在）
    const ok = await createSession(ownerToken, { kbIds: [kbId1, kbId2] });
    expect(ok.status).toBe(201);
    expect(ok.body.kbIds).toEqual([kbId1, kbId2]);
    // 非法：非数组
    const notArray = await createSession(ownerToken, { kbIds: 'x' });
    expect(notArray.status).toBe(400);
    // 非法：数组内含非 uuid
    const badUuid = await createSession(ownerToken, { kbIds: ['not-a-uuid'] });
    expect(badUuid.status).toBe(400);
    // 非法：数组超上限（>50）
    const tooMany = await createSession(ownerToken, {
      kbIds: Array.from({ length: 51 }, () => randomUUID()),
    });
    expect(tooMany.status).toBe(400);
    // 非法：title 超长（>100）
    const longTitle = await createSession(ownerToken, {
      title: '长'.repeat(101),
    });
    expect(longTitle.status).toBe(400);
  });

  it('POST /api/v1/chat/sessions 未登录 401', async () => {
    const res = await request(server).post('/api/v1/chat/sessions').send({});
    expect(res.status).toBe(401);
  });

  it('GET /api/v1/chat/sessions 列表（分页，含 pinned 分组、消息数、更新时间，按 updatedAt DESC）', async () => {
    // 给 sessionA 直插两条消息：验证列表 messageCount 聚合
    await insertMessage(sessionA, '第一条历史消息', 300);
    await insertMessage(sessionA, '第二条历史消息', 120);
    const res = await request(server)
      .get('/api/v1/chat/sessions?page=1&pageSize=10')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.page).toBe(1);
    expect(res.body.pageSize).toBe(10);
    expect(res.body.total).toBeGreaterThanOrEqual(2);
    // 按 updatedAt DESC：第二个创建（带 kbIds 的会话）应排最前
    const items = res.body.items as any[];
    expect(items.length).toBeGreaterThanOrEqual(2);
    expect(items[1].id).toBe(sessionA);
    // 消息数聚合：sessionA 两条消息
    const sessionAItem = items.find((i: any) => i.id === sessionA);
    expect(sessionAItem).toBeDefined();
    expect(sessionAItem.messageCount).toBe(2);
    // pinned 字段 + 更新时间
    expect(sessionAItem.pinned).toBe(false);
    expect(sessionAItem.updatedAt).toBeDefined();
    // 用户维度隔离：userB 列表看不到 owner 的会话
    const bList = await request(server)
      .get('/api/v1/chat/sessions?page=1&pageSize=10')
      .set('Authorization', `Bearer ${userBToken}`);
    expect(bList.status).toBe(200);
    expect(bList.body.total).toBe(0);
  });

  it('title 校验：空串/纯空白 → 400（POST/PUT），环绕空白合法标题 trim 后保存', async () => {
    // POST：title='' / title='   ' → 400（trim 后为空串，被 @MinLength(1) 拦下；
    // 默认标题「新会话」只对缺省 title 生效，空串不能绕过默认值）
    const empty = await createSession(ownerToken, { title: '' });
    expect(empty.status).toBe(400);
    const blank = await createSession(ownerToken, { title: '   ' });
    expect(blank.status).toBe(400);
    // PUT 同规则（更新不接受非法值，与创建校验同步）
    const putEmpty = await request(server)
      .put(`/api/v1/chat/sessions/${sessionA}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ title: '' });
    expect(putEmpty.status).toBe(400);
    const putBlank = await request(server)
      .put(`/api/v1/chat/sessions/${sessionA}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ title: '   ' });
    expect(putBlank.status).toBe(400);
    // 环绕空白是合法输入：trim 后保存（用独立会话验证，不干扰 sessionA 的排序）
    const fresh = await createSession(ownerToken, { title: '  环绕空白  ' });
    expect(fresh.status).toBe(201);
    expect(fresh.body.title).toBe('环绕空白');
  });

  it('PUT /api/v1/chat/sessions/:id 重命名（title 更新，200）', async () => {
    const res = await request(server)
      .put(`/api/v1/chat/sessions/${sessionA}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ title: '对话研发知识库' });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(sessionA);
    expect(res.body.title).toBe('对话研发知识库');
    // 未传字段保持原值（只更新传入字段的语义）
    expect(res.body.kbIds).toEqual([]);
  });

  it('PUT /api/v1/chat/sessions/:id 空更新 {}：不刷新 updatedAt（避免列表跳顶）', async () => {
    // 空更新不落库：updatedAt 保持不变（列表按 updatedAt DESC 排序，空更新
    // 刷新时间戳会让会话「跳顶」，见 SessionService.update 注释）
    const created = await createSession(ownerToken, { title: '空更新会话' });
    expect(created.status).toBe(201);
    const sid = created.body.id as string;
    const before = await request(server)
      .get(`/api/v1/chat/sessions/${sid}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(before.status).toBe(200);
    const put = await request(server)
      .put(`/api/v1/chat/sessions/${sid}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({});
    expect(put.status).toBe(200);
    const after = await request(server)
      .get(`/api/v1/chat/sessions/${sid}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(after.status).toBe(200);
    expect(after.body.updatedAt).toBe(before.body.updatedAt);
  });

  it('PUT /api/v1/chat/sessions/:id 更新 kbIds（关联知识库列表）', async () => {
    const res = await request(server)
      .put(`/api/v1/chat/sessions/${sessionA}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ kbIds: [kbId1] });
    expect(res.status).toBe(200);
    expect(res.body.kbIds).toEqual([kbId1]);
    // 清空 kbIds（空数组合法，解除全部关联）
    const cleared = await request(server)
      .put(`/api/v1/chat/sessions/${sessionA}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ kbIds: [] });
    expect(cleared.status).toBe(200);
    expect(cleared.body.kbIds).toEqual([]);
    // 非法 kbIds 更新 → 400
    const bad = await request(server)
      .put(`/api/v1/chat/sessions/${sessionA}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ kbIds: ['not-a-uuid'] });
    expect(bad.status).toBe(400);
  });

  it('PUT /api/v1/chat/sessions/:id 置顶/取消置顶（pinned 字段设置）', async () => {
    const pin = await request(server)
      .put(`/api/v1/chat/sessions/${sessionA}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ pinned: true });
    expect(pin.status).toBe(200);
    expect(pin.body.pinned).toBe(true);
    expect(pin.body.pinnedAt).toBeDefined();
    const unpin = await request(server)
      .put(`/api/v1/chat/sessions/${sessionA}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ pinned: false });
    expect(unpin.status).toBe(200);
    expect(unpin.body.pinned).toBe(false);
    expect(unpin.body.pinnedAt).toBeNull();
  });

  it('GET /api/v1/chat/sessions/:id 详情（含 kbIds）', async () => {
    const res = await request(server)
      .get(`/api/v1/chat/sessions/${sessionA}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(sessionA);
    expect(res.body.title).toBe('对话研发知识库');
    expect(res.body.kbIds).toEqual([]);
    expect(res.body.pinned).toBe(false);
  });

  it('DELETE /api/v1/chat/sessions/:id 删除（级联删消息）', async () => {
    const created = await createSession(ownerToken, {});
    expect(created.status).toBe(201);
    const sid = created.body.id as string;
    await insertMessage(sid, '删除前的消息', 60);
    const messageRepo = app.get(getRepositoryToken(Message));
    const before = await messageRepo.count({ where: { sessionId: sid } });
    expect(before).toBe(1);
    const del = await request(server)
      .delete(`/api/v1/chat/sessions/${sid}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(del.status).toBe(204);
    // 级联：消息同步删除，无残留
    const after = await messageRepo.count({ where: { sessionId: sid } });
    expect(after).toBe(0);
    // 删除后详情 404（硬删除语义）
    const res = await request(server)
      .get(`/api/v1/chat/sessions/${sid}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(404);
  });

  it('DELETE /api/v1/chat/sessions/batch 批量删除（ids 数组）', async () => {
    // userB 的会话（跨用户宽容语义的目标）——归属 403 用例也会用到
    const bCreate = await createSession(userBToken, {});
    expect(bCreate.status).toBe(201);
    sessionB = bCreate.body.id as string;
    // owner 三个待删会话：删其中两个 + 混入 userB 的 id（应跳过）
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await createSession(ownerToken, {});
      expect(r.status).toBe(201);
      ids.push(r.body.id as string);
    }
    const res = await request(server)
      .delete('/api/v1/chat/sessions/batch')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ ids: [ids[0], ids[1], sessionB] });
    expect(res.status).toBe(200);
    // 宽容语义：只删本人的 → deleted=2（sessionB 不属于 owner，跳过）
    expect(res.body.deleted).toBe(2);
    // 验证：两个 owner 会话已删、第三个还在、userB 的会话未受影响
    for (const id of [ids[0], ids[1]]) {
      const gone = await request(server)
        .get(`/api/v1/chat/sessions/${id}`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(gone.status).toBe(404);
    }
    const kept = await request(server)
      .get(`/api/v1/chat/sessions/${ids[2]}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(kept.status).toBe(200);
    const bSession = await request(server)
      .get(`/api/v1/chat/sessions/${sessionB}`)
      .set('Authorization', `Bearer ${userBToken}`);
    expect(bSession.status).toBe(200);
    // 非法 ids → 400（非数组 / 空数组 / 含非 uuid）
    const notArray = await request(server)
      .delete('/api/v1/chat/sessions/batch')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ ids: 'x' });
    expect(notArray.status).toBe(400);
    const empty = await request(server)
      .delete('/api/v1/chat/sessions/batch')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ ids: [] });
    expect(empty.status).toBe(400);
    const badUuid = await request(server)
      .delete('/api/v1/chat/sessions/batch')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ ids: ['not-a-uuid'] });
    expect(badUuid.status).toBe(400);
  });

  it('DELETE /api/v1/chat/sessions/:id/messages 清空消息（会话保留，消息数 0）', async () => {
    const created = await createSession(ownerToken, {
      title: '清空消息的会话',
    });
    expect(created.status).toBe(201);
    const sid = created.body.id as string;
    await insertMessage(sid, '待清空消息一', 120);
    await insertMessage(sid, '待清空消息二', 60);
    const res = await request(server)
      .delete(`/api/v1/chat/sessions/${sid}/messages`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(204);
    // 消息清空
    const list = await request(server)
      .get(`/api/v1/chat/sessions/${sid}/messages`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(0);
    // 会话保留（详情仍可访问）
    const detail = await request(server)
      .get(`/api/v1/chat/sessions/${sid}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(detail.status).toBe(200);
    expect(detail.body.title).toBe('清空消息的会话');
  });

  it('GET /api/v1/chat/sessions/:id/messages 消息列表（createdAt 升序，分页）', async () => {
    const created = await createSession(ownerToken, { title: '消息列表会话' });
    expect(created.status).toBe(201);
    const sid = created.body.id as string;
    // 三条消息，创建时间间隔 1 分钟（age 越大越旧）：验证 createdAt 升序
    await insertMessage(sid, '最早的消息', 180);
    await insertMessage(sid, '中间的消息', 120);
    await insertMessage(sid, '最新的消息', 60);
    const page1 = await request(server)
      .get(`/api/v1/chat/sessions/${sid}/messages?page=1&pageSize=2`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(page1.status).toBe(200);
    expect(page1.body.total).toBe(3);
    expect(page1.body.page).toBe(1);
    expect(page1.body.pageSize).toBe(2);
    expect(page1.body.items).toHaveLength(2);
    // createdAt 升序：第 1 页 = 最早两条
    expect(page1.body.items[0].content).toBe('最早的消息');
    expect(page1.body.items[1].content).toBe('中间的消息');
    const page2 = await request(server)
      .get(`/api/v1/chat/sessions/${sid}/messages?page=2&pageSize=2`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(page2.status).toBe(200);
    expect(page2.body.items).toHaveLength(1);
    expect(page2.body.items[0].content).toBe('最新的消息');
  });

  it('会话归属：用户 B 操作用户 A 的会话 → 403（GET/PUT/DELETE/messages）', async () => {
    // sessionA 属于 owner（测试 1 创建）；userB 全部操作应 403
    const get = await request(server)
      .get(`/api/v1/chat/sessions/${sessionA}`)
      .set('Authorization', `Bearer ${userBToken}`);
    expect(get.status).toBe(403);
    const put = await request(server)
      .put(`/api/v1/chat/sessions/${sessionA}`)
      .set('Authorization', `Bearer ${userBToken}`)
      .send({ title: '越权改名' });
    expect(put.status).toBe(403);
    const del = await request(server)
      .delete(`/api/v1/chat/sessions/${sessionA}`)
      .set('Authorization', `Bearer ${userBToken}`);
    expect(del.status).toBe(403);
    const messages = await request(server)
      .get(`/api/v1/chat/sessions/${sessionA}/messages`)
      .set('Authorization', `Bearer ${userBToken}`);
    expect(messages.status).toBe(403);
    const clear = await request(server)
      .delete(`/api/v1/chat/sessions/${sessionA}/messages`)
      .set('Authorization', `Bearer ${userBToken}`);
    expect(clear.status).toBe(403);
    // 反向验证：owner 自己的会话仍可正常访问（403 未误伤）
    const own = await request(server)
      .get(`/api/v1/chat/sessions/${sessionA}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(own.status).toBe(200);
  });

  it('会话不存在 404（GET/PUT/DELETE/messages 列表与清空）', async () => {
    const missingId = '00000000-0000-4000-8000-000000000000';
    const get = await request(server)
      .get(`/api/v1/chat/sessions/${missingId}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(get.status).toBe(404);
    const put = await request(server)
      .put(`/api/v1/chat/sessions/${missingId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ title: '不存在' });
    expect(put.status).toBe(404);
    const del = await request(server)
      .delete(`/api/v1/chat/sessions/${missingId}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(del.status).toBe(404);
    const messages = await request(server)
      .get(`/api/v1/chat/sessions/${missingId}/messages`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(messages.status).toBe(404);
    const clear = await request(server)
      .delete(`/api/v1/chat/sessions/${missingId}/messages`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(clear.status).toBe(404);
    // 非 UUID 格式 id 一律 404（不泄露 500，22P02 兜底）
    const notUuid = await request(server)
      .get('/api/v1/chat/sessions/not-a-uuid')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(notUuid.status).toBe(404);
  });

  it('GET /api/v1/chat/sessions 置顶会话排在最前', async () => {
    // 重新置顶 sessionA，再新建一个更新更晚的对照会话：置顶必须排最前
    const pinRes = await request(server)
      .put(`/api/v1/chat/sessions/${sessionA}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ pinned: true });
    expect(pinRes.status).toBe(200);
    expect(pinRes.body.pinned).toBe(true);
    const newer = await createSession(ownerToken, { title: '排序对照会话' });
    expect(newer.status).toBe(201);
    const res = await request(server)
      .get('/api/v1/chat/sessions?page=1&pageSize=20')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    const first = res.body.items[0];
    expect(first.id).toBe(sessionA);
    expect(first.pinned).toBe(true);
    // 其余项均为未置顶（本文件仅 owner 置顶过 sessionA）
    for (const item of res.body.items.slice(1)) {
      expect(item.pinned).toBe(false);
    }
    // 置顶状态已落库（DB 校验，防只改排序不动字段的伪实现）
    const sessionRepo = app.get(getRepositoryToken(Session));
    const owner = await app
      .get(getRepositoryToken(User))
      .findOneOrFail({ where: { email: ownerEmail } });
    const pinnedCount = await sessionRepo.count({
      where: { userId: owner.id, pinned: true },
    });
    expect(pinnedCount).toBeGreaterThanOrEqual(1);
  });
});
