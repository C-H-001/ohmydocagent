// backend/src/modules/users/users.controller.ts
// 用户管理路由（需登录，全局 JwtAuthGuard 默认拦截）：
// GET /users 分页列表（RBAC 仅 Owner/Admin 两种角色且均可访问，无需额外角色守卫，
//   与 InvitationsController 同款约定）；返回公开用户信息（绝不含 passwordHash）。
// PUT /users/:id/role 角色调整：@Roles(Role.Super)，仅 Owner 可用（RolesGuard 全局生效）。
// POST /users/transfer-ownership 所有权转移：@Roles(Role.Super)，仅 Owner 可用，
//   事务内原子交换角色（并发兜底见 UsersService.transferOwnership）。
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { PaginationDto } from '../../common/pagination.js';
import { TransferOwnershipDto } from './dto/transfer-ownership.dto.js';
import { UpdateRoleDto } from './dto/update-role.dto.js';
import { Role, User } from './user.entity.js';
import { UsersService } from './users.service.js';

@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  /** 用户分页列表：仅 super（系统管理专属，用户需求：用户管理归 super）；
   *  返回公开用户（无 passwordHash） */
  @Roles(Role.Super)
  @Get()
  list(@Query() query: PaginationDto) {
    return this.usersService.list(query.page, query.pageSize);
  }

  /**
   * 角色调整（仅 Owner）：见 UsersService.updateRole 的语义——系统恒有且仅有一个 Owner，
   * 破坏不变量的变更（提升出第二个 Owner / 降级掉唯一 Owner）一律 400；
   * 幂等设置（角色未变化）返回 200。真正的换主走 transfer-ownership。
   */
  @Roles(Role.Super)
  @Put(':id/role')
  updateRole(
    @Param('id') id: string,
    @Body() dto: UpdateRoleDto,
    @CurrentUser() user: User,
  ) {
    return this.usersService.updateRole(id, dto.role, user);
  }

  /** 所有权转移（仅 Owner）：POST 为动作语义而非资源创建，返回 200 + { previousOwner, newOwner } */
  @Roles(Role.Super)
  @Post('transfer-ownership')
  @HttpCode(200)
  transferOwnership(
    @Body() dto: TransferOwnershipDto,
    @CurrentUser() user: User,
  ) {
    return this.usersService.transferOwnership(dto.targetUserId, user);
  }
}
