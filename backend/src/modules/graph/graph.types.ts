// 知识图谱仓储类型定义（Task 3.1）：GraphRepository 的输入/输出结构。
// 图模型（参考 WeKnora graph.go，存 Neo4j）：
// - (:Entity { kbId, name, attributes: [string], chunkIds: [string] })
//   ——LLM 抽取的实体节点（Task 3.2 写入），kbId+name 复合唯一（见 initSchema 约束）；
// - (:Chunk { id, kbId, knowledgeId, content })——分块镜像节点（轻量，供反查）；
// - (:Entity)-[:RELATES_TO { type, fromId, toId, kbId, weight, chunkIds }]->(:Entity)
//   ——实体关系，type+fromId+toId+kbId 复合唯一，weight 随重复写入累加。
//   fromId/toId 冗余存端点名（Neo4j 关系无列名，唯一约束键/删除定位直接按属性
//   匹配，查询端点仍用 startNode()/endNode()）；副作用：不支持实体重命名
//   （重命名需同步改写所有关联边的 fromId/toId，当前不做该能力）。

/** upsertEntity 入参：attributes/chunkId 均为追加合并语义（重复项去重） */
export interface UpsertEntityInput {
  kbId: string;
  name: string;
  /** 实体属性（如「人物」「技术专家」），追加去重 */
  attributes: string[];
  /** 来源 chunk id：追加到实体的 chunkIds（去重） */
  chunkId: string;
}

/** upsertRelationship 入参：同边重复写入时 weight 累加、chunkId 追加去重 */
export interface UpsertRelationshipInput {
  kbId: string;
  /** 起始实体名（须已存在，见仓储方法注释） */
  from: string;
  /** 目标实体名（须已存在） */
  to: string;
  /** 关系类型（如「同事」「合作」） */
  type: string;
  /**
   * 本次贡献的权重（累加到边上的 weight）。
   * 并发约定（与 graph.repository.ts 文件头同步登记）：ON MATCH weight 累加
   * （r.weight = r.weight + $weight）依赖单条 Cypher 语句读时一致，两个并发
   * 事务同边累加可能互相覆盖（丢一次累加）——按 KB 串行化 GRAPH 任务
   * （每 KB 同时一个写入任务）或失败重试；未来并行需改显式事务/列表读改写。
   */
  weight: number;
  chunkId: string;
}

/** upsertChunkMirror 入参：content 重复写入时更新为最新值 */
export interface UpsertChunkMirrorInput {
  id: string;
  kbId: string;
  knowledgeId: string;
  content: string;
}

/** getSubgraph 的节点：id 即实体名（实体在 kbId 内的唯一标识，见 initSchema 约束） */
export interface GraphNode {
  /** 节点标识（= name，供可视化组件当 key 用） */
  id: string;
  name: string;
  attributes: string[];
  chunkIds: string[];
  /** 关联边数（含出入向） */
  degree: number;
}

/** getSubgraph 的边 */
export interface GraphEdge {
  source: string;
  target: string;
  type: string;
  weight: number;
}

/** getSubgraph 返回值（Task 3.3 可视化数据源） */
export interface Subgraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** searchEntities 命中项 */
export interface EntitySearchResult {
  name: string;
  attributes: string[];
  chunkIds: string[];
}

/** getEntityDetail 的一跳关联实体 */
export interface RelatedEntity {
  name: string;
  type: string;
  weight: number;
  /** out = 实体指向对方；in = 对方指向实体（无向语义下的方向标记） */
  direction: 'out' | 'in';
}

/** getEntityDetail 的关联 chunk（反查文档用：含 knowledgeId 可定位文档） */
export interface EntityChunkRef {
  id: string;
  knowledgeId: string;
  content: string;
}

/** getEntityDetail 返回值；实体不存在时为 null */
export interface EntityDetail {
  name: string;
  attributes: string[];
  chunkIds: string[];
  related: RelatedEntity[];
  chunks: EntityChunkRef[];
}

/** getKbGraphStats 返回值（Task 3.3 覆盖统计 API） */
export interface GraphStats {
  /** 图谱有实体关联的文档数（实体 chunkIds → chunk 镜像 knowledgeId 去重） */
  coveredKnowledge: number;
  /** 实体节点数 */
  entities: number;
  /** 关系边数 */
  relationships: number;
  /** chunk 镜像节点数 */
  chunks: number;
}

/** findChunkIdsForEntities 命中项（Task 3.4 图谱增强检索用） */
export interface EntityChunkHit {
  entity: string;
  chunkIds: string[];
}

/**
 * 图谱召回结果（GraphRAG，Task: 参考 WeKnora ENTITY_SEARCH）：
 * query 实体词 CONTAINS 命中实体 + 一跳邻居 + 关系，聚合各自关联 chunk。
 * 用于召回管线融合（图谱命中 chunk 与向量/关键词结果 RRF 融合）与
 * 实体上下文注入（entityContext 供 LLM 理解实体关系语义）。
 */
export interface GraphRetrieveResult {
  /** 命中的实体名（query 实体词 CONTAINS 匹配） */
  hitEntities: string[];
  /** 一跳关联实体名（命中实体的邻居） */
  relatedEntities: string[];
  /** 实体关系描述（`实体A -[类型]-> 实体B`，供 LLM 上下文注入） */
  relations: string[];
  /** 命中 + 邻居实体关联的 chunk id（去重） */
  chunkIds: string[];
  /** 实体上下文文本（供 generate 阶段注入系统提示） */
  entityContext: string;
}

/**
 * upsertDocumentGraphInTx 入参：单个文档的整图批量写入（Task 3.2 抽取处理器
 * 调用，单事务全成功或全回滚）。kbId/knowledgeId 由方法入参统一提供
 * （单文档单 KB 单 knowledgeId），这里只给行数据（去掉 Upsert*Input 里
 * 冗余的 kbId/knowledgeId）。
 */
export interface DocumentGraphInput {
  /** 实体行：与 upsertEntity 同语义（MERGE 幂等、attributes/chunkIds 追加去重） */
  entities: Array<Omit<UpsertEntityInput, 'kbId'>>;
  /** 关系行：端点须已存在（本批 entities 或既有实体），缺失则抛错整体回滚 */
  relationships: Array<Omit<UpsertRelationshipInput, 'kbId'>>;
  /** chunk 镜像行：knowledgeId 取方法入参，重复写入 content 更新 */
  chunks: Array<Omit<UpsertChunkMirrorInput, 'kbId' | 'knowledgeId'>>;
}
