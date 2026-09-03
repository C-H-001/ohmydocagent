// 图谱 API e2e（Task 3.3）：可视化数据（nodes/edges）、实体搜索、实体详情
// （属性/关联实体含 direction/反查文档含标题与片段）、图谱覆盖统计。
// 与 graph-extraction.e2e-spec.ts 同基建：FakeGraphChatModel override 固定
// 抽取 JSON → Neo4j 有实体（3 实体 + 2 边，见 EXTRACTION_JSON）。
// 覆盖统计的 coveredKnowledge<totalKnowledge 语义用「空抽取文档」构造：
// FakeGraphChatModel 切换脚本返回 {"node": [], "relation": []}——该文档分块
// 镜像照常写入（extractAll 对 chunks 恒透传，见 graph-extraction.service.ts），
// 但无任何实体引用其 chunk → 按「有实体关联的文档数」口径不计入覆盖。
// Neo4j 测试数据按 kbId 隔离清理（Neo4j 独立实例，沿用既有约定）。
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { DataSource, Repository } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../src/app.module.js';
import { withMockModels } from './mock-model-overrides.js';
import { prepareTestEnv } from './test-db.js';
import { configureApp } from '../src/app.setup.js';
import { waitFor } from './wait-for.js';
import { GRAPH_QUEUE } from '../src/modules/graph/graph-queue.constants.js';
import { GraphRepository } from '../src/modules/graph/graph.repository.js';
import { Neo4jService } from '../src/neo4j/neo4j.service.js';
import { Knowledge } from '../src/modules/knowledge/knowledge.entity.js';
import { Chunk } from '../src/modules/chunk/chunk.entity.js';
import { User } from '../src/modules/users/user.entity.js';
import { RedisService } from '../src/redis/redis.service.js';
import { CHAT_MODEL_SERVICE } from '../src/modules/model/chat-model.interface.js';
import type {
  ChatMessage,
  ChatModelService,
  ChatOptions,
  ChatStreamChunk,
} from '../src/modules/model/chat-model.interface.js';

/** 固定抽取 JSON：3 实体 + 2 关系（与 graph-extraction.e2e-spec.ts 同构） */
const EXTRACTION_JSON = JSON.stringify({
  node: [
    { name: '张三', attributes: ['人物', '技术专家'] },
    { name: 'OhMyDocAgent 平台', attributes: ['产品'] },
    { name: '李四', attributes: ['人物'] },
  ],
  relation: [
    { node1: '张三', node2: 'OhMyDocAgent 平台', type: '开发' },
    { node1: '李四', node2: 'OhMyDocAgent 平台', type: '隶属于' },
  ],
});

/** 空抽取 JSON：无实体无关系（覆盖统计 uncovered 文档构造用） */
const EMPTY_EXTRACTION_JSON = JSON.stringify({ node: [], relation: [] });

/** 可脚本化 Fake ChatModelService（与 graph-extraction.e2e-spec.ts 同款） */
let graphChatScript: () => string = () => EXTRACTION_JSON;
class FakeGraphChatModel implements ChatModelService {
  async chat(
    _messages: ChatMessage[],
    _options?: ChatOptions,
  ): Promise<string> {
    return graphChatScript();
  }
  async *chatStream(): AsyncIterable<ChatStreamChunk> {
    yield { text: graphChatScript() };
  }
}

describe('图谱 API (e2e)', () => {
  let app: INestApplication;
  let server: any;
  let dataSource: DataSource;
  let neo4j: Neo4jService;
  let chunkRepo: Repository<Chunk>;
  let repo: Repository<Knowledge>;
  const ownerEmail = 'graph-api-owner@ohmydocagent.local';
  let ownerToken = '';
  // 主 KB（默认开启抽取）：可视化/搜索/实体详情断言对象
  const mainKbIds: string[] = [];
  // 本文件创建的知识库 id（含隔离 KB）：afterAll 一并清理
  const kbIds: string[] = [];
  const testEmails = [ownerEmail];
  // 上传文档内容（< 默认 chunkSize 800 → 单 chunk，抽取行数确定）
  const mdContent =
    '# OhMyDocAgent 研究报告\n\n张三是 OhMyDocAgent 平台的技术专家，李四隶属于 OhMyDocAgent 平台。\n\n产品团队使用 OhMyDocAgent 平台进行知识管理。';
  let mainDocId = '';

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

  /** 等待文档图谱阶段完成（parserStages 含 graph done） */
  const waitGraphDone = (id: string, description: string) =>
    waitFor(
      async () => {
        const k = await getKnowledge(id);
        if (!k) return false;
        const stages = (k.parserStages ?? []) as Array<{
          stage: string;
          status: string;
        }>;
        return stages.some((s) => s.stage === 'graph' && s.status === 'done');
      },
      { timeoutMs: 15000, description },
    );

  /** 上传文档并等待 ready + 图谱完成（返回文档 id） */
  async function uploadAndWaitGraph(
    kbId: string,
    filename: string,
    content: string,
  ): Promise<string> {
    const res = await uploadFile(kbId, filename, Buffer.from(content));
    expect(res.status).toBe(201);
    const id = res.body.id as string;
    await waitFor(
      async () => {
        const k = await getKnowledge(id);
        return k !== null && k.status === 'ready';
      },
      { description: `${filename} 解析分块完成（ready）` },
    );
    await waitGraphDone(id, `${filename} 图谱抽取完成（graph done 阶段）`);
    return id;
  }

  beforeAll(async () => {
    await prepareTestEnv();
    const moduleRef = await withMockModels(
      Test.createTestingModule({
        imports: [AppModule],
      }),
    )
      .overrideProvider(CHAT_MODEL_SERVICE)
      .useClass(FakeGraphChatModel)
      .compile();
    dataSource = moduleRef.get(DataSource);
    // 测试隔离（沿用既有模式）：users/invitations 清空以初始化 Owner；
    // knowledge/chunks 表必须显式列入清单（chunks 引用 knowledge，先清子表）
    await dataSource.query(
      'TRUNCATE TABLE users, invitations, user_kb_pins, knowledge_bases, knowledge, chunk_revisions, chunks CASCADE',
    );
    // 清空 GRAPH_QUEUE：防上一 e2e 文件遗留的 graph job
    const graphQueue = moduleRef.get(getQueueToken(GRAPH_QUEUE));
    await graphQueue.obliterate({ force: true });
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    server = app.getHttpServer();
    neo4j = app.get(Neo4jService);
    repo = dataSource.getRepository(Knowledge);
    chunkRepo = dataSource.getRepository(Chunk);
    // 前置：init 创建 Owner
    const initRes = await request(server).post('/api/v1/auth/init').send({
      email: ownerEmail,
      password: 'Owner123456',
      name: '图谱 API 测试所有者',
    });
    expect(initRes.status).toBe(201);
    ownerToken = initRes.body.accessToken as string;
    // 前置：主 KB（不带 extractConfig → 默认开启）
    const kbRes = await request(server)
      .post('/api/v1/kbs')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: '图谱 API 测试知识库' });
    expect(kbRes.status).toBe(201);
    mainKbIds.push(kbRes.body.id as string);
    kbIds.push(kbRes.body.id as string);
    // 前置：主文档（单 chunk，实体/边/反查文档断言对象）
    mainDocId = await uploadAndWaitGraph(
      mainKbIds[0],
      '图谱文档.md',
      mdContent,
    );
    // 建约束双保险（应用启动时 onApplicationBootstrap 已建，幂等）
    const graphRepo = app.get(GraphRepository);
    await graphRepo.initSchema();
  });

  afterAll(async () => {
    // Neo4j 测试数据清理（按 kbId 隔离；DETACH DELETE 同时清掉实体/边/chunk 镜像）
    for (const id of kbIds) {
      if (id) {
        await neo4j.run('MATCH (n) WHERE n.kbId = $kbId DETACH DELETE n', {
          kbId: id,
        });
      }
    }
    // 删除测试 KB（级联清空 PG 侧文档/分块/上传文件）
    if (ownerToken) {
      for (const id of mainKbIds) {
        await request(server)
          .delete(`/api/v1/kbs/${id}`)
          .set('Authorization', `Bearer ${ownerToken}`);
      }
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

  it('GET /graphs/kbs/:id 返回可视化数据（nodes 含 attributes/size、edges 含 weight）', async () => {
    const res = await request(server)
      .get(`/api/v1/graphs/kbs/${mainKbIds[0]}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    // 3 实体（张三/OhMyDocAgent 平台/李四）+ 2 边（开发/隶属于）
    expect(res.body.nodes).toHaveLength(3);
    const zhang = res.body.nodes.find(
      (n: { name: string }) => n.name === '张三',
    );
    expect(zhang).toBeDefined();
    expect(zhang.id).toBe('张三');
    expect(zhang.attributes).toEqual(
      expect.arrayContaining(['人物', '技术专家']),
    );
    expect(zhang.chunkIds.length).toBeGreaterThan(0);
    expect(zhang.size).toBe(1); // size = degree（张三→OhMyDocAgent 平台 一条边）
    // 边含 weight（单 chunk 文档 weight=1）
    expect(res.body.edges).toHaveLength(2);
    expect(res.body.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: '张三',
          target: 'OhMyDocAgent 平台',
          type: '开发',
          weight: 1,
        }),
        expect.objectContaining({
          source: '李四',
          target: 'OhMyDocAgent 平台',
          type: '隶属于',
          weight: 1,
        }),
      ]),
    );
  });

  it('nodes size = 关联边数（可视化节点大小；接口暴露 size 而非 degree，见任务书）', async () => {
    const res = await request(server)
      .get(`/api/v1/graphs/kbs/${mainKbIds[0]}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    const { nodes, edges } = res.body as {
      nodes: Array<{ name: string; size: number }>;
      edges: Array<{ source: string; target: string }>;
    };
    // size = 关联边数：用响应里的边集合逐节点数出入向边数（真实度语义）
    const degreeOf = (name: string) =>
      edges.filter((e) => e.source === name || e.target === name).length;
    for (const node of nodes) {
      expect(node.size).toBe(degreeOf(node.name));
    }
    // 中心节点 OhMyDocAgent 平台：两条边都指向它（开发/隶属于）→ size=2
    const hub = nodes.find((n) => n.name === 'OhMyDocAgent 平台');
    expect(hub!.size).toBe(2);
  });

  it('GET /graphs/kbs/:id 无图谱 KB → { nodes: [], edges: [] }（不报错）', async () => {
    const res = await request(server)
      .post('/api/v1/kbs')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: '图谱 API 空库' });
    expect(res.status).toBe(201);
    const emptyKbId = res.body.id as string;
    kbIds.push(emptyKbId);
    const graphRes = await request(server)
      .get(`/api/v1/graphs/kbs/${emptyKbId}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(graphRes.status).toBe(200);
    expect(graphRes.body).toEqual({ nodes: [], edges: [] });
  });

  it('GET /graphs/kbs/:id/search?keyword= 实体模糊搜索（CONTAINS；无结果 → []）', async () => {
    const search = async (keyword: string) =>
      request(server)
        .get(`/api/v1/graphs/kbs/${mainKbIds[0]}/search`)
        .query({ keyword })
        .set('Authorization', `Bearer ${ownerToken}`);
    // 中文模糊（包含「张」）
    const zh = await search('张');
    expect(zh.status).toBe(200);
    expect(zh.body.map((e: { name: string }) => e.name)).toEqual(['张三']);
    expect(zh.body[0].attributes).toEqual(
      expect.arrayContaining(['人物', '技术专家']),
    );
    // 英文大小写不敏感（OhMyDocAgent 平台）
    const en = await search('ohmydocagent');
    expect(en.status).toBe(200);
    expect(en.body.map((e: { name: string }) => e.name)).toEqual([
      'OhMyDocAgent 平台',
    ]);
    // 无结果 → 空数组（不报错）
    const none = await search('不存在的实体');
    expect(none.status).toBe(200);
    expect(none.body).toEqual([]);
  });

  it('search keyword 空/超长（>50 字）→ 400', async () => {
    const doSearch = (keyword?: string) =>
      request(server)
        .get(`/api/v1/graphs/kbs/${mainKbIds[0]}/search`)
        .query(keyword === undefined ? {} : { keyword })
        .set('Authorization', `Bearer ${ownerToken}`);
    // 空串（?keyword=）
    expect((await doSearch('')).status).toBe(400);
    // 缺失参数
    expect((await doSearch(undefined)).status).toBe(400);
    // 51 字符超长
    expect((await doSearch('长'.repeat(51))).status).toBe(400);
    // 50 字符恰好合法（边界）
    expect((await doSearch('中'.repeat(50))).status).toBe(200);
  });

  it('GET /graphs/entities/:name?kbId= 实体详情（属性/关联实体含 direction/反查文档含标题与片段）', async () => {
    const res = await request(server)
      .get(`/api/v1/graphs/entities/${encodeURIComponent('张三')}`)
      .query({ kbId: mainKbIds[0] })
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('张三');
    expect(res.body.attributes).toEqual(
      expect.arrayContaining(['人物', '技术专家']),
    );
    expect(res.body.chunkIds.length).toBeGreaterThan(0);
    // 一跳关联实体：张三→OhMyDocAgent 平台 为 out（实体指向对方）
    expect(res.body.relatedEntities).toEqual([
      expect.objectContaining({
        name: 'OhMyDocAgent 平台',
        type: '开发',
        weight: 1,
        direction: 'out',
      }),
    ]);
    // 反查文档：knowledgeId + 标题（PG 补查）+ 片段（chunk 内容前 2 条）
    expect(res.body.relatedKnowledge).toHaveLength(1);
    const rk = res.body.relatedKnowledge[0];
    expect(rk.knowledgeId).toBe(mainDocId);
    expect(rk.knowledgeTitle).toBe('图谱文档');
    expect(rk.chunkSnippets.length).toBeGreaterThanOrEqual(1);
    // 片段内容与 PG chunks 表一致（真实反查而非空壳）
    const pgChunk = await chunkRepo.findOne({
      where: { knowledgeId: mainDocId },
      order: { chunkIndex: 'ASC' },
    });
    expect(rk.chunkSnippets[0]).toBe(pgChunk!.content);
  });

  it('实体不存在 → 404；kbId 缺失/非法 → 400', async () => {
    // 实体不存在（KB 存在）
    const missing = await request(server)
      .get(`/api/v1/graphs/entities/${encodeURIComponent('幽灵实体')}`)
      .query({ kbId: mainKbIds[0] })
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(missing.status).toBe(404);
    // kbId 缺失
    const noKb = await request(server)
      .get(`/api/v1/graphs/entities/${encodeURIComponent('张三')}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(noKb.status).toBe(400);
    // kbId 非 UUID
    const badKb = await request(server)
      .get(`/api/v1/graphs/entities/${encodeURIComponent('张三')}`)
      .query({ kbId: 'not-a-uuid' })
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(badKb.status).toBe(400);
  });

  it('GET /graphs/kbs/:id/documents 覆盖统计（coveredKnowledge < totalKnowledge 语义）', async () => {
    // 独立 KB：文档 A（有实体，计入覆盖）+ 文档 B（空抽取，不计入覆盖）
    const res = await request(server)
      .post('/api/v1/kbs')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: '图谱 API 覆盖统计库', extractConfig: { enabled: true } });
    expect(res.status).toBe(201);
    const covKbId = res.body.id as string;
    kbIds.push(covKbId);
    await uploadAndWaitGraph(covKbId, '覆盖文档A.md', mdContent);
    // 文档 B：脚本切空抽取（无实体无关系；chunk 镜像照常写入）
    graphChatScript = () => EMPTY_EXTRACTION_JSON;
    await uploadAndWaitGraph(covKbId, '覆盖文档B.md', mdContent);
    graphChatScript = () => EXTRACTION_JSON;
    const stats = await request(server)
      .get(`/api/v1/graphs/kbs/${covKbId}/documents`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(stats.status).toBe(200);
    expect(stats.body.totalKnowledge).toBe(2); // KB 内文档数（PG）
    // 有实体关联的文档数 = 1（文档 B 无实体引用其 chunk，不计入覆盖）
    expect(stats.body.coveredKnowledge).toBe(1);
    expect(stats.body.coveredKnowledge).toBeLessThan(stats.body.totalKnowledge);
    // 图谱侧计数：3 实体 + 2 边 + 2 个 chunk 镜像（两个文档各一个）
    expect(stats.body.entities).toBe(3);
    expect(stats.body.relationships).toBe(2);
    expect(stats.body.chunks).toBe(2);
  });

  it('未登录 401；KB 不存在 404', async () => {
    // 未登录：全图谱路由被全局 JwtAuthGuard 拦截
    const anon = await request(server).get(
      `/api/v1/graphs/kbs/${mainKbIds[0]}`,
    );
    expect(anon.status).toBe(401);
    // KB 不存在（合法 UUID 但无对应行）→ 404（可视化/覆盖/详情统一语义）
    const ghostKbId = randomUUID();
    const graphRes = await request(server)
      .get(`/api/v1/graphs/kbs/${ghostKbId}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(graphRes.status).toBe(404);
    const docsRes = await request(server)
      .get(`/api/v1/graphs/kbs/${ghostKbId}/documents`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(docsRes.status).toBe(404);
    const detailRes = await request(server)
      .get(`/api/v1/graphs/entities/${encodeURIComponent('张三')}`)
      .query({ kbId: ghostKbId })
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(detailRes.status).toBe(404);
  });
});
