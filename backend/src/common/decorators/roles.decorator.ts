// backend/src/common/decorators/roles.decorator.ts
// 声明访问所需角色：@Roles(Role.Super) 表示仅 Owner 可访问，配合全局 RolesGuard 生效
// （RolesGuard 读取本装饰器写入的 ROLES_KEY 元数据，见 common/guards/roles.guard.ts）。
import { SetMetadata } from '@nestjs/common';
import { Role } from '../../modules/users/user.entity.js';

export const ROLES_KEY = 'roles';

/** 角色守卫元数据装饰器：参数为允许访问的角色集合（handler 优先，其次类级） */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
