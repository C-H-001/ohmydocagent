// 引用系统 e2e（Task 2.6）：POST /chat/sessions/:id/messages 完整链路下验证
// 引用语义（同文档合并 / 正文 [n] 对齐 / 无引用剔除 / references 事件一致性）。
// 前置与 rag-pipeline.e2e 同模式：上传两个文档（文档 A 5 段「智能客服系统」、
// 文档 B 5 段「工单流转」，各段 ~180 字，整文 > 800 字 → 每文档 2 块，各块
// 均含目标短语——同文档多块命中）→ 等 ready + 向量化 → 建会话（kbIds=[kb]）
// → FakeChat 脚本化返回含 [n] 的正文。
//
// 检索语义（与 vector.e2e 同，见其文件头注释）：查询
// 「智能客服系统：支持哪些渠道？工单流转：如何自动处理？」的 plainto_tsquery
// 为 4 个 token 的 AND（'simple' 分词器按标点切 token）——单块无法同时命中
// 两文档的 token，关键词路无命中（已实测，见向量路注释）；检索完全依赖向量
// 路（n-gram 特征哈希，MockEmbeddingService）：文档 A 各段重复「智能客服
// 系统/支持/渠道」、文档 B 重复「工单流转/自动/处理」，与查询共享 bigram，
// 余弦 0.30~0.38（> MIN_VECTOR_SCORE=0.05，已实测）。
// 文档 A 2 块 + 文档 B 2 块 = 4 块全部命中 → rerank 截断 top5 全保留 →
// build 按 knowledgeId 合并 → references 恰 2 条（各含 chunks 位置数组 2 项）。
// 文档 A 块余弦高于文档 B（0.38 vs 0.33，已实测）→ 编号 1 = 文档 A、2 = 文档 B。
//
// 决策覆盖（编号语义，见 references.service.ts 注释）：
// - 同文档多分块合并为一个引用（knowledgeId 去重，chunks 记录全部位置）
// - 编号按首次出现顺序 1..N（与 references 数组下标对齐：[1]↔refs[0]）
// - 正文 [n] 兜底对齐：正文未引用的引用被剔除（index 保留原文编号不重映射）
// - 正文无 [n] → references 为空数组（无引用不生成）
// - references 事件（SSE）与落库 references 一致（事件在 generate 完成后、
//   stage(generate done) 之前发出——编排器落库同一份引用）
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
import type { RagReference } from '../src/modules/chat/pipeline/rag.types.js';

/** 脚本化 Fake ChatModelService（override CHAT_MODEL_SERVICE 注入）：与
 * rag-pipeline e2e 同模式——chatStream 按 script 依次 yield（脚本块可为
 * { text } 或 { toolCalls }，Task 2.8 扩展）。**渐进消费**（Agent 多轮语义）：
 * scriptIndex 游标跨调用推进——每次 chatStream 消费一段响应（到工具调用块
 * 为止，下一轮从下一块开始）。streamCalls 记录每次 chatStream 入参（工具
 * 结果回填断言用）。chat 供标题生成消费。 */
class FakeChatModelService implements ChatModelService {
  static script: ChatStreamChunk[] = [];
  static scriptIndex = 0;
  static failWith: Error | null = null;
  static streamCalls: ChatMessage[][] = [];

  async chat(_messages: ChatMessage[]): Promise<string> {
    return '引用系统测试会话标题';
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

/** search_kb 工具调用块（引用用例统一前置：第一轮调工具、第二轮正文——
 * query 与 sendMessage 内容一致才能命中目标文档，见文件头检索语义注释） */
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

describe('引用系统 (e2e)', () => {
  let app: INestApplication;
  let server: any;
  let dataSource: DataSource;
  let messageRepo: Repository<Message>;
  const ownerEmail = 'refs-owner@ohmydocagent.local';
  let ownerToken = '';
  const testEmails = [ownerEmail];
  // 本文件创建的知识库 id：afterAll 清理其上传目录
  const kbIds: string[] = [];
  let docAId = ''; // 文档 A（3 段「智能客服系统」）
  let docBId = ''; // 文档 B（2 段「工单流转」）
  const auth = () => ({ Authorization: `Bearer ${ownerToken}` });

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

  /** 查询最近一条 assistant 消息的 references */
  async function lastAssistantRefs(sessionId: string): Promise<RagReference[]> {
    const assistant = await messageRepo.findOne({
      where: { sessionId, role: 'assistant' },
      order: { createdAt: 'DESC' },
    });
    expect(assistant).toBeDefined();
    return (assistant!.references ?? []) as RagReference[];
  }

  /**
   * 检索测试文档（各段 ~180 字、整文 > 800 字 → 每文档 2 块，检索语义见
   * 文件头注释）：文档 A 各段重复「智能客服系统/支持/渠道」、文档 B 各段
   * 重复「工单流转/自动/处理」——与查询「智能客服系统：支持哪些渠道？
   * 工单流转：如何自动处理？」共享字符 bigram（向量路命中）；块余弦与分块
   * 结果已在实现期用真实 ChunkingService + MockEmbeddingService 校验。
   */
  const paraA = (i: number): string => {
    const core = [
      '智能客服系统支持多渠道接入，智能客服系统支持电话语音渠道，智能客服系统支持网页与微信渠道，用户可在任一渠道获得一致服务体验。',
      '智能客服系统内置知识库问答能力，智能客服系统支持检索增强生成，智能客服系统回答时自动标注引用来源，显著降低人工重复解答成本。',
      '智能客服系统支持人工坐席接管，智能客服系统无法回答时自动转接人工客服，智能客服系统保证服务不中断，并保留完整会话上下文。',
      '智能客服系统提供会话记录查询能力，智能客服系统支持质检分析，智能客服系统帮助运营团队持续优化服务流程，提升客户满意度。',
      '智能客服系统支持知识库版本管理，智能客服系统支持文档自动解析，智能客服系统支持分块与向量化索引，为检索增强生成提供结构化知识底座。',
    ];
    // 补句扩长到 ~180 字（整文 > 800 字 → 每文档 2 块，见文件头检索语义注释）
    const extra =
      '智能客服系统支持统一工作台与渠道数据汇总，智能客服系统持续沉淀服务知识并优化回答质量。';
    let s = core[i];
    while (s.length < 180) s += extra;
    return s;
  };
  const paraB = (i: number): string => {
    const core = [
      '工单流转支持创建与指派，工单流转支持处理与关闭，工单流转全流程自动化处理，工单状态实时同步并透明可见。',
      '工单流转支持自动路由，工单流转支持升级机制，工单流转对超时未处理工单自动升级给上级坐席，保证及时闭环。',
      '工单流转记录完整处理轨迹，工单流转支持客户查看处理进度，工单流转支持处理人更换与转交，工单流转支持工单关联知识库答案。',
      '工单流转支持自动路由，工单流转支持升级机制，工单流转对超时未处理工单自动升级给上级坐席，保证及时闭环。',
      '工单流转支持创建与指派，工单流转支持处理与关闭，工单流转全流程自动化处理，工单状态实时同步并透明可见。',
    ];
    const extra =
      '工单流转支持优先级队列与批量催办，工单流转支持节假日策略与重复单合并，工单流转支持满意度回访。';
    let s = core[i];
    while (s.length < 180) s += extra;
    return s;
  };
  const docAContent = Array.from({ length: 5 }, (_, i) => paraA(i)).join(
    '\n\n',
  );
  const docBContent = Array.from({ length: 5 }, (_, i) => paraB(i)).join(
    '\n\n',
  );

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
      name: '引用系统测试所有者',
    });
    expect(initRes.status).toBe(201);
    ownerToken = initRes.body.accessToken as string;
    const kbRes = await request(server)
      .post('/api/v1/kbs')
      .set(auth())
      .send({ name: '引用系统测试知识库' });
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
    FakeChatModelService.streamCalls = [];
  });

  it('前置：上传文档 A/B 并等待解析/向量化完成（两文档各含多段 → 多块命中）', async () => {
    const resA = await uploadFile(
      kbIds[0],
      '智能客服系统使用手册.md',
      Buffer.from(docAContent),
    );
    expect(resA.status).toBe(201);
    docAId = resA.body.id as string;
    const resB = await uploadFile(
      kbIds[0],
      '工单流转使用指南.md',
      Buffer.from(docBContent),
    );
    expect(resB.status).toBe(201);
    docBId = resB.body.id as string;
    const knowledgeRepo = dataSource.getRepository(Knowledge);
    for (const id of [docAId, docBId]) {
      await waitFor(
        async () => {
          const k = await knowledgeRepo.findOne({ where: { id } });
          return k !== null && k.status === 'ready' && (k.chunkCount ?? 0) > 0;
        },
        { description: `文档解析分块完成（ready 且 chunkCount>0）: ${id}` },
      );
      const k = await knowledgeRepo.findOne({ where: { id } });
      // 整文 > 800 字 → 每文档 2 块（同文档多块命中的前提，见文件头注释）
      expect(k!.chunkCount).toBe(2);
      await waitFor(
        async () => {
          const rows = await dataSource.query<Array<{ count: string }>>(
            `SELECT count(*) AS count FROM chunks
             WHERE "knowledgeId" = $1 AND "indexStatus" = 'ready' AND embedding IS NOT NULL`,
            [id],
          );
          return Number(rows[0].count) === k!.chunkCount;
        },
        {
          description:
            '全部 chunks 向量化完成（embedding 非空 + indexStatus=ready）',
        },
      );
    }
  });

  it('同文档多分块合并为一个引用（两文档 → references 2 条，chunks 位置数组 = 3+2）', async () => {
    const created = await createSession([kbIds[0]]);
    expect(created.status).toBe(201);
    const sid = created.body.id as string;
    // FakeChat 引用 [1][2]（对齐 build 的 1..N 编号）
    FakeChatModelService.script = [
      searchKbCall('智能客服系统：支持哪些渠道？工单流转：如何自动处理？'),
      {
        text: '根据资料 [1][2]，智能客服系统支持多渠道接入，工单流转自动处理。',
      },
    ];
    const res = await sendMessage(
      sid,
      '智能客服系统：支持哪些渠道？工单流转：如何自动处理？',
    );
    expect(res.status).toBe(200);
    const refs = await lastAssistantRefs(sid);
    // 同文档合并：两文档 → 恰 2 条引用
    expect(refs).toHaveLength(2);
    const byDoc = new Map(refs.map((r) => [r.knowledgeId, r]));
    expect(byDoc.get(docAId)).toBeDefined();
    expect(byDoc.get(docBId)).toBeDefined();
    // chunks 位置数组记录同文档全部块（文档 A 2 块、文档 B 2 块——前端点击
    // 引用可定位到各块）
    expect(byDoc.get(docAId)!.chunks).toHaveLength(2);
    expect(byDoc.get(docBId)!.chunks).toHaveLength(2);
    // 主引用 chunkId = 组内最高分块（chunks[0]）
    expect(byDoc.get(docAId)!.chunkId).toBe(
      byDoc.get(docAId)!.chunks![0].chunkId,
    );
    expect(byDoc.get(docBId)!.chunkId).toBe(
      byDoc.get(docBId)!.chunks![0].chunkId,
    );
    // 4 个块位置全量保留
    const allChunks = refs.flatMap((r) => r.chunks ?? []);
    expect(allChunks).toHaveLength(4);
  });

  it('正文 [n] 与 references index 对齐（[1][2] 对应数组 0/1）', async () => {
    const created = await createSession([kbIds[0]]);
    expect(created.status).toBe(201);
    const sid = created.body.id as string;
    FakeChatModelService.script = [
      searchKbCall('智能客服系统：支持哪些渠道？工单流转：如何自动处理？'),
      { text: '答案见 [1] 与 [2]。' },
    ];
    const res = await sendMessage(
      sid,
      '智能客服系统：支持哪些渠道？工单流转：如何自动处理？',
    );
    expect(res.status).toBe(200);
    const refs = await lastAssistantRefs(sid);
    expect(refs).toHaveLength(2);
    // [1]/[2] 与数组下标 0/1 对齐（编号按首次出现顺序 1..N，见 build 注释）
    expect(refs[0].index).toBe(1);
    expect(refs[1].index).toBe(2);
    // 落库正文与 SSE 一致（正文含 [1][2]，未改写）
    const assistant = await messageRepo.findOne({
      where: { sessionId: sid, role: 'assistant' },
    });
    expect(assistant!.content).toBe('答案见 [1] 与 [2]。');
  });

  it('引用含 knowledgeTitle/悬浮摘要（content ≤ 200 字符）/score', async () => {
    const created = await createSession([kbIds[0]]);
    expect(created.status).toBe(201);
    const sid = created.body.id as string;
    FakeChatModelService.script = [
      searchKbCall('智能客服系统：支持哪些渠道？工单流转：如何自动处理？'),
      { text: '根据资料 [1][2] 回答。' },
    ];
    const res = await sendMessage(
      sid,
      '智能客服系统：支持哪些渠道？工单流转：如何自动处理？',
    );
    expect(res.status).toBe(200);
    const refs = await lastAssistantRefs(sid);
    expect(refs).toHaveLength(2);
    const byDoc = new Map(refs.map((r) => [r.knowledgeId, r]));
    // knowledgeTitle：知识库补查（文件名去扩展名，见 rag-pipeline e2e 同断言）
    expect(byDoc.get(docAId)!.knowledgeTitle).toBe('智能客服系统使用手册');
    expect(byDoc.get(docBId)!.knowledgeTitle).toBe('工单流转使用指南');
    // 悬浮摘要：content 截断到 REFERENCE_CONTENT_MAX_LENGTH=200（200 + 省略号）
    for (const r of refs) {
      expect(r.content.length).toBeLessThanOrEqual(201);
      expect(typeof r.content).toBe('string');
      expect(Number(r.score)).toBeGreaterThan(0);
    }
    // 主引用 content 为命中内容（悬浮摘要可展示）
    expect(byDoc.get(docAId)!.content).toContain('智能客服系统');
    expect(byDoc.get(docBId)!.content).toContain('工单流转');
  });

  it('正文未引用的检索块被剔除（references 只含正文引用的）', async () => {
    const created = await createSession([kbIds[0]]);
    expect(created.status).toBe(201);
    const sid = created.body.id as string;
    // FakeChat 只引用 [1]（不引用 [2]）→ 文档 B 的引用被剔除
    FakeChatModelService.script = [
      searchKbCall('智能客服系统：支持哪些渠道？工单流转：如何自动处理？'),
      { text: '根据资料 [1] 回答。' },
    ];
    const res = await sendMessage(
      sid,
      '智能客服系统：支持哪些渠道？工单流转：如何自动处理？',
    );
    expect(res.status).toBe(200);
    const refs = await lastAssistantRefs(sid);
    expect(refs).toHaveLength(1);
    expect(refs[0].index).toBe(1); // index 保留原文编号（不重映射）
    // 被剔除的是未引用的文档 B（正文无 [2]）
    expect(refs[0].knowledgeId).toBe(docAId);
  });

  it('正文无 [n] → references 为空数组（无引用不生成）', async () => {
    const created = await createSession([kbIds[0]]);
    expect(created.status).toBe(201);
    const sid = created.body.id as string;
    // FakeChat 正文无任何 [n]（未标注引用）→ 生成后兜底对齐剔除全部引用
    FakeChatModelService.script = [
      searchKbCall('智能客服系统：支持哪些渠道？工单流转：如何自动处理？'),
      { text: '根据检索到的内容，智能客服系统支持多渠道接入。' },
    ];
    const res = await sendMessage(
      sid,
      '智能客服系统：支持哪些渠道？工单流转：如何自动处理？',
    );
    expect(res.status).toBe(200);
    const refs = await lastAssistantRefs(sid);
    expect(refs).toEqual([]);
  });

  it('references 事件与落库一致（SSE references 事件 = DB 落库 references）', async () => {
    const created = await createSession([kbIds[0]]);
    expect(created.status).toBe(201);
    const sid = created.body.id as string;
    FakeChatModelService.script = [
      searchKbCall('智能客服系统：支持哪些渠道？工单流转：如何自动处理？'),
      { text: '根据资料 [1][2] 回答。' },
    ];
    const res = await sendMessage(
      sid,
      '智能客服系统：支持哪些渠道？工单流转：如何自动处理？',
    );
    expect(res.status).toBe(200);
    const events = parseSse(res.text as string);
    // 事件序：… delta → references（generate 完成后、stage(generate done) 前）
    // → stage(generate done) → done（references 事件在编排器落库前由管线发出，
    // 载荷与落库为同一份引用——见 rag-pipeline.service.ts 注释）
    const refsEvent = events.find((e) => e.event === 'references');
    expect(refsEvent).toBeDefined();
    const refsIndex = events.findIndex((e) => e.event === 'references');
    expect(events[refsIndex + 1].event).toBe('stage');
    expect(events[refsIndex + 2].event).toBe('done');
    // SSE 载荷 = DB 落库（对齐后的同一份引用：正文引用了 [1][2] → 2 条）
    const dbRefs = await lastAssistantRefs(sid);
    expect(refsEvent!.data.references).toEqual(
      JSON.parse(JSON.stringify(dbRefs)),
    );
    expect(refsEvent!.data.references as unknown[]).toHaveLength(2);
  });
});
