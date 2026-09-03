// 分块闭环 e2e（Task 1.5）：解析 → 分块 → ready 全链路。
// - 上传多段 md → 队列处理 → knowledge.status='ready' 且 chunkCount>0，
//   分块落 chunks 表（链表 pre/next + chunkIndex 升序）
// - GET /api/v1/kbs/:kbId/knowledge/:kid/chunks：分块列表 + 分页
// - 图片文档（空文本）→ 直接 ready 且 chunkCount=0（Task 1.4 遗留语义落实）
// - 解析失败文档 → status=failed 且不产生分块
// 队列异步处理：轮询 DB 等待（waitFor，10s 超时，见 test/wait-for.ts）。
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { DataSource, Repository } from 'typeorm';
import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { AppModule } from '../src/app.module.js';
import { withMockModels } from './mock-model-overrides.js';
import { prepareTestEnv } from './test-db.js';
import { configureApp } from '../src/app.setup.js';
import { waitFor } from './wait-for.js';
import { PARSE_QUEUE } from '../src/modules/parse/parse-queue.constants.js';
import { Knowledge } from '../src/modules/knowledge/knowledge.entity.js';
import { Chunk } from '../src/modules/chunk/chunk.entity.js';
import { User } from '../src/modules/users/user.entity.js';
import { RedisService } from '../src/redis/redis.service.js';

describe('Chunk (e2e)', () => {
  let app: INestApplication;
  let server: any;
  let dataSource: DataSource;
  let repo: Repository<Knowledge>;
  let chunkRepo: Repository<Chunk>;
  const ownerEmail = 'chunk-owner@ohmydocagent.local';
  let ownerToken = '';
  // 本文件创建的知识库 id：afterAll 清理其上传目录
  const kbIds: string[] = [];
  const testEmails = [ownerEmail];

  /** fixture 读取（相对本文件路径，独立于进程 cwd） */
  const fixture = (name: string) =>
    readFileSync(path.join(__dirname, 'fixtures', name));

  /**
   * 多段 md 内容（约 2k 字，含 '\n\n' 段落边界与 '。' 句号边界）：
   * 默认分块配置（chunkSize=800/chunkOverlap=100/separators）下应切出 ≥2 块。
   */
  const mdContent = Array.from(
    { length: 30 },
    (_, i) =>
      `## 第 ${i + 1} 节\n\n这是第 ${i + 1} 节的正文内容，用于验证分块引擎在段落边界与句号边界切分文本。段落应当足够长，保证每个分块都能被正常切出并保留原文偏移。`,
  ).join('\n\n');

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
  const getKnowledge = (id: string) => repo.findOne({ where: { id } });

  /** 等待文档进入指定状态（默认 ready） */
  const waitReady = (id: string, description: string, status = 'ready') =>
    waitFor(
      async () => {
        const k = await getKnowledge(id);
        return k !== null && k.status === status;
      },
      { description },
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
    // knowledge/chunks 表必须显式列入清单（chunks 引用 knowledge，先清子表）
    await dataSource.query(
      'TRUNCATE TABLE users, invitations, user_kb_pins, knowledge_bases, knowledge, chunk_revisions, chunks CASCADE',
    );
    // 清空 parse 队列：防上一 e2e 文件遗留的 job 处理本文件已 TRUNCATE 的数据
    // （404 噪音）。在 app.init() 之前执行——worker 尚未启动，无竞争
    const parseQueue = moduleRef.get(getQueueToken(PARSE_QUEUE));
    await parseQueue.obliterate({ force: true });
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    server = app.getHttpServer();
    repo = dataSource.getRepository(Knowledge);
    chunkRepo = dataSource.getRepository(Chunk);
    // 前置：init 创建 Owner + 创建一个知识库
    const initRes = await request(server).post('/api/v1/auth/init').send({
      email: ownerEmail,
      password: 'Owner123456',
      name: '分块测试所有者',
    });
    expect(initRes.status).toBe(201);
    ownerToken = initRes.body.accessToken as string;
    const kbRes = await request(server)
      .post('/api/v1/kbs')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: '分块测试知识库' });
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

  it('上传多段文档后解析→分块闭环，knowledge status=ready 且 chunkCount>0', async () => {
    const res = await uploadFile(
      kbIds[0],
      '分块测试.md',
      Buffer.from(mdContent),
    );
    expect(res.status).toBe(201);
    const id = res.body.id as string;
    // 等待队列处理：分块完成 → status=ready + chunkCount>0
    await waitFor(
      async () => {
        const k = await getKnowledge(id);
        return k !== null && k.status === 'ready' && (k.chunkCount ?? 0) > 0;
      },
      { description: 'md 文档分块完成（status=ready 且 chunkCount>0）' },
    );
    const k = await getKnowledge(id);
    expect(k!.parsedText).toContain('第 1 节');
    expect(k!.chunkCount).toBeGreaterThanOrEqual(2);
    // 分块真实落库
    const dbCount = await chunkRepo.count({ where: { knowledgeId: id } });
    expect(dbCount).toBe(k!.chunkCount);
  });

  it('GET chunks 分块列表：chunkIndex 升序 + pre/next 链表（kbId/kid 双重限定 404）', async () => {
    // 复用上一用例的 md 文档（已 ready）
    const list = await request(server)
      .get(`/api/v1/kbs/${kbIds[0]}/knowledge?type=file&pageSize=10`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(list.status).toBe(200);
    const doc = (list.body.items as Array<{ id: string }>)[0];
    const res = await request(server)
      .get(`/api/v1/kbs/${kbIds[0]}/knowledge/${doc.id}/chunks?pageSize=100`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    const items = res.body.items as Array<{
      id: string;
      chunkIndex: number;
      preChunkId: string | null;
      nextChunkId: string | null;
      content: string;
      startAt: number;
      endAt: number;
    }>;
    expect(items.length).toBeGreaterThanOrEqual(2);
    // chunkIndex 从 0 严格递增
    expect(items[0].chunkIndex).toBe(0);
    for (let i = 1; i < items.length; i++) {
      expect(items[i].chunkIndex).toBe(items[i - 1].chunkIndex + 1);
    }
    // pre/next 链表：首块 pre 空、末块 next 空，中间正确串联
    expect(items[0].preChunkId).toBeNull();
    expect(items[items.length - 1].nextChunkId).toBeNull();
    for (let i = 0; i < items.length - 1; i++) {
      expect(items[i].nextChunkId).toBe(items[i + 1].id);
      expect(items[i + 1].preChunkId).toBe(items[i].id);
    }
    // 每块 ≤ 默认 chunkSize=800，且偏移区间合法（半开区间 [startAt, endAt)）
    for (const c of items) {
      expect(c.content.length).toBeLessThanOrEqual(800);
      expect(c.startAt).toBeLessThan(c.endAt);
    }
    // kbId 双重限定：错误 kbId → 404（防跨 KB 越权读取）
    const wrongKb = await request(server)
      .get(
        `/api/v1/kbs/00000000-0000-0000-0000-000000000000/knowledge/${doc.id}/chunks`,
      )
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(wrongKb.status).toBe(404);
  });

  it('列表分页：page/pageSize 生效，pageSize 超上限 400', async () => {
    const list = await request(server)
      .get(`/api/v1/kbs/${kbIds[0]}/knowledge?type=file&pageSize=10`)
      .set('Authorization', `Bearer ${ownerToken}`);
    const doc = (list.body.items as Array<{ id: string }>)[0];
    // pageSize=1：第 1 页只有 1 条，total=全部分块数
    const p1 = await request(server)
      .get(
        `/api/v1/kbs/${kbIds[0]}/knowledge/${doc.id}/chunks?page=1&pageSize=1`,
      )
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(p1.status).toBe(200);
    expect(p1.body.items).toHaveLength(1);
    expect(p1.body.total).toBeGreaterThanOrEqual(2);
    expect(p1.body.page).toBe(1);
    expect(p1.body.pageSize).toBe(1);
    expect(p1.body.items[0].chunkIndex).toBe(0);
    // page=2：第二页首条 chunkIndex=1（按 chunkIndex 升序分页）
    const p2 = await request(server)
      .get(
        `/api/v1/kbs/${kbIds[0]}/knowledge/${doc.id}/chunks?page=2&pageSize=1`,
      )
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(p2.status).toBe(200);
    expect(p2.body.items[0].chunkIndex).toBe(1);
    // pageSize 超上限 100 → 400（PaginationDto 校验）
    const bad = await request(server)
      .get(`/api/v1/kbs/${kbIds[0]}/knowledge/${doc.id}/chunks?pageSize=101`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(bad.status).toBe(400);
  });

  it('图片文档（空文本）→ 直接 ready 且 chunkCount=0（Task 1.4 遗留语义落实）', async () => {
    const res = await uploadFile(kbIds[0], '空图片.png', fixture('blank.png'));
    expect(res.status).toBe(201);
    const id = res.body.id as string;
    // 空文本（图片占位返回 ''）→ 分块产出空 → 直接 ready + chunkCount=0
    await waitFor(
      async () => {
        const k = await getKnowledge(id);
        return k !== null && k.status === 'ready' && k.chunkCount === 0;
      },
      { description: '图片文档解析完成（ready 且 chunkCount=0）' },
    );
    const k = await getKnowledge(id);
    expect(k!.parsedText).toBe('');
    // 分块表无残留
    const dbCount = await chunkRepo.count({ where: { knowledgeId: id } });
    expect(dbCount).toBe(0);
  });

  it('解析失败文档不产生分块且 status=failed（复用损坏 pdf）', async () => {
    const res = await uploadFile(
      kbIds[0],
      '损坏文档.pdf',
      fixture('corrupt.pdf'),
    );
    expect(res.status).toBe(201);
    const id = res.body.id as string;
    await waitReady(id, '损坏 pdf 解析失败（status=failed）', 'failed');
    const k = await getKnowledge(id);
    expect(k!.error.length).toBeGreaterThan(0);
    // 解析失败不产生分块
    const dbCount = await chunkRepo.count({ where: { knowledgeId: id } });
    expect(dbCount).toBe(0);
    const list = await request(server)
      .get(`/api/v1/kbs/${kbIds[0]}/knowledge/${id}/chunks`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(0);
    expect(list.body.total).toBe(0);
  });

  it('解析中删除文档 → 无孤儿块（删除事务化 + 分块事务存在性复查，任一时序收敛）', async () => {
    // 上传后不等待解析完成立即删除，制造删除与解析的竞态窗口。两种时序都
    // 必须收敛到无孤儿块（Task 1.5 质量修复，见 parse.processor.ts 与
    // KnowledgeService.remove 注释）：
    // a) 删除先提交 → 分块事务的 SELECT FOR UPDATE 复查读到行已删 → 抛错回滚；
    // b) 解析先提交 → 删除事务随后在同一事务内删行 + 删块（原子化）。
    const res = await uploadFile(
      kbIds[0],
      '竞态删除.md',
      Buffer.from(mdContent),
    );
    expect(res.status).toBe(201);
    const id = res.body.id as string;
    const del = await request(server)
      .delete(`/api/v1/kbs/${kbIds[0]}/knowledge/${id}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(del.status).toBe(204);
    // 204 = 删除事务已提交 → 行 + 块原子删除，此刻 chunks 必为空
    expect(await chunkRepo.count({ where: { knowledgeId: id } })).toBe(0);
    // 队列中可能仍在途的解析任务（含重试）不得再产生孤儿块：等队列排空后复查
    const parseQueue = app.get(getQueueToken(PARSE_QUEUE));
    await waitFor(
      async () => {
        const counts = await parseQueue.getJobCounts(
          'waiting',
          'active',
          'delayed',
        );
        return counts.waiting + counts.active + counts.delayed === 0;
      },
      { description: 'parse 队列排空（无在途/待重试解析任务）' },
    );
    expect(await chunkRepo.count({ where: { knowledgeId: id } })).toBe(0);
    // 行已删：详情 404
    const detail = await request(server)
      .get(`/api/v1/kbs/${kbIds[0]}/knowledge/${id}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(detail.status).toBe(404);
  });
});
