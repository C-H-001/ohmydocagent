// 图谱 API 服务（Task 3.3）：GraphRepository（Neo4j 查询）之上的装配层——
// 可视化数据（size = degree）、实体搜索、实体详情（含跨库反查文档）、覆盖统计。
//
// 跨库装配（核心能力）：实体/关系/反查引用存 Neo4j（GraphRepository），
// knowledge 标题与 chunk 内容存 PG——反查文档 = Neo4j chunk 引用（含
// knowledgeId）→ 批量补查 PG knowledge（标题）+ PG chunks（片段内容）。
// 片段取每文档 chunk 内容前 2 条（按 chunkIndex 升序）——PG chunks 是内容
// 事实来源（Task 1.9 分块编辑后 Neo4j 镜像可能陈旧，反查片段取 PG 最新内容）。
//
// 删除残留语义（跨库不一致的既定处理）：Task 3.2 已接线文档删除清理
// （KnowledgeService.remove → GraphRepository.deleteKnowledgeSubgraph），
// 但历史孤儿仍可能——存量脏数据/删除竞态窗口（毫秒级，见 extract.processor.ts
// 注释）下，Neo4j chunk 引用指向的 PG knowledge/chunks 行可能已不存在。
// 装配时查不到的行跳过（不报错、不返回空壳条目）——反查是展示语义，孤儿
// 条目没有可展示的标题/片段，跳过是安全降级（与 ExtractProcessor 的
// 「图谱缺失不影响文档可用」同决策哲学：图谱非关键路径）。
//
// 404/空语义（全部接口统一）：
// - KB 不存在（含非 UUID 撞 PG 22P02）→ 404（ensureKbExists，直查
//   knowledge_bases，与 KnowledgeService.ensureKbExists 同款）；
// - KB 存在但无图谱 → 可视化返回 { nodes: [], edges: [] }（不报错）；
// - 实体不存在 → 404（getEntityDetail 仓储返回 null 时抛出）；
// - 搜索无结果 → []（不报错）。
import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import { Chunk } from '../chunk/chunk.entity.js';
import { KnowledgeBase } from '../kb/kb.entity.js';
import { Knowledge } from '../knowledge/knowledge.entity.js';
import { GraphRepository } from './graph.repository.js';
import type {
  EntityChunkRef,
  EntitySearchResult,
  GraphEdge,
  RelatedEntity,
} from './graph.types.js';

/** 可视化节点（GraphNode 的 API 形态）：size = degree（前端节点大小） */
export interface GraphVisualizationNode {
  id: string;
  name: string;
  /** 节点大小 = 关联边数（degree），前端按此渲染节点尺寸 */
  size: number;
  attributes: string[];
  chunkIds: string[];
}

/** 可视化数据响应（复用 GraphRepository.getSubgraph + size 映射） */
export interface GraphVisualization {
  nodes: GraphVisualizationNode[];
  edges: GraphEdge[];
}

/** 反查文档条目：knowledgeId + 标题（PG 补查）+ 片段（chunk 内容前 2 条） */
export interface RelatedKnowledge {
  knowledgeId: string;
  knowledgeTitle: string;
  chunkSnippets: string[];
}

/** 实体详情响应：属性 + 一跳关联实体（含方向）+ 反查文档 */
export interface EntityDetailResponse {
  name: string;
  attributes: string[];
  chunkIds: string[];
  relatedEntities: RelatedEntity[];
  relatedKnowledge: RelatedKnowledge[];
}

/** 图谱覆盖统计：KB 内文档数 vs 图谱有实体关联的文档数 + 图谱侧计数 */
export interface GraphCoverageStats {
  /** KB 内文档总数（PG knowledge 计数） */
  totalKnowledge: number;
  /** 图谱有实体关联的文档数（实体 chunkIds → chunk 镜像 knowledgeId 去重） */
  coveredKnowledge: number;
  /** 实体节点数（Neo4j） */
  entities: number;
  /** 关系边数（Neo4j） */
  relationships: number;
  /** chunk 镜像节点数（Neo4j） */
  chunks: number;
}

/** 反查文档片段截断：每文档最多取前 2 条 chunk 内容（接口契约，勿随意放大——
 * 实体详情是热路径，片段数×文档数不可控时响应体膨胀，2 条足够预览定位） */
const SNIPPET_LIMIT_PER_DOCUMENT = 2;

@Injectable()
export class GraphService {
  constructor(
    private readonly graphRepository: GraphRepository,
    // PG 侧查询（KB 存在性/文档标题/chunk 片段）用 DataSource 直查：
    // 与 KnowledgeService.ensureKbExists 同款——避免注入 KbService 造成循环依赖
    // （本服务不依赖任何业务服务，模块依赖单向无环）
    private readonly dataSource: DataSource,
  ) {}

  /**
   * 可视化数据：复用 getSubgraph（degree 降序取前 N 节点 + 节点间边），
   * 节点映射 size = degree。KB 无图谱 → { nodes: [], edges: [] }（仓储短路）。
   */
  async getSubgraph(kbId: string): Promise<GraphVisualization> {
    await this.ensureKbExists(kbId);
    const sub = await this.graphRepository.getSubgraph(kbId);
    return {
      nodes: sub.nodes.map((n) => ({
        id: n.id,
        name: n.name,
        // 节点大小 = 关联边数（degree）：前端按度渲染 hub 节点，可视化语义
        // 与「图谱聚合结构」一致（高连接实体是知识聚合中心）
        size: n.degree,
        attributes: n.attributes,
        chunkIds: n.chunkIds,
      })),
      edges: sub.edges,
    };
  }

  /** 实体模糊搜索（CONTAINS，keyword 非空校验在 DTO 层）；无结果 → [] */
  async searchEntities(
    kbId: string,
    keyword: string,
  ): Promise<EntitySearchResult[]> {
    await this.ensureKbExists(kbId);
    return this.graphRepository.searchEntities(kbId, keyword);
  }

  /**
   * 实体详情：属性 + 一跳关联实体（direction 透传仓储语义）+ 反查文档
   * （跨库装配，见文件头「跨库装配」注释）。
   * 实体不存在 → 404（仓储返回 null）。
   */
  async getEntityDetail(
    kbId: string,
    name: string,
  ): Promise<EntityDetailResponse> {
    await this.ensureKbExists(kbId);
    const detail = await this.graphRepository.getEntityDetail(kbId, name);
    if (!detail) {
      throw new NotFoundException('实体不存在');
    }
    const relatedKnowledge = await this.buildRelatedKnowledge(detail.chunks);
    return {
      name: detail.name,
      attributes: detail.attributes,
      chunkIds: detail.chunkIds,
      relatedEntities: detail.related,
      relatedKnowledge,
    };
  }

  /**
   * 图谱覆盖统计：totalKnowledge 来自 PG 计数（KB 内文档数），coveredKnowledge
   * 与图谱侧计数来自 GraphRepository.getKbGraphStats（Neo4j）。两库并行查询，
   * 互不依赖。
   */
  async getCoverage(kbId: string): Promise<GraphCoverageStats> {
    await this.ensureKbExists(kbId);
    const [totalKnowledge, stats] = await Promise.all([
      this.dataSource.getRepository(Knowledge).count({ where: { kbId } }),
      this.graphRepository.getKbGraphStats(kbId),
    ]);
    return {
      totalKnowledge,
      coveredKnowledge: stats.coveredKnowledge,
      entities: stats.entities,
      relationships: stats.relationships,
      chunks: stats.chunks,
    };
  }

  /**
   * 反查文档跨库装配（核心能力，见文件头「跨库装配」注释）：
   * Neo4j 实体关联的 chunk 引用（含 knowledgeId）→ PG 批量补查标题与片段。
   * 步骤：
   * 1. 按 knowledgeId 去重（引用定位键）；
   * 2. PG knowledge 批量查标题（id IN）；
   * 3. PG chunks 批量查内容（id IN + kbId 限定，按 chunkIndex 升序）；
   * 4. 每文档取前 SNIPPET_LIMIT_PER_DOCUMENT 条片段装配；
   *    PG 查不到的行（历史孤儿/删除残留）跳过——见文件头「删除残留语义」。
   */
  private async buildRelatedKnowledge(
    chunks: EntityChunkRef[],
  ): Promise<RelatedKnowledge[]> {
    if (chunks.length === 0) return [];
    // 1. knowledgeId 去重（Neo4j chunk 镜像已带 knowledgeId——反查定位键，
    //    无需再经 PG chunks 反查文档归属，一次装配）
    const knowledgeIds = [...new Set(chunks.map((c) => c.knowledgeId))];
    // 2. PG 批量补查标题（一次 IN 查询而非逐条 N+1；孤儿 knowledgeId 无行，
    //    在标题 Map 中缺失 → 该文档整条跳过，见步骤 4）
    const knowledgeRows = await this.dataSource.getRepository(Knowledge).find({
      where: { id: In(knowledgeIds) },
      select: { id: true, title: true },
    });
    const titleById = new Map(knowledgeRows.map((k) => [k.id, k.title]));
    // 3. PG 批量补查 chunk 内容（kbId 限定是防御性约束——chunk id 是 UUID
    //    跨 KB 碰撞不可能，但实体 chunkIds 若被脏数据污染，双条件兜底不串库）
    const chunkRows = await this.dataSource.getRepository(Chunk).find({
      where: { id: In(chunks.map((c) => c.id)) },
      select: { id: true, knowledgeId: true, content: true },
      order: { chunkIndex: 'ASC' },
    });
    // 4. 按文档分组取前 N 条片段（chunkIndex 升序由步骤 3 的 order 保证）
    const snippetsByKnowledge = new Map<string, string[]>();
    for (const row of chunkRows) {
      const list = snippetsByKnowledge.get(row.knowledgeId);
      // 孤儿 chunk（PG 无行）不会出现在 chunkRows——不参与装配（跳过语义）
      if (list === undefined) {
        snippetsByKnowledge.set(row.knowledgeId, [row.content]);
      } else if (list.length < SNIPPET_LIMIT_PER_DOCUMENT) {
        // 片段截断：每文档只取前 SNIPPET_LIMIT_PER_DOCUMENT 条（预览定位用）
        list.push(row.content);
      }
    }
    return (
      [...snippetsByKnowledge.entries()]
        // 孤儿文档跳过：knowledgeIds 在 PG 无行 → 标题 Map 缺失 → 过滤
        .filter(([knowledgeId]) => titleById.has(knowledgeId))
        // 标题升序排序：确定性响应（跨库装配后的稳定顺序，前端列表稳定渲染）
        .map(([knowledgeId, snippetList]) => ({
          knowledgeId,
          knowledgeTitle: titleById.get(knowledgeId) as string,
          chunkSnippets: snippetList,
        }))
        .sort((a, b) => a.knowledgeTitle.localeCompare(b.knowledgeTitle))
    );
  }

  /**
   * KB 存在性校验：不存在/非 UUID（撞 PG 22P02）一律 404。
   * 与 KnowledgeService.ensureKbExists 同款——直查 knowledge_bases 表
   * （DataSource 注入，避免注入 KbService 造成模块循环依赖）。
   */
  private async ensureKbExists(kbId: string): Promise<void> {
    try {
      const count = await this.dataSource
        .getRepository(KnowledgeBase)
        .count({ where: { id: kbId } });
      if (!count) {
        throw new NotFoundException('知识库不存在');
      }
    } catch (err) {
      if (
        (err as { driverError?: { code?: string } })?.driverError?.code ===
        '22P02'
      ) {
        throw new NotFoundException('知识库不存在');
      }
      throw err;
    }
  }
}
