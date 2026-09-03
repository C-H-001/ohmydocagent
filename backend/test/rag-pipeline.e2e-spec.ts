// RAG e2e（Task 2.5 + Task 2.8 方案 A 迁移）：POST /chat/sessions/:id/messages
// 走 Agent 工具循环（AgentOrchestratorService 接管——Task 2.5 固定五阶段管线
// 改造为 search_kb 工具，见 chat-orchestrator.service.ts 文件头注释）。前置与
// vector.e2e 同模式：上传含目标句子的 md → 解析分块 → EMBED_QUEUE 向量化 →
// 建会话（kbIds=[kbId]）→ FakeChat 脚本化「第一轮 search_kb 工具调用 + 第二轮
// 正文」→ 断言 stage 序列（search/rerank/merge 在工具执行时发出；query_understand
// 取消——职责并入 LLM 工具调用参数）、工具结果回填、references 落库。
//
// FakeChatModelService（override CHAT_MODEL_SERVICE）：脚本块可含
// { text } / { toolCalls }（ChatStreamChunk 扩展，Task 2.8）；streamCalls 记录
// 每次 chatStream 入参（断言系统提示/历史/工具结果回填）；chat() 供标题生成
// 消费（chatScript 可脚本化）。
// MockEmbeddingService（override EMBEDDING_SERVICE）：n-gram 特征哈希的确定性
// 向量（与 vector.e2e 同——检索相关性可测，见 vector.e2e 文件头注释）。
//
// 检索语义：md 文档含独立标点段「智能客服系统：…」（'simple' 分词器把标点
// 分隔的连续 CJK 串作为独立 token，见 vector.e2e 文件头注释）；查询
// 「智能客服系统」向量路 n-gram 重叠 + 关键词路 token 精确匹配双命中。
//
// 决策覆盖（Task 2.8 迁移）：
// - kbIds 空 → 工具定义不含 search_kb（只有 web_search），事件序列不含检索
//   stage（系统提示说明未关联知识库）
// - 检索 0 结果 → 工具返回「未找到相关内容」文案（跳过 merge stage），正常 done
// - references 落库：search_kb 工具的结果生成 references（随 assistant 落库，
//   [n] 编号/标题/内容/score 语义不变，Task 2.6）
// - 多轮对话：历史仍传入（指代上下文不丢）；检索 query 由 LLM 工具调用参数
//   决定（query_understand 职责并入——原「改写」测试改为断言工具调用参数）
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { DataSource, Repository } from 'typeorm';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { AppModule } from '../src/app.module.js';
import { prepareTestEnv } from './test-db.js';
import { configureApp } from '../src/app.setup.js';
import { waitFor } from './wait-for.js';
import {
  PARSE_QUEUE,
  EMBED_QUEUE,
} from '../src/modules/parse/parse-queue.constants.js';
import { CHAT_MODEL_SERVICE } from '../src/modules/model/chat-model.interface.js';
import type {
  ChatMessage,
  ChatModelService,
  ChatOptions,
  ChatStreamChunk,
} from '../src/modules/model/chat-model.interface.js';
import { EMBEDDING_SERVICE } from '../src/modules/model/embedding.interface.js';
import { MockEmbeddingService } from '../src/modules/model/mock/mock-embedding.service.js';
import { Knowledge } from '../src/modules/knowledge/knowledge.entity.js';
import { Message } from '../src/modules/chat/message.entity.js';
import { User } from '../src/modules/users/user.entity.js';
import { RedisService } from '../src/redis/redis.service.js';

/** 脚本化 Fake ChatModelService（override CHAT_MODEL_SERVICE 注入）：
 * - chatStream：按 script 依次 yield（脚本块可为 { text } 或 { toolCalls }，
 *   Task 2.8 扩展；可 failWith 抛错）。**渐进消费**（Agent 多轮语义）：scriptIndex
 *   游标跨调用推进——每次 chatStream 消费一段响应（到工具调用块为止，下一轮
 *   从下一块开始）；无工具调用时一轮消费完整个脚本（与既有单轮语义一致）。
 * - chat：供标题生成消费——chatScript 可脚本化返回值；chatCalls 记录入参 */
class FakeChatModelService implements ChatModelService {
  static script: ChatStreamChunk[] = [];
  static scriptIndex = 0;
  static failWith: Error | null = null;
  static chatScript: string | null = null;
  static streamCalls: ChatMessage[][] = [];
  static chatCalls: ChatMessage[][] = [];

  async chat(messages: ChatMessage[]): Promise<string> {
    FakeChatModelService.chatCalls.push(messages);
    return FakeChatModelService.chatScript ?? 'RAG 测试会话标题';
  }

  async *chatStream(
    messages: ChatMessage[],
    options?: ChatOptions,
  ): AsyncIterable<ChatStreamChunk> {
    if (FakeChatModelService.failWith) {
      throw FakeChatModelService.failWith;
    }
    FakeChatModelService.streamCalls.push(
      messages.map((m) => ({ ...m })), // 快照（防 Agent 原位 push 污染）
    );
    for (
      let i = FakeChatModelService.scriptIndex;
      i < FakeChatModelService.script.length;
      i++
    ) {
      const chunk = FakeChatModelService.script[i];
      if (options?.signal?.aborted) break;
      await new Promise((r) => setTimeout(r, 5));
      if (options?.signal?.aborted) break;
      yield chunk;
      FakeChatModelService.scriptIndex = i + 1;
      // 工具调用块 = 该轮响应的终点（下一轮从下一块开始——Agent 每轮调一次
      // chatStream，见 agent-orchestrator.service.ts 循环注释）
      if (chunk.toolCalls && chunk.toolCalls.length > 0) return;
    }
  }
}

/** 解析 SSE 原始文本 → 事件列表（与 chat-sse e2e 同模式） */
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

describe('RAG via Agent 工具循环 (e2e)', () => {
  let app: INestApplication;
  let server: any;
  let dataSource: DataSource;
  let messageRepo: Repository<Message>;
  const ownerEmail = 'rag-owner@ohmydocagent.local';
  let ownerToken = '';
  const testEmails = [ownerEmail];
  // 本文件创建的知识库 id：afterAll 清理其上传目录
  const kbIds: string[] = [];
  let docId = '';
  const auth = () => ({ Authorization: `Bearer ${ownerToken}` });

  /** search_kb 工具调用块（用例统一前置：第一轮调工具、第二轮正文） */
  function searchKbCall(query: string): ChatStreamChunk {
    return {
      text: '',
      toolCalls: [
        {
          id: 'call_kb',
          name: 'search_kb',
          arguments: JSON.stringify({ query }),
        },
      ],
    };
  }

  /** 上传助手：multipart 内存 buffer + 文件名 */
  function uploadFile(kbId: string, filename: string, buffer: Buffer) {
    return request(server)
      .post(`/api/v1/kbs/${kbId}/file`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .attach('file', buffer, { filename });
  }

  /** 创建会话（kbIds 可指定） */
  function createSession(kbIdsOfSession: string[]) {
    return request(server)
      .post('/api/v1/chat/sessions')
      .set(auth())
      .send({ kbIds: kbIdsOfSession });
  }

  /** 发送对话消息（SSE 流式响应） */
  function sendMessage(sessionId: string, content: string) {
    return request(server)
      .post(`/api/v1/chat/sessions/${sessionId}/messages`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ content })
      .buffer(true);
  }

  /** 已向量化的块数（embedding 非空 + indexStatus=ready） */
  const countEmbedded = (knowledgeId: string) =>
    dataSource.query<Array<{ count: string }>>(
      `SELECT count(*) AS count FROM chunks
       WHERE "knowledgeId" = $1 AND "indexStatus" = 'ready' AND embedding IS NOT NULL`,
      [knowledgeId],
    );

  /**
   * 检索测试文档（~300 字 < 默认 chunkSize=800，单块即可）：目标短语
   * 「智能客服系统」以 '：' 独立段书写（'simple' 分词器语义见文件头注释）。
   * 文档标题「智能客服系统使用手册」= references 的 knowledgeTitle 断言值。
   */
  const mdContent = [
    '# 智能客服系统使用手册',
    '',
    '智能客服系统：支持多渠道接入，包括网页、微信公众号、企业微信与电话渠道（电话语音），用户可在任一渠道获得一致的服务体验。',
    '智能客服系统：内置知识库问答能力，基于企业知识库进行检索增强生成（RAG），回答自动标注引用来源。',
    '智能客服系统：支持人工坐席接管，机器人无法回答时自动转接人工客服，保证服务不中断。',
    '智能客服系统：提供会话记录查询与质检分析，帮助运营团队持续优化服务流程。',
  ].join('\n');

  beforeAll(async () => {
    await prepareTestEnv();
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(CHAT_MODEL_SERVICE)
      .useClass(FakeChatModelService)
      .overrideProvider(EMBEDDING_SERVICE)
      .useClass(MockEmbeddingService)
      .compile();
    dataSource = moduleRef.get(DataSource);
    // 测试隔离（沿用 vector.e2e 模式）：清空全链路表 + 清空 parse/embed 队列
    await dataSource.query(
      'TRUNCATE TABLE users, invitations, user_kb_pins, knowledge_bases, knowledge, chunk_revisions, chunks, messages, sessions, models CASCADE',
    );
    const parseQueue = moduleRef.get(getQueueToken(PARSE_QUEUE));
    await parseQueue.obliterate({ force: true });
    const embedQueue = moduleRef.get(getQueueToken(EMBED_QUEUE));
    await embedQueue.obliterate({ force: true });
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    server = app.getHttpServer();
    messageRepo = dataSource.getRepository(Message);
    // 前置：init 创建 Owner + 创建知识库
    const initRes = await request(server).post('/api/v1/auth/init').send({
      email: ownerEmail,
      password: 'Owner123456',
      name: 'RAG 测试所有者',
    });
    expect(initRes.status).toBe(201);
    ownerToken = initRes.body.accessToken as string;
    const kbRes = await request(server)
      .post('/api/v1/kbs')
      .set(auth())
      .send({ name: 'RAG 测试知识库' });
    expect(kbRes.status).toBe(201);
    kbIds.push(kbRes.body.id as string);
  });

  afterAll(async () => {
    // 清理本文件的上传产物（不动开发数据）
    for (const id of kbIds) {
      await rm(path.join(process.cwd(), 'uploads', id), {
        recursive: true,
        force: true,
      }).catch(() => undefined);
    }
    // 清理本文件产生的 rt:* 键（共享 Redis 隔离，沿用既有约定）
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
    FakeChatModelService.scriptIndex = 0;
    FakeChatModelService.failWith = null;
    FakeChatModelService.chatScript = null;
    FakeChatModelService.streamCalls = [];
    FakeChatModelService.chatCalls = [];
  });

  it('前置：上传文档并等待解析/向量化完成（RAG 检索的数据准备）', async () => {
    const res = await uploadFile(
      kbIds[0],
      '智能客服系统使用手册.md',
      Buffer.from(mdContent),
    );
    expect(res.status).toBe(201);
    docId = res.body.id as string;
    const knowledgeRepo = dataSource.getRepository(Knowledge);
    await waitFor(
      async () => {
        const k = await knowledgeRepo.findOne({ where: { id: docId } });
        return k !== null && k.status === 'ready' && (k.chunkCount ?? 0) > 0;
      },
      { description: 'md 文档解析分块完成（ready 且 chunkCount>0）' },
    );
    const k = await knowledgeRepo.findOne({ where: { id: docId } });
    await waitFor(
      async () => {
        const rows = await countEmbedded(docId);
        return Number(rows[0].count) === k!.chunkCount;
      },
      {
        description:
          '全部 chunks 向量化完成（embedding 非空 + indexStatus=ready）',
      },
    );
  });

  it('search_kb 工具执行时发 stage 序列：search→rerank→merge（generate start/done 包住整个循环）', async () => {
    const created = await createSession([kbIds[0]]);
    expect(created.status).toBe(201);
    // 第一轮：search_kb 工具调用（query 由 LLM 决定）；第二轮：正文
    FakeChatModelService.script = [
      searchKbCall('智能客服系统支持哪些渠道？'),
      { text: '根据资料，智能客服系统支持多渠道接入。' },
    ];
    const res = await sendMessage(
      created.body.id as string,
      '智能客服系统支持哪些渠道？',
    );
    expect(res.status).toBe(200);
    const events = parseSse(res.text as string);
    // 事件序列：stage(generate start) → 工具执行（search/rerank/merge 各
    // start+done）→ tool_call（执行完成后含 result）→ delta → stage(generate
    // done)（编排器落库后）→ done。query_understand 取消（职责并入 LLM 工具
    // 调用参数，见文件头注释）
    expect(events.map((e) => e.event)).toEqual([
      'stage',
      'stage',
      'stage',
      'stage',
      'stage',
      'stage',
      'stage',
      'tool_call',
      'delta',
      'stage',
      'done',
    ]);
    const stageData = events
      .filter((e) => e.event === 'stage')
      .map((e) => e.data);
    expect(stageData.map((d) => d.stage)).toEqual([
      'generate',
      'search',
      'search',
      'rerank',
      'rerank',
      'merge',
      'merge',
      'generate',
    ]);
    expect(stageData.map((d) => d.status)).toEqual([
      'start',
      'start',
      'done',
      'start',
      'done',
      'start',
      'done',
      'done',
    ]);
    // 收尾：done 事件（messageId + 无 error）
    expect(events.some((e) => e.event === 'error')).toBe(false);
    expect(events[events.length - 1].data.type).toBe('done');
  });

  it('assistant 消息落库含 references（search_kb 工具结果生成：chunkId/knowledgeId/标题/内容/score）', async () => {
    const created = await createSession([kbIds[0]]);
    expect(created.status).toBe(201);
    const sid = created.body.id as string;
    // 正文含 [1]：生成后对齐保留被引用的引用（Task 2.6——正文无 [n] 时
    // 引用被剔除，见 references.service.ts 对齐语义）
    FakeChatModelService.script = [
      searchKbCall('智能客服系统'),
      { text: '根据资料 [1] 可知，智能客服系统支持多渠道接入。' },
    ];
    const res = await sendMessage(sid, '智能客服系统');
    expect(res.status).toBe(200);
    const assistant = await messageRepo.findOne({
      where: { sessionId: sid, role: 'assistant' },
    });
    expect(assistant).toBeDefined();
    const refs = assistant!.references as Array<Record<string, unknown>>;
    expect(refs.length).toBeGreaterThan(0);
    const first = refs[0];
    // [n] 编号从 1 开始（与工具返回文本中的引用编号对齐）
    expect(first.index).toBe(1);
    expect(typeof first.chunkId).toBe('string');
    // knowledgeId 指向上传的文档（标题 = 文件名去扩展名，补查 knowledge 表）
    expect(first.knowledgeId).toBe(docId);
    expect(first.knowledgeTitle).toBe('智能客服系统使用手册');
    // 内容：分块内容（截断后 ≤ 200 字符 + 省略号，Task 2.6 悬浮摘要长度）
    expect(typeof first.content).toBe('string');
    expect(String(first.content).length).toBeLessThanOrEqual(201);
    expect(String(first.content)).toContain('智能客服系统');
    // chunks：同文档合并的位置数组（单块文档为单元素数组，前端处理统一）
    expect(Array.isArray(first.chunks)).toBe(true);
    expect((first.chunks as unknown[]).length).toBeGreaterThan(0);
    // score：融合检索分（>0 表示命中）
    expect(Number(first.score)).toBeGreaterThan(0);
  });

  it('生成内容基于检索上下文：工具结果消息含 [1] 引用行（回填 LLM），系统提示含引用规则', async () => {
    const created = await createSession([kbIds[0]]);
    expect(created.status).toBe(201);
    const sid = created.body.id as string;
    // FakeChat 脚本化：第一轮调 search_kb、第二轮引用 [1] 的文本（模拟 LLM
    // 基于工具返回资料的回答）
    FakeChatModelService.script = [
      searchKbCall('智能客服系统支持哪些渠道？'),
      { text: '根据资料 [1] 可知，智能客服系统支持多渠道接入。' },
    ];
    const res = await sendMessage(sid, '智能客服系统支持哪些渠道？');
    expect(res.status).toBe(200);
    // 第二轮消息（FakeChat 记录）：系统提示 + 当前问题 + assistant(tool_calls)
    // + tool(检索结果)——工具结果含 [1] 引用行（标题 + 内容）
    const round2 = FakeChatModelService.streamCalls[1];
    const toolMsg = round2.find((m) => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    expect(String(toolMsg!.content)).toContain('[1]');
    expect(String(toolMsg!.content)).toContain('智能客服系统使用手册');
    expect(String(toolMsg!.content)).toContain('智能客服系统');
    // 系统提示（agent 提示）：引用规则「标注引用 [n]」
    const systemPrompt = round2[0].content;
    expect(systemPrompt).toContain('标注引用');
    // 生成内容（落库）含 [1]（与工具返回文本的引用编号对应）
    const assistant = await messageRepo.findOne({
      where: { sessionId: sid, role: 'assistant' },
    });
    expect(assistant!.content).toContain('[1]');
  });

  it('检索无结果 → 友好提示（不报错；工具结果含「未找到相关内容」，跳过 merge stage）', async () => {
    const created = await createSession([kbIds[0]]);
    expect(created.status).toBe(201);
    const sid = created.body.id as string;
    FakeChatModelService.script = [
      // 无关查询（与文档无共享 n-gram + 无关键词命中 → 检索空数组）
      searchKbCall('qwerty zzzz frobnicate'),
      { text: '抱歉，未找到相关内容。' },
    ];
    const res = await sendMessage(sid, 'qwerty zzzz frobnicate');
    expect(res.status).toBe(200);
    const events = parseSse(res.text as string);
    // 不报错（无 error 事件）、正常 done
    expect(events.some((e) => e.event === 'error')).toBe(false);
    expect(events.some((e) => e.event === 'done')).toBe(true);
    // 跳过 merge stage（检索 0 结果 → 无引用可合并，同 Task 2.5 语义）
    const stageNames = events
      .filter((e) => e.event === 'stage')
      .map((e) => e.data.stage);
    expect(stageNames).not.toContain('merge');
    // 工具结果消息：未找到相关内容，请基于常识回答并说明（search_nothing 语义）
    const round2 = FakeChatModelService.streamCalls[1];
    const toolMsg = round2.find((m) => m.role === 'tool');
    expect(String(toolMsg!.content)).toContain('未找到相关内容');
    // assistant 正常落库、无 references
    const assistant = await messageRepo.findOne({
      where: { sessionId: sid, role: 'assistant' },
    });
    expect(assistant!.references).toEqual([]);
  });

  it('会话无 kbIds → 工具定义不含 search_kb（事件序列不含检索 stage；系统提示说明未关联知识库）', async () => {
    const created = await createSession([]);
    expect(created.status).toBe(201);
    const sid = created.body.id as string;
    FakeChatModelService.script = [{ text: '直接回答。' }];
    const res = await sendMessage(sid, '你好');
    expect(res.status).toBe(200);
    const events = parseSse(res.text as string);
    // 只发 generate start/done（无 search/rerank/merge——无 search_kb 工具）
    const stageNames = events
      .filter((e) => e.event === 'stage')
      .map((e) => e.data.stage);
    expect(stageNames).toEqual(['generate', 'generate']);
    // 系统提示：说明未关联知识库（决策：无 kbIds → 不注入 search_kb，直接回答）
    const systemPrompt = FakeChatModelService.streamCalls[0][0].content;
    expect(systemPrompt).toContain('未关联知识库');
    // 正常完成（done + 无 error）
    expect(events.some((e) => e.event === 'error')).toBe(false);
    expect(events.some((e) => e.event === 'done')).toBe(true);
  });

  it('会话无 kbIds 多轮对话：第二轮 generate 历史含第一轮内容（指代上下文不丢，质量审查整改 #2）', async () => {
    const created = await createSession([]);
    expect(created.status).toBe(201);
    const sid = created.body.id as string;
    // 第一轮：无知识库直接生成（无历史）
    FakeChatModelService.script = [{ text: '第一轮回答' }];
    const first = await sendMessage(sid, '介绍一下智能客服系统');
    expect(first.status).toBe(200);
    // 第二轮：指代问题（「那…呢？」）——generate 入参须含第一轮历史
    FakeChatModelService.scriptIndex = 0; // 游标随新脚本复位（跨消息）
    FakeChatModelService.script = [{ text: '第二轮回答' }];
    const second = await sendMessage(sid, '那电话渠道呢？');
    expect(second.status).toBe(200);
    // chatStream 入参（FakeChat 记录）：系统提示（未关联知识库）+ 第一轮
    // user/assistant + 当前问题（指代「那电话渠道呢？」可结合上下文解）
    const messages = FakeChatModelService.streamCalls[1];
    expect(messages.map((m) => m.role)).toEqual([
      'system',
      'user',
      'assistant',
      'user',
    ]);
    expect(String(messages[1].content)).toContain('介绍一下智能客服系统');
    expect(String(messages[2].content)).toBe('第一轮回答');
    expect(String(messages[3].content)).toBe('那电话渠道呢？');
    // 两轮都正常完成（done + 无 error）
    expect(
      parseSse(second.text as string).some((e) => e.event === 'error'),
    ).toBe(false);
  });

  it('历史上下文：第二轮工具调用的检索 query 由 LLM 决定（消息含历史；tool_call 事件参数透传）', async () => {
    const created = await createSession([kbIds[0]]);
    expect(created.status).toBe(201);
    const sid = created.body.id as string;
    // 第一轮：无历史直接生成（不调工具）
    FakeChatModelService.script = [{ text: '第一轮回答' }];
    const first = await sendMessage(sid, '智能客服系统支持哪些渠道？');
    expect(first.status).toBe(200);
    // 第二轮：LLM 结合历史决定检索 query（query_understand 职责并入工具调用
    // 参数——FakeChat 模拟 LLM 把「那电话渠道呢？」改写后的检索词放进参数）
    FakeChatModelService.scriptIndex = 0; // 游标随新脚本复位（跨消息）
    FakeChatModelService.script = [
      searchKbCall('那电话渠道呢？'),
      { text: '第二轮回答' },
    ];
    const second = await sendMessage(sid, '那电话渠道呢？');
    expect(second.status).toBe(200);
    // 第二轮首轮消息（FakeChat 记录）：系统提示 + 第一轮 user/assistant +
    // 当前问题——历史传入（LLM 结合上下文决定检索词）
    const round2First = FakeChatModelService.streamCalls[1];
    expect(round2First.map((m) => m.role)).toEqual([
      'system',
      'user',
      'assistant',
      'user',
    ]);
    expect(String(round2First[3].content)).toBe('那电话渠道呢？');
    // tool_call 事件：参数透传 LLM 决定的检索 query（原 query_understand
    // 改写语义——由模型决策，服务端不再单独改写）
    const events = parseSse(second.text as string);
    const toolCallEvent = events.find((e) => e.event === 'tool_call');
    expect(toolCallEvent).toBeDefined();
    const call = toolCallEvent!.data.call as Record<string, unknown>;
    expect(call.name).toBe('search_kb');
    expect(call.arguments).toEqual({ query: '那电话渠道呢？' });
    expect(String(call.result)).toContain('[1]');
  });
});
