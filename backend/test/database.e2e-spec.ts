// backend/test/database.e2e-spec.ts
// e2e：验证 TypeORM 能连上 PostgreSQL，且 pgvector 扩展存在
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AppModule } from '../src/app.module.js';
import { ProbeEntity } from '../src/database/probe.entity.js';
import { prepareTestEnv } from './test-db.js';

describe('Database (e2e)', () => {
  let app: INestApplication;
  beforeAll(async () => {
    // 统一走测试库 ohmydocagent_test：先确保数据库存在，再创建 TestingModule
    await prepareTestEnv();
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });
  afterAll(async () => {
    await app.close();
  });

  it('TypeORM 可执行原生查询（pgvector 扩展存在）', async () => {
    const repo = app.get(getRepositoryToken(ProbeEntity));
    const rows = await repo.query(
      `SELECT extname FROM pg_extension WHERE extname='vector'`,
    );
    expect(rows.length).toBe(1);
  });

  it('数据库连接可用（SELECT 1）', async () => {
    const repo = app.get(getRepositoryToken(ProbeEntity));
    const rows = await repo.query(`SELECT 1 AS one`);
    expect(rows[0].one).toBe(1);
  });
});
