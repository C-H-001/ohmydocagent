// 知识图谱仓储（Task 3.1）：Neo4j 读写封装（约束初始化 + 实体/关系/chunk 镜像
// 的 Cypher 操作 + 子图/检索查询 + 幂等删除）。
//
// 安全约定（硬性要求）：全部 Cypher 使用参数化（$param），实体名/关系类型等
// 任何字符串值一律不拼接进查询文本——图谱查询的注入面与 SQL 同理，参数化是
// 唯一防线。唯一的例外是 LIMIT 参数需要显式 neo4j.int()（见下方注释）。
//
// 驱动整数语义（实测，neo4j-driver v6 + Neo4j 2025.10）：
// - JS number 参数会被驱动序列化为 Float（即使传 100 也是 100.0），因此
//   LIMIT $limit 必须传 neo4j.int() 的 Integer 对象，否则报
//   「LIMIT: Invalid input. '100.0' is not a valid value」；
// - 用 JS number 写入的属性读回是 JS number（Float 存储）；Cypher 聚合
//   （count 等）与字面量整数读回是 Integer 对象（有 toNumber()）——
//   toNumber() 辅助统一两种形态（见文件尾）。
//
// 并发约定（重要，Task 3.2 并行抽取的第一个踩坑点）：
// upsertRelationship / upsertDocumentGraphInTx 的 ON MATCH weight 累加
// （r.weight = r.weight + $weight）依赖单条 Cypher 语句原子执行（读时一致，
// 语句内不会读到中间态），但两个并发事务同时累加同一条边时仍存在
// 「读旧值-写新值」竞态，可能互相覆盖（丢一次累加）。当前约定：按 KB 串行化
// 抽取任务（每个 KB 同一时刻最多一个 GRAPH 写入任务）或失败重试；
// 若未来允许同 KB 并行写入，需改为 Cypher 显式事务（长事务行锁）或
// 「列表读改写」（先 MATCH 读出 weight，再 SET 计算后的新值）。
// 该约定在 graph.types.ts 的 UpsertRelationshipInput.weight 注释同步登记。
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import neo4j from 'neo4j-driver';
import { Neo4jService } from '../../neo4j/neo4j.service.js';
import type {
  DocumentGraphInput,
  EntityChunkHit,
  EntityDetail,
  EntitySearchResult,
  GraphNode,
  GraphStats,
  Subgraph,
  UpsertChunkMirrorInput,
  UpsertEntityInput,
  UpsertRelationshipInput,
} from './graph.types.js';

/** getSubgraph 默认/上限：P1 规模单 KB 实体数有限，100 已覆盖可视化预览 */
const SUBGRAPH_LIMIT_DEFAULT = 100;
const SUBGRAPH_LIMIT_MAX = 500;
/**
 * getSubgraph 边数上限（与 SUBGRAPH_LIMIT_MAX 配套）：节点上限 500 的稠密
 * hub 图全连接是 O(k²) ≈ 12.5 万行，可视化/序列化吃不消——边按 weight 降序
 * 截断到该值（节点截断在先，边截断兜底稠密图）。
 */
const EDGE_LIMIT_MAX = 3000;
/** searchEntities 默认/上限 */
const SEARCH_LIMIT_DEFAULT = 20;
const SEARCH_LIMIT_MAX = 100;

@Injectable()
export class GraphRepository implements OnApplicationBootstrap {
  private readonly logger = new Logger(GraphRepository.name);

  constructor(private readonly neo4j: Neo4jService) {}

  /**
   * 应用启动时幂等建约束（Task 3.2 质量审查整改——initSchema 接线到应用
   * 生命周期）：此前约束初始化只在 e2e 显式调用，真实部署启动不执行——
   * 无约束时 MERGE 幂等语义（(name,kbId)/(type,fromId,toId,kbId) 唯一性）
   * 失去 DB 层保障（并发/重试下可能堆节点/堆边）。挂在 onApplicationBootstrap
   * （AppModule imports GraphModule，模块加载即触发一次）。
   * best-effort 语义：Neo4j 不可用时记告警跳过、不阻断应用启动——与
   * ExtractProcessor 的「图谱缺失不影响文档可用」同决策（图谱非关键路径）；
   * 约束缺失仅影响图谱写入幂等保障，可后续重跑 initSchema 恢复（幂等
   * IF NOT EXISTS，见 initSchema 注释）。
   */
  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.initSchema();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Neo4j 图谱约束初始化失败（图谱写入降级，可重跑 initSchema 恢复）: ${message}`,
      );
    }
  }

  /**
   * 幂等建约束（Neo4j 2025 语法，已在 2025.10.1 community 实测）：
   * - Entity(name, kbId) 唯一：实体在 KB 内按名字唯一，跨 KB 同名互不冲突；
   * - RELATES_TO(type, fromId, toId, kbId) 唯一：同类型同向边唯一，
   *   重复写入走 MERGE 合并（weight 累加）而非堆边。
   * 约束名与「旧版 FOR (n:Entity) ASSERT ...」的差异：2025 版用
   * CREATE CONSTRAINT <name> IF NOT EXISTS FOR ... REQUIRE ... IS UNIQUE
   * （REQUIRE 取代 ASSERT，IF NOT EXISTS 位置在约束名后），已实测确认。
   * IF NOT EXISTS 保证重复执行不报错（幂等——应用启动时调用 + e2e 显式调用
   * 双保险，均安全）。
   */
  async initSchema(): Promise<void> {
    await this.neo4j.run(
      `CREATE CONSTRAINT entity_name_kb_unique IF NOT EXISTS
       FOR (n:Entity) REQUIRE (n.name, n.kbId) IS UNIQUE`,
    );
    await this.neo4j.run(
      `CREATE CONSTRAINT relates_to_unique IF NOT EXISTS
       FOR ()-[r:RELATES_TO]-() REQUIRE (r.type, r.fromId, r.toId, r.kbId) IS UNIQUE`,
    );
  }

  /**
   * upsert 实体：MERGE (kbId, name) ——唯一约束保证幂等（重复写入不堆节点）。
   * ON CREATE 全量初始化；ON MATCH 追加 attributes/chunkIds 并去重
   * （`[x IN $attributes WHERE NOT x IN e.attributes] + e.attributes`：
   * 纯 Cypher 去重，不依赖 APOC）。
   * null 守卫：e.chunkIds/e.attributes 为 null 时（正常管线不可达，防御外部
   * 写入/历史脏数据）先初始化——否则 `null + [$chunkId]` 在 Cypher 里恒为 null，
   * 会把列表静默抹成 null。
   */
  async upsertEntity(input: UpsertEntityInput): Promise<void> {
    const { kbId, name, attributes, chunkId } = input;
    await this.neo4j.run(
      `MERGE (e:Entity { kbId: $kbId, name: $name })
       ON CREATE SET e.attributes = $attributes, e.chunkIds = [$chunkId]
       ON MATCH SET e.attributes = CASE WHEN e.attributes IS NULL THEN $attributes
                                        ELSE [x IN $attributes WHERE NOT x IN e.attributes] + e.attributes END,
                    e.chunkIds = CASE WHEN e.chunkIds IS NULL THEN [$chunkId]
                                      WHEN $chunkId IN e.chunkIds THEN e.chunkIds
                                      ELSE e.chunkIds + [$chunkId] END`,
      { kbId, name, attributes, chunkId },
    );
  }

  /**
   * upsert 关系：边只连已存在的实体（前置 upsertEntity，Task 3.2 管线保证顺序）。
   * 用 MATCH 定位端点而非 MERGE 建实体——避免隐式创建「孤岛」实体；端点不存在时
   * MATCH 无行 → MERGE 不执行，此处显式抛错（防 Task 3.2 管线静默丢边）。
   * MERGE 边（type+fromId+toId+kbId 复合唯一，见 initSchema）：
   * ON CREATE 初始化 weight/chunkIds；ON MATCH weight 累加、chunkId 追加去重
   * （null 守卫：r.chunkIds 为 null 时先初始化，防 Cypher `null + [x]` 恒为 null 抹除）。
   * 并发约定（Task 3.2 并行抽取第一个踩坑点）：ON MATCH weight 累加依赖单条语句
   * 读时一致，并发同边写入可能互相覆盖——按 KB 串行化 GRAPH 任务或失败重试，
   * 未来并行需改显式事务/列表读改写（详见文件头「并发约定」）。
   * 参数名用 fromName/toName/relType（from/type 是 Cypher 关键字，规避歧义）。
   * 注意：MERGE 必须以 RETURN r 收尾——实测（Neo4j 2025.10 + driver v6）写子句
   * 结尾的查询 records 恒为空（即使建边成功，见 counters），无 RETURN 时
   * 「实体不存在」守卫无法区分成功/失败，会误报并让调用方以为边没建成。
   */
  async upsertRelationship(input: UpsertRelationshipInput): Promise<void> {
    const { kbId, from, to, type, weight, chunkId } = input;
    const result = await this.neo4j.run(
      `MATCH (a:Entity { kbId: $kbId, name: $fromName })
       MATCH (b:Entity { kbId: $kbId, name: $toName })
       MERGE (a)-[r:RELATES_TO { type: $relType, fromId: $fromName, toId: $toName, kbId: $kbId }]->(b)
       ON CREATE SET r.weight = $weight, r.chunkIds = [$chunkId]
       ON MATCH SET r.weight = r.weight + $weight,
                    r.chunkIds = CASE WHEN $chunkId IN r.chunkIds THEN r.chunkIds
                                      ELSE r.chunkIds + [$chunkId] END
       RETURN r`,
      { kbId, fromName: from, toName: to, relType: type, weight, chunkId },
    );
    if (result.records.length === 0) {
      throw new Error(
        `关系写入失败：实体不存在（${from} → ${to}，需先 upsertEntity）`,
      );
    }
  }

  /**
   * upsert chunk 镜像节点（轻量反查镜像，非分块本体）：MERGE (id, kbId)，
   * content 重复写入更新为最新值（文档重解析时镜像同步刷新）。
   */
  async upsertChunkMirror(input: UpsertChunkMirrorInput): Promise<void> {
    const { id, kbId, knowledgeId, content } = input;
    await this.neo4j.run(
      `MERGE (c:Chunk { id: $id, kbId: $kbId })
       ON CREATE SET c.knowledgeId = $knowledgeId, c.content = $content
       ON MATCH SET c.content = $content, c.knowledgeId = $knowledgeId`,
      { id, kbId, knowledgeId, content },
    );
  }

  /**
   * 单个文档的整图批量写入（Task 3.2 抽取处理器调用）：实体×N + 边×M +
   * chunk 镜像×K 在一个写事务内执行（Neo4jService.withWriteTransaction）——
   * 全成功或全回滚，杜绝逐条 run() 中途失败留部分写入（Task 3.2 前置要求）。
   * 幂等语义与单条 upsert 完全一致：实体 MERGE (kbId,name)、attributes/chunkIds
   * 追加去重（含 null 守卫）；边按 (type,fromId,toId,kbId) MERGE、weight 累加；
   * chunk 镜像 MERGE (id,kbId)、content 更新。
   * 并发约定同 upsertRelationship（ON MATCH weight 累加依赖读时一致），
   * 调用方须保证按 KB 串行化 GRAPH 写入或失败重试（见文件头「并发约定」）。
   * 端点守卫：关系行的端点须已存在（本批 entities 或既有实体）——UNWIND+MATCH
   * 对缺失端点静默丢行，用 RETURN count(*) 与入参行数比对，不一致即抛错回滚。
   * 空输入短路：三个数组全空时不开启事务（无语句可执行）。
   */
  async upsertDocumentGraphInTx(
    kbId: string,
    knowledgeId: string,
    input: DocumentGraphInput,
  ): Promise<void> {
    if (
      input.entities.length === 0 &&
      input.relationships.length === 0 &&
      input.chunks.length === 0
    ) {
      return;
    }
    await this.neo4j.withWriteTransaction(async (tx) => {
      // 1. 实体：UNWIND 批量 MERGE（null 守卫与单条 upsertEntity 同源）
      if (input.entities.length > 0) {
        await tx.run(
          `UNWIND $rows AS row
           MERGE (e:Entity { kbId: $kbId, name: row.name })
           ON CREATE SET e.attributes = row.attributes, e.chunkIds = [row.chunkId]
           ON MATCH SET e.attributes = CASE WHEN e.attributes IS NULL THEN row.attributes
                                            ELSE [x IN row.attributes WHERE NOT x IN e.attributes] + e.attributes END,
                        e.chunkIds = CASE WHEN e.chunkIds IS NULL THEN [row.chunkId]
                                          WHEN row.chunkId IN e.chunkIds THEN e.chunkIds
                                          ELSE e.chunkIds + [row.chunkId] END`,
          {
            kbId,
            rows: input.entities.map((e) => ({
              name: e.name,
              attributes: e.attributes,
              chunkId: e.chunkId,
            })),
          },
        );
      }
      // 2. 边：同事务上一步已写入本批实体，跨文档端点依赖既有实体
      if (input.relationships.length > 0) {
        const result = await tx.run(
          `UNWIND $rows AS row
           MATCH (a:Entity { kbId: $kbId, name: row.fromName })
           MATCH (b:Entity { kbId: $kbId, name: row.toName })
           MERGE (a)-[r:RELATES_TO { type: row.relType, fromId: row.fromName, toId: row.toName, kbId: $kbId }]->(b)
           ON CREATE SET r.weight = row.weight, r.chunkIds = [row.chunkId]
           ON MATCH SET r.weight = r.weight + row.weight,
                        r.chunkIds = CASE WHEN r.chunkIds IS NULL THEN [row.chunkId]
                                          WHEN row.chunkId IN r.chunkIds THEN r.chunkIds
                                          ELSE r.chunkIds + [row.chunkId] END
           RETURN count(*) AS matched`,
          {
            kbId,
            rows: input.relationships.map((r) => ({
              fromName: r.from,
              toName: r.to,
              relType: r.type,
              weight: r.weight,
              chunkId: r.chunkId,
            })),
          },
        );
        const matched = this.toNumber(result.records[0]?.get('matched'));
        if (matched < input.relationships.length) {
          throw new Error(
            `关系批量写入失败：${input.relationships.length - matched} 条边的端点实体不存在（需先写入实体）`,
          );
        }
      }
      // 3. chunk 镜像：knowledgeId 统一取方法入参（单文档单 knowledgeId）
      if (input.chunks.length > 0) {
        await tx.run(
          `UNWIND $rows AS row
           MERGE (c:Chunk { id: row.id, kbId: $kbId })
           ON CREATE SET c.knowledgeId = $knowledgeId, c.content = row.content
           ON MATCH SET c.content = row.content, c.knowledgeId = $knowledgeId`,
          {
            kbId,
            knowledgeId,
            rows: input.chunks.map((c) => ({ id: c.id, content: c.content })),
          },
        );
      }
    });
  }

  /**
   * 列出 KB 图谱的全部实体名（Task 3.2 跨文档关系端点判定用）：抽取服务
   * 的「本文档实体集合 ∪ 图谱既有实体」两段判定需要既有实体集合（见
   * graph-extraction.service.ts extractAll 注释）——关系端点若是历史文档
   * 抽取过的实体（本文档未出现），保留合法跨文档边。collect 恒返回一行，
   * 无实体时为 []。
   */
  async listEntityNames(kbId: string): Promise<string[]> {
    const result = await this.neo4j.run(
      `MATCH (e:Entity { kbId: $kbId }) RETURN collect(e.name) AS names`,
      { kbId },
    );
    return (result.records[0]?.get('names') as string[]) ?? [];
  }

  /**
   * 删除单个文档在 KB 图谱中的关联（文档删除时调用）。
   * 决策：实体/边保留——图谱是跨文档聚合结构，删文档只移除该文档的
   * chunk 关联（chunkIds 剔除 + 镜像节点删除），实体与边继续服务其它文档。
   * 四步走在一个显式事务里（beginTransaction/commit，失败回滚）保证原子性：
   * chunk 镜像节点是该文档 chunk id 的唯一事实来源（先收集再剔除）。
   */
  async deleteKnowledgeSubgraph(
    kbId: string,
    knowledgeId: string,
  ): Promise<void> {
    const session = this.neo4j.getSession();
    const tx = session.beginTransaction();
    try {
      // 1. 收集该文档的全部 chunk id（聚合查询恒返回一行，无 chunk 时为空数组）
      const idResult = await tx.run(
        `MATCH (c:Chunk { kbId: $kbId, knowledgeId: $knowledgeId })
         RETURN collect(c.id) AS ids`,
        { kbId, knowledgeId },
      );
      const ids = (idResult.records[0]?.get('ids') as string[]) ?? [];
      if (ids.length > 0) {
        // 2. 实体中剔除该文档的 chunk 关联（any() 谓词对 null chunkIds 天然安全：
        //    `x IN null` 为 null → 不命中，不会对缺失属性 SET 报错）
        await tx.run(
          `MATCH (e:Entity { kbId: $kbId })
           WHERE any(x IN $ids WHERE x IN e.chunkIds)
           SET e.chunkIds = [x IN e.chunkIds WHERE NOT x IN $ids]`,
          { kbId, ids },
        );
        // 3. 边中剔除该文档的 chunk 关联（边保留，weight 不重算——设计决策；
        //    TODO(P3 权重细化)：reparse 反复触发同边 weight 单调累加（共现计数
        //    随重解析轮数膨胀，与真实共现次数漂移），P3 引入统计显著性（PMI）/距
        //    离衰减或按文档重算 weight 时，在此补充 weight 重算语义，见
        //    graph-extraction.service.ts 文件头「权重」注释）
        await tx.run(
          `MATCH (a:Entity { kbId: $kbId })-[r:RELATES_TO]->(b:Entity { kbId: $kbId })
           WHERE any(x IN $ids WHERE x IN r.chunkIds)
           SET r.chunkIds = [x IN r.chunkIds WHERE NOT x IN $ids]`,
          { kbId, ids },
        );
      }
      // 4. 删除该文档的 chunk 镜像节点
      await tx.run(
        `MATCH (c:Chunk { kbId: $kbId, knowledgeId: $knowledgeId }) DELETE c`,
        { kbId, knowledgeId },
      );
      await tx.commit();
    } catch (err) {
      await tx.rollback().catch(() => undefined);
      throw err;
    } finally {
      await session.close();
    }
  }

  /**
   * 删除整个 KB 的图谱数据（KB 删除时调用）：DETACH DELETE 同时清掉
   * 实体/边/chunk 镜像（节点删除连带删除其全部边）。
   */
  async deleteKbSubgraph(kbId: string): Promise<void> {
    await this.neo4j.run(`MATCH (n) WHERE n.kbId = $kbId DETACH DELETE n`, {
      kbId,
    });
  }

  /**
   * 取 KB 子图（Task 3.3 可视化数据源）：先按 degree 降序取前 N 个节点，
   * 边只返回这些节点之间的（避免返回与截断节点相连的悬空边）。degree 用
   * OPTIONAL MATCH + count(r)（无边的实体 degree=0，仍参与返回）。
   * 边数截断：稠密 hub 图节点间全连接是 O(k²)（500 节点最坏 12.5 万行），
   * 可视化吃不消——按 weight 降序 LIMIT EDGE_LIMIT_MAX（见常量注释）。
   * 节点 id 即 name（实体在 kbId 内的唯一标识，见 initSchema 注释）。
   */
  async getSubgraph(
    kbId: string,
    limit = SUBGRAPH_LIMIT_DEFAULT,
  ): Promise<Subgraph> {
    // limit 防御（服务层兜底，与 VectorService.hybridSearch 的 topK 归一化同思路）：
    // 收敛为 [1, SUBGRAPH_LIMIT_MAX] 内整数，防负数/NaN/小数进 LIMIT
    const k = Math.min(
      Math.max(
        Number.isFinite(limit) ? Math.floor(limit) : SUBGRAPH_LIMIT_DEFAULT,
        1,
      ),
      SUBGRAPH_LIMIT_MAX,
    );
    const nodeResult = await this.neo4j.run(
      `MATCH (e:Entity { kbId: $kbId })
       OPTIONAL MATCH (e)-[r:RELATES_TO]-()
       WITH e, count(r) AS degree
       ORDER BY degree DESC, e.name
       LIMIT $limit
       RETURN e.name AS name, e.attributes AS attributes, e.chunkIds AS chunkIds, degree`,
      // LIMIT 必须传 Integer（JS number 会被驱动序列化为 Float 导致报错，见文件头注释）
      { kbId, limit: neo4j.int(k) },
    );
    const nodes: GraphNode[] = nodeResult.records.map((rec) => {
      const name = rec.get('name') as string;
      return {
        id: name,
        name,
        attributes: (rec.get('attributes') as string[]) ?? [],
        chunkIds: (rec.get('chunkIds') as string[]) ?? [],
        degree: this.toNumber(rec.get('degree')),
      };
    });
    if (nodes.length === 0) return { nodes: [], edges: [] };
    const names = nodes.map((n) => n.name);
    const edgeResult = await this.neo4j.run(
      `MATCH (a:Entity { kbId: $kbId })-[r:RELATES_TO]->(b:Entity { kbId: $kbId })
       WHERE a.name IN $names AND b.name IN $names
       RETURN a.name AS source, b.name AS target, r.type AS type, r.weight AS weight
       ORDER BY r.weight DESC
       LIMIT $edgeLimit`,
      // LIMIT 必须传 Integer（JS number 会被驱动序列化为 Float，见文件头注释）
      { kbId, names, edgeLimit: neo4j.int(EDGE_LIMIT_MAX) },
    );
    return {
      nodes,
      edges: edgeResult.records.map((rec) => ({
        source: rec.get('source') as string,
        target: rec.get('target') as string,
        type: rec.get('type') as string,
        weight: this.toNumber(rec.get('weight')),
      })),
    };
  }

  /**
   * 实体名模糊搜索（前缀/包含）：toLower 双向归一化后 CONTAINS（中文无大小写
   * 概念，toLower 对英文名友好）。LIMIT 传 Integer（见 getSubgraph 注释）。
   * TODO(全文索引)：实体量大时 CONTAINS 是逐节点全表扫描，无法走索引；后续可
   * 换 Neo4j 全文索引（db.index.fulltext.queryNodes 建实体名索引）做模糊检索。
   */
  async searchEntities(
    kbId: string,
    keyword: string,
    limit = SEARCH_LIMIT_DEFAULT,
  ): Promise<EntitySearchResult[]> {
    const k = Math.min(
      Math.max(
        Number.isFinite(limit) ? Math.floor(limit) : SEARCH_LIMIT_DEFAULT,
        1,
      ),
      SEARCH_LIMIT_MAX,
    );
    const result = await this.neo4j.run(
      `MATCH (e:Entity { kbId: $kbId })
       WHERE toLower(e.name) CONTAINS toLower($keyword)
       RETURN e.name AS name, e.attributes AS attributes, e.chunkIds AS chunkIds
       ORDER BY e.name
       LIMIT $limit`,
      { kbId, keyword, limit: neo4j.int(k) },
    );
    return result.records.map((rec) => ({
      name: rec.get('name') as string,
      attributes: (rec.get('attributes') as string[]) ?? [],
      chunkIds: (rec.get('chunkIds') as string[]) ?? [],
    }));
  }

  /**
   * 实体详情：自身属性 + 一跳关联实体（含方向）+ 关联 chunk 列表
   * （chunk 镜像反查：id/knowledgeId/content，Task 3.3 反查文档用）。
   * 实体不存在 → null。
   * 实现要点：collect(DISTINCT CASE WHEN n IS NULL THEN null ELSE {...} END)
   * ——OPTIONAL MATCH 未命中时投影全 null，CASE 转 null 后 collect 自动丢弃
   * null 元素，避免 related/chunks 混入 {name: null, ...} 脏项。
   * 自环排除（WHERE n <> e）：抽取管线理论不产生自环（防御性）——
   * 若出现 from=to 的边，related 里不该把自己列成关联实体。
   */
  async getEntityDetail(
    kbId: string,
    name: string,
  ): Promise<EntityDetail | null> {
    const result = await this.neo4j.run(
      `MATCH (e:Entity { kbId: $kbId, name: $name })
       OPTIONAL MATCH (e)-[r:RELATES_TO]-(n:Entity { kbId: $kbId })
       WHERE n <> e
       WITH e, collect(DISTINCT CASE WHEN n IS NULL THEN null
                                     ELSE { name: n.name, type: r.type, weight: r.weight,
                                            direction: CASE WHEN startNode(r) = e THEN 'out' ELSE 'in' END } END) AS related
       OPTIONAL MATCH (c:Chunk { kbId: $kbId })
       WHERE c.id IN e.chunkIds
       RETURN e.name AS name, e.attributes AS attributes, e.chunkIds AS chunkIds,
              related,
              collect(DISTINCT CASE WHEN c IS NULL THEN null
                                    ELSE { id: c.id, knowledgeId: c.knowledgeId, content: c.content } END) AS chunks`,
      { kbId, name },
    );
    if (result.records.length === 0) return null;
    const rec = result.records[0];
    const related = (rec.get('related') as Array<Record<string, unknown>>).map(
      (m) => ({
        name: m.name as string,
        type: m.type as string,
        weight: this.toNumber(m.weight),
        direction: m.direction as 'out' | 'in',
      }),
    );
    return {
      name: rec.get('name') as string,
      attributes: (rec.get('attributes') as string[]) ?? [],
      chunkIds: (rec.get('chunkIds') as string[]) ?? [],
      related,
      chunks: rec.get('chunks') as EntityDetail['chunks'],
    };
  }

  /**
   * 实体命中 → chunkIds（Task 3.4 图谱增强检索）：按实体名精确匹配
   * （LLM 抽取的实体名即查询键），返回命中实体的全部来源 chunk。
   */
  /**
   * 图谱召回查询（GraphRAG，参考 WeKnora SearchNode）：
   * `n.name CONTAINS 任一 query 实体词` 命中实体 → 一跳邻居（边连接）→
   * 返回命中实体 + 邻居的 name/chunkIds + 关系描述。一次 Cypher 聚合，
   * 供 GraphSearchService.graphRetrieve 组装召回结果（融合 + 实体上下文）。
   */
  async searchEntitiesWithNeighbors(
    kbId: string,
    keywords: string[],
    limit = 10,
  ): Promise<
    {
      entity: string;
      chunkIds: string[];
      neighbors: { name: string; chunkIds: string[]; relationType: string }[];
    }[]
  > {
    if (keywords.length === 0) return [];
    const result = await this.neo4j.run(
      `MATCH (e:Entity { kbId: $kbId })
       WHERE ANY(kw IN $keywords WHERE toLower(e.name) CONTAINS toLower(kw))
       OPTIONAL MATCH (e)-[r:RELATES_TO]-(n2:Entity { kbId: $kbId })
       WHERE n2 <> e
       WITH e, collect(DISTINCT CASE WHEN n2 IS NULL THEN null
                                    ELSE { name: n2.name, chunkIds: n2.chunkIds, relationType: r.type } END) AS neighbors
       RETURN e.name AS name, e.chunkIds AS chunkIds, neighbors
       ORDER BY e.name
       LIMIT $limit`,
      { kbId, keywords, limit: neo4j.int(limit) },
    );
    return result.records.map((rec) => ({
      entity: rec.get('name') as string,
      chunkIds: ((rec.get('chunkIds') as string[]) ?? []).filter(Boolean),
      neighbors: ((rec.get('neighbors') as unknown[]) ?? [])
        .filter((n) => n && typeof n === 'object')
        .map((n) => ({
          name: (n as { name: string }).name,
          chunkIds: ((n as { chunkIds?: string[] }).chunkIds ?? []).filter(Boolean),
          relationType: (n as { relationType: string }).relationType,
        })),
    }));
  }

  async findChunkIdsForEntities(
    kbId: string,
    keywords: string[],
  ): Promise<EntityChunkHit[]> {
    if (keywords.length === 0) return [];
    const result = await this.neo4j.run(
      `MATCH (e:Entity { kbId: $kbId })
       WHERE e.name IN $keywords
       RETURN e.name AS name, e.chunkIds AS chunkIds`,
      { kbId, keywords },
    );
    return result.records.map((rec) => ({
      entity: rec.get('name') as string,
      chunkIds: (rec.get('chunkIds') as string[]) ?? [],
    }));
  }

  /**
   * 图谱覆盖统计（Task 3.3 覆盖统计 API）：实体数/边数/chunk 镜像数 + 有实体
   * 关联的文档数（coveredKnowledge）。四条计数并行查询（互不依赖）。
   * coveredKnowledge 口径：实体 chunkIds 引用的 chunk → chunk 镜像的
   * knowledgeId 去重计数——「图谱有实体关联的文档数」。无实体引用的文档
   * （如空抽取文档——镜像照常写入但实体不引用其 chunk，见 graph-api.e2e-spec.ts
   * 覆盖统计用例）不计入覆盖；UNWIND 对 chunkIds 为 null/空的实体产出 0 行
   * （null 被 MATCH 过滤、空数组无行），天然安全不参与计数。
   * 口径差异说明：不用「chunk 镜像的 knowledgeId 去重」做覆盖——那会把
   * 无实体的文档也计为覆盖（镜像与实体无关，恒写入），与「有实体关联」
   * 的语义不符，见 graph-extraction.service.ts extractAll 注释（chunks 透传）。
   */
  async getKbGraphStats(kbId: string): Promise<GraphStats> {
    const [entityResult, relResult, chunkResult, coveredResult] =
      await Promise.all([
        this.neo4j.run(
          `MATCH (e:Entity { kbId: $kbId }) RETURN count(e) AS total`,
          { kbId },
        ),
        this.neo4j.run(
          `MATCH ()-[r:RELATES_TO { kbId: $kbId }]->() RETURN count(r) AS total`,
          { kbId },
        ),
        this.neo4j.run(
          `MATCH (c:Chunk { kbId: $kbId }) RETURN count(c) AS total`,
          { kbId },
        ),
        // 有实体关联的文档数：实体 chunkIds → chunk 镜像 → knowledgeId 去重。
        // UNWIND 对 null chunkIds 产出 null 行、对空数组产出 0 行——都
        // 不贡献计数（null 由 MATCH 过滤，见方法头注释）
        this.neo4j.run(
          `MATCH (e:Entity { kbId: $kbId })
           UNWIND e.chunkIds AS cid
           MATCH (c:Chunk { kbId: $kbId, id: cid })
           RETURN count(DISTINCT c.knowledgeId) AS total`,
          { kbId },
        ),
      ]);
    return {
      coveredKnowledge: this.toNumber(coveredResult.records[0]?.get('total')),
      entities: this.toNumber(entityResult.records[0]?.get('total')),
      relationships: this.toNumber(relResult.records[0]?.get('total')),
      chunks: this.toNumber(chunkResult.records[0]?.get('total')),
    };
  }

  /**
   * 数值归一化：Cypher 聚合/字面量整数读回是 driver 的 Integer 对象
   * （有 toNumber()），JS number 写入的属性读回是普通 number（Float 存储）——
   * 两种形态统一转 JS number（见文件头「驱动整数语义」注释）。
   */
  private toNumber(value: unknown): number {
    if (value === null || value === undefined) return 0;
    if (typeof value === 'number') return value;
    const maybeInteger = value as { toNumber?: () => number };
    if (typeof maybeInteger.toNumber === 'function') {
      return maybeInteger.toNumber();
    }
    return Number(value);
  }
}
