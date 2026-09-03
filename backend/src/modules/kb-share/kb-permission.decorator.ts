// @RequireKbPermission 装饰器（Task 4.2）：声明端点所需 KB 权限档位
// （'view'|'edit'|'full'），配合全局 KbAccessGuard 生效（Guard 读取本装饰器
// 写入的 KB_PERMISSION_KEY 元数据，见 kb-access.guard.ts）。handler 优先于
// 类级：类上声明 view（只读兜底）、写接口在 handler 上覆盖为 edit/full。
import { SetMetadata } from '@nestjs/common';
import { KbPermission } from './kb-access.service.js';

export const KB_PERMISSION_KEY = 'kb_permission';

/** 声明端点所需 KB 权限：未声明的端点 Guard 自动放行（与 @Roles 同模式） */
export const RequireKbPermission = (permission: KbPermission) =>
  SetMetadata(KB_PERMISSION_KEY, permission);
