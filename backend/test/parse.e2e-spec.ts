// 解析管线 e2e（Task 1.4 + Task 1.5）：上传/URL/手动创建后自动入队，占位解析器
// 抽取文本写回 knowledge.parsedText，状态流转 pending → parsing → ready（Task 1.5
// 分块完成后置 ready）/ failed（失败 → failed + error 记录）。
// 队列异步处理：轮询 DB 等待（waitFor，10s 超时，见 test/wait-for.ts）。
// URL 用例不真拉公网（WSL 网络不稳）：用 127.0.0.1:9（discard 端口，连接即刻拒绝）
// 验证「URL 文档能入队且解析失败 → status=failed」语义；拉取逻辑由
// placeholder-parser.spec.ts 的 mock fetch 单测覆盖。
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
import { User } from '../src/modules/users/user.entity.js';
import { RedisService } from '../src/redis/redis.service.js';

describe('Parse (e2e)', () => {
  let app: INestApplication;
  let server: any;
  let dataSource: DataSource;
  let repo: Repository<Knowledge>;
  const ownerEmail = 'parse-owner@ohmydocagent.local';
  let ownerToken = '';
  // 本文件创建的知识库 id：afterAll 清理其上传目录
  const kbIds: string[] = [];
  const testEmails = [ownerEmail];

  /** fixture 读取（相对本文件路径，独立于进程 cwd） */
  const fixture = (name: string) =>
    readFileSync(path.join(__dirname, 'fixtures', name));
  /** md 上传内容（与 unit fixture 同内容，e2e 用内存 buffer 上传） */
  const mdContent = '# OhMyDocAgent 研究报告\n\n这是 markdown 内容。';

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
    // 清空 parse 队列：防上一 e2e 文件遗留的 job（如 knowledge.e2e-spec 上传的
    // 假 pdf/docx）处理本文件已 TRUNCATE 的数据（404 噪音）。
    // 在 app.init() 之前执行——worker 尚未启动，无竞争
    const parseQueue = moduleRef.get(getQueueToken(PARSE_QUEUE));
    await parseQueue.obliterate({ force: true });
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    server = app.getHttpServer();
    repo = dataSource.getRepository(Knowledge);
    // 前置：init 创建 Owner + 创建一个知识库
    const initRes = await request(server).post('/api/v1/auth/init').send({
      email: ownerEmail,
      password: 'Owner123456',
      name: '解析测试所有者',
    });
    expect(initRes.status).toBe(201);
    ownerToken = initRes.body.accessToken as string;
    const kbRes = await request(server)
      .post('/api/v1/kbs')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: '解析测试知识库' });
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

  it('上传 md 文件后自动入队解析，parsedText 写入 + 分块闭环置 ready', async () => {
    const res = await uploadFile(
      kbIds[0],
      '研究报告.md',
      Buffer.from(mdContent),
    );
    expect(res.status).toBe(201);
    const id = res.body.id as string;
    // 等待队列处理：parsedText 写入 + status=ready（Task 1.5 分块完成后置 ready）
    await waitFor(
      async () => {
        const k = await getKnowledge(id);
        return k !== null && k.status === 'ready' && k.parsedText !== null;
      },
      { description: 'md 文档解析分块完成（parsedText 写入 + ready）' },
    );
    const k = await getKnowledge(id);
    expect(k!.parsedText).toContain('markdown 内容');
    expect(k!.parsedText).toContain('OhMyDocAgent 研究报告');
    // 非空文本 → 分块闭环产生分块
    expect(k!.chunkCount).toBeGreaterThan(0);
  });

  it('上传 pdf（占位解析）后 parsedText 非空（真实小 PDF fixture）', async () => {
    const res = await uploadFile(kbIds[0], 'sample.pdf', fixture('sample.pdf'));
    expect(res.status).toBe(201);
    const id = res.body.id as string;
    await waitFor(
      async () => {
        const k = await getKnowledge(id);
        return k !== null && k.status === 'ready' && k.parsedText !== null;
      },
      { description: 'pdf 文档解析分块完成（parsedText 非空）' },
    );
    const k = await getKnowledge(id);
    expect(k!.parsedText).toContain('OhMyDocAgent parser test PDF content');
  });

  it('上传损坏 pdf → status=failed + error 记录', async () => {
    const res = await uploadFile(
      kbIds[0],
      'broken.pdf',
      fixture('corrupt.pdf'),
    );
    expect(res.status).toBe(201);
    const id = res.body.id as string;
    await waitFor(
      async () => {
        const k = await getKnowledge(id);
        return k !== null && k.status === 'failed';
      },
      { description: '损坏 pdf 解析失败（status=failed）' },
    );
    const k = await getKnowledge(id);
    expect(k!.error.length).toBeGreaterThan(0);
  });

  it('URL 导入 → 解析任务拉取失败时 status=failed（不真拉公网；拉取逻辑单测覆盖）', async () => {
    const res = await request(server)
      .post(`/api/v1/kbs/${kbIds[0]}/url`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ sourceUrl: 'http://127.0.0.1:9/unreachable-doc' });
    expect(res.status).toBe(201);
    const id = res.body.id as string;
    await waitFor(
      async () => {
        const k = await getKnowledge(id);
        return k !== null && k.status === 'failed';
      },
      { description: 'URL 拉取失败（连接拒绝）→ status=failed' },
    );
    const k = await getKnowledge(id);
    expect(k!.error.length).toBeGreaterThan(0);
  });

  it('手动创建 → 解析任务用 manualContent 抽取（parsedText=manualContent）', async () => {
    const content = '这是手动创建的知识文档内容';
    const res = await request(server)
      .post(`/api/v1/kbs/${kbIds[0]}/manual`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ title: '手动笔记', content });
    expect(res.status).toBe(201);
    const id = res.body.id as string;
    await waitFor(
      async () => {
        const k = await getKnowledge(id);
        return k !== null && k.status === 'ready' && k.parsedText === content;
      },
      { description: '手动文档解析分块完成（parsedText=manualContent）' },
    );
  });

  it('详情响应含 parserStages 解析时间线（extract 阶段记录；Task 1.7 正式做 stages 接口）', async () => {
    // 复用上一用例的手动文档（已解析完成，parserStages 应含 extract done）
    const list = await request(server)
      .get(`/api/v1/kbs/${kbIds[0]}/knowledge?type=manual`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(list.status).toBe(200);
    const manual = list.body.items[0] as { id: string };
    const detail = await request(server)
      .get(`/api/v1/kbs/${kbIds[0]}/knowledge/${manual.id}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(detail.status).toBe(200);
    const stages = detail.body.parserStages as Array<{
      stage: string;
      status: string;
      at: string;
    }>;
    expect(Array.isArray(stages)).toBe(true);
    // 成功解析：extract 阶段有 running + done 两条记录
    expect(
      stages.some((s) => s.stage === 'extract' && s.status === 'running'),
    ).toBe(true);
    expect(
      stages.some((s) => s.stage === 'extract' && s.status === 'done'),
    ).toBe(true);
    // Task 1.5 分块阶段：成功文档应有 chunk running + done 两条记录
    expect(
      stages.some((s) => s.stage === 'chunk' && s.status === 'running'),
    ).toBe(true);
    expect(stages.some((s) => s.stage === 'chunk' && s.status === 'done')).toBe(
      true,
    );
  });

  it('解析失败后错误信息记录（failed 文档详情 error 非空；P4 任务仪表盘可重试）', async () => {
    // 列表投影不含 error（内部诊断字段，见 KnowledgeService.LIST_SELECT 注释），
    // 故逐条查详情断言 error 非空（列表仅用于筛出 failed 文档 id）
    const res = await request(server)
      .get(`/api/v1/kbs/${kbIds[0]}/knowledge?status=failed&pageSize=20`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    const ids = (res.body.items as Array<{ id: string }>).map((i) => i.id);
    expect(ids.length).toBeGreaterThanOrEqual(2); // 损坏 pdf + URL 两个 failed
    for (const id of ids) {
      const detail = await request(server)
        .get(`/api/v1/kbs/${kbIds[0]}/knowledge/${id}`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(detail.status).toBe(200);
      expect(detail.body.error.length).toBeGreaterThan(0);
    }
  });
});
