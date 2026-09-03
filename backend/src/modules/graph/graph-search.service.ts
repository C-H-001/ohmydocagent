// graph-search.service.ts
// 图谱召回服务（GraphRAG，Task: 参考 WeKnora chat_pipeline ENTITY_SEARCH）：
// query 实体词 → 知识图谱 CONTAINS 命中实体 → 一跳邻居扩展 → 聚合关联 chunk
// （召回来源）+ 实体关系上下文（注入 LLM 的实体语义）。
//
// 与 Task 3.4 简化版（仅补充候选）的区别：本服务产出**完整召回路**——
//   GraphRetrieveResult：hitEntities/relatedEntities/relations/entityContext，
//   KbSearchTool 将其与向量/关键词路做 RRF 融合（见 kb-search.tool 集成注释）。
//
// 参考 WeKnora SearchNode 语义（不照搬）：
//   Cypher: MATCH (n)-[r]-(m) WHERE ANY(kw IN $kws WHERE n.name CONTAINS kw)
//   ——命中实体 + 一跳邻居 + 关系；实体匹配用 CONTAINS 子串（对中文实体
//   词更宽容）；邻居扩展让「间接关联」也能召回。
import { Injectable } from '@nestjs/common';
import { GraphRepository } from './graph.repository.js';
import type { GraphRetrieveResult } from './graph.types.js';

/** 单次查询参与实体匹配的分词数量上限（前 N 个非空 token，控制 Neo4j 查询数） */
const MAX_ENTITY_KEYWORDS = 3;
/** 每 KB 图谱召回节点上限（命中 + 邻居，防大图拖慢查询） */
const GRAPH_RETRIEVE_LIMIT = 10;

@Injectable()
export class GraphSearchService {
  constructor(private readonly graphRepository: GraphRepository) {}

  /**
   * 图谱召回：query 分词 → 各 KB CONTAINS 命中实体 + 一跳邻居 → 聚合
   *   - chunkIds：命中 + 邻居实体关联的 chunk（召回来源，与向量/关键词融合）
   *   - entityContext：`实体A -[类型]-> 实体B` 描述（供 generate 注入）
   * 无命中/图不可用 → 空结果（静默降级，调用方走普通检索）。
   */
  async graphRetrieve(query: string, kbIds: string[]): Promise<GraphRetrieveResult> {
    const empty: GraphRetrieveResult = {
      hitEntities: [],
      relatedEntities: [],
      relations: [],
      chunkIds: [],
      entityContext: '',
    };
    if (!query.trim() || kbIds.length === 0) return empty;

    const keywords = query
      .split(/[\s,，。;；:：!！?？、]+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 0)
      .slice(0, MAX_ENTITY_KEYWORDS);
    if (keywords.length === 0) return empty;

    const hitEntities = new Set<string>();
    const relatedEntities = new Set<string>();
    const relations = new Set<string>();
    const chunkIds = new Set<string>();

    for (const kbId of kbIds) {
      let rows: Awaited<ReturnType<typeof this.graphRepository.searchEntitiesWithNeighbors>>;
      try {
        rows = await this.graphRepository.searchEntitiesWithNeighbors(
          kbId,
          keywords,
          GRAPH_RETRIEVE_LIMIT,
        );
      } catch (err) {
        // 图查询失败：静默降级（图谱召回非关键路径，检索继续）
        continue;
      }
      for (const row of rows) {
        hitEntities.add(row.entity);
        for (const cid of row.chunkIds) chunkIds.add(cid);
        // 一跳邻居：邻居实体的 chunk 也进召回（WeKnora 沿边扩展语义）
        for (const nb of row.neighbors) {
          relatedEntities.add(nb.name);
          for (const cid of nb.chunkIds) chunkIds.add(cid);
          relations.add(`${row.entity} -[${nb.relationType}]-> ${nb.name}`);
        }
      }
    }

    const hitList = [...hitEntities];
    const relList = [...relations];
    // 实体上下文：命中实体 + 关系描述（供 LLM 理解实体语义，GraphRAG 核心）
    const entityContext =
      hitList.length > 0
        ? [
            `知识图谱实体：${hitList.join('、')}`,
            ...(relList.length > 0 ? [`实体关系：${relList.join('；')}`] : []),
          ].join('。')
        : '';

    return {
      hitEntities: hitList,
      relatedEntities: [...relatedEntities],
      relations: relList,
      chunkIds: [...chunkIds],
      entityContext,
    };
  }

  /** 兼容旧调用（Task 3.4 expand）——直接命中实体 chunk（不含邻居/上下文） */
  /**
   * 实体名精确检索（查询实体抽取接入：LLM 从问题抽出的实体名 → 图谱 CONTAINS
   * 匹配 + 一跳邻居，比 query 切词更精准——「量子计算是什么」切词含「什么」，
   * 实体检索只拿「量子计算」）。无实体命中 → 空结果（调用方回退 query 切词）。
   */
  async graphRetrieveByEntities(
    entityNames: string[],
    kbIds: string[],
  ): Promise<GraphRetrieveResult> {
    const empty: GraphRetrieveResult = {
      hitEntities: [],
      relatedEntities: [],
      relations: [],
      chunkIds: [],
      entityContext: '',
    };
    const names = (entityNames ?? [])
      .map((n) => n.trim())
      .filter((n) => n.length > 0)
      .slice(0, MAX_ENTITY_KEYWORDS);
    if (names.length === 0 || kbIds.length === 0) return empty;

    const hitEntities = new Set<string>();
    const relatedEntities = new Set<string>();
    const relations = new Set<string>();
    const chunkIds = new Set<string>();

    for (const kbId of kbIds) {
      let rows: Awaited<ReturnType<typeof this.graphRepository.searchEntitiesWithNeighbors>>;
      try {
        rows = await this.graphRepository.searchEntitiesWithNeighbors(
          kbId,
          names,
          GRAPH_RETRIEVE_LIMIT,
        );
      } catch (err) {
        continue;
      }
      for (const row of rows) {
        hitEntities.add(row.entity);
        for (const cid of row.chunkIds) chunkIds.add(cid);
        for (const nb of row.neighbors) {
          relatedEntities.add(nb.name);
          for (const cid of nb.chunkIds) chunkIds.add(cid);
          relations.add(`${row.entity} -[${nb.relationType}]-> ${nb.name}`);
        }
      }
    }

    const hitList = [...hitEntities];
    const relList = [...relations];
    const entityContext =
      hitList.length > 0
        ? [
            `知识图谱实体：${hitList.join('、')}`,
            ...(relList.length > 0 ? [`实体关系：${relList.join('；')}`] : []),
          ].join('。')
        : '';
    return {
      hitEntities: hitList,
      relatedEntities: [...relatedEntities],
      relations: relList,
      chunkIds: [...chunkIds],
      entityContext,
    };
  }

  async expand(query: string, kbIds: string[]): Promise<{ hitEntities: string[]; chunkIds: string[] }> {
    const r = await this.graphRetrieve(query, kbIds);
    return { hitEntities: r.hitEntities, chunkIds: r.chunkIds };
  }
}
