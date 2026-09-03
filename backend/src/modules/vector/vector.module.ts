// 向量模块（Task 1.6）：VectorService（pgvector 读写 + 向量/关键词/混合检索）。
// 被 KbModule（hybrid-search 端点）与 ParseModule（EmbedProcessor 批量 upsert）
// 消费；本模块只依赖 ModelModule（查询向量化，见 hybridSearch），模块依赖
// 方向单向无环。检索全部走原生 SQL（DataSource.query），无需注册实体仓库。
import { Module } from '@nestjs/common';
import { ModelModule } from '../model/model.module.js';
import { VectorService } from './vector.service.js';

@Module({
  imports: [ModelModule],
  providers: [VectorService],
  exports: [VectorService],
})
export class VectorModule {}
