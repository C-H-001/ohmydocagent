// 审计模块（Task 4.4）：注册 AuditLog 实体仓库 + AuditService + AuditController。
// @Global 决策：审计接线点分布在 auth/users/invitations/kb/kb-share/model 等
// 多个既有模块的 service 内（任务要求「在既有 service 加一行调用」）——若按
// 常规模块导出，这些模块都要 import AuditModule；且 UsersModule → AdminModule
// （审计）→ UsersModule（settings 个人资料）存在成环风险。@Global 后各接线
// service 直接注入 AuditService 即可，零 import 改动、无循环依赖；控制器仍
// 归属于本模块（路由只随 AppModule → AdminModule 挂载一次）。单元测试用
// Test.createTestingModule({ providers }) 构建时不受 @Global 影响（需显式
// ）
import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditController } from './audit.controller.js';
import { AuditLog } from './audit-log.entity.js';
import { AuditService } from './audit.service.js';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([AuditLog])],
  controllers: [AuditController],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
