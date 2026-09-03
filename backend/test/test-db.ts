// backend/test/test-db.ts
// e2e 测试库隔离助手：
// 1. ensureTestDatabase()：幂等确保 ohmydocagent_test 数据库存在（直连 postgres 库创建）
// 2. prepareTestEnv()：e2e 的 beforeAll 先调用，再创建 TestingModule——
//    通过 process.env.DB_NAME 让 ConfigService/TypeORM 连到测试库，隔离开发数据
import { Client } from 'pg';

const TEST_DB_NAME = 'ohmydocagent_test';

/** 幂等创建 ohmydocagent_test：已存在则跳过，并发创建撞 duplicate_database 也容忍 */
export async function ensureTestDatabase(): Promise<void> {
  const client = new Client({
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: Number(process.env.DB_PORT ?? 5432),
    user: process.env.DB_USER ?? 'ohmydocagent',
    password: process.env.DB_PASSWORD ?? 'ohmydocagent',
    database: 'postgres',
  });
  await client.connect();
  try {
    const { rowCount } = await client.query(
      `SELECT 1 FROM pg_database WHERE datname = $1`,
      [TEST_DB_NAME],
    );
    if (rowCount === 0) {
      try {
        await client.query(`CREATE DATABASE ${TEST_DB_NAME}`);
      } catch (err) {
        // 并发下可能同时判定不存在并创建，撞 duplicate_database（SQLSTATE 42P04）时容忍
        if ((err as { code?: string }).code !== '42P04') throw err;
      }
    }
  } finally {
    await client.end();
  }
}

/**
 * e2e 前置：确保测试库存在并把应用指向它。
 * 必须在创建 TestingModule 之前调用——ConfigModule 加载 .env 时
 * dotenv 不会覆盖已存在的 process.env 变量（见 config.module.ts assignVariablesToProcess）。
 */
export async function prepareTestEnv(): Promise<void> {
  await ensureTestDatabase();
  process.env.DB_NAME = TEST_DB_NAME;
}
