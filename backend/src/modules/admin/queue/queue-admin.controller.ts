// 队列仪表盘路由（Task 4.3）：管理员（Owner/Admin）查看队列概览/任务列表/
// 详情与重试/取消。@Roles 类级声明，全局 RolesGuard 生效（见 roles.guard.ts
// 注释：系统仅 Owner/Admin 两种角色，@Roles(Owner, Admin) 即「任意登录用户」，
// 拒绝场景由全局 JwtAuthGuard 以 401 拦截）。
import { Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { Roles } from '../../../common/decorators/roles.decorator.js';
import { Role } from '../../users/user.entity.js';
import { QUEUE_JOB_STATES, QueueAdminService } from './queue-admin.service.js';
import type { QueueJobState } from './queue-admin.service.js';
import { IsIn, IsOptional } from 'class-validator';
import { PaginationDto } from '../../../common/pagination.js';

/** 任务列表查询参数：state 可选（枚举校验）+ 分页（复用 PaginationDto） */
export class QueueJobsQueryDto extends PaginationDto {
  @IsOptional()
  @IsIn([...QUEUE_JOB_STATES], {
    message:
      'state 必须是 waiting|active|completed|failed|delayed|prioritized|waiting-children 之一',
  })
  state?: QueueJobState;
}

@Roles(Role.Super)
@Controller('admin/queues')
export class QueueAdminController {
  constructor(private readonly queueAdminService: QueueAdminService) {}

  /** 五队列概览：getJobCounts（waiting/active/completed/failed/delayed/paused） */
  @Get()
  overview() {
    return this.queueAdminService.overview();
  }

  /** 任务列表：?state=&page=&pageSize=（内存分页，顺序 new→old） */
  @Get(':name/jobs')
  jobs(@Param('name') name: string, @Query() query: QueueJobsQueryDto) {
    return this.queueAdminService.jobs(
      name,
      query.state,
      query.page,
      query.pageSize,
    );
  }

  /** 任务详情：payload/progress/result/failedReason */
  @Get(':name/jobs/:id')
  jobDetail(@Param('name') name: string, @Param('id') id: string) {
    return this.queueAdminService.jobDetail(name, id);
  }

  /** 重试失败任务（POST 为动作语义，返回 200） */
  @Post(':name/jobs/:id/retry')
  @HttpCode(200)
  retry(@Param('name') name: string, @Param('id') id: string) {
    return this.queueAdminService.retry(name, id);
  }

  /** 取消（移除）任务（POST 为动作语义，返回 200） */
  @Post(':name/jobs/:id/cancel')
  @HttpCode(200)
  cancel(@Param('name') name: string, @Param('id') id: string) {
    return this.queueAdminService.cancel(name, id);
  }
}
