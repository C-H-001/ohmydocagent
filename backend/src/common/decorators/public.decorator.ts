// backend/src/common/decorators/public.decorator.ts
// @Public()：标记路由为公开访问，绕过全局 JwtAuthGuard（配合反射读取 isPublic 元数据）
import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/** 公开路由装饰器：挂在 @Public() 上的 handler/controller 无需携带 accessToken */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
