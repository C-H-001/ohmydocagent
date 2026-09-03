// 聊天 SSE e2e（Task 2.4）：POST /chat/sessions/:id/messages 的流式对话回路。
// 事件协议（前端 P5.6 契约，见 src/modules/chat/sse/chat-event.types.ts）：
// stage(generate start/done) → delta（逐段正文）/reasoning_delta（深度思考）→
// done（messageId + usage）；上游失败 → error 事件（HTTP 保持 200，不 500 断开）。
// 质量审查整改覆盖：
// - 事件序（#3）：先落库 assistant 再发 stage(done)/done——done 到达时消息已可查
// - 断连（#1）：生成中途客户端断开 → abort 传递到 provider、生成中止、已累积
//   内容落库（partial assistant，断连不丢已生成部分）
// - 错误脱敏（#4）：error 事件 message 为固定友好文案、不含原始 err.message
//
// 决策（见任务书）：overrideProvider(CHAT_MODEL_SERVICE) 注入
// FakeChatModelService——静态 script（可脚本化流式块）/failWith（抛错标志），
// 避免真实 API；真实 ChatModelService/供应商的流式行为由 providers/*.spec.ts
// 单测覆盖。预置默认 chat 模型记录仅为走通真实模型管理链路（Fake 覆盖路由，
// 不打真实 API）。
//
// 错误语义：404（会话不存在/非 UUID）/403（他人会话）在 SSE headers 发送前
// 由异常过滤器以标准 JSON 响应（控制器先做归属校验再创建 SseService，见
// session.controller.ts 注释）；401 未登录由全局 JwtAuthGuard 拦截；
// content 校验（Task 2.2 M-3 TODO 落实：@MinLength(1)/@MaxLength(20000)）
// → 400 JSON（DTO 校验在控制器前，SSE 未开始）。
//
// 标题生成联动：首条 user 消息触发 TITLE_QUEUE（Fake.chat 返回固定文本），
// 与 title.e2e 既有覆盖同语义，本文件不额外断言（Redis/队列为共享基础设施，
// 标题生成异步进行，不阻塞流式响应）。
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { DataSource, Repository } from 'typeorm';
import { vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { prepareTestEnv } from './test-db.js';
import { configureApp } from '../src/app.setup.js';
import { CHAT_MODEL_SERVICE } from '../src/modules/model/chat-model.interface.js';
import type {
  ChatMessage,
  ChatModelService,
  ChatOptions,
  ChatStreamChunk,
} from '../src/modules/model/chat-model.interface.js';
import { Message } from '../src/modules/chat/message.entity.js';
import { User } from '../src/modules/users/user.entity.js';
import { RedisService } from '../src/redis/redis.service.js';

/** 脚本化 Fake ChatModelService（e2e override CHAT_MODEL_SERVICE 注入）：
 * 模块编译一次、服务单例——script/failWith 走静态字段，由各用例在发请求前
 * 设置（beforeEach 复位防用例间泄漏）。chat() 供标题生成消费（固定文本）。
 * 断连支持（质量审查整改 #1）：接收编排器传入的 AbortController.signal，注册
 * abort 监听置 aborted 标志（断连用例断言「abort 已传递到 provider」）；生成
 * 循环内检查 signal.aborted 停止产出（真实实现中 fetch 流被 abort 中断）。 */
class FakeChatModelService implements ChatModelService {
  /** 流式块脚本：chatStream 依次 yield（可为空数组 = 无正文增量） */
  static script: ChatStreamChunk[] = [];
  /** 抛错标志：非 null 时 chatStream 迭代即抛（模拟上游超时/熔断） */
  static failWith: Error | null = null;
  /** abort 触发标志：编排器的断连取消信号已传递到 provider（断连用例断言） */
  static aborted = false;

  async chat(_messages: ChatMessage[]): Promise<string> {
    return 'SSE 测试会话标题';
  }

  async *chatStream(
    _messages: ChatMessage[],
    options?: ChatOptions,
  ): AsyncIterable<ChatStreamChunk> {
    if (FakeChatModelService.failWith) {
      throw FakeChatModelService.failWith;
    }
    const signal = options?.signal;
    if (signal) {
      signal.addEventListener('abort', () => {
        FakeChatModelService.aborted = true;
      });
    }
    for (const chunk of FakeChatModelService.script) {
      // 断连（abort）后停止产出——真实实现（fetch 流）被 abort 中断
      if (signal?.aborted) break;
      // 每块间小延迟模拟生成节奏：给断连用例留出「生成中途断开」窗口
      await new Promise((r) => setTimeout(r, 5));
      if (signal?.aborted) break;
      yield chunk;
    }
  }
}

/** 解析 SSE 原始文本 → 事件列表（每事件：event 名 + data JSON）。
 * superagent 对 text/*（含 text/event-stream）走内置 text 解析器，res.text
 * 即原始流文本；事件以空行（\\n\\n）分隔，每块含 event:/data: 行。 */
interface ParsedSseEvent {
  event: string;
  data: Record<string, unknown>;
}
function parseSse(raw: string): ParsedSseEvent[] {
  return raw
    .split('\n\n')
    .filter((block) => block.trim().length > 0)
    .map((block) => {
      const lines = block.split('\n');
      const event = lines
        .find((l) => l.startsWith('event: '))
        ?.slice('event: '.length)
        .trim();
      const dataLine = lines.find((l) => l.startsWith('data: '));
      if (!event || !dataLine) {
        throw new Error(`SSE 块缺少 event/data 行: ${JSON.stringify(block)}`);
      }
      return {
        event,
        data: JSON.parse(dataLine.slice('data: '.length)) as Record<
          string,
          unknown
        >,
      };
    });
}

describe('Chat SSE 流式对话 (e2e)', () => {
  let app: INestApplication;
  let server: any;
  let dataSource: DataSource;
  let messageRepo: Repository<Message>;
  const ownerEmail = 'chat-sse-owner@ohmydocagent.local';
  const userBEmail = 'chat-sse-userb@ohmydocagent.local';
  let ownerToken = '';
  let userBToken = '';
  // 本文件创建的用户邮箱：afterAll 统一清理其 rt:* 键（共享 Redis 隔离）
  const testEmails = [ownerEmail, userBEmail];
  // owner 的主会话（流式用例 + 归属 403 复用；每个用例独立发消息）
  let sessionA = '';
  const auth = () => ({ Authorization: `Bearer ${ownerToken}` });

  /** 助手：发送对话消息（SSE 流式响应；.buffer(true) 显式声明缓冲——
   * text/* 默认即缓冲，这里显式化意图，见文件头 superagent 注释） */
  function sendMessage(sessionId: string, content: string, token: string) {
    return request(server)
      .post(`/api/v1/chat/sessions/${sessionId}/messages`)
      .set('Authorization', `Bearer ${token}`)
      .send({ content })
      .buffer(true);
  }

  beforeAll(async () => {
    await prepareTestEnv();
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(CHAT_MODEL_SERVICE)
      .useClass(FakeChatModelService)
      .compile();
    dataSource = moduleRef.get(DataSource);
    // 测试隔离（沿用既有约定）：清空消息/会话/模型（本文件会预置默认 chat
    // 模型记录）+ 用户/邀请（sessions 无外键，级联清理消息）
    await dataSource.query(
      'TRUNCATE TABLE users, invitations, messages, sessions, models CASCADE',
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
      name: 'SSE 测试所有者',
    });
    expect(initRes.status).toBe(201);
    ownerToken = initRes.body.accessToken as string;
    // 前置：公开注册第二个用户（归属 403 用例）
    const regRes = await request(server).post('/api/v1/auth/register').send({
      email: userBEmail,
      password: 'Admin123456',
      name: 'SSE 测试用户乙',
    });
    expect(regRes.status).toBe(201);
    userBToken = regRes.body.accessToken as string;
    // 前置：预置默认 chat 模型记录（真实模型管理链路；供应商调用被 Fake
    // 覆盖——不打真实 API，见文件头注释）
    const modelRes = await request(server)
      .post('/api/v1/models')
      .set(auth())
      .send({
        name: 'SSE 测试模型',
        provider: 'openai-compatible',
        baseUrl: 'https://api.example.com',
        apiKey: 'sk-test',
        modelName: 'test-chat',
        type: 'chat',
      });
    expect(modelRes.status).toBe(201);
    const defaultRes = await request(server)
      .put(`/api/v1/models/${modelRes.body.id}/default`)
      .set(auth());
    expect(defaultRes.status).toBe(200);
    // 前置：owner 主会话
    const sessionRes = await request(server)
      .post('/api/v1/chat/sessions')
      .set(auth())
      .send({});
    expect(sessionRes.status).toBe(201);
    sessionA = sessionRes.body.id as string;
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

  beforeEach(() => {
    // 复位 Fake 脚本（防用例间泄漏）
    FakeChatModelService.script = [];
    FakeChatModelService.failWith = null;
    FakeChatModelService.aborted = false;
  });

  it('POST /api/v1/chat/sessions/:id/messages 返回 text/event-stream（200 + Content-Type）', async () => {
    const res = await sendMessage(sessionA, '你好', ownerToken);
    expect(res.status).toBe(200);
    // Content-Type 断言：SSE 媒体类型（含 charset 尾缀，用前缀匹配）
    expect(res.headers['content-type']).toMatch(/^text\/event-stream/);
    // 空脚本（beforeEach 复位）：无 delta，事件序列 stage(start/done) + done
    const events = parseSse(res.text as string);
    expect(events.map((e) => e.event)).toEqual(['stage', 'stage', 'done']);
    expect(events[0].data).toEqual({
      type: 'stage',
      stage: 'generate',
      status: 'start',
    });
  });

  it('流按序输出事件：stage(generate start) → delta → stage(done) → done（FakeChat 脚本化）', async () => {
    FakeChatModelService.script = [{ text: '第一段' }, { text: '，第二段' }];
    const res = await sendMessage(sessionA, '流式测试', ownerToken);
    expect(res.status).toBe(200);
    const events = parseSse(res.text as string);
    // 事件类型顺序（协议：先 stage 再正文增量再收尾）
    expect(events.map((e) => e.event)).toEqual([
      'stage',
      'delta',
      'delta',
      'stage',
      'done',
    ]);
    // 事件载荷：data 与事件 type 对齐，delta 逐段透传
    expect(events[0].data).toEqual({
      type: 'stage',
      stage: 'generate',
      status: 'start',
    });
    expect(events[1].data).toEqual({ type: 'delta', text: '第一段' });
    expect(events[2].data).toEqual({ type: 'delta', text: '，第二段' });
    expect(events[3].data).toEqual({
      type: 'stage',
      stage: 'generate',
      status: 'done',
    });
    expect(events[4].data.type).toBe('done');
  });

  it('reasoning 增量透传：reasoning_delta 事件（Task 2.8 深度思考的流式通道）', async () => {
    FakeChatModelService.script = [
      { text: '', reasoning: '让我想想……' },
      { text: '答案' },
    ];
    const res = await sendMessage(sessionA, '推理测试', ownerToken);
    expect(res.status).toBe(200);
    const events = parseSse(res.text as string);
    expect(events.map((e) => e.event)).toEqual([
      'stage',
      'reasoning_delta',
      'delta',
      'stage',
      'done',
    ]);
    expect(events[1].data).toEqual({
      type: 'reasoning_delta',
      text: '让我想想……',
    });
  });

  it('生成完成后 Message 落库：user（发送内容）+ assistant（累积全文含 reasoning）', async () => {
    // 独立会话验证落库（不干扰共享 sessionA 的历史消息）
    const created = await request(server)
      .post('/api/v1/chat/sessions')
      .set(auth())
      .send({});
    expect(created.status).toBe(201);
    const sid = created.body.id as string;
    FakeChatModelService.script = [
      { text: '', reasoning: '分析中' },
      { text: '完整回复' },
      { text: '内容' },
    ];
    const res = await sendMessage(sid, '落库测试', ownerToken);
    expect(res.status).toBe(200);
    const messages = await messageRepo.find({
      where: { sessionId: sid },
      order: { createdAt: 'ASC', id: 'ASC' },
    });
    // user + assistant 两条（按创建时序）
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('user');
    expect(messages[0].content).toBe('落库测试');
    expect(messages[1].role).toBe('assistant');
    // assistant content = delta 累积全文
    expect(messages[1].content).toBe('完整回复内容');
    // reasoning 一并落库（Task 2.8 历史回显用）
    expect(messages[1].reasoning).toBe('分析中');
  });

  it('done 事件含 messageId（与落库的 assistant 消息一致）+ usage 透传', async () => {
    const created = await request(server)
      .post('/api/v1/chat/sessions')
      .set(auth())
      .send({});
    expect(created.status).toBe(201);
    const sid = created.body.id as string;
    FakeChatModelService.script = [
      { text: '带用量回复' },
      { text: '', usage: { inputTokens: 12, outputTokens: 34 } },
    ];
    const res = await sendMessage(sid, 'usage 测试', ownerToken);
    expect(res.status).toBe(200);
    const events = parseSse(res.text as string);
    const done = events.find((e) => e.event === 'done');
    expect(done).toBeDefined();
    // done 事件：messageId 定位落库消息 + usage 透传（include_usage/done 行统计）
    expect(typeof done!.data.messageId).toBe('string');
    expect(done!.data.usage).toEqual({ inputTokens: 12, outputTokens: 34 });
    // messageId 与落库的 assistant 消息 id 一致（前端定位消息的依据）
    const assistant = await messageRepo.findOne({
      where: { sessionId: sid, role: 'assistant' },
      order: { createdAt: 'DESC', id: 'DESC' },
    });
    expect(assistant?.id).toBe(done!.data.messageId);
  });

  it('会话不存在 404 / 未登录 401 / 他人会话 403（SSE 开始前 JSON 响应）', async () => {
    // 404：不存在的会话（uuid 格式）
    const missing = await sendMessage(
      '00000000-0000-4000-8000-000000000000',
      '内容',
      ownerToken,
    );
    expect(missing.status).toBe(404);
    // 404：非 UUID 格式 id（22P02 兜底，不泄露 500）
    const notUuid = await sendMessage('not-a-uuid', '内容', ownerToken);
    expect(notUuid.status).toBe(404);
    // 401：未登录（全局 JwtAuthGuard）
    const unauth = await request(server)
      .post(`/api/v1/chat/sessions/${sessionA}/messages`)
      .send({ content: '内容' });
    expect(unauth.status).toBe(401);
    // 403：他人会话（userB 操作 owner 的 sessionA）
    const forbidden = await sendMessage(sessionA, '越权内容', userBToken);
    expect(forbidden.status).toBe(403);
  });

  it('content 校验（落实 Task 2.2 M-3 TODO）：空串/纯空白/缺失/超长 → 400 且不落库', async () => {
    // 400 校验在 DTO 层（ValidationPipe，控制器前）——SSE 未开始，JSON 响应
    const before = await messageRepo.count({ where: { sessionId: sessionA } });
    const invalidBodies = [
      { content: '' }, // 空串：@MinLength(1) 拦截
      { content: '   ' }, // 纯空白：trim 后为空串 → @MinLength(1) 拦截
      {}, // 缺失：@IsString 拦截
      { content: '长'.repeat(20001) }, // 超长：@MaxLength(20000) 拦截
    ];
    for (const body of invalidBodies) {
      const res = await request(server)
        .post(`/api/v1/chat/sessions/${sessionA}/messages`)
        .set(auth())
        .send(body);
      expect(res.status).toBe(400);
    }
    // 非法入参不产生消息（校验在创建前）
    const after = await messageRepo.count({ where: { sessionId: sessionA } });
    expect(after).toBe(before);
  });

  it('上游流式失败 → SSE error 事件（HTTP 保持 200 不 500 断开；user 已落库、assistant 不落库）', async () => {
    const created = await request(server)
      .post('/api/v1/chat/sessions')
      .set(auth())
      .send({});
    expect(created.status).toBe(201);
    const sid = created.body.id as string;
    // Fake 抛错（模拟上游超时/熔断）——编排器捕获后转 error 事件 + 结束流
    FakeChatModelService.failWith = new Error('上游模型连接超时');
    const res = await sendMessage(sid, '错误场景', ownerToken);
    // 非 500 断开：HTTP 200 + SSE error 事件（headers 已发送，状态码不可改，
    // 错误走事件协议而非异常过滤器，见 chat-orchestrator.service.ts 注释）
    expect(res.status).toBe(200);
    const events = parseSse(res.text as string);
    expect(events.map((e) => e.event)).toEqual(['stage', 'error']);
    // error 事件：协议字段 code + message（前端按 code 做文案/重试策略）；
    // 脱敏（质量审查整改 #4）：message 为固定友好文案、不含原始 err.message
    // （原始细节只进服务端 logger，防 DB 连接串/内网地址等信息泄露）
    const err = events[1].data;
    expect(err.type).toBe('error');
    expect(err.code).toBe('chat_model_error');
    expect(err.message).toBe('模型调用失败，请稍后重试');
    expect(err.message).not.toContain('上游模型连接超时');
    // user 消息已落库（发送内容保留，前端可引导重试）；assistant 未落库
    const messages = await messageRepo.find({
      where: { sessionId: sid },
      order: { createdAt: 'ASC', id: 'ASC' },
    });
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('user');
    expect(messages[0].content).toBe('错误场景');
  });

  it('事件序（整改 #3）：done 事件到达时 assistant 消息已可查（先落库再通知——无假成功）', async () => {
    const created = await request(server)
      .post('/api/v1/chat/sessions')
      .set(auth())
      .send({});
    expect(created.status).toBe(201);
    const sid = created.body.id as string;
    FakeChatModelService.script = [{ text: '顺序验证回复' }];
    const res = await sendMessage(sid, '事件序测试', ownerToken);
    expect(res.status).toBe(200);
    const events = parseSse(res.text as string);
    const done = events.find((e) => e.event === 'done');
    // 事件序列仍为 stage(start) → delta → stage(done) → done（协议不变）
    expect(events.map((e) => e.event)).toEqual([
      'stage',
      'delta',
      'stage',
      'done',
    ]);
    // done 后立即查库：assistant 已落库且 id 与 done.messageId 一致——
    // 落库发生在 done 之前（先落库再发 stage done/done，见编排器注释）
    const assistant = await messageRepo.findOne({
      where: { sessionId: sid, role: 'assistant' },
    });
    expect(assistant).toBeDefined();
    expect(assistant!.id).toBe(done!.data.messageId);
    expect(assistant!.content).toBe('顺序验证回复');
  });

  it('断连（整改 #1）：生成中途客户端断开 → abort 传递到 provider，生成中止且已累积内容落库（partial assistant）', async () => {
    const created = await request(server)
      .post('/api/v1/chat/sessions')
      .set(auth())
      .send({});
    expect(created.status).toBe(201);
    const sid = created.body.id as string;
    // 长脚本 + 每块 5ms 延迟：总生成时长约 1.5s——客户端在生成进行中（约
    // 200ms 处）断开，模拟用户关页面/断网
    FakeChatModelService.script = Array.from({ length: 300 }, (_, i) => ({
      text: `块${i}`,
    }));
    FakeChatModelService.aborted = false;
    const req = sendMessage(sid, '断连测试', ownerToken);
    // superagent 惰性发送：挂一个最早的处理链触发真实请求（否则请求一直
    // 不发出，waitFor 永远看不到 user 消息落库）
    const reqSettled = req.then(
      () => 'resolved',
      () => 'rejected',
    );
    // 等生成真正开始（user 消息已落库 = 编排器已进入生成阶段，避免冷启动
    // 延迟导致 abort 早于服务端处理请求——固定延迟方案在隔离运行时不可靠）
    await vi.waitFor(async () => {
      const msgs = await messageRepo.find({ where: { sessionId: sid } });
      expect(msgs.length).toBe(1); // 仅 user 消息：生成已开始、尚未到 assistant
    });
    req.abort();
    // superagent abort 使请求 promise 拒绝（客户端侧）
    await expect(reqSettled).resolves.toBe('rejected');
    await new Promise((r) => setTimeout(r, 500));
    // 断连取消信号已传递到 provider（Fake 注册的 abort 监听被触发）——真实实现
    // 中 fetch 流被中断、上游生成停止（烧 token 止损）。服务端处理 close → abort
    // 是异步的（客户端 reject 先于服务端收尾），用 waitFor 轮询
    await vi.waitFor(() => expect(FakeChatModelService.aborted).toBe(true));
    // 服务端收尾是异步的：轮询等待 partial assistant 落库
    await vi.waitFor(async () => {
      const messages = await messageRepo.find({
        where: { sessionId: sid },
        order: { createdAt: 'ASC', id: 'ASC' },
      });
      expect(messages).toHaveLength(2); // user + partial assistant
    });
    const messages = await messageRepo.find({
      where: { sessionId: sid },
      order: { createdAt: 'ASC', id: 'ASC' },
    });
    expect(messages[0].role).toBe('user');
    expect(messages[0].content).toBe('断连测试');
    expect(messages[1].role).toBe('assistant');
    // 只保存了断连前已生成的部分：是脚本的连续前缀，且未生成完整内容
    // （断连不丢已生成部分，但生成确实被中止）
    const full = FakeChatModelService.script.map((c) => c.text).join('');
    expect(full.startsWith(messages[1].content)).toBe(true);
    expect(messages[1].content.length).toBeLessThan(full.length);
    // 服务端流已收尾（end）——连接断开后无残留写/未处理错误
  });
});
