// KB 共享模块（Task 4.2）：KnowledgeBaseShare 实体 + 共享管理（KbShareService）
// + 访问权限判定（KbAccessService）+ 全局守卫（KbAccessGuard，AppModule 以
// APP_GUARD 注册，见 app.module.ts；本模块导出 Guard 供实例化依赖解析）。
// KnowledgeBase（KB 存在性与 creatorId 判定）、Chunk（分块路由 chunkId 反查
// kbId）——均为实体级依赖，与 orgs 模块无环（只引用实体类，不互相 import 模块）。
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Chunk } from '../chunk/chunk.entity.js';
import { KnowledgeBase } from '../kb/kb.entity.js';
import { KbAccessGuard } from './kb-access.guard.js';
import { KbAccessService } from './kb-access.service.js';
import { KnowledgeBaseShare } from './kb-share.entity.js';
import { User } from '../users/user.entity.js';
import { KbShareController } from './kb-share.controller.js';
import { KbShareService } from './kb-share.service.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      User,
      KnowledgeBaseShare,
      KnowledgeBase,
      Chunk,
    ]),
  ],
  controllers: [KbShareController],
  providers: [KbShareService, KbAccessService, KbAccessGuard],
  exports: [KbAccessService, KbAccessGuard],
})
export class KbShareModule {}
