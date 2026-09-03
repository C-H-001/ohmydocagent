// 聊天停止生成 e2e（Task 2.10）：POST /chat/sessions/:id/stop 显式停止生成。
// 语义：stop 端点经 GenerationRegistry（sessionId → AbortController）abort 该
// 会话的活动生成——abort 信号经编排器 → Agent → 供应商 fetch（烧 token
// 止损）；停止后已累积部分落库（interrupted=true 标记）；socket 仍开 → SSE
// 流收到收尾事件（stage(generate done) → done（interrupted=true，partial
// 内容）），与断连（socket 已关、不发事件）区分。
//
// 幂等决策：无活动生成 → 200 { stopped: false, reason: 'no_active_generation' }
// （选幂等 200 而非 409——stop 是「尽力而为」操作，前端连点安全，见
// generation-registry.service.ts 注释）。
//
// 时序（复用 Task 2.4 断连 e2e 的 waitFor 模式）：FakeChat 长脚本（每块延迟）
// → 发起消息（superagent 惰性发送：挂 .then 处理链触发真实请求）→ 等 user
// 消息落库（生成开始信号）→ 调 stop → 断言 stop 200、SSE 流收到 done（partial）、
// assistant 落库 interrupted=true、FakeChat 被 abort（aborted 标志）。
//
// FakeChat 与 chat-sse.e2e 同模式（静态 script/failWith/aborted）；aborted 标
// 志增强：signal 在监听注册前已 abort 也置位（stop 早于 chatStream 启动的
// 竞态下仍能断言 abort 已传递到 provider）。
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

/** 脚本化 Fake ChatModelService（e2e override CHAT_MODEL_SERVICE 注入，同
 * chat-sse.e2e 模式）：静态 script/failWith/aborted 由各用例在发请求前设置
 * （beforeEach 复位防用例间泄漏）。aborted 标志：接收编排器传入的
 * AbortController.signal——注册 abort 监听置位；signal 在监听注册前已 abort
 * （stop 早于 chatStream 启动的竞态）也置位——测试断言「abort 已传递到
 * provider」不依赖监听注册时机。 */
class FakeChatModelService implements ChatModelService {
  /** 流式块脚本：chatStream 依次 yield（可为空数组 = 无正文增量） */
  static script: ChatStreamChunk[] = [];
  /** abort 触发标志：stop/断连的取消信号已传递到 provider（用例断言） */
  static aborted = false;

  async chat(_messages: ChatMessage[]): Promise<string> {
    return 'SSE 停止测试会话标题';
  }

  async *chatStream(
    _messages: ChatMessage[],
    options?: ChatOptions,
  ): AsyncIterable<ChatStreamChunk> {
    const signal = options?.signal;
    if (signal) {
      // 已 abort（stop 早于本方法启动）→ 立即置位（见类注释）；否则注册监听
      if (signal.aborted) {
        FakeChatModelService.aborted = true;
      } else {
        signal.addEventListener('abort', () => {
          FakeChatModelService.aborted = true;
        });
      }
    }
    for (const chunk of FakeChatModelService.script) {
      // stop/断连（abort）后停止产出——真实实现（fetch 流）被 abort 中断
      if (signal?.aborted) break;
      // 每块间小延迟模拟生成节奏：给 stop 留出「生成中途停止」窗口
      await new Promise((r) => setTimeout(r, 5));
      if (signal?.aborted) break;
      yield chunk;
    }
  }
}

/** 解析 SSE 原始文本 → 事件列表（同 chat-sse.e2e 模式） */
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

describe('Chat 停止生成 (e2e)', () => {
  let app: INestApplication;
  let server: any;
  let dataSource: DataSource;
  let messageRepo: Repository<Message>;
  const ownerEmail = 'chat-stop-owner@ohmydocagent.local';
  const userBEmail = 'chat-stop-userb@ohmydocagent.local';
  let ownerToken = '';
  let userBToken = '';
  // 本文件创建的用户邮箱：afterAll 统一清理其 rt:* 键（共享 Redis 隔离）
  const testEmails = [ownerEmail, userBEmail];
  // owner 的主会话（幂等 stop / 归属 403 用例复用）
  let sessionA = '';
  const auth = () => ({ Authorization: `Bearer ${ownerToken}` });
  const authB = () => ({ Authorization: `Bearer ${userBToken}` });

  /** 助手：发送对话消息（SSE 流式响应；.buffer(true) 显式声明缓冲） */
  function sendMessage(sessionId: string, content: string, token: string) {
    return request(server)
      .post(`/api/v1/chat/sessions/${sessionId}/messages`)
      .set('Authorization', `Bearer ${token}`)
      .send({ content })
      .buffer(true);
  }

  /** 助手：新建独立会话（避免用例间历史消息干扰） */
  async function createSession(): Promise<string> {
    const created = await request(server)
      .post('/api/v1/chat/sessions')
      .set(auth())
      .send({});
    expect(created.status).toBe(201);
    return created.body.id as string;
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
    // 测试隔离（沿用既有约定）：清空消息/会话/模型 + 用户/邀请
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
      name: '停止测试所有者',
    });
    expect(initRes.status).toBe(201);
    ownerToken = initRes.body.accessToken as string;
    // 前置：公开注册第二个用户（归属 403 用例）
    const regRes = await request(server).post('/api/v1/auth/register').send({
      email: userBEmail,
      password: 'Admin123456',
      name: '停止测试用户乙',
    });
    expect(regRes.status).toBe(201);
    userBToken = regRes.body.accessToken as string;
    // 前置：预置默认 chat 模型记录（供应商调用被 Fake 覆盖——不打真实 API）
    const modelRes = await request(server)
      .post('/api/v1/models')
      .set(auth())
      .send({
        name: '停止测试模型',
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
    FakeChatModelService.aborted = false;
  });

  it(
    '生成中调用 stop → 200 { stopped: true }，SSE 流收到 done（partial），assistant 落库 interrupted=true',
    { timeout: 30000 },
    async () => {
      const sid = await createSession();
      // 长脚本 + 每块 5ms 延迟：总生成时长约 1.5s——stop 在生成进行中到达
      FakeChatModelService.script = Array.from({ length: 300 }, (_, i) => ({
        text: `块${i}`,
      }));
      const req = sendMessage(sid, '停止测试', ownerToken);
      // superagent 惰性发送：挂一个最早的处理链触发真实请求（否则请求一直
      // 不发出，waitFor 永远看不到 user 消息落库）；同时拿到解析后的响应体
      // （.buffer(true) → res.text 即完整 SSE 流文本）
      const reqSettled: Promise<{ status: string; res?: request.Response }> =
        req.then(
          (r) => ({ status: 'resolved', res: r }),
          () => ({ status: 'rejected', res: undefined }),
        );
      // 等生成真正开始（user 消息已落库 = 编排器已进入生成阶段）
      await vi.waitFor(async () => {
        const msgs = await messageRepo.find({ where: { sessionId: sid } });
        expect(msgs.length).toBe(1); // 仅 user 消息：生成已开始、尚未到 assistant
      });
      // 调 stop：归属校验通过 + 活动生成存在 → 200 { stopped: true }
      const stopRes = await request(server)
        .post(`/api/v1/chat/sessions/${sid}/stop`)
        .set(auth())
        .send();
      expect(stopRes.status).toBe(200);
      expect(stopRes.body).toEqual({ stopped: true });
      // SSE 流正常收尾（stop 后编排器发收尾事件 + end）：done 事件携带
      // interrupted=true（partial 内容）——socket 仍开，客户端能收到
      const sseText = await reqSettled;
      expect(sseText.status).toBe('resolved');
      const events = parseSse(sseText.res!.text as string);
      // 收尾事件序：stage(generate done) → done（interrupted=true）
      expect(events[events.length - 1].event).toBe('done');
      expect(events[events.length - 2].event).toBe('stage');
      const done = events[events.length - 1].data;
      expect(done.type).toBe('done');
      expect(done.interrupted).toBe(true);
      // assistant 落库：partial + interrupted=true（生成未完成标记）
      await vi.waitFor(async () => {
        const msgs = await messageRepo.find({ where: { sessionId: sid } });
        expect(msgs.length).toBe(2); // user + partial assistant
      });
      const messages = await messageRepo.find({
        where: { sessionId: sid },
        order: { createdAt: 'ASC', id: 'ASC' },
      });
      expect(messages[0].role).toBe('user');
      expect(messages[0].content).toBe('停止测试');
      expect(messages[1].role).toBe('assistant');
      expect(messages[1].interrupted).toBe(true);
      // partial 是脚本连续前缀（stop 不丢已生成部分）
      const full = FakeChatModelService.script.map((c) => c.text).join('');
      expect(full.startsWith(messages[1].content)).toBe(true);
      // done.messageId 与落库 assistant 一致（前端定位消息的依据）
      expect(done.messageId).toBe(messages[1].id);
    },
  );

  it('无活动生成时 stop → 200 { stopped: false, reason: no_active_generation }（幂等，前端连点安全）', async () => {
    // sessionA 无活动生成（既有用例的生成均已 await 完成、finally 注销）
    const stopRes = await request(server)
      .post(`/api/v1/chat/sessions/${sessionA}/stop`)
      .set(auth())
      .send();
    expect(stopRes.status).toBe(200);
    expect(stopRes.body).toEqual({
      stopped: false,
      reason: 'no_active_generation',
    });
  });

  it('他人会话 stop → 403；会话不存在 → 404（归属校验在 registry 之前）', async () => {
    // 403：userB 操作 owner 的 sessionA（归属校验：非本人 → 403）
    const forbidden = await request(server)
      .post(`/api/v1/chat/sessions/${sessionA}/stop`)
      .set(authB())
      .send();
    expect(forbidden.status).toBe(403);
    // 404：不存在的会话（uuid 格式）
    const missing = await request(server)
      .post('/api/v1/chat/sessions/00000000-0000-4000-8000-000000000000/stop')
      .set(auth())
      .send();
    expect(missing.status).toBe(404);
    // 404：非 UUID 格式 id（22P02 兜底，不泄露 500）
    const notUuid = await request(server)
      .post('/api/v1/chat/sessions/not-a-uuid/stop')
      .set(auth())
      .send();
    expect(notUuid.status).toBe(404);
    // 401：未登录（全局 JwtAuthGuard）
    const unauth = await request(server)
      .post(`/api/v1/chat/sessions/${sessionA}/stop`)
      .send();
    expect(unauth.status).toBe(401);
  });

  it(
    'stop 后 FakeChat abort 触发（生成停止，烧 token 止损）且已累积内容为脚本连续前缀',
    { timeout: 30000 },
    async () => {
      const sid = await createSession();
      FakeChatModelService.script = Array.from({ length: 300 }, (_, i) => ({
        text: `块${i}`,
      }));
      FakeChatModelService.aborted = false;
      const req = sendMessage(sid, '止损测试', ownerToken);
      const reqSettled = req.then(
        () => 'resolved',
        () => 'rejected',
      );
      await vi.waitFor(async () => {
        const msgs = await messageRepo.find({ where: { sessionId: sid } });
        expect(msgs.length).toBe(1);
      });
      const stopRes = await request(server)
        .post(`/api/v1/chat/sessions/${sid}/stop`)
        .set(auth())
        .send();
      expect(stopRes.status).toBe(200);
      // abort 已传递到 provider（Fake 注册的 abort 监听被触发）——真实实现中
      // fetch 流被中断、上游生成停止（烧 token 止损）。服务端处理 stop → abort
      // 是异步的，用 waitFor 轮询
      await vi.waitFor(() => expect(FakeChatModelService.aborted).toBe(true));
      await reqSettled;
      // 已累积内容为脚本连续前缀且长度小于全长（生成被中止，止损生效）
      const messages = await messageRepo.find({
        where: { sessionId: sid },
        order: { createdAt: 'ASC', id: 'ASC' },
      });
      expect(messages).toHaveLength(2);
      expect(messages[1].interrupted).toBe(true);
      const full = FakeChatModelService.script.map((c) => c.text).join('');
      expect(full.startsWith(messages[1].content)).toBe(true);
      expect(messages[1].content.length).toBeLessThan(full.length);
    },
  );

  it('正常完成的消息 interrupted=false（回归：interrupted 只标记未完成生成）', async () => {
    const sid = await createSession();
    FakeChatModelService.script = [{ text: '正常完成回复' }];
    const res = await sendMessage(sid, '回归测试', ownerToken);
    expect(res.status).toBe(200);
    const messages = await messageRepo.find({
      where: { sessionId: sid },
      order: { createdAt: 'ASC', id: 'ASC' },
    });
    expect(messages).toHaveLength(2);
    expect(messages[1].role).toBe('assistant');
    expect(messages[1].content).toBe('正常完成回复');
    // 正常完成：interrupted 为默认 false（stop/断连才置 true）
    expect(messages[1].interrupted).toBe(false);
  });
});
