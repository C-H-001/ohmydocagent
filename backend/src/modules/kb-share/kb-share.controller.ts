// KB 共享管理路由（Task 4.2，全部需登录——全局 JwtAuthGuard 默认拦截）：
// POST /kbs/:id/shares 创建共享（{ orgId, permission }，full 权限专属）、
// GET /kbs/:id/shares 共享列表（含 orgName）、PUT /kbs/:id/shares/:shareId
// 改权限、DELETE /kbs/:id/shares/:shareId 撤销共享。
// 共享管理是 KB full 权限专属（创建者/系统 Owner），端点统一挂
// @RequireKbPermission('full')——view/edit 共享成员访问一律 404（隐藏）。
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { User } from '../users/user.entity.js';
import { CreateShareDto } from './dto/create-share.dto.js';
import { UpdateShareDto } from './dto/update-share.dto.js';
import { KbShareService } from './kb-share.service.js';
import { RequireKbPermission } from './kb-permission.decorator.js';

@Controller('kbs/:id/shares')
export class KbShareController {
  constructor(private readonly kbShareService: KbShareService) {}

  /** 创建共享：201 返回完整实体；重复共享 409；KB 不存在/无权 404 */
  @Post()
  @HttpCode(201)
  @RequireKbPermission('full')
  create(
    @Param('id') kbId: string,
    @Body() dto: CreateShareDto,
    @CurrentUser() user: User,
  ) {
    return this.kbShareService.create(kbId, dto, user);
  }

  /** 共享列表（含 orgName）：admin 及以上可看（KBAdmin 可见），管理仍 full */
  @Get()
  @RequireKbPermission('admin')
  list(@Param('id') kbId: string, @CurrentUser() user: User) {
    return this.kbShareService.list(kbId, user);
  }

  /** 改权限（view↔edit）：仅 full 权限；share 不存在/不属于该 kb 404 */
  @Put(':shareId')
  @RequireKbPermission('full')
  update(
    @Param('id') kbId: string,
    @Param('shareId') shareId: string,
    @Body() dto: UpdateShareDto,
    @CurrentUser() user: User,
  ) {
    return this.kbShareService.update(kbId, shareId, dto, user);
  }

  /** 撤销共享（删除）：204 无响应体，仅 full 权限 */
  @Delete(':shareId')
  @HttpCode(204)
  @RequireKbPermission('full')
  async remove(
    @Param('id') kbId: string,
    @Param('shareId') shareId: string,
    @CurrentUser() user: User,
  ): Promise<void> {
    await this.kbShareService.remove(kbId, shareId, user);
  }
}
