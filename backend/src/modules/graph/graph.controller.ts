// 图谱 HTTP API 路由（Task 3.3）：可视化数据、实体搜索、实体详情（含反查
// 文档）、图谱覆盖统计。路由前缀 graphs（全局前缀 api/v1 → /api/v1/graphs/...）。
// 全局守卫（JwtAuthGuard + RolesGuard + KbAccessGuard，见 app.module.ts）默认
// 拦截——全部需登录；本任务无角色限制（Owner 语义，P1 单用户）。
// 权限登记（Task 4.2 挂账，P5 联调时挂载）：KbAccessGuard 的 kbId 解析已支持
// query.kbId（见 kb-access.guard.ts resolveKbId），图谱 kbs/:kbId 三端点挂
// @RequireKbPermission('view') 即可（view 语义含图谱读，见任务书权限语义）；
// entities/:name 通过 query kbId 判定归属（当前 GraphService.ensureKbExists
// 只校验存在性，P5 在此叠加访问权判定）。简化决策：本任务先挂核心写接口 +
// KB 详情/文档列表读接口，图谱读接口按任务书「注释登记剩余」处理。
import { Controller, Get, Param, Query } from '@nestjs/common';
import { EntityDetailQueryDto } from './dto/entity-detail-query.dto.js';
import { SearchEntitiesDto } from './dto/search-entities.dto.js';
import { GraphService } from './graph.service.js';

@Controller('graphs')
export class GraphController {
  constructor(private readonly graphService: GraphService) {}

  /**
   * 可视化数据：{ nodes: [{ id, name, size(=degree), attributes, chunkIds }],
   * edges: [{ source, target, type, weight }] }。KB 无图谱 → { nodes: [], edges: [] }
   * （不报错）；KB 不存在 → 404。
   */
  @Get('kbs/:kbId')
  getSubgraph(@Param('kbId') kbId: string) {
    return this.graphService.getSubgraph(kbId);
  }

  /**
   * 实体模糊搜索（CONTAINS）：keyword 必填非空、≤50 字（DTO 校验，违规 400）；
   * 无结果 → []。KB 不存在 → 404。
   */
  @Get('kbs/:kbId/search')
  search(@Param('kbId') kbId: string, @Query() query: SearchEntitiesDto) {
    return this.graphService.searchEntities(kbId, query.keyword);
  }

  /**
   * 实体详情（属性/关联实体含 direction/反查文档）：name 走路径参数（URL
   * 编码——实体名是 LLM 抽取的自由文本，可能含中文/特殊字符），kbId 必填
   * query（实体按 kbId+name 复合唯一，见 initSchema 约束）。实体不存在 → 404。
   */
  @Get('entities/:name')
  getEntityDetail(
    @Param('name') name: string,
    @Query() query: EntityDetailQueryDto,
  ) {
    return this.graphService.getEntityDetail(query.kbId, name);
  }

  /**
   * 图谱覆盖统计：{ totalKnowledge, coveredKnowledge, entities,
   * relationships, chunks }（KB 内文档数 vs 图谱有实体关联的文档数，
   * 见 graph.service.ts getCoverage 注释）。KB 不存在 → 404。
   */
  @Get('kbs/:kbId/documents')
  getCoverage(@Param('kbId') kbId: string) {
    return this.graphService.getCoverage(kbId);
  }
}
