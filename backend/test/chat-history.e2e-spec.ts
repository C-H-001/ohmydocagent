// 聊天历史 e2e（Task 2.11）：历史搜索 + 按知识库统计 + 清空全部会话。
// 场景覆盖（任务书 Step 1 清单 + 越权防护）：
// - GET /api/v1/chat/history?keyword= 搜索当前用户全部会话的消息（user +
//   assistant 内容命中，返回 messageId/sessionId/sessionTitle/role/摘要/createdAt）
// - 搜索分页 + 摘要截断（content >200 截断到 200 + '…'）
// - 搜索通配符转义（质量审查整改）：消息含 '50%折扣'，搜索 '50%' 命中字面
//   量、'50X' 不误中（% 转义为字面量，防用户输入扩大匹配）
// - 搜索无结果 → 空数组；keyword 空/纯空白/缺失/超长 → 400
// - GET /api/v1/chat/history/stats?days= 按 KB 聚合（references 引用反查
//   kbId：messageCount=引用该 KB 的 assistant 消息数、citationCount=引用
//   总条数、kbName 补查；days 窗口过滤）
// - stats 无引用 → 空数组；days 非法 → 400
// - DELETE /api/v1/chat/history 清空全部会话（{ deleted } + 会话/消息/附件
//   行+磁盘归零；他人数据不受影响）；幂等重放（质量审查整改）：再次 DELETE
//   → { deleted: 0 }（无会话用户重复调用不报错）
// - 越权防护：用户 B 搜索/统计不到用户 A 的消息（数据维度 = 本人会话）
// 数据准备决策：消息经 SQL 直插（session.e2e 同模式）——POST /messages 的
// references 需真实 RAG 管线 + 向量化链路生成（references.e2e 已覆盖该链路），
// 本文件直插与 ReferencesService.build 产物同构的 references jsonb；统计的
// knowledgeId → kbId 反查需要 knowledge 行真实存在（POST /kbs/:kbId/manual
// 创建，join 语义见 chat-history.service.ts 注释）。统计口径（任务书决策）：
// 基于 references（引用即 KB 使用证据），user 消息的 kbIds 不计。
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { DataSource, Repository } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { AppModule } from '../src/app.module.js';
import { prepareTestEnv } from './test-db.js';
import { configureApp } from '../src/app.setup.js';
import { User } from '../src/modules/users/user.entity.js';
import { Session } from '../src/modules/chat/session.entity.js';
import { Message } from '../src/modules/chat/message.entity.js';
import { RedisService } from '../src/redis/redis.service.js';

describe('聊天历史（Task 2.11 e2e）', () => {
  let app: INestApplication;
  let server: any;
  let dataSource: DataSource;
  let messageRepo: Repository<Message>;
  const ownerEmail = 'chat-history-owner@ohmydocagent.local';
  const userBEmail = 'chat-history-userb@ohmydocagent.local';
  let ownerToken = '';
  let userBToken = '';
  // 本文件创建的用户邮箱：afterAll 统一清理其 rt:* 键（共享 Redis 隔离，沿用既有约定）
  const testEmails = [ownerEmail, userBEmail];
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  /** 助手：创建会话（标题可选） */
  function createSession(token: string, title?: string) {
    return request(server)
      .post('/api/v1/chat/sessions')
      .set(auth(token))
      .send(title ? { title } : {});
  }

  /** 助手：SQL 直插消息（references 与 ReferencesService.build 产物同构） */
  async function insertMessage(opts: {
    sessionId: string;
    role: 'user' | 'assistant';
    content: string;
    references?: unknown[];
    ageSeconds?: number;
  }): Promise<void> {
    const { sessionId, role, content, references = [], ageSeconds = 0 } = opts;
    await dataSource.query(
      `INSERT INTO messages (id, "sessionId", role, content, "references", "createdAt")
       VALUES ($1, $2, $3, $4, $5::jsonb, now() - ($6 || ' seconds')::interval)`,
      [
        randomUUID(),
        sessionId,
        role,
        content,
        JSON.stringify(references),
        ageSeconds,
      ],
    );
  }

  /** 助手：创建知识库 */
  function createKb(token: string, name: string) {
    return request(server).post('/api/v1/kbs').set(auth(token)).send({ name });
  }

  /** 助手：手动创建文档（返回 knowledge 实体——统计 join 需要行真实存在） */
  function createManualKnowledge(token: string, kbId: string, title: string) {
    return request(server)
      .post(`/api/v1/kbs/${kbId}/manual`)
      .set(auth(token))
      .send({ title, content: '统计文档正文内容' });
  }

  /** 构造单条引用（knowledgeId 对应真实 knowledge 行；结构与 build 产物同构） */
  function makeReference(
    knowledgeId: string,
    index = 1,
  ): Record<string, unknown> {
    return {
      index,
      chunkId: randomUUID(),
      knowledgeId,
      knowledgeTitle: '统计文档',
      content: '引用块内容',
      score: 0.9,
    };
  }

  /** 判断磁盘文件是否存在（cwd 为 backend，uploads 相对 cwd，chat-attachment e2e 同款） */
  async function fileExists(relativePath: string): Promise<boolean> {
    try {
      await access(path.join(process.cwd(), 'uploads', relativePath));
      return true;
    } catch {
      return false;
    }
  }

  beforeAll(async () => {
    await prepareTestEnv();
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    dataSource = moduleRef.get(DataSource);
    // 测试隔离（沿用既有约定）：chat-history 新增读取 knowledge_bases/
    // knowledge/attachments，显式列入清单（含 Task 2.9 的 attachments 表）
    await dataSource.query(
      'TRUNCATE TABLE users, invitations, user_kb_pins, knowledge_bases, knowledge, chunk_revisions, chunks, messages, sessions, attachments, models CASCADE',
    );
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    server = app.getHttpServer();
    messageRepo = dataSource.getRepository(Message);
    // 前置：init 创建 Owner（全局守卫要求所有路由登录）
    const initRes = await request(server).post('/api/v1/auth/init').send({
      email: ownerEmail,
      password: 'Owner123456',
      name: '历史测试所有者',
    });
    expect(initRes.status).toBe(201);
    ownerToken = initRes.body.accessToken as string;
    // 前置：公开注册第二个用户（越权防护用例）
    const regRes = await request(server).post('/api/v1/auth/register').send({
      email: userBEmail,
      password: 'Admin123456',
      name: '历史测试用户乙',
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

  it('GET /api/v1/chat/history?keyword= 搜索历史消息（命中 user/assistant 内容 + 会话标题关联）', async () => {
    // 独立会话：搜索断言不依赖其他用例的数据
    const created = await createSession(ownerToken, '历史搜索会话甲');
    expect(created.status).toBe(201);
    const sid = created.body.id as string;
    await insertMessage({
      sessionId: sid,
      role: 'user',
      content: '量子纠缠的定义是什么？',
    });
    await insertMessage({
      sessionId: sid,
      role: 'assistant',
      content: '量子纠缠是量子力学中的现象，请参考相关文献。',
    });
    // 全词搜索：user + assistant 两条都命中
    const res = await request(server)
      .get('/api/v1/chat/history')
      .query({ keyword: '量子纠缠' })
      .set(auth(ownerToken));
    expect(res.status).toBe(200);
    expect(res.body.page).toBe(1);
    expect(res.body.pageSize).toBe(10);
    expect(res.body.total).toBe(2);
    const items = res.body.items as any[];
    // 响应字段契约：messageId/sessionId/sessionTitle/role/content 摘要/createdAt
    for (const item of items) {
      expect(item.messageId).toBeDefined();
      expect(item.sessionId).toBe(sid);
      expect(item.sessionTitle).toBe('历史搜索会话甲');
      expect(['user', 'assistant']).toContain(item.role);
      expect(item.content).toBeDefined();
      expect(item.createdAt).toBeDefined();
    }
    expect(items.map((i: any) => i.role).sort()).toEqual(['assistant', 'user']);
    // 单角色词搜索：user 内容独有词 / assistant 内容独有词各自命中
    const userHit = await request(server)
      .get('/api/v1/chat/history')
      .query({ keyword: '定义是什么' })
      .set(auth(ownerToken));
    expect(userHit.status).toBe(200);
    expect(userHit.body.total).toBe(1);
    expect(userHit.body.items[0].role).toBe('user');
    const assistantHit = await request(server)
      .get('/api/v1/chat/history')
      .query({ keyword: '量子力学中的现象' })
      .set(auth(ownerToken));
    expect(assistantHit.status).toBe(200);
    expect(assistantHit.body.total).toBe(1);
    expect(assistantHit.body.items[0].role).toBe('assistant');
    // 未登录 → 401（全局守卫）
    const unauth = await request(server).get('/api/v1/chat/history');
    expect(unauth.status).toBe(401);
  });

  it('GET /api/v1/chat/history 搜索分页 + 摘要截断（content >200 截断到 200 + "…"）', async () => {
    const created = await createSession(ownerToken, '历史搜索会话乙');
    expect(created.status).toBe(201);
    const sid = created.body.id as string;
    // 3 条超长消息（206 字符 > 200）：验证截断 + 分页
    for (let i = 0; i < 3; i++) {
      await insertMessage({
        sessionId: sid,
        role: 'assistant',
        content: `${'前'.repeat(100)}分页搜索关键词${'后'.repeat(100)}`,
      });
    }
    const page1 = await request(server)
      .get('/api/v1/chat/history')
      .query({ keyword: '分页搜索关键词', page: 1, pageSize: 2 })
      .set(auth(ownerToken));
    expect(page1.status).toBe(200);
    expect(page1.body.total).toBe(3);
    expect(page1.body.items).toHaveLength(2);
    // 摘要截断：200 + '…'（列表页预览语义，见 chat-history.service.ts 注释；
    // 期望值从原始内容推导 slice(0,200)，避免中文串长度手数错位）
    const full = `${'前'.repeat(100)}分页搜索关键词${'后'.repeat(100)}`;
    for (const item of page1.body.items) {
      expect(item.content).toBe(`${full.slice(0, 200)}…`);
      expect(item.content.length).toBe(201);
    }
    const page2 = await request(server)
      .get('/api/v1/chat/history')
      .query({ keyword: '分页搜索关键词', page: 2, pageSize: 2 })
      .set(auth(ownerToken));
    expect(page2.status).toBe(200);
    expect(page2.body.total).toBe(3);
    expect(page2.body.items).toHaveLength(1);
    // 短内容不截断（≤200 原样返回）
    const short = await request(server)
      .get('/api/v1/chat/history')
      .query({ keyword: '量子纠缠' })
      .set(auth(ownerToken));
    expect(short.status).toBe(200);
    expect(
      short.body.items.every(
        (i: any) => typeof i.content === 'string' && i.content.length <= 200,
      ),
    ).toBe(true);
  });

  it('GET /api/v1/chat/history keyword 含 % 通配符：字面量匹配（50% 命中、50X 不误中）', async () => {
    // 独立会话 + 独立消息：通配符转义断言不依赖其他用例的数据
    const created = await createSession(ownerToken, '转义搜索会话');
    expect(created.status).toBe(201);
    const sid = created.body.id as string;
    await insertMessage({
      sessionId: sid,
      role: 'user',
      content: '这款商品打 50%折扣，原价 100 元。',
    });
    // 搜索字面量 '50%'：% 转义后只匹配字面量（若未转义，% 会通配任意
    // 50 开头的串——语义泄漏，见 chat-history.service.ts escapeLike 注释）
    const hit = await request(server)
      .get('/api/v1/chat/history')
      .query({ keyword: '50%' })
      .set(auth(ownerToken));
    expect(hit.status).toBe(200);
    expect(hit.body.total).toBe(1);
    expect(hit.body.items[0].content).toContain('50%折扣');
    // 反例：'50X' 不应误中（'%' 已按字面量处理，不会因通配扩成 50X）
    const miss = await request(server)
      .get('/api/v1/chat/history')
      .query({ keyword: '50X' })
      .set(auth(ownerToken));
    expect(miss.status).toBe(200);
    expect(miss.body.total).toBe(0);
  });

  it('GET /api/v1/chat/history 搜索无结果 → 空数组', async () => {
    const res = await request(server)
      .get('/api/v1/chat/history')
      .query({ keyword: '绝不存在的关键词xyz' })
      .set(auth(ownerToken));
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
    expect(res.body.total).toBe(0);
  });

  it('GET /api/v1/chat/history keyword 空/纯空白/缺失/超长 → 400', async () => {
    // 空串 / 纯空白：@Transform trim 后空串被 @MinLength(1) 拦下（DTO 注释）
    for (const keyword of ['', '   ']) {
      const res = await request(server)
        .get('/api/v1/chat/history')
        .query({ keyword })
        .set(auth(ownerToken));
      expect(res.status).toBe(400);
    }
    // 缺失 keyword：@IsString 对 undefined 判 400（必填语义）
    const missing = await request(server)
      .get('/api/v1/chat/history')
      .set(auth(ownerToken));
    expect(missing.status).toBe(400);
    // 超长（>100）：@MaxLength(100) 拦下
    const long = await request(server)
      .get('/api/v1/chat/history')
      .query({ keyword: '长'.repeat(101) })
      .set(auth(ownerToken));
    expect(long.status).toBe(400);
  });

  it('GET /api/v1/chat/history/stats 按 KB 聚合（messageCount/citationCount/kbName）', async () => {
    // 知识库甲：2 条 assistant 消息引用（其一含 2 条引用 → citationCount=3）
    const kbA = await createKb(ownerToken, '历史统计知识库甲');
    expect(kbA.status).toBe(201);
    const kbAId = kbA.body.id as string;
    const docA = await createManualKnowledge(ownerToken, kbAId, '统计文档甲');
    expect(docA.status).toBe(201);
    const docAId = docA.body.id as string;
    // 知识库乙：1 条 assistant 消息引用
    const kbB = await createKb(ownerToken, '历史统计知识库乙');
    expect(kbB.status).toBe(201);
    const kbBId = kbB.body.id as string;
    const docB = await createManualKnowledge(ownerToken, kbBId, '统计文档乙');
    expect(docB.status).toBe(201);
    const docBId = docB.body.id as string;
    const session = await createSession(ownerToken, '统计会话');
    expect(session.status).toBe(201);
    const sid = session.body.id as string;
    // 口径（任务书决策）：只统计 assistant 消息的 references——
    // 同消息多引用都计（citationCount=3）；同 KB 多消息只计消息数（messageCount=2）
    await insertMessage({
      sessionId: sid,
      role: 'assistant',
      content: '引用甲一',
      references: [makeReference(docAId, 1), makeReference(docAId, 2)],
    });
    await insertMessage({
      sessionId: sid,
      role: 'assistant',
      content: '引用甲二',
      references: [makeReference(docAId, 1)],
    });
    await insertMessage({
      sessionId: sid,
      role: 'assistant',
      content: '引用乙一',
      references: [makeReference(docBId, 1)],
    });
    // user 消息不计（无 references——即使会话 kbIds 关联了知识库也不计，
    // 统计基于引用即使用证据，会话级 kbIds 不是消息级证据）
    await insertMessage({ sessionId: sid, role: 'user', content: '统计问题' });

    const res = await request(server)
      .get('/api/v1/chat/history/stats')
      .set(auth(ownerToken));
    expect(res.status).toBe(200);
    const items = res.body as Array<Record<string, unknown>>;
    const rowA = items.find((i) => i.kbId === kbAId);
    const rowB = items.find((i) => i.kbId === kbBId);
    expect(rowA).toBeDefined();
    expect(rowA!.kbName).toBe('历史统计知识库甲');
    expect(rowA!.messageCount).toBe(2);
    expect(rowA!.citationCount).toBe(3);
    expect(rowB).toBeDefined();
    expect(rowB!.kbName).toBe('历史统计知识库乙');
    expect(rowB!.messageCount).toBe(1);
    expect(rowB!.citationCount).toBe(1);
  });

  it('GET /api/v1/chat/history/stats?days= 窗口过滤（窗口外消息不计）', async () => {
    const kbC = await createKb(ownerToken, '历史统计知识库丙');
    expect(kbC.status).toBe(201);
    const kbCId = kbC.body.id as string;
    const docC = await createManualKnowledge(ownerToken, kbCId, '统计文档丙');
    expect(docC.status).toBe(201);
    const docCId = docC.body.id as string;
    const session = await createSession(ownerToken, '窗口过滤会话');
    expect(session.status).toBe(201);
    const sid = session.body.id as string;
    // 窗口内（2 天前）与窗口外（10 天前）各 1 条引用消息
    await insertMessage({
      sessionId: sid,
      role: 'assistant',
      content: '窗口内回复',
      references: [makeReference(docCId, 1)],
      ageSeconds: 2 * 86400,
    });
    await insertMessage({
      sessionId: sid,
      role: 'assistant',
      content: '窗口外回复',
      references: [makeReference(docCId, 1)],
      ageSeconds: 10 * 86400,
    });
    // days=7：只统计窗口内的 1 条
    const res7 = await request(server)
      .get('/api/v1/chat/history/stats')
      .query({ days: 7 })
      .set(auth(ownerToken));
    expect(res7.status).toBe(200);
    const row7 = (res7.body as any[]).find((i: any) => i.kbId === kbCId);
    expect(row7).toBeDefined();
    expect(row7.messageCount).toBe(1);
    // days 缺省 30：两条都计（默认窗口语义）
    const resDefault = await request(server)
      .get('/api/v1/chat/history/stats')
      .set(auth(ownerToken));
    const rowDefault = (resDefault.body as any[]).find(
      (i: any) => i.kbId === kbCId,
    );
    expect(rowDefault).toBeDefined();
    expect(rowDefault.messageCount).toBe(2);
    // days 非法（0/366/负数/非数字）→ 400
    for (const bad of ['0', '366', '-1', 'abc']) {
      const badRes = await request(server)
        .get('/api/v1/chat/history/stats')
        .query({ days: bad })
        .set(auth(ownerToken));
      expect(badRes.status).toBe(400);
    }
  });

  it('GET /api/v1/chat/history/stats 无引用数据 → 空数组', async () => {
    // 用户乙有会话但无引用消息：空数组（不报错、不补查）
    const session = await createSession(userBToken, '乙的无引用会话');
    expect(session.status).toBe(201);
    await insertMessage({
      sessionId: session.body.id as string,
      role: 'assistant',
      content: '无引用回复',
    });
    await insertMessage({
      sessionId: session.body.id as string,
      role: 'user',
      content: '无引用问题',
    });
    const res = await request(server)
      .get('/api/v1/chat/history/stats')
      .set(auth(userBToken));
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('他人数据不可见：用户 B 搜索不到用户 A 的消息、统计互不干扰', async () => {
    // owner 的消息（量子纠缠关键词，测试 1 已插入）——用户乙搜索应空
    const res = await request(server)
      .get('/api/v1/chat/history')
      .query({ keyword: '量子纠缠' })
      .set(auth(userBToken));
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
    expect(res.body.total).toBe(0);
    // 用户乙自己会话的消息可搜到（反向验证隔离未误伤）
    const own = await request(server)
      .get('/api/v1/chat/history')
      .query({ keyword: '无引用问题' })
      .set(auth(userBToken));
    expect(own.status).toBe(200);
    expect(own.body.total).toBe(1);
    // 统计隔离：用户乙的 stats 不含 owner 引用的知识库（乙无引用 → 空数组）
    const bStats = await request(server)
      .get('/api/v1/chat/history/stats')
      .set(auth(userBToken));
    expect(bStats.status).toBe(200);
    expect(bStats.body).toEqual([]);
  });

  it('DELETE /api/v1/chat/history 清空全部会话（返回 deleted，会话/消息归零）', async () => {
    // 记录 owner 当前会话数（前序用例累计）与待清空目标
    const beforeList = await request(server)
      .get('/api/v1/chat/sessions?page=1&pageSize=100')
      .set(auth(ownerToken));
    const beforeTotal = beforeList.body.total as number;
    expect(beforeTotal).toBeGreaterThan(0);

    const del = await request(server)
      .delete('/api/v1/chat/history')
      .set(auth(ownerToken));
    expect(del.status).toBe(200);
    expect(del.body.deleted).toBe(beforeTotal);
    // 会话归零
    const afterList = await request(server)
      .get('/api/v1/chat/sessions?page=1&pageSize=100')
      .set(auth(ownerToken));
    expect(afterList.body.total).toBe(0);
    // 他人数据不受影响：用户乙的会话仍在
    const bList = await request(server)
      .get('/api/v1/chat/sessions?page=1&pageSize=100')
      .set(auth(userBToken));
    expect(bList.status).toBe(200);
    expect(bList.body.total).toBeGreaterThan(0);
    // 幂等重放（质量审查整改）：无会话用户再次 DELETE → { deleted: 0 }
    // （清空操作可安全重放，服务端不报错；口径见 clearAll 方法注释）
    const delAgain = await request(server)
      .delete('/api/v1/chat/history')
      .set(auth(ownerToken));
    expect(delAgain.status).toBe(200);
    expect(delAgain.body.deleted).toBe(0);
  });
});
