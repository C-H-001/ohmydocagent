// backend/src/common/guards/roles.guard.ts
// 角色守卫：读取 @Roles 元数据，与 request.user.role 比对；未声明 @Roles 的端点自动放行。
// 执行顺序说明：本守卫在 AppModule 中注册为全局 APP_GUARD 且位于 JwtAuthGuard 之后
// （NestJS 按注册顺序执行全局守卫）——JwtAuthGuard 先运行并经由 passport-jwt 把
// 查库得到的最新用户挂到 request.user，RolesGuard 再据此做角色判定；
// 角色判定统一走数据库最新值（JwtStrategy 每次请求查库，token 内不携带角色快照）。
// @Public() + @Roles 是矛盾组合（公开端点无 req.user），不在使用范围内，按 403 处理。
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '../../modules/users/user.entity.js';
import { ROLES_KEY } from '../decorators/roles.decorator.js';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // handler 优先，其次类级：取 @Roles() 声明的角色集合
    const requiredRoles = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!requiredRoles || requiredRoles.length === 0) {
      // 未声明 @Roles：RBAC 无额外限制（全局 JwtAuthGuard 已保证登录）
      return true;
    }
    const { user } = context.switchToHttp().getRequest();
    if (!user || !requiredRoles.includes(user.role)) {
      throw new ForbiddenException('无权访问该资源');
    }
    return true;
  }
}
