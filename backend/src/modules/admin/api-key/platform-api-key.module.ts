// 平台 API Key 模块（Task 4.5）：实体仓库 + 服务 + 控制器 + 守卫。
// 依赖：AuditModule 为 @Global（api_key.create/delete 审计直接注入 AuditService，
// 见 audit.module.ts 注释）。导出 PlatformApiKeyService 与 ApiKeyGuard——供
// 测试与其他模块（如需把平台 key 认证挂到更多端点）复用。
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ApiKeyGuard } from './platform-api-key.guard.js';
import { PlatformApiKeyController } from './platform-api-key.controller.js';
import { PlatformApiKey } from './platform-api-key.entity.js';
import { PlatformApiKeyService } from './platform-api-key.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([PlatformApiKey])],
  controllers: [PlatformApiKeyController],
  providers: [PlatformApiKeyService, ApiKeyGuard],
  exports: [PlatformApiKeyService, ApiKeyGuard],
})
export class ApiKeyModule {}
