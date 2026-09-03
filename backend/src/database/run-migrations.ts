// backend/src/database/run-migrations.ts
// 生产迁移执行器：启动时应用待执行迁移（DB_SYNC=0 下表结构由 migration 管理）。
// 构建后产物 dist/database/run-migrations.js；Dockerfile CMD 启动前调用。
import 'dotenv/config';
import { DataSource } from 'typeorm';
import { entities } from './entities.js';

async function main() {
  const ds = new DataSource({
    type: 'postgres',
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: parseInt(process.env.DB_PORT ?? '5432', 10),
    username: process.env.DB_USER ?? 'ohmydocagent',
    password: process.env.DB_PASSWORD ?? 'ohmydocagent',
    database: process.env.DB_NAME ?? 'ohmydocagent',
    entities,
    migrations: ['dist/database/migrations/*.js'],
  });
  await ds.initialize();
  const pending = await ds.showMigrations();
  console.log(`[migration] 待执行迁移：${pending ? '有' : '无'}`);
  await ds.runMigrations();
  console.log('[migration] 完成');
  await ds.destroy();
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[migration] 失败：', err?.message ?? err);
    process.exit(1);
  });
