// 知识库路由（Task 1.1 + Task 1.10，全部需登录——全局 JwtAuthGuard 默认拦截）：
// POST /kbs 创建、GET /kbs 分页列表（view=all|mine|favorite|recent 视图筛选 +
// 当前用户 pinned/favorite 标记 + docCount/chunkCount）、GET /kbs/stats 统计、
// GET/PUT/DELETE /kbs/:id（GET 详情自动记录最近访问）、PUT /kbs/:id/pin 置顶开关、
// PUT /kbs/:id/favorite 收藏开关（toggle）、POST /kbs/:id/duplicate 复制、
// POST /kbs/:id/hybrid-search 混合检索（Task 1.6）。
// 路由顺序：GET /kbs/stats 必须在 GET /kbs/:id 之前声明——Express 按注册顺序
// 匹配路由，若 stats 在 :id 之后注册，'stats' 会被 :id 吞掉并撞 22P02 返回 404。
// 本任务不设知识库级权限（创建者/全员可见，Owner/Admin 无差别），
// P4 引入共享机制后再加 KbAccessGuard（与 RolesGuard 同模式全局挂载）。
// ——Task 4.2 已挂载：全局 KbAccessGuard（app.module.ts APP_GUARD）配合
// @RequireKbPermission 装饰器生效：GET :id（view 读）、PUT :id（edit 写）、
// DELETE :id（full——共享成员即使 edit 也不可删 KB，见任务书权限语义）。
// 登记挂账（P5 前端联调时收敛）：GET /kbs 列表、GET /kbs/stats、
// pin/favorite/duplicate/hybrid-search 暂未挂权限（列表与统计需先定义「可见 KB
// 集合 = 我创建的 + 我所在组织共享的」的过滤口径，检索范围交集见
// kb-access.service.ts 文件头注释；pin/favorite 是用户级开关与共享语义无关；
// duplicate 读源配置，view 语义待 P5 明确）。
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Logger,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { User } from '../users/user.entity.js';
import { VectorService } from '../vector/vector.service.js';
import { RequireKbPermission } from '../kb-share/kb-permission.decorator.js';
import { KbAccessService } from '../kb-share/kb-access.service.js';
import { HybridSearchDto } from '../vector/dto/hybrid-search.dto.js';
import { CreateKbDto } from './dto/create-kb.dto.js';
import { DuplicateKbDto } from './dto/duplicate-kb.dto.js';
import { ListKbDto } from './dto/list-kb.dto.js';
import { UpdateKbDto } from './dto/update-kb.dto.js';
import { KbService } from './kb.service.js';

@Controller('kbs')
export class KbController {
  private readonly logger = new Logger(KbController.name);
  constructor(
    private readonly kbService: KbService,
    // 混合检索（Task 1.6）：路由天然归属 kb 资源（POST :id/hybrid-search），
    // 挂在本控制器最简；VectorService 是纯检索能力（对话 RAG 后续也调用它，
    // 见 vector.service.ts 注释），控制器只管 HTTP 层（KB 存在性校验 + DTO）
    private readonly vectorService: VectorService,
    // 当前用户对 KB 的权限档（详情响应 myPermission，前端据此隐藏共享管理入口：
    // 用户需求——成员管理仅 KB Owner/系统 super 可见，普通成员不展示）
    private readonly kbAccessService: KbAccessService,
  ) {}

  /** 创建知识库：201 返回完整实体（含默认 type=document） */
  @Post()
  @HttpCode(201)
  create(@Body() dto: CreateKbDto, @CurrentUser() user: User) {
    return this.kbService.create(dto, user.id);
  }

  /** 分页列表：ListKbDto 校验 page/pageSize/view（非法 view 400），
   * 返回项含 pinned/favorite 标记 + docCount/chunkCount 聚合计数 */
  @Get()
  list(@Query() query: ListKbDto, @CurrentUser() user: User) {
    return this.kbService.list(query.page, query.pageSize, user, query.view);
  }

  /**
   * 统计（Task 1.10）：totalKbs/mine/favorite/totalDocs/totalChunks。
   * 必须声明在 GET /kbs/:id 之前（Express 按注册顺序匹配，见文件头注释）。
   */
  @Get('stats')
  stats(@CurrentUser() user: User) {
    return this.kbService.stats(user.id);
  }

  /**
   * 详情：返回 KB 完整实体，同时记录最近访问（Task 1.10）——详情访问即视为
   * 「最近访问」信号（recent 视图数据源）。访问记录是辅助数据：记录失败
   * 不阻断详情返回（吞错仅日志层面，避免辅助功能拖垮主流程）。
   * Task 4.2：view 权限可读（KB 创建者/系统 Owner/所在组织共享 view+ 成员），
   * 无权/不存在统一 404（KbAccessGuard）。
   */
  @RequireKbPermission('view')
  @Get(':id')
  async getById(@Param('id') id: string, @CurrentUser() user: User) {
    const kb = await this.kbService.getById(id);
    // 当前用户权限档（view/edit/admin/full）——前端条件渲染共享管理入口
    const myPermission = await this.kbAccessService.effectivePermission(user, id);
    // 访问记录是辅助数据：失败不阻断详情返回，但必须留日志（质量审查整改——
    // 原先静默吞错，生产环境无法排查记录失败原因）
    await this.kbService
      .recordVisit(id, user.id)
      .catch((err) =>
        this.logger.warn(
          `记录最近访问失败: kbId=${id}, userId=${user.id}`,
          err as Error,
        ),
      );
    return { ...kb, myPermission };
  }

  /** 更新名称/描述/分块配置（只更新传入字段）：Task 4.2——edit 权限可改 */
  @RequireKbPermission('edit')
  @Put(':id')
  update(@Param('id') id: string, @Body() dto: UpdateKbDto) {
    return this.kbService.update(id, dto);
  }

  /** 删除（硬删除）：204 无响应体。Task 4.2——full 权限专属（KB 创建者/系统
   * Owner）；共享成员即使 edit 也不可删 KB（任务书权限语义：edit 不可删除 KB） */
  @RequireKbPermission('full')
  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id') id: string): Promise<void> {
    await this.kbService.remove(id);
  }

  /** 置顶开关（toggle）：200 + { pinned }（当前用户维度，见 KbService.togglePin） */
  @Put(':id/pin')
  togglePin(@Param('id') id: string, @CurrentUser() user: User) {
    return this.kbService.togglePin(id, user.id);
  }

  /** 收藏开关（toggle，Task 1.10）：与 pin 同形态——200 + { favorite } */
  @Put(':id/favorite')
  toggleFavorite(@Param('id') id: string, @CurrentUser() user: User) {
    return this.kbService.toggleFavorite(id, user.id);
  }

  /** 复制知识库：POST 为动作语义（创建副本），201 返回新 KB */
  @Post(':id/duplicate')
  @HttpCode(201)
  duplicate(
    @Param('id') id: string,
    @Body() dto: DuplicateKbDto,
    @CurrentUser() user: User,
  ) {
    return this.kbService.duplicate(id, user.id, dto.name);
  }

  /**
   * 混合检索（Task 1.6）：向量 + 关键词两路加权融合（0.6/0.4，见
   * VectorService.hybridSearch 注释），供前端调试与后续对话 RAG 复用。
   * - KB 存在性校验（KbService.getById：不存在/非 UUID 一律 404，防跨 KB）
   * - topK 缺省 10（DTO @IsOptional 不校验缺省值，服务层兜底默认）
   * - 返回 { items: [{ chunkId, content, knowledgeId, score, vectorScore,
   *   keywordScore }] }——score 为融合排序分（相对值，仅用于排序，注释见
   *   vector.service.ts hybridSearch 文档）
   */
  @Post(':id/hybrid-search')
  @HttpCode(200) // 检索是动作而非创建资源：显式 200（NestJS POST 默认 201）
  async hybridSearch(
    @Param('id') id: string,
    @Body() dto: HybridSearchDto,
    @CurrentUser() user: User,
  ) {
    await this.kbService.getById(id); // 404 语义（KB 不存在/非法 id）
    // BYOK：query 向量化按用户路由（用户私有 embedding 模型；未配 → 503 提示）
    const items = await this.vectorService.hybridSearch(
      [id],
      dto.query,
      dto.topK ?? 10,
      undefined,
      undefined,
      user.id,
    );
    return { items };
  }
}
