// backend/src/database/data-source.ts
// TypeORM CLI 数据源（migration 生成/运行用）：
//   npm run migration:generate -- src/database/migrations/InitSchema
//   npm run migration:run
//   npm run migration:revert
// 说明：CLI 直连 .env 配置的库；生产在部署时对正式库执行 migration:run。
// 注意：migration:generate 会对比数据库当前 schema 与实体差异——应针对
// **空库/基线库**生成，避免把历史 synchronize 状态混入（见 scripts 说明）。
import 'dotenv/config';
import { DataSource } from 'typeorm';
import { entities } from './entities.js';

export default new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST ?? '127.0.0.1',
  port: parseInt(process.env.DB_PORT ?? '5432', 10),
  username: process.env.DB_USER ?? 'ohmydocagent',
  password: process.env.DB_PASSWORD ?? 'ohmydocagent',
  database: process.env.DB_NAME ?? 'ohmydocagent',
  entities,
  migrations: ['src/database/migrations/*.ts'],
  // 生产 migration 由 CLI/部署脚本显式执行；应用内 synchronize 由 DB_SYNC 控制
});
