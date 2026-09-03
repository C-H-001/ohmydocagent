// 知识图谱 API 类型化封装（frontend/src/api/graph.ts，Task 5.9）
// 路由速查（backend: modules/graph/graph.controller.ts）：
//   GET /graphs/kbs/:kbId 可视化数据（nodes 含 size=degree）
//   GET /graphs/kbs/:kbId/search?keyword= 实体模糊搜索
//   GET /graphs/entities/:name?kbId= 实体详情（属性/关联实体/反查文档）
//   GET /graphs/kbs/:kbId/documents 图谱覆盖统计
// 简化决策：KB 无图谱 → { nodes: [], edges: [] }；搜索无结果 → []；实体不存在 404。

import { api } from "./client"

/** 可视化节点（graph.service GraphVisualizationNode）：size = degree */
export interface GraphNode {
  id: string
  name: string
  size: number
  attributes: string[]
  chunkIds: string[]
}

/** 可视化边（graph.types GraphEdge） */
export interface GraphEdge {
  source: string
  target: string
  type: string
  weight: number
}

/** GET /graphs/kbs/:kbId 响应 */
export interface GraphVisualization {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

/** 实体搜索命中项（graph.types EntitySearchResult） */
export interface EntitySearchResult {
  name: string
  attributes: string[]
  chunkIds: string[]
}

/** 反查文档条目（graph.service RelatedKnowledge） */
export interface RelatedKnowledge {
  knowledgeId: string
  knowledgeTitle: string
  chunkSnippets: string[]
}

/** 实体详情响应（graph.service EntityDetailResponse） */
export interface EntityDetailResponse {
  name: string
  attributes: string[]
  chunkIds: string[]
  relatedEntities: {
    name: string
    type: string
    direction: "out" | "in"
    weight: number
  }[]
  relatedKnowledge: RelatedKnowledge[]
}

/** 图谱覆盖统计（graph.service GraphCoverageStats） */
export interface GraphCoverageStats {
  totalKnowledge: number
  coveredKnowledge: number
  entities: number
  relationships: number
  chunks: number
}

export const graphApi = {
  /** GET /graphs/kbs/:kbId 可视化数据 */
  getVisualization(kbId: string): Promise<GraphVisualization> {
    return api.get(`/graphs/kbs/${kbId}`)
  },

  /** GET /graphs/kbs/:kbId/search?keyword= 实体搜索 */
  searchEntities(kbId: string, keyword: string): Promise<EntitySearchResult[]> {
    return api.get(`/graphs/kbs/${kbId}/search`, { query: { keyword } })
  },

  /** GET /graphs/entities/:name?kbId= 实体详情（name 走路径参数，URL 编码） */
  getEntityDetail(kbId: string, name: string): Promise<EntityDetailResponse> {
    return api.get(`/graphs/entities/${encodeURIComponent(name)}`, { query: { kbId } })
  },

  /** GET /graphs/kbs/:kbId/documents 覆盖统计 */
  getCoverage(kbId: string): Promise<GraphCoverageStats> {
    return api.get(`/graphs/kbs/${kbId}/documents`)
  },
}
