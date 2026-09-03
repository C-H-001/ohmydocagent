// 向量化 + 混合检索 e2e（Task 1.6）：上传含关键词的 md 文档 → 解析分块 →
// EMBED_QUEUE 自动向量化（chunks.embedding 非空 + indexStatus=ready）→
// POST /api/v1/kbs/:kbId/hybrid-search 三路检索（向量/关键词/混合）公开端点。
//
// 队列异步处理：轮询 DB 等待（waitFor，10s 超时，见 test/wait-for.ts）。
//
// 检索相关性如何可测（MockEmbeddingService 设计要点）：
// MockEmbeddingService 用「字符 n-gram 特征哈希」生成确定性向量（见
// embedding.service.ts 注释）——共享字符片段的文本向量相似度更高。因此
// 查询「知识管理」时，包含该短语的 chunk 余弦相似度显著高于无关 chunk，
// 向量检索 top-1 可预期（真实模型 Task 2.3 接入后语义更强，本断言仍成立）。
//
// 关键词检索的 'simple' 分词语义（已实测）：PG 默认 parser 把标点分隔的
// 连续 CJK 串作为一个 token（如 '知识管理：…' → token '知识管理'），
// to_tsvector('simple', content) @@ plainto_tsquery('simple', '知识管理')
// 按 token 精确匹配——故测试内容中目标短语必须以「独立标点分隔段」出现
// （正文按 '：' 句读书写），查询词与其精确对应。
//
// 「无匹配返回空数组」的判定：VectorService 对向量相似度设下限阈值
// MIN_VECTOR_SCORE（0.05，随 mock 调参，见 vector.service.ts 注释）——
// 无关查询（与任何 chunk 无共享 n-gram）余弦 ≈ 0 被过滤，两路皆空 → []。
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { DataSource, Repository } from 'typeorm';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../src/app.module.js';
import { withMockModels } from './mock-model-overrides.js';
import { prepareTestEnv } from './test-db.js';
import { configureApp } from '../src/app.setup.js';
import { waitFor } from './wait-for.js';
import {
  PARSE_QUEUE,
  EMBED_QUEUE,
} from '../src/modules/parse/parse-queue.constants.js';
import { Knowledge } from '../src/modules/knowledge/knowledge.entity.js';
import { Chunk } from '../src/modules/chunk/chunk.entity.js';
import { User } from '../src/modules/users/user.entity.js';
import { RedisService } from '../src/redis/redis.service.js';

/** 混合检索响应单项结构 */
interface HybridItem {
  chunkId: string;
  content: string;
  knowledgeId: string;
  score: number;
  vectorScore: number;
  keywordScore: number;
}

describe('Vector (e2e)', () => {
  let app: INestApplication;
  let server: any;
  let dataSource: DataSource;
  let knowledgeRepo: Repository<Knowledge>;
  const ownerEmail = 'vector-owner@ohmydocagent.local';
  let ownerToken = '';
  // 本文件创建的知识库 id：afterAll 清理其上传目录
  const kbIds: string[] = [];
  const testEmails = [ownerEmail];

  /**
   * 检索测试文档（~840 字 > 默认 chunkSize=800，应切出 ≥2 块）：
   * 三个独立小节各含目标短语，短语以 '：' 独立段书写（'simple' 分词语义见文件头注释）：
   * - 第 1 节：知识管理（向量检索 + 关键词检索 + 混合检索的目标 chunk）
   * - 第 2 节：全文检索（关键词检索的目标 chunk）
   * - 第 3 节：向量检索
   * 小节间用空行（'\n\n'）分隔——分块引擎在此切块，各节内容 < 800 保持整节。
   * 分块/向量余弦/关键词命中的实际数值已在实现期用真实 ChunkingService 与
   * MockEmbeddingService 校验（见任务报告）：相关查询余弦 0.25~0.51，无关查询
   * < 0.03（低于 MIN_VECTOR_SCORE=0.05 的过滤阈值，无匹配返回空数组）。
   */
  const mdContent = [
    '# OhMyDocAgent 知识管理平台',
    '',
    'OhMyDocAgent 知识管理平台支持 RAG 检索增强生成。知识管理：是企业将分散的文档、经验进行结构化沉淀的核心能力。知识管理：让团队的知识资产可复用、可传承。知识管理平台提供文档上传、自动解析、向量化索引与混合检索能力，帮助团队从海量资料中快速定位所需内容。知识管理：是 OhMyDocAgent 平台的核心模块，覆盖文档导入、自动解析、分块与向量化索引的全链路，为 RAG 问答提供结构化知识底座。知识管理：也是企业知识资产沉淀的唯一入口，文档一经导入即自动进入解析与向量化流水线。知识管理：的价值在于让散落各处的经验变成团队可检索、可复用的公共资产，降低重复劳动。知识管理：平台的检索体验决定了知识复用效率，OhMyDocAgent 为此提供了向量与关键词双路混合检索。',
    '',
    '## 全文检索',
    '',
    '全文检索：基于关键词匹配，适合精确查询场景。用户输入关键词即可快速定位包含该词的文档段落。全文检索对专有名词、编号、代码片段等精确内容召回效果最好，实现简单且响应速度快。全文检索：是 RAG 系统的基础能力，与向量检索互补，保证精确内容不被语义召回遗漏。全文检索：在 OhMyDocAgent 中由 PostgreSQL 全文索引驱动，查询词与文档词精确对齐即可命中。全文检索：对版本号、型号、人名等必须精确匹配的场景不可或缺。全文检索：的局限在于对同义词与口语化表达无能为力，需要向量检索补齐。',
    '',
    '## 向量检索',
    '',
    '向量检索：基于语义相似度，适合模糊查询场景。即使查询词与文档用词不完全一致，也能通过语义相近召回相关段落。向量检索对开放式问题、概念性查询效果更好，是 RAG 系统的核心能力。向量检索：配合全文检索构成混合检索，兼顾精确匹配与语义召回。向量检索：在 OhMyDocAgent 中由 pgvector 余弦相似度驱动，查询向量与分块向量距离最近者优先返回。向量检索：对同义词、口语化表达、跨语言查询有天然优势。向量检索：的召回结果按相似度排序，可配合重排模型进一步精排。',
  ].join('\n');

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

  let docId = '';

  beforeAll(async () => {
    await prepareTestEnv();
    const moduleRef = await withMockModels(
      Test.createTestingModule({
        imports: [AppModule],
      }),
    ).compile();
    dataSource = moduleRef.get(DataSource);
    // 测试隔离（沿用既有模式）：users/invitations 清空以初始化 Owner；
    // knowledge/chunks 表必须显式列入清单（chunks 引用 knowledge，先清子表）
    await dataSource.query(
      'TRUNCATE TABLE users, invitations, user_kb_pins, knowledge_bases, knowledge, chunk_revisions, chunks CASCADE',
    );
    // 清空 parse/embed 队列：防上一 e2e 文件遗留的 job 处理本文件已 TRUNCATE 的
    // 数据（404/无意义噪音）。在 app.init() 之前执行——worker 尚未启动，无竞争
    const parseQueue = moduleRef.get(getQueueToken(PARSE_QUEUE));
    await parseQueue.obliterate({ force: true });
    const embedQueue = moduleRef.get(getQueueToken(EMBED_QUEUE));
    await embedQueue.obliterate({ force: true });
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    server = app.getHttpServer();
    knowledgeRepo = dataSource.getRepository(Knowledge);
    // 前置：init 创建 Owner + 创建一个知识库
    const initRes = await request(server).post('/api/v1/auth/init').send({
      email: ownerEmail,
      password: 'Owner123456',
      name: '向量化测试所有者',
    });
    expect(initRes.status).toBe(201);
    ownerToken = initRes.body.accessToken as string;
    const kbRes = await request(server)
      .post('/api/v1/kbs')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: '向量化测试知识库' });
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

  it('上传文档后 chunks 自动向量化（embedding 非空、indexStatus=ready）', async () => {
    const res = await uploadFile(
      kbIds[0],
      '检索测试.md',
      Buffer.from(mdContent),
    );
    expect(res.status).toBe(201);
    docId = res.body.id as string;
    // 等待解析分块完成（knowledge ready）
    await waitFor(
      async () => {
        const k = await getKnowledge(docId);
        return k !== null && k.status === 'ready' && (k.chunkCount ?? 0) > 0;
      },
      { description: 'md 文档解析分块完成（ready 且 chunkCount>0）' },
    );
    const k = await getKnowledge(docId);
    expect(k!.chunkCount).toBeGreaterThanOrEqual(2);
    // 等待 EMBED_QUEUE 向量化完成：全部块 embedding 非空 + indexStatus=ready
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
    const rows = await countEmbedded(docId);
    expect(Number(rows[0].count)).toBe(k!.chunkCount);
    // 抽查块内容：向量化后 content 完整保留（未被截断）
    const chunkRepo = dataSource.getRepository(Chunk);
    const first = await chunkRepo.findOne({
      where: { knowledgeId: docId },
      order: { chunkIndex: 'ASC' },
    });
    expect(first!.content).toContain('知识管理');
  });

  it('向量检索：查询「知识管理」返回相关 chunk（含 score）', async () => {
    const res = await request(server)
      .post(`/api/v1/kbs/${kbIds[0]}/hybrid-search`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ query: '知识管理', topK: 5 });
    expect(res.status).toBe(200);
    const items = res.body.items as HybridItem[];
    expect(Array.isArray(items)).toBe(true);
    expect(items.length).toBeGreaterThanOrEqual(1);
    // 向量检索（纯向量分：关键词路无命中时 keywordScore=0，见文件头注释；
    // 「知识管理」以独立段出现 → 关键词路也命中 → 双分都在）：
    // 含「知识管理」短语的 chunk 与查询 n-gram 重叠最高 → 排序第一
    expect(items[0].content).toContain('知识管理');
    expect(items[0].score).toBeGreaterThan(0);
    expect(items[0].vectorScore).toBeGreaterThan(0);
    expect(items[0].keywordScore).toBeGreaterThan(0);
    expect(items[0].knowledgeId).toBe(docId);
    // 结果按 score 降序
    for (let i = 1; i < items.length; i++) {
      expect(items[i].score).toBeLessThanOrEqual(items[i - 1].score);
    }
  });

  it('关键词检索：精确词命中（tsvector simple token 匹配 + ts_rank 打分）', async () => {
    const res = await request(server)
      .post(`/api/v1/kbs/${kbIds[0]}/hybrid-search`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ query: '全文检索' });
    expect(res.status).toBe(200);
    const items = res.body.items as HybridItem[];
    expect(items.length).toBeGreaterThanOrEqual(1);
    // 'simple' 分词：'全文检索' 是独立 token（见文件头注释），命中即返回——
    // 含该词的 chunk 在关键词路命中（keywordScore>0），且融合后排序第一
    // （向量路与关键词路双命中）；其余纯向量路 chunk 的 keywordScore=0
    expect(items[0].content).toContain('全文检索');
    expect(items[0].keywordScore).toBeGreaterThan(0);
    // 关键词路命中的项（keywordScore>0）内容都含精确词
    for (const item of items) {
      if (item.keywordScore > 0) {
        expect(item.content).toContain('全文检索');
      }
    }
  });

  it('关键词检索不返回未向量化块（indexStatus=processing 过滤，与向量路对齐）', async () => {
    // 直接 SQL 插入一个 indexStatus='processing' 的块（模拟分块完成但向量化
    // 尚未执行/失败的中间态），内容含唯一哨兵词——若关键词路不过滤，该块
    // 会被精确 token 匹配命中并返回（keywordScore>0）。哨兵词与文档其他
    // 内容无字符重叠：向量路对其余弦 ≈ 0（低于 MIN_VECTOR_SCORE 阈值被过滤），
    // 混合检索结果只能来自关键词路——过滤生效时两路皆空 → []。
    const sentinel = 'zzqqxxyy哨兵占位';
    await dataSource.query(
      `INSERT INTO chunks
         (id, "kbId", "knowledgeId", content, "sourceContent",
          "contentRevision", "indexStatus", "chunkIndex", "startAt", "endAt")
       VALUES ($1, $2, $3, $4, $4, 0, 'processing', 99999, 0, 0)`,
      [randomUUID(), kbIds[0], docId, sentinel],
    );
    const res = await request(server)
      .post(`/api/v1/kbs/${kbIds[0]}/hybrid-search`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ query: sentinel });
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });

  it('混合检索：两路融合结果去重（无重复 chunkId，双路分都在）', async () => {
    const res = await request(server)
      .post(`/api/v1/kbs/${kbIds[0]}/hybrid-search`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ query: '知识管理', topK: 10 });
    expect(res.status).toBe(200);
    const items = res.body.items as HybridItem[];
    // 去重：chunkId 唯一
    const ids = items.map((i) => i.chunkId);
    expect(new Set(ids).size).toBe(ids.length);
    // 两路融合：top 项同时携带向量分与关键词分（向量路 + 关键词路都命中）
    expect(items[0].vectorScore).toBeGreaterThan(0);
    expect(items[0].keywordScore).toBeGreaterThan(0);
    expect(items[0].content).toContain('知识管理');
  });

  it('无匹配时返回空数组（不报错）', async () => {
    const res = await request(server)
      .post(`/api/v1/kbs/${kbIds[0]}/hybrid-search`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ query: 'qwerty zzzz frobnicate' });
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });

  it('参数校验：topK 越界 / query 缺失 → 400', async () => {
    const auth = { Authorization: `Bearer ${ownerToken}` };
    // topK 越界（0 与 51）
    const tooSmall = await request(server)
      .post(`/api/v1/kbs/${kbIds[0]}/hybrid-search`)
      .set(auth)
      .send({ query: '知识管理', topK: 0 });
    expect(tooSmall.status).toBe(400);
    const tooLarge = await request(server)
      .post(`/api/v1/kbs/${kbIds[0]}/hybrid-search`)
      .set(auth)
      .send({ query: '知识管理', topK: 51 });
    expect(tooLarge.status).toBe(400);
    // topK 非数字
    const notNumber = await request(server)
      .post(`/api/v1/kbs/${kbIds[0]}/hybrid-search`)
      .set(auth)
      .send({ query: '知识管理', topK: 'abc' });
    expect(notNumber.status).toBe(400);
    // query 缺失 / 空串
    const missingQuery = await request(server)
      .post(`/api/v1/kbs/${kbIds[0]}/hybrid-search`)
      .set(auth)
      .send({});
    expect(missingQuery.status).toBe(400);
    const emptyQuery = await request(server)
      .post(`/api/v1/kbs/${kbIds[0]}/hybrid-search`)
      .set(auth)
      .send({ query: '' });
    expect(emptyQuery.status).toBe(400);
  });

  it('未登录 401；KB 不存在 404', async () => {
    // 未登录（无 token）→ 全局 JwtAuthGuard 拦截 401
    const unauth = await request(server)
      .post(`/api/v1/kbs/${kbIds[0]}/hybrid-search`)
      .send({ query: '知识管理' });
    expect(unauth.status).toBe(401);
    // KB 不存在（合法 UUID 格式但无此库）→ 404
    const missing = await request(server)
      .post('/api/v1/kbs/00000000-0000-0000-0000-000000000000/hybrid-search')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ query: '知识管理' });
    expect(missing.status).toBe(404);
    // 非 UUID 格式 id → 同样 404（22P02 视为不存在，不泄露内部错误）
    const badId = await request(server)
      .post('/api/v1/kbs/not-a-uuid/hybrid-search')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ query: '知识管理' });
    expect(badId.status).toBe(404);
  });
});
