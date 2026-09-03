// backend/test/infra.e2e-spec.ts
// 基础设施连通性 e2e：Redis 与 Neo4j 接入层验证
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { AppModule } from '../src/app.module.js';
import { RedisService } from '../src/redis/redis.service.js';
import { Neo4jService } from '../src/neo4j/neo4j.service.js';
import { prepareTestEnv } from './test-db.js';

describe('Infra (e2e)', () => {
  let app: INestApplication;
  beforeAll(async () => {
    await prepareTestEnv(); // 统一走测试库环境（DB_NAME=ohmydocagent_test）
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });
  afterAll(async () => {
    await app.close();
  });

  it('RedisService.ping() 返回 PONG', async () => {
    const redis = app.get(RedisService);
    expect(await redis.ping()).toBe('PONG');
  });

  it('RedisService 可写入并读取（带测试前缀隔离）', async () => {
    const redis = app.get(RedisService);
    const key = `test:infra:${Date.now()}`;
    await redis.set(key, 'hello', 60);
    expect(await redis.get(key)).toBe('hello');
    await redis.del(key);
  });

  it('Neo4jService 可执行查询（RETURN 1 AS ok）', async () => {
    const neo4j = app.get(Neo4jService);
    const result = await neo4j.run('RETURN 1 AS ok');
    // neo4j-driver 对整数返回 Integer 对象，需 toNumber() 转 JS number
    expect(result.records[0].get('ok').toNumber()).toBe(1);
  });
});
