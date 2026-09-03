// 图谱抽取管线 e2e（Task 3.2）：文档解析 ready 后按 KB extractConfig 入队
// GRAPH_QUEUE，LLM 抽取实体/关系 → 批量写入 Neo4j（实体/边/chunk 镜像）。
// ChatModelService 用可脚本化 FakeGraphChatModel override（chat() 返回当前脚本
// 的固定抽取 JSON——确定性断言；测试间切换正常/损坏脚本，见 graphChatScript）。
// 注意：本 override 同时服务 SUMMARY（摘要落库为抽取 JSON 文本，无害，不做断言）。
// 队列异步处理：waitFor 轮询（见 wait-for.ts）。Neo4j 测试数据按 kbId 隔离清理
// （Neo4j 独立实例无 ohmydocagent_test 隔离，沿用 graph-repo.e2e-spec.ts 约定）。
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { DataSource, Repository } from 'typeorm';
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

/** 固定抽取 JSON：3 实体 + 2 关系（与单测 VALID_EXTRACTION_JSON 同构） */
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

/** 可脚本化 Fake ChatModelService：chat() 返回 graphChatScript() 当前结果
 * （测试间切换脚本：正常抽取 JSON / 损坏 JSON） */
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

describe('图谱抽取管线 (e2e)', () => {
  let app: INestApplication;
  let server: any;
  let dataSource: DataSource;
  let neo4j: Neo4jService;
  let graphQueue: any;
  let chunkRepo: Repository<Chunk>;
  let repo: Repository<Knowledge>;
  const ownerEmail = 'graph-extract-owner@ohmydocagent.local';
  let ownerToken = '';
  // 主 KB（extractConfig 缺省 → 默认开启）：实体/边/chunk 镜像断言对象
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

  beforeAll(async () => {
    await prepareTestEnv();
    // withMockModels（embedding mock）之上再 override CHAT_MODEL_SERVICE 为
    // 脚本化 fake（override 按序生效，后调用覆盖先调用——Nest 测试模块的
    // override 是 Map 语义）
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
    // 清空 GRAPH_QUEUE：防上一 e2e 文件遗留的 graph job（其文档已被 TRUNCATE，
    // 404 no-op 是噪音；obliterate 在 app.init() 前执行，worker 未启动无竞争）
    graphQueue = moduleRef.get(getQueueToken(GRAPH_QUEUE));
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
      name: '图谱抽取测试所有者',
    });
    expect(initRes.status).toBe(201);
    ownerToken = initRes.body.accessToken as string;
    // 前置：主 KB 不带 extractConfig（验证默认开启——上传即建图的产品核心能力）
    const kbRes = await request(server)
      .post('/api/v1/kbs')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: '图谱抽取测试知识库' });
    expect(kbRes.status).toBe(201);
    mainKbIds.push(kbRes.body.id as string);
    kbIds.push(kbRes.body.id as string);
    // 前置：建约束（MERGE 唯一性语义依赖约束；幂等，跑两次不报错）——
    // 应用启动时 onApplicationBootstrap 已建，此处显式再跑一次是双保险
    // （也顺带验证幂等，见 graph-repo.e2e-spec.ts 首个用例）
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

  it('文档解析完成后自动抽取实体写入 Neo4j（节点存在且 chunkIds 关联）', async () => {
    graphChatScript = () => EXTRACTION_JSON;
    const res = await uploadFile(
      mainKbIds[0],
      '图谱文档.md',
      Buffer.from(mdContent),
    );
    expect(res.status).toBe(201);
    const id = res.body.id as string;
    mainDocId = id;
    await waitFor(
      async () => {
        const k = await getKnowledge(id);
        return k !== null && k.status === 'ready';
      },
      { description: 'md 文档解析分块完成（ready）' },
    );
    // 等待图谱抽取完成（parserStages 追加 graph done 阶段）
    await waitGraphDone(id, '图谱抽取完成（graph done 阶段）');
    // 实体节点存在（张三/OhMyDocAgent 平台/李四），且 chunkIds 关联到该文档实际 chunk
    const chunkIds = (
      await chunkRepo.find({
        where: { knowledgeId: id },
        select: { id: true },
      })
    ).map((c) => c.id);
    expect(chunkIds.length).toBeGreaterThan(0);
    const result = await neo4j.run(
      `MATCH (e:Entity { kbId: $kbId }) RETURN e.name AS name, e.chunkIds AS ids ORDER BY e.name`,
      { kbId: mainKbIds[0] },
    );
    const byName = new Map(
      result.records.map((r) => [r.get('name') as string, r.get('ids')]),
    );
    expect(byName.has('张三')).toBe(true);
    expect(byName.has('OhMyDocAgent 平台')).toBe(true);
    expect(byName.has('李四')).toBe(true);
    // 实体 chunkIds 与该文档 chunk id 集合一致（每个 chunk 都抽取到张三）
    expect((byName.get('张三') as string[]).sort()).toEqual(
      [...chunkIds].sort(),
    );
  });

  it('抽取 JSON 写入关系（RELATES_TO 边存在且 weight 累加语义）', async () => {
    const res = await neo4j.run(
      `MATCH (a:Entity { kbId: $kbId, name: '张三' })-[r:RELATES_TO { type: '开发' }]->(b:Entity { kbId: $kbId, name: 'OhMyDocAgent 平台' }) RETURN r.weight AS w`,
      { kbId: mainKbIds[0] },
    );
    expect(res.records).toHaveLength(1);
    // 单 chunk 文档：weight=1（同边多次抽取由仓储 MERGE 累加，见 graph.repository.ts）
    expect(res.records[0].get('w')).toBe(1);
    // 两条边（开发/隶属于）都写入
    const edgeCount = await neo4j.run(
      `MATCH ()-[r:RELATES_TO { kbId: $kbId }]->() RETURN count(r) AS total`,
      { kbId: mainKbIds[0] },
    );
    expect(edgeCount.records[0].get('total').toNumber()).toBe(2);
  });

  it('chunk 镜像节点同步（Chunk 节点可查：id/content/knowledgeId 与 chunks 表一致）', async () => {
    const chunkRows = await chunkRepo.find({
      where: { knowledgeId: mainDocId },
      select: { id: true, content: true },
      order: { chunkIndex: 'ASC' },
    });
    expect(chunkRows.length).toBeGreaterThan(0);
    const result = await neo4j.run(
      `MATCH (c:Chunk { kbId: $kbId }) RETURN c.id AS id, c.content AS content, c.knowledgeId AS kid ORDER BY c.id`,
      { kbId: mainKbIds[0] },
    );
    // 镜像数量 = chunks 表行数（本 KB 只有这一个文档）
    expect(result.records).toHaveLength(chunkRows.length);
    const byId = new Map(
      result.records.map((r) => [r.get('id') as string, r.get('content')]),
    );
    for (const row of chunkRows) {
      expect(byId.get(row.id)).toBe(row.content);
    }
    // knowledgeId 指向正确文档（反查定位用）
    expect(result.records[0].get('kid')).toBe(mainDocId);
  });

  it('KB extractConfig.enabled=false 时不入队不建图（KB 级开关生效）', async () => {
    const res = await request(server)
      .post('/api/v1/kbs')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: '图谱关闭知识库', extractConfig: { enabled: false } });
    expect(res.status).toBe(201);
    const disabledKbId = res.body.id as string;
    kbIds.push(disabledKbId);
    expect(res.body.extractConfig).toEqual({ enabled: false });
    const upload = await uploadFile(
      disabledKbId,
      '关闭图谱.md',
      Buffer.from(mdContent),
    );
    expect(upload.status).toBe(201);
    const id = upload.body.id as string;
    await waitFor(
      async () => {
        const k = await getKnowledge(id);
        return k !== null && k.status === 'ready';
      },
      { description: 'enabled=false 文档解析完成（ready）' },
    );
    // 给幽灵 graph job 留处理窗口（应不存在：无 graph 阶段 + Neo4j 无实体）
    await new Promise((r) => setTimeout(r, 1000));
    const k = await getKnowledge(id);
    const stages = (k?.parserStages ?? []) as Array<{ stage: string }>;
    expect(stages.some((s) => s.stage === 'graph')).toBe(false);
    const count = await neo4j.run(
      `MATCH (e:Entity { kbId: $kbId }) RETURN count(e) AS total`,
      { kbId: disabledKbId },
    );
    expect(count.records[0].get('total').toNumber()).toBe(0);
  });

  it('LLM 返回损坏 JSON → 抽取失败仅日志（文档状态不坏；graph job 重试耗尽进 failed）', async () => {
    graphChatScript = () => '模型输出了非 JSON 内容';
    // 独立 KB：该 KB 无任何实体写入（主 KB 已有实体，无法区分文档归属）
    const res = await request(server)
      .post('/api/v1/kbs')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: '图谱损坏JSON知识库', extractConfig: { enabled: true } });
    expect(res.status).toBe(201);
    const brokenKbId = res.body.id as string;
    kbIds.push(brokenKbId);
    const failedBefore = await graphQueue.getFailedCount();
    const upload = await uploadFile(
      brokenKbId,
      '损坏JSON.md',
      Buffer.from(mdContent),
    );
    expect(upload.status).toBe(201);
    const id = upload.body.id as string;
    await waitFor(
      async () => {
        const k = await getKnowledge(id);
        return k !== null && k.status === 'ready';
      },
      { description: '损坏 JSON 文档解析完成（ready）' },
    );
    // 等 graph job 失败（attempts=2 + backoff 2s 重试后进 failed 状态）
    await waitFor(
      async () => {
        const failed = await graphQueue.getFailedCount();
        return failed > failedBefore;
      },
      {
        timeoutMs: 15000,
        description: '损坏 JSON 的 graph job 重试耗尽进 failed',
      },
    );
    // 文档状态不坏：仍 ready、无 graph done 阶段（running 悬挂，时间线不误伤）
    const k = await getKnowledge(id);
    expect(k!.status).toBe('ready');
    const stages = k!.parserStages as Array<{ stage: string; status: string }>;
    expect(stages.some((s) => s.stage === 'graph' && s.status === 'done')).toBe(
      false,
    );
    const count = await neo4j.run(
      `MATCH (e:Entity { kbId: $kbId }) RETURN count(e) AS total`,
      { kbId: brokenKbId },
    );
    expect(count.records[0].get('total').toNumber()).toBe(0);
    // 恢复脚本（后续用例不受影响）
    graphChatScript = () => EXTRACTION_JSON;
  });

  it('同文档重复解析（reparse）→ 图谱去重不膨胀（实体/边幂等；chunk 关联刷新）', async () => {
    graphChatScript = () => EXTRACTION_JSON;
    // 前置计数：3 实体 + 2 边（首轮抽取）
    const before = await neo4j.run(
      `MATCH (e:Entity { kbId: $kbId }) RETURN count(e) AS total`,
      { kbId: mainKbIds[0] },
    );
    expect(before.records[0].get('total').toNumber()).toBe(3);
    const res = await request(server)
      .post(`/api/v1/kbs/${mainKbIds[0]}/knowledge/${mainDocId}/reparse`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ queued: true });
    // 等第二轮完成（reparse 重置 parserStages——graph done 重新出现即本轮完成）
    await waitGraphDone(mainDocId, 'reparse 第二轮图谱抽取完成');
    // 实体/边幂等：数量不变（MERGE 语义，不堆节点/边；weight 累加不膨胀计数）
    const afterEntities = await neo4j.run(
      `MATCH (e:Entity { kbId: $kbId }) RETURN count(e) AS total`,
      { kbId: mainKbIds[0] },
    );
    expect(afterEntities.records[0].get('total').toNumber()).toBe(3);
    const afterEdges = await neo4j.run(
      `MATCH ()-[r:RELATES_TO { kbId: $kbId }]->() RETURN count(r) AS total`,
      { kbId: mainKbIds[0] },
    );
    expect(afterEdges.records[0].get('total').toNumber()).toBe(2);
    // chunk 关联刷新：张三的 chunkIds = 本轮新 chunk id 集合（旧 chunk 关联已由
    // deleteKnowledgeSubgraph 清理——reparse 幂等语义，不累积陈旧 chunkIds）
    const newChunkIds = (
      await chunkRepo.find({
        where: { knowledgeId: mainDocId },
        select: { id: true },
      })
    ).map((c) => c.id);
    expect(newChunkIds.length).toBeGreaterThan(0);
    const zhang = await neo4j.run(
      `MATCH (e:Entity { kbId: $kbId, name: '张三' }) RETURN e.chunkIds AS ids`,
      { kbId: mainKbIds[0] },
    );
    expect((zhang.records[0].get('ids') as string[]).sort()).toEqual(
      [...newChunkIds].sort(),
    );
  });

  it('删除文档 → 图谱子图清理（chunk 镜像删除 + 实体 chunkIds 剔除；实体保留）', async () => {
    // 独立 KB 隔离（主 KB 的文档被后续用例共用，不能删）：上传 → 抽取完成 → 删除文档
    graphChatScript = () => EXTRACTION_JSON;
    const res = await request(server)
      .post('/api/v1/kbs')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: '图谱删除文档知识库' });
    expect(res.status).toBe(201);
    const kbId = res.body.id as string;
    kbIds.push(kbId);
    const upload = await uploadFile(
      kbId,
      '待删除文档.md',
      Buffer.from(mdContent),
    );
    expect(upload.status).toBe(201);
    const docId = upload.body.id as string;
    await waitFor(
      async () => {
        const k = await getKnowledge(docId);
        return k !== null && k.status === 'ready';
      },
      { description: '待删除文档解析完成（ready）' },
    );
    await waitGraphDone(docId, '待删除文档图谱抽取完成');
    // 前置：图谱已写入（实体 + chunk 镜像存在）
    const before = await neo4j.run(
      `MATCH (e:Entity { kbId: $kbId }) RETURN count(e) AS total`,
      { kbId },
    );
    expect(before.records[0].get('total').toNumber()).toBe(3);
    const mirrorBefore = await neo4j.run(
      `MATCH (c:Chunk { kbId: $kbId, knowledgeId: $kid }) RETURN count(c) AS total`,
      { kbId, kid: docId },
    );
    expect(mirrorBefore.records[0].get('total').toNumber()).toBeGreaterThan(0);
    // 删除文档（KnowledgeService.remove 事务提交后 best-effort 清理图谱子图，
    // Task 3.2 质量审查整改——已删文档不得残留反查入口）；控制器返回 204 No Content
    const del = await request(server)
      .delete(`/api/v1/kbs/${kbId}/knowledge/${docId}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(del.status).toBe(204);
    // 1) chunk 镜像全部删除（该文档的镜像节点不再存在）
    const mirrorAfter = await neo4j.run(
      `MATCH (c:Chunk { kbId: $kbId, knowledgeId: $kid }) RETURN count(c) AS total`,
      { kbId, kid: docId },
    );
    expect(mirrorAfter.records[0].get('total').toNumber()).toBe(0);
    // 2) 实体保留（图谱是跨文档聚合结构，删除文档不删实体），但 chunkIds 已剔除
    //    ——反查不再命中已删文档
    const entityAfter = await neo4j.run(
      `MATCH (e:Entity { kbId: $kbId }) RETURN e.name AS name, e.chunkIds AS ids ORDER BY e.name`,
      { kbId },
    );
    expect(entityAfter.records).toHaveLength(3);
    for (const rec of entityAfter.records) {
      expect(rec.get('ids')).toEqual([]);
    }
  });

  it('删除 KB → 图谱子图清空（实体/边/chunk 镜像全删）', async () => {
    graphChatScript = () => EXTRACTION_JSON;
    const res = await request(server)
      .post('/api/v1/kbs')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: '图谱删除知识库' });
    expect(res.status).toBe(201);
    const kbId = res.body.id as string;
    kbIds.push(kbId);
    const upload = await uploadFile(
      kbId,
      '待删库文档.md',
      Buffer.from(mdContent),
    );
    expect(upload.status).toBe(201);
    const docId = upload.body.id as string;
    await waitFor(
      async () => {
        const k = await getKnowledge(docId);
        return k !== null && k.status === 'ready';
      },
      { description: '待删库文档解析完成（ready）' },
    );
    await waitGraphDone(docId, '待删库文档图谱抽取完成');
    const before = await neo4j.run(
      `MATCH (n) WHERE n.kbId = $kbId RETURN count(n) AS total`,
      { kbId },
    );
    expect(before.records[0].get('total').toNumber()).toBeGreaterThan(0);
    // 删除 KB（KbService.remove 事务提交后 best-effort 调 deleteKbSubgraph，
    // Task 3.2 质量审查整改——已删 KB 的子图不得残留为无主数据）；控制器返回 204
    const del = await request(server)
      .delete(`/api/v1/kbs/${kbId}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(del.status).toBe(204);
    const after = await neo4j.run(
      `MATCH (n) WHERE n.kbId = $kbId RETURN count(n) AS total`,
      { kbId },
    );
    expect(after.records[0].get('total').toNumber()).toBe(0);
    // 边一并清空（DETACH DELETE 语义）
    const edges = await neo4j.run(
      `MATCH ()-[r:RELATES_TO { kbId: $kbId }]->() RETURN count(r) AS total`,
      { kbId },
    );
    expect(edges.records[0].get('total').toNumber()).toBe(0);
  });
});
