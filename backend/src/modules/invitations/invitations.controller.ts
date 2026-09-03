// backend/src/modules/invitations/invitations.controller.ts
// 邀请管理路由（需登录，全局 JwtAuthGuard 默认拦截）：
// POST 创建（201 返回完整 token）、GET 分页列表（token 脱敏）、DELETE 撤销。
// RBAC 仅 Owner/Admin 两种角色且均允许管理邀请，故无需额外角色守卫。
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { User } from '../users/user.entity.js';
import { CreateInvitationDto } from './dto/create-invitation.dto.js';
import { InvitationsService } from './invitations.service.js';

@Controller('invitations')
export class InvitationsController {
  constructor(private readonly invitationsService: InvitationsService) {}

  /** 创建邀请：201 响应含完整 token（仅此一次展示，后续列表只给脱敏预览） */
  @Post()
  @HttpCode(201)
  create(@Body() dto: CreateInvitationDto, @CurrentUser() user: User) {
    return this.invitationsService.create(dto, user.id);
  }

  /** 分页列表：token 脱敏（tokenPreview），page 从 1 起，pageSize 上限 100 */
  @Get()
  list(@Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    const p = Math.max(1, parseInt(page ?? '1', 10) || 1);
    const ps = Math.min(100, Math.max(1, parseInt(pageSize ?? '10', 10) || 10));
    return this.invitationsService.list(p, ps);
  }

  /** 撤销邀请（删除，token 立即失效） */
  @Delete(':id')
  @HttpCode(204)
  async revoke(@Param('id') id: string): Promise<void> {
    await this.invitationsService.revoke(id);
  }
}
