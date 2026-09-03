// 个人资料路由（Task 4.6）：GET/PUT /settings/profile + POST /settings/change-password。
// 位置决策（任务简化）：用户自身资源（昵称/头像/密码）归 users 模块，与 admin
// 的全局配置域（SettingsController @Controller('admin/settings')）分离——本
// 控制器挂 @Controller('settings') 前缀，仅操作当前登录用户（@CurrentUser），
// 无角色限制（全局 JwtAuthGuard 已保证登录）。
import { Body, Controller, Get, HttpCode, Post, Put } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { ChangePasswordDto } from './dto/change-password.dto.js';
import { UpdateProfileDto } from './dto/update-profile.dto.js';
import { User } from './user.entity.js';
import { UsersService } from './users.service.js';

@Controller('settings')
export class ProfileController {
  constructor(private readonly usersService: UsersService) {}

  /** 当前用户资料（含 email/role，不含 passwordHash） */
  @Get('profile')
  profile(@CurrentUser() user: User) {
    return this.usersService.toPublicUser(user);
  }

  /** 更新昵称/头像（只更新传入字段） */
  @Put('profile')
  updateProfile(@CurrentUser() user: User, @Body() dto: UpdateProfileDto) {
    return this.usersService.updateProfile(user.id, dto.name, dto.avatarUrl);
  }

  /** 修改密码（旧密码校验 + 新密码落库；成功后旧 refresh token 仍有效——
   * 未强制全端登出，简化决策，见 change-password 注释） */
  @Post('change-password')
  @HttpCode(200)
  async changePassword(
    @CurrentUser() user: User,
    @Body() dto: ChangePasswordDto,
  ) {
    await this.usersService.changePassword(
      user.id,
      dto.oldPassword,
      dto.newPassword,
    );
    return { changed: true };
  }
}
