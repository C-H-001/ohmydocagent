// 平台 API Key 守卫（Task 4.5）：X-API-Key 请求头 → sha256 校验 → 注入 admin 身份。
// 组合语义（「JWT 或 API Key」二选一）：
// - 若 request.user 已存在（全局 JwtAuthGuard 已通过 passport-jwt 填充）→ 放行
//   （JWT 路径，本守卫不重复校验）；
// - 否则读取 X-API-Key：缺失/无效/已暂停 → 401（Unprocessable 区分不必要——
//   与全局守卫 401 语义一致，不泄露 key 是否存在的细节）；
// - 校验成功 → req.user = { id, name, type: 'api-key', role: 'member' }：
//   后续 RolesGuard 读 @Roles 元数据时按 admin 判定（平台 key 等价管理员凭证）。
// 挂载方式：@UseApiKey()（applyDecorators 包装 @UseGuards），见
// use-api-key.decorator.ts；示例挂载点见 PlatformApiKeyController.self
// （@Public + @UseApiKey——@Public 跳过全局 JwtAuthGuard 让纯 API Key 请求可达）。
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { PlatformApiKeyService } from './platform-api-key.service.js';

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly apiKeyService: PlatformApiKeyService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    // JWT 路径：req.user 已由全局 JwtAuthGuard 填充 → 放行
    if (request.user) {
      return true;
    }
    const rawKey = request.headers['x-api-key'];
    if (typeof rawKey !== 'string' || rawKey.length === 0) {
      throw new UnauthorizedException('缺少 API Key（X-API-Key 请求头）');
    }
    const identity = await this.apiKeyService.validate(rawKey);
    if (!identity) {
      throw new UnauthorizedException('API Key 无效或已暂停');
    }
    request.user = identity;
    return true;
  }
}
