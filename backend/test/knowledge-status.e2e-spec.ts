// 知识文档状态 e2e（Task 1.7）：自动摘要（SUMMARY_QUEUE + MockChatModelService）+
// 解析时间线 stages API + 重新生成摘要 + 重新解析（reparse）。
// 队列异步处理：轮询 DB 等待（waitFor，超时给足 15s——reparse 用例等待两轮
// 队列 parse+embed+summary 全完成，见 test/wait-for.ts）。
//
// 摘要语义（mock）：MockChatModelService.chat() 返回固定中文摘要文本
// MOCK_SUMMARY_TEXT（确定性，Task 2.3 换真实 LLM 后此处断言改语义相关性）——
// 因此「重新生成摘要」的验证口径是 parserStages 中 summary 阶段计数增加
// （固定 mock 文本不随重生成变化，阶段时间线才是「重新生成发生」的真实证据）。
//
// reparse 语义：事务内删旧 chunks（含向量——embedding 在 chunks 表内，删行即删
// 向量）→ 重置 parserStages/parsedText/summary/error/chunkCount → status=pending
// → 入队 PARSE；EMBED 队列中未消费的旧 job 会读到已删 chunk → 幂等 no-op
// （Task 1.6 已做，见 embed.processor.ts 注释）。防重：status 非 ready/failed →
// 409（行锁 + 事务内状态检查，防并发双跑，见 KnowledgeService.reparse 注释）。
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { DataSource, Repository } from 'typeorm';
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AppModule } from '../src/app.module.js';
import { withMockModels } from './mock-model-overrides.js';
import { prepareTestEnv } from './test-db.js';
import { configureApp } from '../src/app.setup.js';
import { waitFor } from './wait-for.js';
import {
  PARSE_QUEUE,
  EMBED_QUEUE,
  SUMMARY_QUEUE,
} from '../src/modules/parse/parse-queue.constants.js';
import { Knowledge } from '../src/modules/knowledge/knowledge.entity.js';
import { Chunk } from '../src/modules/chunk/chunk.entity.js';
import { User } from '../src/modules/users/user.entity.js';
import { RedisService } from '../src/redis/redis.service.js';
import { MOCK_SUMMARY_TEXT } from '../src/modules/model/mock/mock-chat-model.service.js';

/** stages 响应结构（GET /kbs/:kbId/knowledge/:kid/stages） */
interface StagesResponse {
  stages: Array<{ stage: string; status: string; at: string; detail?: string }>;
  status: string;
  chunkCount: number;
  summary: string | null;
  updatedAt: string;
}

describe('Knowledge Status (e2e)', () => {
  let app: INestApplication;
  let server: any;
  let dataSource: DataSource;
  let knowledgeRepo: Repository<Knowledge>;
  const ownerEmail = 'knowledge-status-owner@ohmydocagent.local';
  let ownerToken = '';
  // 本文件创建的知识库 id：afterAll 清理其上传目录
  const kbIds: string[] = [];
  const testEmails = [ownerEmail];
  // 用例间共享的文档 id：docId（自动摘要/时间线/重生成摘要）、
  // reparseDocId（重新解析/向量化/防重）
  let docId = '';
  let reparseDocId = '';

  /** 自动摘要用例的 md 内容（非空文本 → 分块 → 摘要） */
  const mdContent =
    '# OhMyDocAgent 自动摘要测试\n\n这是用于验证自动摘要管线的 markdown 内容。';
  /** reparse 用例的旧内容：长文本（默认 chunkSize=800 → ≥2 块） */
  const longContent = Array.from(
    { length: 40 },
    (_, i) =>
      `第${i + 1}段：OhMyDocAgent 知识管理平台提供文档解析、自动分块、向量化索引与混合检索能力，帮助团队沉淀并复用知识资产。`,
  ).join('\n');
  /** reparse 用例的新内容：短文本（< 800 → 恰 1 块），覆盖磁盘文件后重解析读到 */
  const shortContent =
    '重新解析后的全新内容：文档内容已更换，分块数量应明显减少。';

  /** 上传助手：multipart 内存 buffer + 文件名 */
  function uploadFile(
    kbId: string,
    filename: string,
    buffer: Buffer,
    token = ownerToken,
  ) {
    return request(server)
      .post(`/api/v1/kbs/${kbId}/file`)
      .set('Authorization', `Bearer ${token}`)
      .attach('file', buffer, { filename });
  }

  /** 轮询查询文档（waitFor 的 predicate 用） */
  const getKnowledge = (id: string) => knowledgeRepo.findOne({ where: { id } });

  /** 已向量化的块数（embedding 非空 + indexStatus=ready） */
  const countEmbedded = (knowledgeId: string) =>
    dataSource.query<Array<{ count: string }>>(
      `SELECT count(*) AS count FROM chunks
       WHERE "knowledgeId" = $1 AND "indexStatus" = 'ready' AND embedding IS NOT NULL`,
      [knowledgeId],
    );

  beforeAll(async () => {
    await prepareTestEnv();
    const moduleRef = await withMockModels(
      Test.createTestingModule({
        imports: [AppModule],
      }),
    ).compile();
    dataSource = moduleRef.get(DataSource);
    // 测试隔离（沿用既有模式）：users/invitations 清空以初始化 Owner；
    // knowledge/chunks 表必须显式列入清单（chunks 引用 knowledge，先清子表）。
    // 无新表（Task 1.7 摘要落 knowledge.summary 列，时间线复用 parserStages 列）
    await dataSource.query(
      'TRUNCATE TABLE users, invitations, user_kb_pins, knowledge_bases, knowledge, chunk_revisions, chunks CASCADE',
    );
    // 清空 parse/embed/summary 队列：防上一 e2e 文件遗留的 job 处理本文件已
    // TRUNCATE 的数据（404/无意义噪音）。在 app.init() 之前执行——worker 尚未
    // 启动，无竞争
    const parseQueue = moduleRef.get(getQueueToken(PARSE_QUEUE));
    await parseQueue.obliterate({ force: true });
    const embedQueue = moduleRef.get(getQueueToken(EMBED_QUEUE));
    await embedQueue.obliterate({ force: true });
    const summaryQueue = moduleRef.get(getQueueToken(SUMMARY_QUEUE));
    await summaryQueue.obliterate({ force: true });
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    server = app.getHttpServer();
    knowledgeRepo = dataSource.getRepository(Knowledge);
    // 前置：init 创建 Owner + 创建一个知识库
    const initRes = await request(server).post('/api/v1/auth/init').send({
      email: ownerEmail,
      password: 'Owner123456',
      name: '文档状态测试所有者',
    });
    expect(initRes.status).toBe(201);
    ownerToken = initRes.body.accessToken as string;
    const kbRes = await request(server)
      .post('/api/v1/kbs')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: '文档状态测试知识库' });
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

  it('上传 md 后自动摘要：knowledge.summary 非空（mock LLM 返回固定中文摘要）', async () => {
    const res = await uploadFile(
      kbIds[0],
      '自动摘要.md',
      Buffer.from(mdContent),
    );
    expect(res.status).toBe(201);
    docId = res.body.id as string;
    // 等待 parse+embed+summary 全完成：status=ready && summary 非空 && 全部块已向量化
    await waitFor(
      async () => {
        const k = await getKnowledge(docId);
        if (!k || k.status !== 'ready') return false;
        const embedded = await countEmbedded(docId);
        return k.summary !== null && Number(embedded[0].count) === k.chunkCount;
      },
      {
        timeoutMs: 15000,
        description:
          'parse+embed+summary 全完成（ready + summary 非空 + 全部块向量化）',
      },
    );
    const k = await getKnowledge(docId);
    // mock 语义：固定中文摘要文本（确定性，Task 2.3 换真实 LLM 后断言改语义）
    expect(k!.summary).toBe(MOCK_SUMMARY_TEXT);
    expect(k!.summary).toMatch(/[\u4e00-\u9fff]/);
  });

  it('GET stages 返回解析时间线（extract→chunk→embed→summary 各阶段，含状态与时间）', async () => {
    const res = await request(server)
      .get(`/api/v1/kbs/${kbIds[0]}/knowledge/${docId}/stages`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    const body = res.body as StagesResponse;
    expect(Array.isArray(body.stages)).toBe(true);
    expect(body.status).toBe('ready');
    expect(body.chunkCount).toBeGreaterThan(0);
    expect(new Date(body.updatedAt).getTime()).not.toBeNaN();
    // 质量审查整改：响应含 summary 字段（控制器注释承诺「前端轮询 stages/summary
    // 更新」，前端无需再单独查详情即可渲染当前摘要）
    expect(body.summary).toBe(MOCK_SUMMARY_TEXT);
    // 四个阶段都应存在，且各有 running + done 两条记录（时间线真实：状态 + 时间）
    for (const stage of ['extract', 'chunk', 'embed', 'summary']) {
      const recs = body.stages.filter((s) => s.stage === stage);
      expect(recs.some((s) => s.status === 'running')).toBe(true);
      expect(recs.some((s) => s.status === 'done')).toBe(true);
      for (const r of recs) {
        expect(new Date(r.at).getTime()).not.toBeNaN();
      }
    }
  });

  it('POST regenerate-summary 重新生成摘要（202 + { queued: true }，summary 阶段时间线更新）', async () => {
    // 初始自动摘要后 summary 阶段应为 1 轮（running + done 共 2 条）
    const before = await request(server)
      .get(`/api/v1/kbs/${kbIds[0]}/knowledge/${docId}/stages`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(before.status).toBe(200);
    const beforeStages = before.body.stages as Array<{ stage: string }>;
    const summaryCountBefore = beforeStages.filter(
      (s) => s.stage === 'summary',
    ).length;
    // 放宽为 >= 2（质量审查整改）：初始自动摘要是 1 轮（running + done 共 2 条），
    // 但若未来出现重试追加（attempts=2 + backoff），计数会大于 2——断言只应
    // 要求「至少一轮完整记录」，防重试追加破裂
    expect(summaryCountBefore).toBeGreaterThanOrEqual(2);
    // 重新生成：202 Accepted（异步任务，前端轮询 stages/summary 更新）
    const res = await request(server)
      .post(`/api/v1/kbs/${kbIds[0]}/knowledge/${docId}/regenerate-summary`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ queued: true });
    // 等待新摘要完成：summary 阶段计数 +2（固定 mock 文本不变，阶段时间线是
    // 「重新生成发生」的证据）
    await waitFor(
      async () => {
        const k = await getKnowledge(docId);
        if (!k) return false;
        const stages = k.parserStages as Array<{ stage: string }>;
        return (
          stages.filter((s) => s.stage === 'summary').length ===
          summaryCountBefore + 2
        );
      },
      {
        timeoutMs: 15000,
        description: '重新生成摘要完成（summary 阶段 +2）',
      },
    );
    const k = await getKnowledge(docId);
    expect(k!.summary).toBe(MOCK_SUMMARY_TEXT);
  });

  it('POST reparse 重新解析：202 → 旧 chunks 清空、新 chunks 生成（chunkCount 更新）', async () => {
    // 上传长文本文档（≥2 块）→ 等待首轮解析+向量化完成
    const upload = await uploadFile(
      kbIds[0],
      '重解析.md',
      Buffer.from(longContent),
    );
    expect(upload.status).toBe(201);
    const id = upload.body.id as string;
    const filePath = upload.body.filePath as string;
    await waitFor(
      async () => {
        const k = await getKnowledge(id);
        if (!k || k.status !== 'ready') return false;
        const embedded = await countEmbedded(id);
        return Number(embedded[0].count) === k.chunkCount && k.chunkCount >= 2;
      },
      {
        timeoutMs: 15000,
        description: 'reparse 文档首轮解析完成（ready + ≥2 块已向量化）',
      },
    );
    const before = await getKnowledge(id);
    const oldChunkCount = before!.chunkCount;
    const chunkRepo = dataSource.getRepository(Chunk);
    const oldIds = (
      await chunkRepo.find({
        where: { knowledgeId: id },
        select: { id: true },
      })
    ).map((c) => c.id);
    expect(oldIds.length).toBe(oldChunkCount);
    // 覆盖磁盘文件（md 解析在 parse 时读盘，见 placeholder-parser.ts）——
    // 重新解析读到新内容，验证「清旧建新」而非原地不动
    await writeFile(
      path.join(process.cwd(), 'uploads', filePath),
      shortContent,
      'utf8',
    );
    const res = await request(server)
      .post(`/api/v1/kbs/${kbIds[0]}/knowledge/${id}/reparse`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ queued: true });
    // 等待第二轮队列完成（parse+chunk+summary）：ready + parsedText=新内容 + 新摘要
    await waitFor(
      async () => {
        const k = await getKnowledge(id);
        return (
          k !== null &&
          k.status === 'ready' &&
          k.parsedText !== null &&
          k.parsedText.includes('重新解析后的全新内容') &&
          k.summary !== null
        );
      },
      {
        timeoutMs: 15000,
        description: 'reparse 第二轮完成（新内容解析 + 新摘要生成）',
      },
    );
    const after = await getKnowledge(id);
    // 旧 chunks 全部清空：旧 id 无一残留
    const newIds = (
      await chunkRepo.find({
        where: { knowledgeId: id },
        select: { id: true },
      })
    ).map((c) => c.id);
    expect(newIds.length).toBeGreaterThan(0);
    expect(newIds.filter((cid) => oldIds.includes(cid))).toHaveLength(0);
    // chunkCount 更新：短内容 → 1 块（旧长内容 ≥2 块），且与实际块数一致
    expect(after!.chunkCount).toBe(1);
    expect(after!.chunkCount).not.toBe(oldChunkCount);
    expect(newIds.length).toBe(after!.chunkCount);
    // 新块内容为覆盖后的新文本（解析读盘得到新内容）
    const first = await chunkRepo.findOne({
      where: { knowledgeId: id },
      order: { chunkIndex: 'ASC' },
    });
    expect(first!.content).toContain('重新解析后的全新内容');
    // 时间线已重置：只剩本轮记录（extract running 恰 1 条，旧记录已清）
    const stages = after!.parserStages as Array<{
      stage: string;
      status: string;
    }>;
    expect(
      stages.filter((s) => s.stage === 'extract' && s.status === 'running'),
    ).toHaveLength(1);
    reparseDocId = id;
  });

  it('reparse 后向量化仍完成（全部块 indexStatus=ready）', async () => {
    await waitFor(
      async () => {
        const k = await getKnowledge(reparseDocId);
        if (!k) return false;
        const embedded = await countEmbedded(reparseDocId);
        return Number(embedded[0].count) === k.chunkCount;
      },
      {
        timeoutMs: 15000,
        description: 'reparse 后全部块重新向量化完成（indexStatus=ready）',
      },
    );
    const k = await getKnowledge(reparseDocId);
    const embedded = await countEmbedded(reparseDocId);
    expect(Number(embedded[0].count)).toBe(k!.chunkCount);
    // 无 processing/failed 残留（新块全部就绪，检索可用）
    const stale = await dataSource.query<Array<{ count: string }>>(
      `SELECT count(*) AS count FROM chunks
       WHERE "knowledgeId" = $1 AND "indexStatus" != 'ready'`,
      [reparseDocId],
    );
    expect(Number(stale[0].count)).toBe(0);
  });

  it('reparse 防重：status 非 ready/failed（处理中）→ 409', async () => {
    // 直接置 parsing 模拟「正在解析中」的中间态（确定性——不依赖队列时序；
    // 若用「reparse 后立即再 reparse」存在 worker 完成整个管线的竞态窗口）
    await knowledgeRepo.update({ id: reparseDocId }, { status: 'parsing' });
    const res = await request(server)
      .post(`/api/v1/kbs/${kbIds[0]}/knowledge/${reparseDocId}/reparse`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(409);
    expect(res.body.message).toContain('处理中');
    // 恢复 ready（清理中间态，不留脏数据）
    await knowledgeRepo.update({ id: reparseDocId }, { status: 'ready' });
  });

  it('stages/regenerate-summary/reparse 文档不存在 → 404（含非 UUID id）', async () => {
    const missingId = '00000000-0000-4000-8000-000000000000';
    const stages = await request(server)
      .get(`/api/v1/kbs/${kbIds[0]}/knowledge/${missingId}/stages`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(stages.status).toBe(404);
    const regen = await request(server)
      .post(`/api/v1/kbs/${kbIds[0]}/knowledge/${missingId}/regenerate-summary`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(regen.status).toBe(404);
    const reparse = await request(server)
      .post(`/api/v1/kbs/${kbIds[0]}/knowledge/${missingId}/reparse`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(reparse.status).toBe(404);
    // 非 UUID id → 404（22P02 视为不存在，不泄露 500）
    const badId = await request(server)
      .get(`/api/v1/kbs/${kbIds[0]}/knowledge/not-a-uuid/stages`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(badId.status).toBe(404);
  });
});
