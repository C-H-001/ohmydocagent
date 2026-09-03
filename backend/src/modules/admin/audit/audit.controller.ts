// 审计日志路由（Task 4.4）：GET /admin/audit-logs 分页筛选（action/userId 可选）
// + GET /admin/audit-logs/:id 单条详情。@Roles(Owner, Admin) 类级声明，全局
// RolesGuard 生效（系统仅 Owner/Admin 两种角色，拒绝场景由全局 JwtAuthGuard
// 以 401 拦截，见 queue-admin.controller.ts 注释）。
import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
} from '@nestjs/common';
import { IsOptional, IsString, IsUUID } from 'class-validator';
import { Roles } from '../../../common/decorators/roles.decorator.js';
import { PaginationDto } from '../../../common/pagination.js';
import { Role } from '../../users/user.entity.js';
import { AuditService } from './audit.service.js';

/** 审计列表查询参数：action/userId 可选筛选 + 分页（复用 PaginationDto） */
export class AuditLogsQueryDto extends PaginationDto {
  @IsOptional()
  @IsString({ message: 'action 必须是字符串' })
  action?: string;

  @IsOptional()
  @IsUUID(undefined, { message: 'userId 必须是合法的 UUID' })
  userId?: string;
}

@Roles(Role.Super)
@Controller('admin/audit-logs')
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  /** 审计列表：?action=&userId=&page=&pageSize=（时间倒序） */
  @Get()
  list(@Query() query: AuditLogsQueryDto) {
    return this.auditService.list(
      query.page,
      query.pageSize,
      query.action,
      query.userId,
    );
  }

  /** 单条详情：不存在 → 404 */
  @Get(':id')
  async detail(@Param('id') id: string) {
    const log = await this.auditService.findById(id);
    if (!log) {
      throw new NotFoundException('审计记录不存在');
    }
    return log;
  }
}
