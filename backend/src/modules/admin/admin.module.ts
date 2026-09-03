// 系统管理聚合模块（Task 4.3~4.6）：聚合四个子域模块——
// - QueueModule（4.3）：任务队列仪表盘（概览/列表/详情/重试/取消）
// - AuditModule（4.4）：审计日志（@Global——接线点在 auth/users/kb/kb-share/
//   model/invitations 等既有模块的 service 内直接注入 AuditService，零 import
//   改动、无循环依赖，见 audit.module.ts 注释）
// - ApiKeyModule（4.5）：平台 API Keys（创建明文一次/列表脱敏/吊销 + ApiKeyGuard）
// - SettingsModule（4.6）：全局设置 + 系统信息健康探测
import { Module } from '@nestjs/common';
import { ApiKeyModule } from './api-key/platform-api-key.module.js';
import { AuditModule } from './audit/audit.module.js';
import { QueueModule } from './queue/queue.module.js';
import { SettingsModule } from './settings/settings.module.js';

@Module({
  imports: [QueueModule, AuditModule, ApiKeyModule, SettingsModule],
})
export class AdminModule {}
