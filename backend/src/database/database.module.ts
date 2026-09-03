// backend/src/database/database.module.ts
// TypeORM 连接 PostgreSQL（paradedb/pgvector），实体列表随任务扩展
import { Module, OnModuleInit } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { entities } from './entities.js';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        host: config.get('database.host'),
        port: config.get('database.port'),
        username: config.get('database.username'),
        password: config.get('database.password'),
        database: config.get('database.database'),
        entities,
        // 同步开关由 DB_SYNC 显式控制（默认 false），生产环境必须为 false 并走 migration（P5 启用）
        synchronize: config.get('database.synchronize'),
        // pgvector HNSW 查询精度（参考 WeKnora HNSW M=32 的检索侧 ef_search）：
        // 每连接初始化时应用（pg 连接 options GUC），ef_search 越大召回越全、
        // 延迟越高（默认 40，见 hnsw.index 注释）
        extra: {
          options: `-c hnsw.ef_search=${config.get('database.hnswEfSearch') ?? 40}`,
        },
      }),
    }),
    // forFeature 注册实体仓库 provider（forRootAsync 只注册 DataSource），
    // 测试通过 getRepositoryToken(ProbeEntity) 取到真实仓库执行原生查询。
    TypeOrmModule.forFeature(entities),
  ],
  exports: [TypeOrmModule],
})
export class DatabaseModule implements OnModuleInit {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * 兜底确保 pgvector 扩展存在（Task 1.6）：幂等 CREATE EXTENSION IF NOT
   * EXISTS，开发库/测试库（ohmydocagent_test 由 e2e 自动 CREATE DATABASE）都覆盖。
   * 实测结论：TypeORM 1.1.0 在 synchronize 前会自动执行该语句（afterConnect →
   * checkMetadataForExtensions，见 PostgresDriver.js），且本地 template1 已预装
   * vector（新建库自动继承）——本兜底是双保险：覆盖 synchronize=false 的
   * 生产 migration 场景（届时自动建扩展的逻辑不执行，migration 前先手动建）。
   * 不抛错：扩展缺失时向量功能不可用，但基础 CRUD 不应被拖垮（后续检索
   * 查询撞缺扩展错误会自然暴露）。
   */
  async onModuleInit(): Promise<void> {
    try {
      await this.dataSource.query('CREATE EXTENSION IF NOT EXISTS vector');
    } catch (err) {
      // 幂等语句失败（权限/版本问题）仅记日志不阻断启动
      console.warn('pgvector 扩展确保失败（向量功能将不可用）:', err);
    }
  }
}
