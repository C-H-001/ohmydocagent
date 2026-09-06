// 模型用量查询控制器：
// - GET /api/v1/me/model-usage：当前用户自己的模型用量（所有登录用户）
// - GET /api/v1/admin/model-usage：全部用户用量（super 专属）
import { Controller, Get, Query } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { Role, User } from '../users/user.entity.js';
import { ModelUsageService } from './model-usage.service.js';

@Controller()
export class UsageController {
  constructor(private readonly usageService: ModelUsageService) {}

  /** 当前用户自己的模型用量（模型选择器/用量管理界面数据源） */
  @Get('me/model-usage')
  async listMine(@CurrentUser() user: User) {
    const rows = await this.usageService.listMine(user.id);
    const totalTokens = rows.reduce(
      (acc, r) => acc + r.inputTokens + r.outputTokens,
      0,
    );
    return { items: rows, totalTokens, totalCalls: rows.reduce((a, r) => a + r.calls, 0) };
  }

  /** 用量趋势（按日 per-model——趋势图数据源；所有登录用户看自己） */
  @Get('me/model-usage/trend')
  async trend(
    @CurrentUser() user: User,
    @Query('days') days?: string,
  ) {
    const n = days ? parseInt(days, 10) : 30;
    return { items: await this.usageService.trend(user.id, Number.isFinite(n) ? n : 30) };
  }

  /** 全部用户用量（super 专属） */
  @Roles(Role.Super)
  @Get('admin/model-usage')
  async listAll() {
    const rows = await this.usageService.listAll();
    return { items: rows };
  }
}
