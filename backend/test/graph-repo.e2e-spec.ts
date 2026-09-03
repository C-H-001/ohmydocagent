// 知识图谱仓储 e2e（Task 3.1）：GraphRepository 的 Neo4j 读写全链路。
// 注意：Neo4j 是独立实例（无 ohmydocagent_test 那样的 PG 库隔离）——测试数据
// 按 kbId 前缀隔离（主 KB 用 API 创建的真实 uuid，隔离用例用随机 uuid），
// afterAll 统一按 kbId DETACH DELETE 清理，避免污染本地开发库。
// 用例间存在顺序依赖（共享同一 kbId 的图数据），vitest 串行执行保证顺序。
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../src/app.module.js';
import { prepareTestEnv } from './test-db.js';
import { configureApp } from '../src/app.setup.js';
import { GraphRepository } from '../src/modules/graph/graph.repository.js';
import { Neo4jService } from '../src/neo4j/neo4j.service.js';
import { User } from '../src/modules/users/user.entity.js';
import { RedisService } from '../src/redis/redis.service.js';

describe('GraphRepository (e2e)', () => {
  let app: INestApplication;
  let server: any;
  let dataSource: DataSource;
  let repo: GraphRepository;
  let neo4j: Neo4jService;
  const ownerEmail = 'graph-owner@ohmydocagent.local';
  let ownerToken = '';
  let kbId = '';
  // 主 KB 的文档 id：测试用随机 uuid（Neo4j 测试与 PG 的 Knowledge 行解耦，
  // 文档删除联动由 Task 3.2/3.5 的管线负责，本任务只测仓储语义）
  const kid1 = randomUUID();
  // 隔离用例产生的额外 kbId：afterAll 一并清理
  const isolatedKbIds: string[] = [];
  // 本文件创建的测试用户邮箱：afterAll 清理 rt:* 键（共享 Redis 隔离，沿用既有约定）
  const testEmails = [ownerEmail];

  beforeAll(async () => {
    await prepareTestEnv();
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    // 测试隔离（沿用 auth-init/kb 模式）：users/invitations 清空以初始化 Owner；
    // 本文件会创建 knowledge_bases 行，显式列入清单（先清子表 user_kb_pins 再清主表）
    dataSource = moduleRef.get(DataSource);
    await dataSource.query(
      'TRUNCATE TABLE users, invitations, user_kb_pins, knowledge_bases CASCADE',
    );
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    server = app.getHttpServer();
    repo = app.get(GraphRepository);
    neo4j = app.get(Neo4jService);
    // 前置：init 创建 Owner（全局守卫要求所有 KB 路由登录）
    const initRes = await request(server).post('/api/v1/auth/init').send({
      email: ownerEmail,
      password: 'Owner123456',
      name: '图谱测试所有者',
    });
    expect(initRes.status).toBe(201);
    ownerToken = initRes.body.accessToken as string;
    // 前置：创建 KB 获取真实 uuid 作为 kbId（图谱数据按 kbId 隔离，见文件头注释）
    const kbRes = await request(server)
      .post('/api/v1/kbs')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: '图谱测试知识库' });
    expect(kbRes.status).toBe(201);
    kbId = kbRes.body.id as string;
    // 注意：不再显式调用 repo.initSchema()——Task 3.2 质量审查整改后约束由
    // GraphRepository.onApplicationBootstrap 在应用启动时幂等创建（首个用例
    // 验证启动即建约束，见下）。真实部署启动同样覆盖，不再依赖 e2e 显式调用。
  });

  afterAll(async () => {
    // Neo4j 测试数据清理（按 kbId 隔离，Neo4j 是独立实例，无 ohmydocagent_test 隔离机制）：
    // DETACH DELETE 同时清掉实体/边/chunk 镜像（节点删除连带删除其全部边）
    for (const id of [kbId, ...isolatedKbIds]) {
      if (id) {
        await neo4j.run('MATCH (n) WHERE n.kbId = $kbId DETACH DELETE n', {
          kbId: id,
        });
      }
    }
    // 删除测试 KB（级联清空 PG 侧文档/分块/上传文件，保持 ohmydocagent_test 无残留）
    if (kbId && ownerToken) {
      await request(server)
        .delete(`/api/v1/kbs/${kbId}`)
        .set('Authorization', `Bearer ${ownerToken}`);
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

  it('AppModule 启动即建约束（onApplicationBootstrap 接线）；initSchema 幂等', async () => {
    // 约束由应用启动时 GraphRepository.onApplicationBootstrap 调用 initSchema
    // 创建（Task 3.2 质量审查整改：MERGE 幂等语义的 DB 层保障接线到应用
    // 生命周期，不再依赖 e2e 显式调用）——beforeAll 未显式调用，此处约束
    // 已存在即证明接线生效
    const result = await neo4j.run('SHOW CONSTRAINTS');
    const names = result.records.map((r) => r.get('name'));
    expect(names).toContain('entity_name_kb_unique');
    expect(names).toContain('relates_to_unique');
    // initSchema 幂等（显式再跑两次不报错——CREATE CONSTRAINT ... IF NOT EXISTS）
    await repo.initSchema();
    await repo.initSchema();
  });

  it('upsertEntity 幂等（同实体重复写入不重复节点）', async () => {
    await repo.upsertEntity({
      kbId,
      name: '张三',
      attributes: ['人物'],
      chunkId: 'chunk-1',
    });
    // 重复写入：attributes/chunkIds 追加去重，节点仍唯一
    await repo.upsertEntity({
      kbId,
      name: '张三',
      attributes: ['人物', '技术专家'],
      chunkId: 'chunk-2',
    });
    await repo.upsertEntity({
      kbId,
      name: '张三',
      attributes: ['技术专家'],
      chunkId: 'chunk-2',
    });
    const result = await neo4j.run(
      `MATCH (e:Entity { kbId: $kbId, name: $name }) RETURN e`,
      { kbId, name: '张三' },
    );
    expect(result.records).toHaveLength(1);
    const props = result.records[0].get('e').properties;
    expect(props.attributes).toEqual(
      expect.arrayContaining(['人物', '技术专家']),
    );
    expect(props.attributes).toHaveLength(2);
    expect(props.chunkIds).toEqual(
      expect.arrayContaining(['chunk-1', 'chunk-2']),
    );
    expect(props.chunkIds).toHaveLength(2);
  });

  it('upsertRelationship 权重累加（同边两次 → weight=2 且边唯一）', async () => {
    await repo.upsertEntity({
      kbId,
      name: '李四',
      attributes: ['人物'],
      chunkId: 'chunk-1',
    });
    await repo.upsertRelationship({
      kbId,
      from: '张三',
      to: '李四',
      type: '同事',
      weight: 1,
      chunkId: 'chunk-1',
    });
    await repo.upsertRelationship({
      kbId,
      from: '张三',
      to: '李四',
      type: '同事',
      weight: 1,
      chunkId: 'chunk-2',
    });
    const result = await neo4j.run(
      `MATCH (a:Entity { kbId: $kbId, name: '张三' })-[r:RELATES_TO]->(b:Entity { kbId: $kbId, name: '李四' }) RETURN r`,
      { kbId },
    );
    expect(result.records).toHaveLength(1);
    const props = result.records[0].get('r').properties;
    expect(props.weight).toBe(2);
    expect(props.chunkIds).toEqual(
      expect.arrayContaining(['chunk-1', 'chunk-2']),
    );
    expect(props.chunkIds).toHaveLength(2);
  });

  it('upsertChunkMirror + 查询 chunk 节点', async () => {
    await repo.upsertChunkMirror({
      id: 'chunk-1',
      kbId,
      knowledgeId: kid1,
      content: '张三与李四共事',
    });
    await repo.upsertChunkMirror({
      id: 'chunk-2',
      kbId,
      knowledgeId: kid1,
      content: '张三是一名技术专家',
    });
    // 同 id 重复写入：content 更新且不重复节点
    await repo.upsertChunkMirror({
      id: 'chunk-1',
      kbId,
      knowledgeId: kid1,
      content: '张三与李四共事（更新）',
    });
    const result = await neo4j.run(
      `MATCH (c:Chunk { kbId: $kbId }) RETURN c.id AS id, c.content AS content ORDER BY c.id`,
      { kbId },
    );
    expect(result.records).toHaveLength(2);
    const byId = new Map(
      result.records.map((r) => [r.get('id'), r.get('content')]),
    );
    expect(byId.get('chunk-1')).toBe('张三与李四共事（更新）');
    expect(byId.get('chunk-2')).toBe('张三是一名技术专家');
  });

  it('getSubgraph 返回节点/边（含 degree）', async () => {
    // 孤立实体（无关系）：验证 degree=0 也参与返回
    await repo.upsertEntity({
      kbId,
      name: '王五',
      attributes: ['人物'],
      chunkId: 'chunk-2',
    });
    const sub = await repo.getSubgraph(kbId);
    const zhang = sub.nodes.find((n) => n.name === '张三');
    const wang = sub.nodes.find((n) => n.name === '王五');
    expect(zhang).toBeDefined();
    expect(zhang!.degree).toBe(1); // 张三→李四 一条边
    expect(wang!.degree).toBe(0);
    expect(sub.edges).toEqual([
      expect.objectContaining({
        source: '张三',
        target: '李四',
        type: '同事',
        weight: 2,
      }),
    ]);
  });

  it('searchEntities 模糊搜索（CONTAINS）', async () => {
    const exact = await repo.searchEntities(kbId, '张三');
    expect(exact.map((e) => e.name)).toEqual(['张三']);
    const fuzzy = await repo.searchEntities(kbId, '李');
    expect(fuzzy.map((e) => e.name)).toEqual(['李四']);
    // LIMIT 生效（空关键字命中全部，截断为 1）
    const limited = await repo.searchEntities(kbId, '', 1);
    expect(limited).toHaveLength(1);
  });

  it('getEntityDetail 返回关联实体与 chunk 列表', async () => {
    const detail = await repo.getEntityDetail(kbId, '张三');
    expect(detail).not.toBeNull();
    expect(detail!.name).toBe('张三');
    expect(detail!.chunkIds).toEqual(
      expect.arrayContaining(['chunk-1', 'chunk-2']),
    );
    // 一跳关联实体：含方向（张三→李四 为 out）
    expect(detail!.related).toEqual([
      expect.objectContaining({ name: '李四', type: '同事', direction: 'out' }),
    ]);
    // 关联 chunk 反查：含 knowledgeId 与内容（Task 3.3 反查文档用）
    expect(detail!.chunks.map((c) => c.id)).toEqual(
      expect.arrayContaining(['chunk-1', 'chunk-2']),
    );
    expect(detail!.chunks.find((c) => c.id === 'chunk-1')?.content).toBe(
      '张三与李四共事（更新）',
    );
    // 不存在的实体 → null
    expect(await repo.getEntityDetail(kbId, '不存在的实体')).toBeNull();
  });

  it('deleteKnowledgeSubgraph 移除该文档 chunk 关联（实体保留）', async () => {
    const kid2 = randomUUID();
    // 第二个文档的 chunk：与第一个文档共用实体（图谱是跨文档聚合）
    await repo.upsertChunkMirror({
      id: 'chunk-3',
      kbId,
      knowledgeId: kid2,
      content: '张三与王五合作',
    });
    await repo.upsertEntity({
      kbId,
      name: '张三',
      attributes: [],
      chunkId: 'chunk-3',
    });
    await repo.upsertRelationship({
      kbId,
      from: '张三',
      to: '王五',
      type: '合作',
      weight: 1,
      chunkId: 'chunk-3',
    });
    // 删除第一个文档的子图
    await repo.deleteKnowledgeSubgraph(kbId, kid1);
    // 1) chunk 镜像：kid1 的已删、kid2 的保留
    const chunkResult = await neo4j.run(
      `MATCH (c:Chunk { kbId: $kbId }) RETURN c.id AS id, c.knowledgeId AS kid ORDER BY c.id`,
      { kbId },
    );
    expect(
      chunkResult.records.map((r) => ({ id: r.get('id'), kid: r.get('kid') })),
    ).toEqual([{ id: 'chunk-3', kid: kid2 }]);
    // 2) 实体保留，且只移除 kid1 的 chunk 关联（张三仍有 kid2 的 chunk-3）
    const entityResult = await neo4j.run(
      `MATCH (e:Entity { kbId: $kbId, name: '张三' }) RETURN e.chunkIds AS ids`,
      { kbId },
    );
    expect(entityResult.records[0].get('ids')).toEqual(['chunk-3']);
    // 3) 同事边保留：chunkIds 清空但 weight 不变（决策：边是跨文档聚合，不随文档删除）
    const colleagueResult = await neo4j.run(
      `MATCH (a:Entity { kbId: $kbId, name: '张三' })-[r:RELATES_TO { type: '同事' }]->(b:Entity { kbId: $kbId, name: '李四' }) RETURN r.chunkIds AS ids, r.weight AS w`,
      { kbId },
    );
    expect(colleagueResult.records[0].get('ids')).toEqual([]);
    expect(colleagueResult.records[0].get('w')).toBe(2);
    // 4) 新边（合作）保留其 chunk 关联
    const coopResult = await neo4j.run(
      `MATCH (a:Entity { kbId: $kbId, name: '张三' })-[r:RELATES_TO { type: '合作' }]->(b:Entity { kbId: $kbId, name: '王五' }) RETURN r.chunkIds AS ids`,
      { kbId },
    );
    expect(coopResult.records[0].get('ids')).toEqual(['chunk-3']);
  });

  it('deleteKbSubgraph 清空该 KB 全部', async () => {
    await repo.deleteKbSubgraph(kbId);
    const result = await neo4j.run(
      `MATCH (n) WHERE n.kbId = $kbId RETURN count(n) AS total`,
      { kbId },
    );
    expect(result.records[0].get('total').toNumber()).toBe(0);
    // 边一并清空（DETACH DELETE 语义）
    const edgeResult = await neo4j.run(
      `MATCH ()-[r:RELATES_TO { kbId: $kbId }]->() RETURN count(r) AS total`,
      { kbId },
    );
    expect(edgeResult.records[0].get('total').toNumber()).toBe(0);
  });

  it('不同 kbId 的实体隔离（同 name 不同 kb 不冲突）', async () => {
    const otherKbId = randomUUID();
    isolatedKbIds.push(otherKbId);
    // 同 name 实体写两个 kb：唯一约束是 (name, kbId) 复合键，互不冲突
    await repo.upsertEntity({
      kbId,
      name: '张三',
      attributes: ['主库实体'],
      chunkId: 'c-main',
    });
    await repo.upsertEntity({
      kbId: otherKbId,
      name: '张三',
      attributes: ['跨库实体'],
      chunkId: 'c-other',
    });
    await repo.upsertChunkMirror({
      id: 'c-other',
      kbId: otherKbId,
      knowledgeId: kid1,
      content: '另一个知识库的分块',
    });
    const count = await neo4j.run(
      `MATCH (e:Entity) WHERE e.name = $name AND e.kbId IN $ids RETURN count(e) AS total`,
      { name: '张三', ids: [kbId, otherKbId] },
    );
    expect(count.records[0].get('total').toNumber()).toBe(2);
    // 子图按 kbId 隔离：otherKbId 的子图只含自己的节点（属性不串库）
    const sub = await repo.getSubgraph(otherKbId);
    expect(sub.nodes.map((n) => n.name)).toEqual(['张三']);
    expect(sub.nodes[0].attributes).toEqual(['跨库实体']);
  });

  it('upsertEntity 防御：既有实体 chunkIds/attributes 为 null 时初始化而非抹除', async () => {
    const nullKbId = randomUUID();
    isolatedKbIds.push(nullKbId);
    // 直接写一个 chunkIds/attributes 为 null 的实体（正常管线不产生，防御路径）：
    // 旧实现 `null + [$chunkId]` 在 Cypher 里恒为 null，会把列表静默抹成 null
    await neo4j.run(`CREATE (e:Entity { kbId: $kbId, name: '无列表实体' })`, {
      kbId: nullKbId,
    });
    await repo.upsertEntity({
      kbId: nullKbId,
      name: '无列表实体',
      attributes: ['人物'],
      chunkId: 'n1',
    });
    const result = await neo4j.run(
      `MATCH (e:Entity { kbId: $kbId, name: '无列表实体' }) RETURN e.attributes AS attrs, e.chunkIds AS ids`,
      { kbId: nullKbId },
    );
    expect(result.records[0].get('attrs')).toEqual(['人物']);
    expect(result.records[0].get('ids')).toEqual(['n1']);
  });

  it('upsertDocumentGraphInTx 批量写入（实体+边+chunk 镜像单事务，幂等）', async () => {
    const batchKbId = randomUUID();
    isolatedKbIds.push(batchKbId);
    const batchKid = randomUUID();
    await repo.upsertDocumentGraphInTx(batchKbId, batchKid, {
      entities: [
        { name: '批量实体A', attributes: ['人物'], chunkId: 'b-c1' },
        { name: '批量实体B', attributes: ['人物'], chunkId: 'b-c1' },
      ],
      relationships: [
        {
          from: '批量实体A',
          to: '批量实体B',
          type: '合作',
          weight: 2,
          chunkId: 'b-c1',
        },
      ],
      chunks: [{ id: 'b-c1', content: '批量文档分块' }],
    });
    // 全部写入成功
    const sub = await repo.getSubgraph(batchKbId);
    expect(sub.nodes.map((n) => n.name).sort()).toEqual([
      '批量实体A',
      '批量实体B',
    ]);
    expect(sub.edges).toEqual([
      expect.objectContaining({
        source: '批量实体A',
        target: '批量实体B',
        type: '合作',
        weight: 2,
      }),
    ]);
    const chunkRes = await neo4j.run(
      `MATCH (c:Chunk { kbId: $kbId, id: 'b-c1' }) RETURN c.knowledgeId AS kid, c.content AS content`,
      { kbId: batchKbId },
    );
    expect(chunkRes.records[0].get('kid')).toBe(batchKid);
    expect(chunkRes.records[0].get('content')).toBe('批量文档分块');
    // 幂等重复调用：实体/边不重复节点，weight 累加、chunkIds 追加去重、content 更新
    await repo.upsertDocumentGraphInTx(batchKbId, batchKid, {
      entities: [
        { name: '批量实体A', attributes: ['技术专家'], chunkId: 'b-c2' },
      ],
      relationships: [
        {
          from: '批量实体A',
          to: '批量实体B',
          type: '合作',
          weight: 1,
          chunkId: 'b-c2',
        },
      ],
      chunks: [{ id: 'b-c1', content: '批量文档分块（更新）' }],
    });
    const count = await neo4j.run(
      `MATCH (e:Entity { kbId: $kbId }) RETURN count(e) AS total`,
      { kbId: batchKbId },
    );
    expect(count.records[0].get('total').toNumber()).toBe(2);
    const edgeRes = await neo4j.run(
      `MATCH ()-[r:RELATES_TO { kbId: $kbId }]->() RETURN r.weight AS w`,
      { kbId: batchKbId },
    );
    expect(edgeRes.records[0].get('w')).toBe(3);
    const aProps = await neo4j.run(
      `MATCH (e:Entity { kbId: $kbId, name: '批量实体A' }) RETURN e.attributes AS attrs, e.chunkIds AS ids`,
      { kbId: batchKbId },
    );
    expect(aProps.records[0].get('attrs')).toEqual(['技术专家', '人物']); // 新属性在前 + 既有去重
    expect(aProps.records[0].get('ids')).toEqual(['b-c1', 'b-c2']);
  });

  it('upsertDocumentGraphInTx 原子性（任一边端点缺失 → 整体回滚不留半批）', async () => {
    const atomicKbId = randomUUID();
    isolatedKbIds.push(atomicKbId);
    await expect(
      repo.upsertDocumentGraphInTx(atomicKbId, randomUUID(), {
        entities: [{ name: '甲', attributes: [], chunkId: 'a-c1' }],
        relationships: [
          {
            from: '甲',
            to: '不存在的乙',
            type: '关联',
            weight: 1,
            chunkId: 'a-c1',
          },
        ],
        chunks: [{ id: 'a-c1', content: '原子性测试分块' }],
      }),
    ).rejects.toThrow(/端点实体不存在/);
    // 全部回滚：实体/边/chunk 镜像一个都不该留下（旧逐条 run() 会留半批）
    const result = await neo4j.run(
      `MATCH (n) WHERE n.kbId = $kbId RETURN count(n) AS total`,
      { kbId: atomicKbId },
    );
    expect(result.records[0].get('total').toNumber()).toBe(0);
  });

  it('getSubgraph 边数上限（稠密图超 EDGE_LIMIT_MAX 时截断）', async () => {
    // 3160 条边单事务批量写入在慢机/首次 Neo4j 事务下可能超 5s 默认超时——
    // 显式放宽到 60s（纯测试基建超时，非业务性能指标）
    // 可参考：真实抽取每文档数十条边，量级远小于此最坏场景。
    const denseKbId = randomUUID();
    isolatedKbIds.push(denseKbId);
    // 80 节点全连接 = 3160 条边 > EDGE_LIMIT_MAX(3000)：节点上限内的最坏稠密图
    const names = Array.from({ length: 80 }, (_, i) => `稠密节点${i}`);
    const relationships: Array<{
      from: string;
      to: string;
      type: string;
      weight: number;
      chunkId: string;
    }> = [];
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        relationships.push({
          from: names[i],
          to: names[j],
          type: '关联',
          weight: 1,
          chunkId: 'dense-c',
        });
      }
    }
    expect(relationships).toHaveLength(3160);
    await repo.upsertDocumentGraphInTx(denseKbId, randomUUID(), {
      entities: names.map((n) => ({
        name: n,
        attributes: [],
        chunkId: 'dense-c',
      })),
      relationships,
      chunks: [],
    });
    const sub = await repo.getSubgraph(denseKbId);
    expect(sub.nodes).toHaveLength(80);
    // 超限截断：边数 = 上限值（而非 3160 全量喂给可视化）
    expect(sub.edges.length).toBeLessThanOrEqual(3000);
    expect(sub.edges.length).toBe(3000);
  }, 60000);

  it('findChunkIdsForEntities 无命中 → []、多实体命中去重', async () => {
    const searchKbId = randomUUID();
    isolatedKbIds.push(searchKbId);
    await repo.upsertEntity({
      kbId: searchKbId,
      name: '甲',
      attributes: [],
      chunkId: 'k1',
    });
    await repo.upsertEntity({
      kbId: searchKbId,
      name: '甲',
      attributes: [],
      chunkId: 'k2',
    });
    await repo.upsertEntity({
      kbId: searchKbId,
      name: '乙',
      attributes: [],
      chunkId: 'k3',
    });
    // 无命中 → 空数组
    expect(await repo.findChunkIdsForEntities(searchKbId, ['丙'])).toEqual([]);
    // 空关键词列表 → 空数组（方法内短路，不发查询）
    expect(await repo.findChunkIdsForEntities(searchKbId, [])).toEqual([]);
    // 多实体命中 + 关键词重复：按节点匹配每个实体一行，chunkIds 合并去重
    const hits = await repo.findChunkIdsForEntities(searchKbId, [
      '甲',
      '甲',
      '乙',
    ]);
    expect(hits.map((h) => h.entity)).toEqual(['甲', '乙']);
    expect(hits.find((h) => h.entity === '甲')!.chunkIds).toEqual(['k1', 'k2']);
    expect(hits.find((h) => h.entity === '乙')!.chunkIds).toEqual(['k3']);
  });
});
