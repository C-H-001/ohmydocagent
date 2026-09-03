// @UseApiKey()：挂载 ApiKeyGuard 的声明式装饰器（Task 4.5）。
// 语义：端点可通过 X-API-Key 请求头认证（或已有 JWT 时直接放行，见
// platform-api-key.guard.ts 注释）。用法：
//   @Public()               // 跳过全局 JwtAuthGuard（纯 API Key 请求可达）
//   @UseApiKey()            // X-API-Key 校验 + 注入 admin 身份
//   @Roles(Role.Super)  // 可选：身份 role 按 Admin 参与 RBAC
import { UseGuards, applyDecorators } from '@nestjs/common';
import { ApiKeyGuard } from './platform-api-key.guard.js';

/** 声明端点支持平台 API Key 认证（与全局 JWT 守卫组合，见文件头注释） */
export const UseApiKey = () => applyDecorators(UseGuards(ApiKeyGuard));
