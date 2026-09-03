// 批量操作 e2e（Task 1.8）：批量删除 / 批量重新解析 / 批量打标去标 / 批量移动文件夹。
// 队列异步处理：batch-reparse 用例用 waitFor 轮询 DB 等待（与 knowledge-status 同一模式）。
//
// 批量语义（设计决策，见 KnowledgeService 各 batch 方法注释）：
// - ids 中不属于该 KB 的 id → 跳过（宽容），返回实际处理计数——前端多选同页文档
//   不会跨 KB，单条误选不应拖垮整批；KB 不存在 → 404（快速失败，与单条接口一致）
// - batch-reparse：处理中（pending/parsing）与跨 KB 的文档跳过计入 skipped（不 409
//   ——批量场景防重宽容，等本轮完成再批）；成功入队的计入 queued（202 Accepted）
// - batch-tags：tagIds 空数组 = 批量去标（全量替换语义与单条 setKnowledgeTags 一致）；
//   tagIds 含跨 KB 标签 → 400（严格——标签是整批共享目标，标错库是程序错误，快速失败）
// - 部分失败语义（质量审查整改）：单条处理抛错 → 计入 failed 计数继续处理其余条，
//   不整批 500——前端可重试（操作幂等）。batch-tags 返回 { updated, failed }；
//   batch-reparse 返回 { queued, skipped, failed }（queued = 已重置，队列投递
//   best-effort，与单条 reparse 一致）
// - ids 含重复 UUID → 去重后只处理一次（计数不虚高）
// - batch-move：folderId 必填（DTO @IsDefined），null = 移回根；folderId 属于其它
//   KB → 404（严格，同标签理由）
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { DataSource, In, Repository } from 'typeorm';
import { access, rm, writeFile } from 'node:fs/promises';
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
import { KnowledgeTag } from '../src/modules/knowledge/knowledge-tag.entity.js';
import { User } from '../src/modules/users/user.entity.js';
import { RedisService } from '../src/redis/redis.service.js';

describe('Knowledge Batch (e2e)', () => {
  let app: INestApplication;
  let server: any;
  let dataSource: DataSource;
  let knowledgeRepo: Repository<Knowledge>;
  const ownerEmail = 'knowledge-batch-owner@ohmydocagent.local';
  let ownerToken = '';
  // 本文件创建的知识库 id（afterAll 清理其上传目录）
  const kbIds: string[] = [];
  const testEmails = [ownerEmail];
  // 共享用例库 KB1 的文档 id（beforeAll 上传 3 个 md 并等解析完成）
  let mdA = '';
  let mdB = '';
  let mdC = '';
  // 批量打标/移动用例的共享文档与标签 id
  let tagA = '';
  let tagB = '';
  let docX = '';
  let docY = '';
  // 跨库 KB2 的文档/标签/文件夹（跨 KB 场景用）
  let foreignDoc = '';
  let foreignTag = '';
  let foreignFolder = '';

  /** 共享用例库 id 的快捷别名 */
  const kbId = () => kbIds[0];

  /** 长内容：默认 chunkSize=800 → ≥2 块（batch-reparse 用例旧内容，重解析后换短内容 → 恰 1 块） */
  const longContent = Array.from(
    { length: 40 },
    (_, i) =>
      `第${i + 1}段：OhMyDocAgent 知识管理平台提供文档解析、自动分块、向量化索引与混合检索能力，帮助团队沉淀并复用知识资产。`,
  ).join('\n');
  /** 短内容：< 800 → 恰 1 块 */
  const shortContent =
    '批量重新解析后的全新内容：文档内容已更换，分块数量应明显减少。';

  /** 带 Owner token 的 GET */
  function get(path: string) {
    return request(server)
      .get(path)
      .set('Authorization', `Bearer ${ownerToken}`);
  }

  /** 带 Owner token 的 POST（JSON body） */
  function post(path: string, body: unknown) {
    return request(server)
      .post(path)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send(body as object);
  }

  /** 带 Owner token 的 PUT（JSON body） */
  function put(path: string, body: unknown) {
    return request(server)
      .put(path)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send(body as object);
  }

  /** 上传助手：multipart 内存 buffer + 文件名 */
  function uploadFile(
    kb: string,
    filename: string,
    buffer: Buffer,
    token = ownerToken,
  ) {
    return request(server)
      .post(`/api/v1/kbs/${kb}/file`)
      .set('Authorization', `Bearer ${token}`)
      .attach('file', buffer, { filename });
  }

  const fakeText = (text: string) => Buffer.from(text, 'utf8');

  /** 手动创建文档并返回 id（断言 201） */
  async function makeDoc(kb: string, title: string): Promise<string> {
    const res = await post(`/api/v1/kbs/${kb}/manual`, {
      title,
      content: `${title} 的内容正文`,
    });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  /** 创建标签并返回 id（断言 201） */
  async function makeTag(kb: string, name: string): Promise<string> {
    const res = await post(`/api/v1/kbs/${kb}/tags`, { name });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  /** 创建根文件夹并返回 id（断言 201） */
  async function makeFolder(kb: string, name: string): Promise<string> {
    const res = await post(`/api/v1/kbs/${kb}/folders`, { name });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  /** 轮询查询文档（waitFor 的 predicate 用） */
  const getKnowledge = (id: string) => knowledgeRepo.findOne({ where: { id } });

  /** 判断磁盘文件是否存在（batch-delete 断言文件清理用；cwd 为 backend） */
  async function fileExists(relativePath: string): Promise<boolean> {
    try {
      await access(path.join(process.cwd(), 'uploads', relativePath));
      return true;
    } catch {
      return false;
    }
  }

  const countChunks = (knowledgeId: string) =>
    dataSource.getRepository(Chunk).count({ where: { knowledgeId } });

  beforeAll(async () => {
    await prepareTestEnv();
    const moduleRef = await withMockModels(
      Test.createTestingModule({
        imports: [AppModule],
      }),
    ).compile();
    dataSource = moduleRef.get(DataSource);
    // 测试隔离（沿用既有模式）：users/invitations 清空以初始化 Owner；
    // Task 1.3 新增表（knowledge_tags/knowledge_folders/tags）必须显式列入清单
    await dataSource.query(
      'TRUNCATE TABLE users, invitations, user_kb_pins, knowledge_tags, knowledge_folders, tags, knowledge_bases, knowledge, chunk_revisions, chunks CASCADE',
    );
    // 清空 parse/embed/summary 队列：防上一 e2e 文件遗留的 job 处理本文件已
    // TRUNCATE 的数据。在 app.init() 之前执行——worker 尚未启动，无竞争
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
    // 前置：init 创建 Owner + KB1（共享用例库）+ 3 个 md 文档
    const initRes = await request(server).post('/api/v1/auth/init').send({
      email: ownerEmail,
      password: 'Owner123456',
      name: '批量操作测试所有者',
    });
    expect(initRes.status).toBe(201);
    ownerToken = initRes.body.accessToken as string;
    const kbRes = await post('/api/v1/kbs', { name: '批量操作测试库' });
    expect(kbRes.status).toBe(201);
    kbIds.push(kbRes.body.id as string);
    const upA = await uploadFile(kbId(), '批量A.md', fakeText('# 批量A'));
    expect(upA.status).toBe(201);
    mdA = upA.body.id as string;
    const upB = await uploadFile(kbId(), '批量B.md', fakeText('# 批量B'));
    expect(upB.status).toBe(201);
    mdB = upB.body.id as string;
    const upC = await uploadFile(kbId(), '批量C.md', fakeText(longContent));
    expect(upC.status).toBe(201);
    mdC = upC.body.id as string;
    // 跨库 KB2 + 一个文档（跨 KB 场景用）
    const kb2Res = await post('/api/v1/kbs', { name: '批量操作跨库测试库' });
    expect(kb2Res.status).toBe(201);
    kbIds.push(kb2Res.body.id as string);
    const upForeign = await uploadFile(
      kbIds[1],
      '跨库文档.md',
      fakeText('# 跨库'),
    );
    expect(upForeign.status).toBe(201);
    foreignDoc = upForeign.body.id as string;
    // 等 4 个 md 文档全部解析完成（status=ready，分块/向量化由队列异步完成）
    await waitFor(
      async () => {
        const docs = await knowledgeRepo.find({
          where: { id: In([mdA, mdB, mdC, foreignDoc]) },
        });
        return docs.length === 4 && docs.every((d) => d.status === 'ready');
      },
      {
        timeoutMs: 15000,
        description: '4 个 md 文档解析完成（ready）',
      },
    );
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

  it('POST /api/v1/kbs/:id/knowledge/batch-delete 批量删除（ids 数组，200 返回删除数；残留 0）', async () => {
    // 前置：两个文档解析已完成，存在分块（删除级联应清理干净）
    expect(await countChunks(mdA)).toBeGreaterThan(0);
    expect(await countChunks(mdB)).toBeGreaterThan(0);
    const res = await post(`/api/v1/kbs/${kbId()}/knowledge/batch-delete`, {
      ids: [mdA, mdB],
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: 2 });
    // 行已删：详情 404 + 仓库无残留
    for (const id of [mdA, mdB]) {
      const detail = await get(`/api/v1/kbs/${kbId()}/knowledge/${id}`);
      expect(detail.status).toBe(404);
      expect(await knowledgeRepo.findOne({ where: { id } })).toBeNull();
    }
    // 分块无残留（级联清理）
    expect(await countChunks(mdA)).toBe(0);
    expect(await countChunks(mdB)).toBe(0);
  });

  it('POST batch-delete 删除后文档磁盘文件清理', async () => {
    const up = await uploadFile(kbId(), '批量删除磁盘.md', fakeText('# 待删'));
    expect(up.status).toBe(201);
    const delId = up.body.id as string;
    const filePath = up.body.filePath as string;
    expect(await fileExists(filePath)).toBe(true);
    const res = await post(`/api/v1/kbs/${kbId()}/knowledge/batch-delete`, {
      ids: [delId],
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: 1 });
    // 行已删 + 磁盘文件已清理
    expect(await knowledgeRepo.findOne({ where: { id: delId } })).toBeNull();
    expect(await fileExists(filePath)).toBe(false);
  });

  it('POST /api/v1/kbs/:id/knowledge/batch-reparse 批量重新解析（202，处理完成后新 chunks 生成）', async () => {
    const filePath = (await getKnowledge(mdC))!.filePath;
    // 旧块 id 收集（长内容 ≥2 块）
    const chunkRepo = dataSource.getRepository(Chunk);
    const oldIds = (
      await chunkRepo.find({
        where: { knowledgeId: mdC },
        select: { id: true },
      })
    ).map((c) => c.id);
    const oldChunkCount = (await getKnowledge(mdC))!.chunkCount;
    expect(oldChunkCount).toBeGreaterThanOrEqual(2);
    // 覆盖磁盘文件（md 解析在 parse 时读盘，见 placeholder-parser.ts）——
    // 重新解析读到新内容，验证「清旧建新」而非原地不动
    await writeFile(
      path.join(process.cwd(), 'uploads', filePath),
      shortContent,
      'utf8',
    );
    const res = await post(`/api/v1/kbs/${kbId()}/knowledge/batch-reparse`, {
      ids: [mdC],
    });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ queued: 1, skipped: 0, failed: 0 });
    // 等待第二轮队列完成（parse+chunk+embed+summary）：ready + 新内容解析完成
    await waitFor(
      async () => {
        const k = await getKnowledge(mdC);
        return (
          k !== null &&
          k.status === 'ready' &&
          k.parsedText !== null &&
          k.parsedText.includes('批量重新解析后的全新内容')
        );
      },
      {
        timeoutMs: 15000,
        description: 'batch-reparse 第二轮完成（新内容解析）',
      },
    );
    const after = await getKnowledge(mdC);
    // 旧 chunks 全部清空：旧 id 无一残留
    const newIds = (
      await chunkRepo.find({
        where: { knowledgeId: mdC },
        select: { id: true },
      })
    ).map((c) => c.id);
    expect(newIds.length).toBeGreaterThan(0);
    expect(newIds.filter((cid) => oldIds.includes(cid))).toHaveLength(0);
    // chunkCount 更新：短内容 → 1 块（旧长内容 ≥2 块），且与实际块数一致
    expect(after!.chunkCount).toBe(1);
    expect(after!.chunkCount).not.toBe(oldChunkCount);
    expect(newIds.length).toBe(after!.chunkCount);
    // 新块内容为覆盖后的新文本
    const first = await chunkRepo.findOne({
      where: { knowledgeId: mdC },
      order: { chunkIndex: 'ASC' },
    });
    expect(first!.content).toContain('批量重新解析后的全新内容');
  });

  it('POST batch-reparse 处理中文档与跨 KB 文档跳过（返回 skipped 计数，不 409）', async () => {
    // 确定性模拟「处理中」：新建 manual 文档，等 worker 解析完成后置 parsing
    // （与 knowledge-status 防重用例同模式——不依赖队列时序）
    const parsingDoc = await makeDoc(kbId(), '处理中文档');
    await waitFor(
      async () => (await getKnowledge(parsingDoc))?.status === 'ready',
      {
        timeoutMs: 15000,
        description: 'manual 文档解析完成（用于置 parsing 模拟处理中）',
      },
    );
    await knowledgeRepo.update({ id: parsingDoc }, { status: 'parsing' });
    const res = await post(`/api/v1/kbs/${kbId()}/knowledge/batch-reparse`, {
      ids: [parsingDoc, foreignDoc],
    });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ queued: 0, skipped: 2, failed: 0 });
    // 处理中文档未被重置（保持 parsing）；跨库文档未受影响
    expect((await getKnowledge(parsingDoc))!.status).toBe('parsing');
    expect((await getKnowledge(foreignDoc))!.kbId).toBe(kbIds[1]);
    // 恢复 ready（清理中间态，不留脏数据）
    await knowledgeRepo.update({ id: parsingDoc }, { status: 'ready' });
  });

  it('PUT /api/v1/kbs/:id/knowledge/batch-tags 批量打标（ids + tagIds，全部文档关联标签）', async () => {
    tagA = await makeTag(kbId(), '重要');
    tagB = await makeTag(kbId(), '设计');
    docX = await makeDoc(kbId(), '批量打标文档X');
    docY = await makeDoc(kbId(), '批量打标文档Y');
    const res = await put(`/api/v1/kbs/${kbId()}/knowledge/batch-tags`, {
      ids: [docX, docY],
      tagIds: [tagA, tagB],
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ updated: 2, failed: 0 });
    // 全部文档关联标签（knowledge_tags 关联行，全量替换语义）
    const relRepo = dataSource.getRepository(KnowledgeTag);
    for (const id of [docX, docY]) {
      const rels = await relRepo.find({ where: { knowledgeId: id } });
      expect(rels.map((r) => r.tagId).sort()).toEqual([tagA, tagB].sort());
    }
  });

  it('PUT batch-tags 批量去标（tagIds 空数组，全部文档清除标签）', async () => {
    const res = await put(`/api/v1/kbs/${kbId()}/knowledge/batch-tags`, {
      ids: [docX, docY],
      tagIds: [],
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ updated: 2, failed: 0 });
    const relRepo = dataSource.getRepository(KnowledgeTag);
    for (const id of [docX, docY]) {
      const rels = await relRepo.find({ where: { knowledgeId: id } });
      expect(rels).toHaveLength(0);
    }
  });

  it('PUT batch-tags 含其它 KB 的标签 → 400（防跨 KB 打标，严格校验）', async () => {
    foreignTag = await makeTag(kbIds[1], '跨库标签');
    const res = await put(`/api/v1/kbs/${kbId()}/knowledge/batch-tags`, {
      ids: [docX],
      tagIds: [tagB, foreignTag],
    });
    expect(res.status).toBe(400);
  });

  it('POST /api/v1/kbs/:id/knowledge/batch-move 批量移动文件夹（ids + folderId；null = 移回根）', async () => {
    const folder = await makeFolder(kbId(), '批量目标文件夹');
    const res = await post(`/api/v1/kbs/${kbId()}/knowledge/batch-move`, {
      ids: [docX, docY],
      folderId: folder,
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ moved: 2 });
    expect((await getKnowledge(docX))!.folderId).toBe(folder);
    expect((await getKnowledge(docY))!.folderId).toBe(folder);
    // folderId=null：批量移回根（决策：batch-move 支持 null 表示归根）
    const back = await post(`/api/v1/kbs/${kbId()}/knowledge/batch-move`, {
      ids: [docX],
      folderId: null,
    });
    expect(back.status).toBe(200);
    expect(back.body).toEqual({ moved: 1 });
    expect((await getKnowledge(docX))!.folderId).toBeNull();
    expect((await getKnowledge(docY))!.folderId).toBe(folder);
  });

  it('POST batch-move 缺 folderId → 400；folderId 属于其它 KB → 404', async () => {
    const missing = await post(`/api/v1/kbs/${kbId()}/knowledge/batch-move`, {
      ids: [docX],
    });
    expect(missing.status).toBe(400);
    foreignFolder = await makeFolder(kbIds[1], '跨库文件夹');
    const foreign = await post(`/api/v1/kbs/${kbId()}/knowledge/batch-move`, {
      ids: [docX],
      folderId: foreignFolder,
    });
    expect(foreign.status).toBe(404);
  });

  it('batch 接口空 ids 数组 → 400（四个接口一致）', async () => {
    const del = await post(`/api/v1/kbs/${kbId()}/knowledge/batch-delete`, {
      ids: [],
    });
    expect(del.status).toBe(400);
    const rep = await post(`/api/v1/kbs/${kbId()}/knowledge/batch-reparse`, {
      ids: [],
    });
    expect(rep.status).toBe(400);
    const tags = await put(`/api/v1/kbs/${kbId()}/knowledge/batch-tags`, {
      ids: [],
      tagIds: [],
    });
    expect(tags.status).toBe(400);
    const move = await post(`/api/v1/kbs/${kbId()}/knowledge/batch-move`, {
      ids: [],
      folderId: null,
    });
    expect(move.status).toBe(400);
  });

  it('batch 接口 ids 含非 UUID → 400（DTO IsUUID each 拦截，防 22P02 500）', async () => {
    const del = await post(`/api/v1/kbs/${kbId()}/knowledge/batch-delete`, {
      ids: ['not-a-uuid'],
    });
    expect(del.status).toBe(400);
    const tags = await put(`/api/v1/kbs/${kbId()}/knowledge/batch-tags`, {
      ids: ['not-a-uuid'],
      tagIds: [],
    });
    expect(tags.status).toBe(400);
  });

  it('batch-delete ids 含跨 KB 文档 → 部分处理（跳过跨库，返回实际删除数）', async () => {
    const res = await post(`/api/v1/kbs/${kbId()}/knowledge/batch-delete`, {
      ids: [docY, foreignDoc],
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: 1 });
    // docY 已删；跨库文档不受影响
    expect(await knowledgeRepo.findOne({ where: { id: docY } })).toBeNull();
    const foreign = await knowledgeRepo.findOne({ where: { id: foreignDoc } });
    expect(foreign).not.toBeNull();
    expect(foreign!.kbId).toBe(kbIds[1]);
  });

  it('batch 接口 ids 含重复 UUID → 去重后处理一次（计数不虚高，质量审查整改补测）', async () => {
    const relRepo = dataSource.getRepository(KnowledgeTag);
    // batch-delete 去重：同一 id 重复 3 次 → 只删 1 行
    const dupDel = await makeDoc(kbId(), '重复删除文档');
    const delRes = await post(`/api/v1/kbs/${kbId()}/knowledge/batch-delete`, {
      ids: [dupDel, dupDel, dupDel],
    });
    expect(delRes.status).toBe(200);
    expect(delRes.body).toEqual({ deleted: 1 });
    expect(await knowledgeRepo.findOne({ where: { id: dupDel } })).toBeNull();
    // batch-tags 去重：同一 id 重复 3 次 → 只打 1 个文档（关联行恰 1 行）
    const dupTagDoc = await makeDoc(kbId(), '重复打标文档');
    const tagsRes = await put(`/api/v1/kbs/${kbId()}/knowledge/batch-tags`, {
      ids: [dupTagDoc, dupTagDoc, dupTagDoc],
      tagIds: [tagA],
    });
    expect(tagsRes.status).toBe(200);
    expect(tagsRes.body).toEqual({ updated: 1, failed: 0 });
    const rels = await relRepo.find({ where: { knowledgeId: dupTagDoc } });
    expect(rels.map((r) => r.tagId)).toEqual([tagA]);
    // batch-reparse 去重：同一 ready 文档重复 2 次 → 只重置/入队 1 次（mdC 上轮已 ready）
    expect((await getKnowledge(mdC))!.status).toBe('ready');
    const repRes = await post(`/api/v1/kbs/${kbId()}/knowledge/batch-reparse`, {
      ids: [mdC, mdC],
    });
    expect(repRes.status).toBe(202);
    expect(repRes.body).toEqual({ queued: 1, skipped: 0, failed: 0 });
  });

  it('batch-tags 混入跨 KB 文档 id → 跳过不计数（updated 只含本库文档，failed=0，质量审查整改补测）', async () => {
    const relRepo = dataSource.getRepository(KnowledgeTag);
    // 前置：docX 上轮已去标（无标签）；foreignDoc 属于跨库 KB2
    expect(await relRepo.find({ where: { knowledgeId: docX } })).toHaveLength(
      0,
    );
    const res = await put(`/api/v1/kbs/${kbId()}/knowledge/batch-tags`, {
      ids: [docX, foreignDoc],
      tagIds: [tagA],
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ updated: 1, failed: 0 });
    // 本库文档被打标；跨库文档未被触碰（宽容跳过，不计数）
    const docXRels = await relRepo.find({ where: { knowledgeId: docX } });
    expect(docXRels.map((r) => r.tagId)).toEqual([tagA]);
    const foreignRels = await relRepo.find({
      where: { knowledgeId: foreignDoc },
    });
    expect(foreignRels.map((r) => r.tagId)).not.toContain(tagA);
  });

  it('batch 接口 KB 不存在 → 404（快速失败，与单条接口一致）', async () => {
    const missingKb = '00000000-0000-4000-8000-000000000000';
    const res = await post(`/api/v1/kbs/${missingKb}/knowledge/batch-delete`, {
      ids: [docX],
    });
    expect(res.status).toBe(404);
  });

  it('batch 接口未登录 → 401（四个接口一致）', async () => {
    const del = await request(server)
      .post(`/api/v1/kbs/${kbId()}/knowledge/batch-delete`)
      .send({ ids: [docX] });
    expect(del.status).toBe(401);
    const rep = await request(server)
      .post(`/api/v1/kbs/${kbId()}/knowledge/batch-reparse`)
      .send({ ids: [docX] });
    expect(rep.status).toBe(401);
    const tags = await request(server)
      .put(`/api/v1/kbs/${kbId()}/knowledge/batch-tags`)
      .send({ ids: [docX], tagIds: [] });
    expect(tags.status).toBe(401);
    const move = await request(server)
      .post(`/api/v1/kbs/${kbId()}/knowledge/batch-move`)
      .send({ ids: [docX], folderId: null });
    expect(move.status).toBe(401);
  });
});
