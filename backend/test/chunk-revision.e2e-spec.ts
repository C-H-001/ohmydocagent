// 分块编辑 / 版本历史 / 回滚 e2e（Task 1.9）：
// - PUT /api/v1/chunks/:chunkId 编辑内容：content 更新、contentRevision+1、
//   sourceContent 保留原值、indexStatus=processing（触发重新向量化）
// - 编辑后自动重新向量化：单块 EMBED job（payload { chunkId }）处理后
//   indexStatus 流转 processing→ready，embedding 更新（mock 确定性：同内容
//   同向量，不同内容向量不同——用「编辑前后 embedding 不同」与「回滚后
//   embedding 与首次编辑后相同」两向断言证明重新向量化闭环）
// - GET /api/v1/chunks/:chunkId/revisions 版本历史（revision 升序）
// - POST /api/v1/chunks/:chunkId/revert 追加式回滚（不改历史）；revision=0
//   回滚到原始版本（目标内容 = sourceContent，质量审查整改）
// - 并发编辑同 chunk 恰一成一败（revision 插入撞唯一索引 23505 → 409，
//   事务回滚无孤儿行；用 FOR UPDATE 行锁把两个请求卡在同一窗口内，
//   并发语义可复现，见末尾用例注释）
// 路由决策：编辑/历史/回滚走顶层 chunks/:chunkId（kbId 由 chunk 行反查，
// 无需双重限定；P1 无 KB 级权限（P4 加），先不做 kbId 校验——见
// chunk.controller.ts 注释）。
// 队列异步处理：轮询 DB 等待（waitFor，10s 超时，见 test/wait-for.ts）。
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

/** 版本历史响应单项结构 */
interface RevisionItem {
  id: string;
  chunkId: string;
  content: string;
  revision: number;
  editorId: string;
  createdAt: string;
}

describe('ChunkRevision (e2e)', () => {
  let app: INestApplication;
  let server: any;
  let dataSource: DataSource;
  let knowledgeRepo: Repository<Knowledge>;
  let chunkRepo: Repository<Chunk>;
  const ownerEmail = 'chunk-revision-owner@ohmydocagent.local';
  let ownerToken = '';
  let ownerId = '';
  // 本文件创建的知识库 id：afterAll 清理其上传目录
  const kbIds: string[] = [];
  const testEmails = [ownerEmail];
  // 被测目标块（第一个 chunk）：id / 原始内容 / 原始 embedding（原生 SQL 读，
  // embedding 列 select:false 实体查询不加载）
  let targetChunkId = '';
  let originalContent = '';
  let originalEmbedding = '';
  // 编辑 1 后的 embedding（回滚断言用：mock 确定性，回滚后应回到此向量）
  let embeddingAfterEdit1 = '';

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

  /** 读取块 embedding（原生 SQL：embedding 列 select:false，实体查询不加载） */
  const readEmbedding = (chunkId: string) =>
    dataSource.query<Array<{ embedding: string | null }>>(
      `SELECT embedding FROM chunks WHERE id = $1`,
      [chunkId],
    );

  /** 已向量化块数（embedding 非空 + indexStatus=ready） */
  const countEmbedded = (knowledgeId: string) =>
    dataSource.query<Array<{ count: string }>>(
      `SELECT count(*) AS count FROM chunks
       WHERE "knowledgeId" = $1 AND "indexStatus" = 'ready' AND embedding IS NOT NULL`,
      [knowledgeId],
    );

  /**
   * 多段 md 内容（约 2k 字）：默认分块配置（chunkSize=800/chunkOverlap=100/
   * separators）下应切出 ≥2 块。与 chunk.e2e-spec.ts 同素材模式。
   */
  const mdContent = Array.from(
    { length: 30 },
    (_, i) =>
      `## 第 ${i + 1} 节\n\n这是第 ${i + 1} 节的正文内容，用于验证分块引擎在段落边界与句号边界切分文本。段落应当足够长，保证每个分块都能被正常切出并保留原文偏移。`,
  ).join('\n\n');

  /** 编辑 1 内容（与原文差异大：向量断言依赖 mock 确定性的「内容不同 → 向量不同」） */
  const edit1Content =
    '编辑后的版本一内容：OhMyDocAgent 支持分块内容编辑与版本管理。分块编辑后内容立即更新，并自动触发重新向量化，保证检索结果与最新内容一致。版本历史保留每次编辑的快照，可随时回滚到任意历史版本。编辑操作只更新当前内容与版本号，首次解析的原始内容始终保留在 sourceContent 中。';

  /** 编辑 2 内容（与编辑 1/原文都不同） */
  const edit2Content =
    '编辑后的版本二内容：第二次编辑验证 contentRevision 递增与版本历史追加。每次编辑都会生成新的版本记录，revision 号随 contentRevision 同步递增，版本历史按 revision 升序返回。回滚是追加式操作：不修改既有历史，而是以目标版本内容生成一个新版本，保证版本线完整可追溯。';

  beforeAll(async () => {
    await prepareTestEnv();
    const moduleRef = await withMockModels(
      Test.createTestingModule({
        imports: [AppModule],
      }),
    ).compile();
    dataSource = moduleRef.get(DataSource);
    // 测试隔离（沿用既有模式）：users/invitations 清空以初始化 Owner；
    // chunk_revisions 必须先于 chunks 清（无外键，逻辑子表——见任务书约定）
    await dataSource.query(
      'TRUNCATE TABLE users, invitations, user_kb_pins, knowledge_bases, knowledge, chunk_revisions, chunks CASCADE',
    );
    // 清空 parse/embed 队列：防上一 e2e 文件遗留的 job 处理本文件已 TRUNCATE
    // 的数据（404/无意义噪音）。在 app.init() 之前执行——worker 尚未启动，无竞争
    const parseQueue = moduleRef.get(getQueueToken(PARSE_QUEUE));
    await parseQueue.obliterate({ force: true });
    const embedQueue = moduleRef.get(getQueueToken(EMBED_QUEUE));
    await embedQueue.obliterate({ force: true });
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    server = app.getHttpServer();
    knowledgeRepo = dataSource.getRepository(Knowledge);
    chunkRepo = dataSource.getRepository(Chunk);
    // 前置：init 创建 Owner + 创建一个知识库
    const initRes = await request(server).post('/api/v1/auth/init').send({
      email: ownerEmail,
      password: 'Owner123456',
      name: '版本管理测试所有者',
    });
    expect(initRes.status).toBe(201);
    ownerToken = initRes.body.accessToken as string;
    // editorId 断言用：me 端点返回当前用户（含 id）
    const meRes = await request(server)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(meRes.status).toBe(200);
    ownerId = meRes.body.id as string;
    const kbRes = await request(server)
      .post('/api/v1/kbs')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: '版本管理测试知识库' });
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

  it('回归：上传多段 md 解析分块 + 初始向量化完成，chunks 列表（chunkIndex 升序、含 content/sourceContent/contentRevision）', async () => {
    const res = await uploadFile(
      kbIds[0],
      '版本管理测试.md',
      Buffer.from(mdContent),
    );
    expect(res.status).toBe(201);
    const id = res.body.id as string;
    // 等待解析分块完成（ready 且 chunkCount>0）
    await waitFor(
      async () => {
        const k = await knowledgeRepo.findOne({ where: { id } });
        return k !== null && k.status === 'ready' && (k.chunkCount ?? 0) > 0;
      },
      { description: 'md 文档解析分块完成（ready 且 chunkCount>0）' },
    );
    const k = await knowledgeRepo.findOne({ where: { id } });
    expect(k!.chunkCount).toBeGreaterThanOrEqual(2);
    // 等待初始向量化完成：全部块 embedding 非空 + indexStatus=ready
    await waitFor(
      async () => {
        const rows = await countEmbedded(id);
        return Number(rows[0].count) === k!.chunkCount;
      },
      {
        description:
          '全部 chunks 初始向量化完成（embedding 非空 + indexStatus=ready）',
      },
    );
    // 分块列表回归确认：分页 + chunkIndex 升序 + 含 content/sourceContent/
    // contentRevision（实体全列，embedding 除外）
    const list = await request(server)
      .get(`/api/v1/kbs/${kbIds[0]}/knowledge/${id}/chunks?pageSize=100`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(list.status).toBe(200);
    const items = list.body.items as Array<{
      id: string;
      chunkIndex: number;
      content: string;
      sourceContent: string;
      contentRevision: number;
      indexStatus: string;
    }>;
    expect(items.length).toBeGreaterThanOrEqual(2);
    expect(items[0].chunkIndex).toBe(0);
    for (let i = 1; i < items.length; i++) {
      expect(items[i].chunkIndex).toBe(items[i - 1].chunkIndex + 1);
    }
    // 初始状态：contentRevision=0、sourceContent=content、indexStatus=ready
    targetChunkId = items[0].id;
    originalContent = items[0].content;
    expect(items[0].contentRevision).toBe(0);
    expect(items[0].sourceContent).toBe(items[0].content);
    expect(items[0].indexStatus).toBe('ready');
    // 记录原始 embedding（编辑后应变化，回滚后应恢复）
    const rows = await readEmbedding(targetChunkId);
    expect(rows[0].embedding).not.toBeNull();
    originalEmbedding = rows[0].embedding!;
  });

  it('PUT /api/v1/chunks/:chunkId 编辑内容：200，content 更新、contentRevision=1、sourceContent 保留原值、indexStatus=processing', async () => {
    const res = await request(server)
      .put(`/api/v1/chunks/${targetChunkId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ content: edit1Content });
    expect(res.status).toBe(200);
    const body = res.body as {
      id: string;
      content: string;
      sourceContent: string;
      contentRevision: number;
      indexStatus: string;
    };
    expect(body.id).toBe(targetChunkId);
    // content 更新为编辑内容；sourceContent 保留首次解析原文；revision 0→1；
    // indexStatus=processing（触发单块重新向量化，见下一用例）
    expect(body.content).toBe(edit1Content);
    expect(body.sourceContent).toBe(originalContent);
    expect(body.contentRevision).toBe(1);
    expect(body.indexStatus).toBe('processing');
  });

  it('编辑后自动重新向量化：indexStatus 流转 processing→ready，embedding 更新（与编辑前不同）', async () => {
    // 等单块 EMBED job（payload { chunkId }）处理完：embedding 变为新内容的
    // 向量（mock 确定性：内容不同 → n-gram 特征哈希不同 → 向量不同）
    await waitFor(
      async () => {
        const rows = await readEmbedding(targetChunkId);
        return (
          rows.length === 1 &&
          rows[0].embedding !== null &&
          rows[0].embedding !== originalEmbedding
        );
      },
      { description: '编辑后单块重新向量化完成（embedding 已更新）' },
    );
    const rows = await readEmbedding(targetChunkId);
    expect(rows[0].embedding).not.toBe(originalEmbedding);
    // 状态已流转回 ready（重新向量化闭环）
    const chunk = await chunkRepo.findOne({ where: { id: targetChunkId } });
    expect(chunk!.indexStatus).toBe('ready');
    expect(chunk!.content).toBe(edit1Content);
    // 记录编辑 1 后的 embedding：回滚到 revision 1 后应回到此向量（确定性 mock）
    embeddingAfterEdit1 = rows[0].embedding!;
  });

  it('再次编辑：contentRevision 递增正确（编辑 2 次 → revision 2），列表反映最新内容且 sourceContent 不变', async () => {
    const res = await request(server)
      .put(`/api/v1/chunks/${targetChunkId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ content: edit2Content });
    expect(res.status).toBe(200);
    expect((res.body as { contentRevision: number }).contentRevision).toBe(2);
    // 列表端点（实体全列）反映编辑后状态：最新内容 + sourceContent 仍是原文
    const list = await request(server)
      .get(`/api/v1/kbs/${kbIds[0]}/knowledge?type=file&pageSize=10`)
      .set('Authorization', `Bearer ${ownerToken}`);
    const doc = (list.body.items as Array<{ id: string }>)[0];
    const chunks = await request(server)
      .get(`/api/v1/kbs/${kbIds[0]}/knowledge/${doc.id}/chunks?pageSize=100`)
      .set('Authorization', `Bearer ${ownerToken}`);
    const item = (
      chunks.body.items as Array<{
        id: string;
        content: string;
        sourceContent: string;
        contentRevision: number;
      }>
    ).find((c) => c.id === targetChunkId);
    expect(item).toBeDefined();
    expect(item!.content).toBe(edit2Content);
    expect(item!.sourceContent).toBe(originalContent);
    expect(item!.contentRevision).toBe(2);
  });

  it('GET /api/v1/chunks/:chunkId/revisions 版本历史：revision 升序，含 content/editorId/createdAt；chunk 不存在 404', async () => {
    const res = await request(server)
      .get(`/api/v1/chunks/${targetChunkId}/revisions`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    const revisions = res.body as RevisionItem[];
    // 两次编辑 → 2 条版本记录（revision 1/2 升序；0 号原始不落库——
    // 初始状态由 chunk.content 表示，见 chunk-revision.entity.ts 注释；
    // 原始内容经 sourceContent 保留，见上一用例断言）
    expect(revisions).toHaveLength(2);
    expect(revisions[0].revision).toBe(1);
    expect(revisions[1].revision).toBe(2);
    expect(revisions[0].content).toBe(edit1Content);
    expect(revisions[1].content).toBe(edit2Content);
    expect(revisions[0].chunkId).toBe(targetChunkId);
    expect(revisions[1].chunkId).toBe(targetChunkId);
    // editorId = 编辑者（Owner 用户 id）；createdAt 为日期串
    for (const r of revisions) {
      expect(r.editorId).toBe(ownerId);
      expect(r.createdAt).toBeTruthy();
      expect(Number.isNaN(Date.parse(r.createdAt))).toBe(false);
    }
    // chunk 不存在 → 404（与编辑/回滚一致的资源语义）
    const missing = await request(server)
      .get(`/api/v1/chunks/${randomUUID()}/revisions`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(missing.status).toBe(404);
  });

  it('PUT 校验：空内容/纯空白 400；chunk 不存在 404；未登录 401', async () => {
    // 空内容 → 400（UpdateChunkDto：@IsString @IsNotEmpty @MaxLength）
    const empty = await request(server)
      .put(`/api/v1/chunks/${targetChunkId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ content: '' });
    expect(empty.status).toBe(400);
    // 纯空白内容 → 400（质量审查整改：@Transform trim 后为空串，@IsNotEmpty 拦下）
    const whitespace = await request(server)
      .put(`/api/v1/chunks/${targetChunkId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ content: '   ' });
    expect(whitespace.status).toBe(400);
    // 超长内容（> 20000 字符）→ 400
    const tooLong = await request(server)
      .put(`/api/v1/chunks/${targetChunkId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ content: 'x'.repeat(20001) });
    expect(tooLong.status).toBe(400);
    // 不存在的 chunk → 404（含非法 UUID 的 22P02→404 语义）
    const missing = await request(server)
      .put(`/api/v1/chunks/${randomUUID()}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ content: '新内容' });
    expect(missing.status).toBe(404);
    const badUuid = await request(server)
      .put(`/api/v1/chunks/not-a-uuid`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ content: '新内容' });
    expect(badUuid.status).toBe(404);
    // 未登录 → 401（全局 JwtAuthGuard）
    const noAuth = await request(server)
      .put(`/api/v1/chunks/${targetChunkId}`)
      .send({ content: '新内容' });
    expect(noAuth.status).toBe(401);
  });

  it('POST /api/v1/chunks/:chunkId/revert 回滚到指定版本：200，content 变回目标版本、contentRevision+1、新 revision 记录（追加式）', async () => {
    // 当前 revision=2（编辑 1 → 编辑 2），回滚到 revision 1：
    // content 变回编辑 1 内容、contentRevision 2→3、追加 revision=3 记录
    const res = await request(server)
      .post(`/api/v1/chunks/${targetChunkId}/revert`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ revision: 1 });
    expect(res.status).toBe(200);
    const body = res.body as {
      content: string;
      contentRevision: number;
      indexStatus: string;
    };
    expect(body.content).toBe(edit1Content);
    expect(body.contentRevision).toBe(3);
    expect(body.indexStatus).toBe('processing');
    // 版本历史追加：3 条（revision 1/2/3 升序，历史未被修改）
    const revisions = (
      await request(server)
        .get(`/api/v1/chunks/${targetChunkId}/revisions`)
        .set('Authorization', `Bearer ${ownerToken}`)
    ).body as RevisionItem[];
    expect(revisions).toHaveLength(3);
    expect(revisions.map((r) => r.revision)).toEqual([1, 2, 3]);
    // 回滚后的新记录内容 = 目标版本内容（revision 1 = 编辑 1 内容）
    expect(revisions[2].content).toBe(edit1Content);
    expect(revisions[0].content).toBe(edit1Content);
    expect(revisions[1].content).toBe(edit2Content);
  });

  it('POST revert 校验：不存在的 revision 404；revision < 0 / 非整数 400；chunk 不存在 404', async () => {
    // 不存在的 revision（当前历史 1/2/3，回滚 999）→ 404（读设计：目标版本
    // 不存在 = 资源不存在）
    const missingRev = await request(server)
      .post(`/api/v1/chunks/${targetChunkId}/revert`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ revision: 999 });
    expect(missingRev.status).toBe(404);
    // 负 revision（< Min(0)）→ 400；revision=0 是合法值（回滚到原始版本，
    // 见「revision=0 回滚」用例）
    const negative = await request(server)
      .post(`/api/v1/chunks/${targetChunkId}/revert`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ revision: -1 });
    expect(negative.status).toBe(400);
    // revision 非整数 → 400（@IsInt）
    const float = await request(server)
      .post(`/api/v1/chunks/${targetChunkId}/revert`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ revision: 1.5 });
    expect(float.status).toBe(400);
    // chunk 不存在 → 404
    const missingChunk = await request(server)
      .post(`/api/v1/chunks/${randomUUID()}/revert`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ revision: 1 });
    expect(missingChunk.status).toBe(404);
  });

  it('回滚后向量化重新完成：indexStatus=ready，embedding 与首次编辑后一致（mock 确定性）', async () => {
    // 回滚内容 = 编辑 1 内容 → 重新向量化后 embedding 应回到编辑 1 后的向量
    // （MockEmbeddingService 确定性：同内容同向量，证明「回滚 → 重新嵌入
    // 目标版本内容」的闭环真实生效，而非停留在旧向量）
    await waitFor(
      async () => {
        const rows = await readEmbedding(targetChunkId);
        return rows.length === 1 && rows[0].embedding === embeddingAfterEdit1;
      },
      { description: '回滚后单块重新向量化完成（embedding 回到目标版本向量）' },
    );
    const chunk = await chunkRepo.findOne({ where: { id: targetChunkId } });
    expect(chunk!.indexStatus).toBe('ready');
    expect(chunk!.content).toBe(edit1Content);
    expect(chunk!.contentRevision).toBe(3);
  });

  it('POST revert revision=0 回滚到原始版本：content 恢复为 sourceContent、追加新版本记录、向量化重新完成（embedding 回到原始向量）', async () => {
    // 前置：contentRevision=3（编辑 1 → 编辑 2 → 回滚 1），content=编辑 1 内容；
    // revision=0 表示原始版本——目标内容 = sourceContent（首次解析原文），无对应
    // 历史行（0 号原始不落库，见 chunk-revision.entity.ts 注释）
    const res = await request(server)
      .post(`/api/v1/chunks/${targetChunkId}/revert`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ revision: 0 });
    expect(res.status).toBe(200);
    const body = res.body as {
      content: string;
      sourceContent: string;
      contentRevision: number;
      indexStatus: string;
    };
    // content 恢复为原始内容（= sourceContent）、contentRevision 3→4、
    // indexStatus=processing（触发重新向量化，见下一断言）
    expect(body.content).toBe(originalContent);
    expect(body.sourceContent).toBe(originalContent);
    expect(body.contentRevision).toBe(4);
    expect(body.indexStatus).toBe('processing');
    // 版本历史追加：4 条（revision 1/2/3/4 升序，历史未被修改）；
    // 新记录（revision 4）内容 = 原始版本内容（sourceContent）
    const revisions = (
      await request(server)
        .get(`/api/v1/chunks/${targetChunkId}/revisions`)
        .set('Authorization', `Bearer ${ownerToken}`)
    ).body as RevisionItem[];
    expect(revisions).toHaveLength(4);
    expect(revisions.map((r) => r.revision)).toEqual([1, 2, 3, 4]);
    expect(revisions[3].content).toBe(originalContent);
    // 向量化重新完成：content=原始内容 → embedding 回到首次解析时的原始向量
    // （mock 确定性：同内容同向量，证明「回滚到原始版本 → 重新嵌入 sourceContent」
    // 闭环真实生效）
    await waitFor(
      async () => {
        const rows = await readEmbedding(targetChunkId);
        return rows.length === 1 && rows[0].embedding === originalEmbedding;
      },
      {
        description:
          'revision=0 回滚后单块重新向量化完成（embedding 回到原始向量）',
      },
    );
    const chunk = await chunkRepo.findOne({ where: { id: targetChunkId } });
    expect(chunk!.indexStatus).toBe('ready');
    expect(chunk!.content).toBe(originalContent);
    expect(chunk!.contentRevision).toBe(4);
  });

  it('并发编辑同 chunk 恰一成一败：一个 200 一个 409，最终 revision 恰新增一条（23505 收口 + 事务回滚，无孤儿行）', async () => {
    // 前置状态：contentRevision=4（上用例回滚到原始版本后），版本历史 4 条
    const before = (
      await request(server)
        .get(`/api/v1/chunks/${targetChunkId}/revisions`)
        .set('Authorization', `Bearer ${ownerToken}`)
    ).body as RevisionItem[];
    const beforeCount = before.length;
    const beforeRevision = before[beforeCount - 1].revision;
    // 并发确定性：光靠 Promise.all 不可靠（请求串行时后者读到已自增的
    // contentRevision，两次编辑都成功）。用独立 QueryRunner 持 chunks 行的
    // FOR UPDATE 锁，把两个 PUT 卡在「已 load、未提交」的窗口内——两者都从
    // 相同 contentRevision 算得相同新 revision，后落库者必撞 (chunkId, revision)
    // 复合唯一索引（23505）→ 409（服务层捕获转 ConflictException，事务回滚
    // 撤销其 chunk 更新）；释放锁后先发者正常提交 → 200
    const qr = dataSource.createQueryRunner();
    await qr.connect();
    try {
      await qr.startTransaction();
      await qr.query(`SELECT id FROM chunks WHERE id = $1 FOR UPDATE`, [
        targetChunkId,
      ]);
      const contentA = '并发编辑甲：恰一成一败'; // 与原文/编辑内容都不同
      const contentB = '并发编辑乙：恰一成一败';
      // 立即派发（superagent 的 Test 是 thenable——不经 await/end 不会真正发送，
      // 先建后等会让两个请求一直挂着、pg_stat_activity 无锁等待，waitFor 必超时；
      // 故用 .then() 立刻触发 dispatch，再在释放锁后 Promise.all 收结果）
      const putA = request(server)
        .put(`/api/v1/chunks/${targetChunkId}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ content: contentA })
        .then((r) => r);
      const putB = request(server)
        .put(`/api/v1/chunks/${targetChunkId}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ content: contentB })
        .then((r) => r);
      // 两个请求的 chunk UPDATE 都阻塞在我们的 FOR UPDATE 行锁上（pg_stat_activity
      // 出现 2 个等锁中的活动会话，wait_event_type='Lock'）——证明两者都已进入事务
      // 且读取了相同 contentRevision（串行化下才可能出现的「双双成功」被结构性排除）
      await waitFor(
        async () => {
          const rows = (await dataSource.query(
            `SELECT COUNT(*)::int AS n FROM pg_stat_activity
             WHERE state = 'active' AND wait_event_type = 'Lock'`,
          )) as { n: number }[];
          return rows[0].n >= 2;
        },
        { description: '两个并发 PUT 均已阻塞在 chunk 行锁上' },
      );
      // 释放行锁：先获得锁的请求正常提交（200），后落库者 revision 插入撞
      // 唯一索引 → 409（服务层转 ConflictException「分块正在被编辑，请重试」）
      await qr.rollbackTransaction();
      const [r1, r2] = await Promise.all([putA, putB]);
      const statuses = [r1.status, r2.status].sort((a, b) => a - b);
      expect(statuses).toEqual([200, 409]);
      const winner = r1.status === 200 ? r1 : r2;
      const conflict = r1.status === 409 ? r1 : r2;
      // 赢家：contentRevision = 前置 + 1；输家：409 + 明确的冲突语义文案
      expect((winner.body as { contentRevision: number }).contentRevision).toBe(
        beforeRevision + 1,
      );
      expect((winner.body as { content: string }).content).toMatch(
        /^并发编辑[甲乙]/,
      );
      expect(conflict.status).toBe(409);
      expect(conflict.body.message).toBe('分块正在被编辑，请重试');
      // 最终 revision 恰新增一条：失败方事务回滚，无孤儿版本行
      const after = (
        await request(server)
          .get(`/api/v1/chunks/${targetChunkId}/revisions`)
          .set('Authorization', `Bearer ${ownerToken}`)
      ).body as RevisionItem[];
      expect(after).toHaveLength(beforeCount + 1);
      expect(after[after.length - 1].revision).toBe(beforeRevision + 1);
      expect(after[after.length - 1].content).toBe(
        (winner.body as { content: string }).content,
      );
      // DB 状态与赢家一致：contentRevision=前置+1、内容=赢家内容
      const chunk = await chunkRepo.findOne({ where: { id: targetChunkId } });
      expect(chunk!.contentRevision).toBe(beforeRevision + 1);
      expect(chunk!.content).toBe((winner.body as { content: string }).content);
    } finally {
      await qr.release();
    }
  }, 15000);
});
