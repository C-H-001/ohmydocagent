// 平台 API Key 路由（Task 4.5）：
// - POST /admin/api-keys 创建（JWT 路径，@Roles(Owner, Admin)）：返回明文一次
// - GET /admin/api-keys 列表（脱敏，hasApiKey=true，无 keyHash/明文）
// - DELETE /admin/api-keys/:id 吊销
// - GET /admin/api-keys/self 示例受保护端点（@Public + @UseApiKey——纯 API Key
//   认证路径，验证 guard 端到端；返回注入的身份，证明请求已通过平台 key 认证）
// 守卫顺序说明：全局守卫（JwtAuthGuard → RolesGuard → KbAccessGuard）先于
// 路由守卫（ApiKeyGuard）执行。self 端点必须 @Public（跳过 JWT 使纯 API Key
// 请求可达）且不能带 @Roles 类级声明——否则 RolesGuard 在 ApiKeyGuard 注入
// 身份之前就因 req.user 为空抛 403。因此 @Roles 逐个 handler 声明，不给 self
// 挂角色（ApiKeyGuard 注入的 identity.role=admin 已等价管理员凭证，见 guard
// 注释；self 仅需证明认证成功）。
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
} from '@nestjs/common';
import {
  IsArray,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator.js';
import { Public } from '../../../common/decorators/public.decorator.js';
import { Roles } from '../../../common/decorators/roles.decorator.js';
import { Role, User } from '../../users/user.entity.js';
import { PlatformApiKeyService } from './platform-api-key.service.js';
import { UseApiKey } from './use-api-key.decorator.js';

/** 创建请求体：名称必填（唯一）+ 可选权限域（预留，见实体注释） */
export class CreateApiKeyDto {
  @IsString({ message: '名称必须是字符串' })
  @MinLength(1, { message: '名称不能为空' })
  @MaxLength(100, { message: '名称最长 100 个字符' })
  name!: string;

  @IsOptional()
  @IsArray({ message: 'scopes 必须是数组' })
  @IsString({ each: true, message: 'scopes 元素必须是字符串' })
  scopes?: string[];
}

@Controller('admin/api-keys')
export class PlatformApiKeyController {
  constructor(private readonly apiKeyService: PlatformApiKeyService) {}

  /** 创建：返回明文 key（仅此一次，前端需立即保存） */
  @Roles(Role.Super)
  @Post()
  create(@Body() dto: CreateApiKeyDto, @CurrentUser() user: User) {
    return this.apiKeyService.create(dto.name, dto.scopes ?? [], user.id);
  }

  /** 列表：脱敏（hasApiKey=true，无 keyHash/明文） */
  @Roles(Role.Super)
  @Get()
  list() {
    return this.apiKeyService.list();
  }

  /** 吊销（硬删）：DELETE 语义即资源删除，返回 200 + { revoked: true } */
  @Roles(Role.Super)
  @Delete(':id')
  @HttpCode(200)
  async revoke(@Param('id') id: string, @CurrentUser() user: User) {
    await this.apiKeyService.revoke(id, user.id);
    return { revoked: true };
  }

  /** 示例受保护端点（Task 4.5 验收点）：@Public 跳过全局 JWT 守卫，
   * @UseApiKey 校验 X-API-Key 并注入 admin 身份 → 返回身份证明 */
  @Public()
  @UseApiKey()
  @Get('self')
  self(@CurrentUser() user: ApiKeyUser) {
    return { id: user.id, name: user.name, type: user.type, role: user.role };
  }
}

/** self 端点注入身份的形态（ApiKeyGuard 注入，见 platform-api-key.guard.ts） */
interface ApiKeyUser {
  id: string;
  name: string;
  type: 'api-key';
  role: 'member';
}
