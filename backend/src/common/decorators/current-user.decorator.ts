// backend/src/common/decorators/current-user.decorator.ts
// @CurrentUser()：从请求上下文取 JwtStrategy validate 挂载的 req.user
import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { User } from '../../modules/users/user.entity.js';

/** 参数装饰器：控制器方法参数注入当前登录用户（无 token 的路由不会走到这里） */
export const CurrentUser = createParamDecorator(
  (data: unknown, ctx: ExecutionContext): User => {
    const request = ctx.switchToHttp().getRequest();
    return request.user as User;
  },
);
