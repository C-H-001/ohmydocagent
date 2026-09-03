// 知识库模块（Task 1.1 + Task 1.10）：KB CRUD + 用户级置顶 + 用户级收藏 + 最近访问
// + 复制 + 统计。
// Task 1.2：KB 删除级联需要 KnowledgeService（事务内删文档行）与
// StorageService（事务外清理磁盘目录），故 imports KnowledgeModule/StorageModule；
// KnowledgeModule 不依赖本模块（文档模块 KB 存在性校验直查表），依赖方向单向无环
// Task 1.6：hybrid-search 端点消费 VectorService（向量/关键词/混合检索），
// VectorModule 只依赖 ModelModule，无环
// Task 1.10：user_kb_favorites/user_kb_recents 两张关系表加入 forFeature
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GraphModule } from '../graph/graph.module.js';
import { KnowledgeModule } from '../knowledge/knowledge.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { VectorModule } from '../vector/vector.module.js';
import { KbController } from './kb.controller.js';
import { KnowledgeBase } from './kb.entity.js';
import { KbShareModule } from '../kb-share/kb-share.module.js';
import { KbService } from './kb.service.js';
import { UserKbFavorite } from './user-kb-favorite.entity.js';
import { UserKbPin } from './user-kb-pin.entity.js';
import { UserKbRecent } from './user-kb-recent.entity.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      KnowledgeBase,
      UserKbPin,
      UserKbFavorite,
      UserKbRecent,
    ]),
    KnowledgeModule,
    StorageModule,
    // Task 3.2：GraphRepository（KB 删除后清空该 KB 的 Neo4j 图谱子图，见
    // KbService.remove 注释）。KbModule → GraphModule 无环（GraphModule 不依赖
    // KbModule）
    GraphModule,
    // Task 1.6：hybrid-search 端点（KbController 注入 VectorService）
    VectorModule,
    // 可见性过滤（用户需求）：KbAccessService（创建者 ∪ 共享）——
    // KbShareModule 导出 KbAccessService，KbModule 注入使用（无环：
    // KbShareModule 不依赖 KbModule）
    KbShareModule,
  ],
  controllers: [KbController],
  providers: [KbService],
  exports: [KbService],
})
export class KbModule {}
