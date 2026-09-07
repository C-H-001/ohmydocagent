import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { DataSource } from 'typeorm';
import { Knowledge } from '../dist/modules/knowledge/knowledge.entity.js';
import { KnowledgeBase } from '../dist/modules/kb/kb.entity.js';
import { KnowledgeService } from '../dist/modules/knowledge/knowledge.service.js';

// Only use the explicitly configured isolated test database, never application .env.
const url = process.env.MULTIDIM_TEST_DATABASE_URL;
test('文档列表返回已记录的 Token，保留零值并继续隐藏正文和内部路径', { skip: !url }, async () => {
  const schema = `knowledge_list_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  let ds;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    ds = new DataSource({ type: 'postgres', url, schema, entities: [Knowledge, KnowledgeBase],
      synchronize: true, logging: false });
    await ds.initialize();
    const kbRepo = ds.getRepository(KnowledgeBase);
    const ownerId = randomUUID();
    const kb = await kbRepo.save(kbRepo.create({ name: 'Token list test', creatorId: ownerId }));
    const otherKb = await kbRepo.save(kbRepo.create({ name: 'Other KB', creatorId: ownerId }));
    const repo = ds.getRepository(Knowledge);
    const counted = await repo.save(repo.create({ kbId: kb.id, title: 'Recorded document', type: 'manual',
      status: 'ready', tokenCost: 13798, chunkCount: 22, createdAt: new Date('2026-09-02T02:00:00Z'),
      manualContent: 'private body', parsedText: 'private parsed text', summary: 'private summary',
      filePath: '/internal/fixture.txt', error: 'private diagnostics' }));
    const zero = await repo.save(repo.create({ kbId: kb.id, title: 'No recorded usage', type: 'manual',
      status: 'ready', tokenCost: 0, createdAt: new Date('2026-09-02T01:00:00Z') }));
    await repo.save(repo.create({ kbId: otherKb.id, title: 'Other document', type: 'manual', tokenCost: 99999 }));
    const service = new KnowledgeService(repo, undefined, undefined, undefined, undefined, ds,
      undefined, undefined, undefined, undefined);

    const result = await service.list(kb.id, { page: 1, pageSize: 10 });
    assert.equal(result.total, 2);
    assert.deepEqual(result.items.map(item => [item.id, item.tokenCost]), [[counted.id, 13798], [zero.id, 0]]);
    for (const item of result.items) {
      for (const field of ['manualContent', 'parsedText', 'summary', 'filePath', 'error', 'parserStages']) {
        assert.equal(JSON.stringify(item).includes(`"${field}":`), false, `List must not expose ${field}`);
      }
    }
    assert.equal((await repo.findOneByOrFail({ id: counted.id })).tokenCost, 13798);
    assert.equal((await repo.findOneByOrFail({ id: zero.id })).tokenCost, 0);
  } finally {
    if (ds?.isInitialized) await ds.destroy();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
