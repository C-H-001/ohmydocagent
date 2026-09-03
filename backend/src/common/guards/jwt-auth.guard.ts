// backend/src/common/guards/jwt-auth.guard.ts
// 全局 JWT 守卫：所有路由默认要求有效 accessToken，
// 标记 @Public() 的路由放行（注册/登录/刷新/登出等）。
// 通过 AppModule 的 APP_GUARD 注册为全局守卫。
import { ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator.js';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext) {
    // 先查 @Public() 元数据（handler 优先，其次类级），命中则跳过认证
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }
    // 其余路由走 passport-jwt：token 缺失/无效由 AuthGuard 抛 401
    return super.canActivate(context);
  }
}
