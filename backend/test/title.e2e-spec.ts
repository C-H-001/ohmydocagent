// 会话标题自动生成 e2e（Task 2.2）：MessageService.createUserMessage 创建首条
// 用户消息后入队 TITLE_QUEUE，TitleProcessor 消费并用 ChatModelService 生成标题
// 更新会话 title。
// 说明：
// - 消息 HTTP 发送端点（对话）在 Task 2.4/2.5 才实现——本文件通过
//   app.get(MessageService) 直接调用服务方法触发（触发点与后续对话管线一致）。
// - ChatModelService 在 TestingModule override 为固定标题 mock（FIFO 队列：
//   每个用例 push 预期标题，worker 按入队顺序消费；与 MockChatModelService
//   的固定长文本不同——本文件断言确定性标题）。beforeEach 清空 FIFO：
//   上一用例的标题任务已全部处理完（各用例都等「可观察副作用」后才结束——
//   title 落库或 completed 计数递增，见各用例注释），无在途 job，清空安全。
// - 等待约定（Task 2.2 质量审查整改）：不用「队列空闲」（waiting/active/
//   delayed 全零）作为处理完成的判定——入队是 fire-and-forget 异步入队
//   （事务提交后），空闲判定可能在入队前瞬时满足（假通过根源，实测复现）。
//   改为等可观察副作用：标题变更落库（waitFor title 变化）或标题任务
//   completed 计数递增（getJobCounts）——副作用必然发生在入队之后，等待
//   方向与异步流程一致，不依赖队列瞬时状态。
// - 队列异步处理：轮询 DB 等待（waitFor，10s 超时，见 test/wait-for.ts）。
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { DataSource, Repository } from 'typeorm';
import type { Queue } from 'bullmq';
import { AppModule } from '../src/app.module.js';
import { prepareTestEnv } from './test-db.js';
import { configureApp } from '../src/app.setup.js';
import { waitFor } from './wait-for.js';
import { CHAT_MODEL_SERVICE } from '../src/modules/model/chat-model.interface.js';
import { TITLE_QUEUE } from '../src/modules/chat/chat-queue.constants.js';
import type { TitleJob } from '../src/modules/chat/chat-queue.constants.js';
import { GRAPH_QUEUE } from '../src/modules/graph/graph-queue.constants.js';
import { MessageService } from '../src/modules/chat/message.service.js';
import { Session } from '../src/modules/chat/session.entity.js';
import { Message } from '../src/modules/chat/message.entity.js';
import { User } from '../src/modules/users/user.entity.js';
import { RedisService } from '../src/redis/redis.service.js';

describe('Session Title (e2e)', () => {
  let app: INestApplication;
  let server: any;
  let dataSource: DataSource;
  let sessionRepo: Repository<Session>;
  let messageService: MessageService;
  let titleQueue: Queue<TitleJob>;
  const ownerEmail = 'title-owner@ohmydocagent.local';
  let ownerToken = '';
  let ownerId = '';
  const testEmails = [ownerEmail];

  // ChatModelService mock：FIFO 标题队列（每用例 push 预期标题，worker 按序消费）
  const mockTitles: string[] = [];
  const chatModelMock = {
    chat: vi.fn(async () => {
      const t = mockTitles.shift();
      if (t === undefined) {
        throw new Error('mock 标题队列为空（测试用例未 push 预期标题）');
      }
      return t;
    }),
  };

  /** 助手：以 owner 身份创建会话 */
  function createSession() {
    return request(server)
      .post('/api/v1/chat/sessions')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({});
  }

  beforeAll(async () => {
    await prepareTestEnv();
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      // override：标题生成用固定标题 mock（确定性断言；真实 MockChatModelService
      // 返回固定长文本，与「截断 50」单测交叉覆盖）
      .overrideProvider(CHAT_MODEL_SERVICE)
      .useValue(chatModelMock)
      .compile();
    dataSource = moduleRef.get(DataSource);
    // 测试隔离（沿用既有约定）：先清子表 messages 再清主表 sessions，
    // 与 users/invitations 一并显式列入清单；另加 knowledge 系列表（Task 3.2
    // 同步：上一 e2e 文件的文档图谱 job 可能带 backoff 重试迟到本文件窗口——
    // 清掉 knowledge 行后 ExtractProcessor 404 no-op 不调 chat，避免污染
    // 本文件的 FIFO 标题 mock，见 extract.processor.ts 注释）
    await dataSource.query(
      'TRUNCATE TABLE users, invitations, messages, sessions, knowledge_bases, knowledge, chunk_revisions, chunks CASCADE',
    );
    // 清空标题队列：防上一 e2e 文件遗留的 job（防御性清理，无则空跑）；
    // 在 app.init() 之前执行——worker 尚未启动，无竞争
    titleQueue = moduleRef.get(getQueueToken(TITLE_QUEUE));
    await titleQueue.obliterate({ force: true });
    // Task 3.2 同步：一并清空图谱抽取队列（上一 e2e 文件的 graph job 带
    // backoff 重试时可能迟到本文件窗口——obliterate 连 delayed 一起清掉，
    // 与 knowledge 表 TRUNCATE 双保险，见上方 TRUNCATE 注释）
    const graphQueue = moduleRef.get(getQueueToken(GRAPH_QUEUE));
    await graphQueue.obliterate({ force: true });
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    server = app.getHttpServer();
    sessionRepo = dataSource.getRepository(Session);
    messageService = app.get(MessageService);
    // 前置：init 创建 Owner
    const initRes = await request(server).post('/api/v1/auth/init').send({
      email: ownerEmail,
      password: 'Owner123456',
      name: '标题测试所有者',
    });
    expect(initRes.status).toBe(201);
    ownerToken = initRes.body.accessToken as string;
    const userRepo = app.get(getRepositoryToken(User));
    const owner = await userRepo.findOneOrFail({
      where: { email: ownerEmail },
    });
    ownerId = owner.id;
  });

  beforeEach(() => {
    // 清空上一用例的 FIFO 遗留（上一用例已等待其标题任务处理完毕，无在途 job）
    mockTitles.length = 0;
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

  it('首条用户消息后自动生成标题（等队列 → title 不再是"新会话"，等于 mock LLM 返回）', async () => {
    const created = await createSession();
    expect(created.status).toBe(201);
    const sid = created.body.id as string;
    // mock 返回固定标题（10 字内）；首条消息触发标题任务
    mockTitles.push('AI 助手使用指南');
    const msg = await messageService.createUserMessage(
      sid,
      'AI 助手如何添加知识库？',
      ownerId,
    );
    // 服务方法事务创建 user 消息（角色/内容落库）
    expect(msg.role).toBe('user');
    expect(msg.content).toBe('AI 助手如何添加知识库？');
    // 等队列：title 不再是默认值「新会话」
    await waitFor(
      async () => {
        const s = await sessionRepo.findOne({ where: { id: sid } });
        return s !== null && s.title !== '新会话';
      },
      { description: '首条用户消息后标题自动生成（title 不再是默认值）' },
    );
    const s = await sessionRepo.findOne({ where: { id: sid } });
    expect(s!.title).toBe('AI 助手使用指南');
    // 消息已落库（首条）
    const messageRepo = app.get(getRepositoryToken(Message));
    const count = await messageRepo.count({ where: { sessionId: sid } });
    expect(count).toBe(1);
  });

  it('手动重命名后的会话不覆盖标题（重命名 → 再发首条消息 → title 保持手动值）', async () => {
    const created = await createSession();
    expect(created.status).toBe(201);
    const sid = created.body.id as string;
    // 手动重命名（覆盖规则：title !== '新会话' 时标题任务 no-op）
    const renamed = await request(server)
      .put(`/api/v1/chat/sessions/${sid}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ title: '手动标题' });
    expect(renamed.status).toBe(200);
    // 此标题不应被消费（若处理器误覆盖手动标题，断言会抓到）
    mockTitles.push('不应出现的自动标题');
    // 等「可观察副作用」：标题任务 completed 计数递增（该 no-op job 必然
    // 完成）——不用队列空闲判定（入队是 fire-and-forget，空闲可能在入队前
    // 瞬时满足，假通过根源，见文件头注释）
    const completedBefore = (await titleQueue.getJobCounts('completed'))
      .completed;
    await messageService.createUserMessage(sid, '第一条消息', ownerId);
    await waitFor(
      async () => {
        const counts = await titleQueue.getJobCounts('completed');
        return counts.completed > completedBefore;
      },
      { description: '手动标题会话的标题任务完成（completed 计数递增）' },
    );
    const s = await sessionRepo.findOne({ where: { id: sid } });
    expect(s!.title).toBe('手动标题');
  });

  it('第二条用户消息不重新生成标题（title 保持首次自动生成的标题）', async () => {
    const created = await createSession();
    expect(created.status).toBe(201);
    const sid = created.body.id as string;
    // 基线：首条消息的标题任务入队前记录 completed 计数（防与上一用例遗留
    // 计数混淆——completed job 保留 1000 条，见 parse-queue.constants）
    const baselineBefore = (await titleQueue.getJobCounts('completed'))
      .completed;
    mockTitles.push('首次自动标题');
    await messageService.createUserMessage(sid, '问题一', ownerId);
    await waitFor(
      async () => {
        const s = await sessionRepo.findOne({ where: { id: sid } });
        return s !== null && s.title !== '新会话';
      },
      { description: '首条消息标题生成' },
    );
    // title 落库与 job 标记 completed 之间有小窗口：先等 completed 计数
    // 递增（首条任务必然完成）再记基线，防基线取在完成窗口内造成误报
    await waitFor(
      async () => {
        const counts = await titleQueue.getJobCounts('completed');
        return counts.completed > baselineBefore;
      },
      { description: '首条标题任务 completed 计数递增' },
    );
    const completedBefore = (await titleQueue.getJobCounts('completed'))
      .completed;
    // 第二条消息不应入队：此标题不应被消费（若误入队，title 会被覆盖成它）
    mockTitles.push('不应被消费的标题');
    await messageService.createUserMessage(sid, '问题二', ownerId);
    // 无新标题任务的断言：等固定短延迟（给「误入队的 job」入队+消费的时间）
    // 后断言 completed 计数未递增——期望就是「无事发生」，没有可等待的
    // 副作用，延迟 + 计数不变是能真正消除假通过的组合（队列空闲判定在
    // 入队前即瞬时满足，见文件头注释）
    await new Promise((r) => setTimeout(r, 500));
    const counts = await titleQueue.getJobCounts('completed', 'failed');
    expect(counts.completed).toBe(completedBefore);
    expect(counts.failed).toBe(0);
    const s = await sessionRepo.findOne({ where: { id: sid } });
    expect(s!.title).toBe('首次自动标题');
  });
});
