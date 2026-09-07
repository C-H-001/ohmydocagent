import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { ChunkService } from '../dist/modules/chunk/chunk.service.js';
import { testUrl, uuid, withDatabase } from './helpers/multidim-db.mjs';

test(
  '双连接交错：切换持有 KB 锁时，编辑不能先锁住 chunk 造成死锁',
  { skip: !testUrl, timeout: 10000 },
  async () =>
    withDatabase(async (ds) => {
      const kb = uuid(1),
        chunk = uuid(2),
        owner = uuid(3),
        doc = uuid(4);
      await ds.query(
        'INSERT INTO knowledge_bases(id,"creatorId") VALUES ($1,$2)',
        [kb, owner],
      );
      await ds.query(
        'INSERT INTO chunks(id,"kbId","knowledgeId",content) VALUES ($1,$2,$3,\'原文\')',
        [chunk, kb, doc],
      );
      const service = new ChunkService(null, null, null, ds);
      const switching = ds.createQueryRunner();
      await switching.connect();
      await switching.startTransaction();
      let editing;
      try {
        await switching.query(
          'SELECT id FROM knowledge_bases WHERE id=$1 FOR UPDATE',
          [kb],
        );
        editing = service.updateContent(chunk, '修改后的正文', owner);
        editing.catch(() => undefined);
        let blocked = false;
        for (let i = 0; i < 100; i++) {
          const [{ n }] = await ds.query(
            `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE application_name=$1 AND wait_event_type='Lock' AND pid<>pg_backend_pid()`,
            [ds.options.schema],
          );
          if (n > 0) {
            blocked = true;
            break;
          }
          await delay(10);
        }
        assert.ok(
          blocked,
          '确认编辑已经等待切换事务，避免依赖固定睡眠猜测时序',
        );
        await switching.query("SET LOCAL lock_timeout='200ms'");
        // 对应 activate/rollback 恢复新索引就绪状态的写操作。
        await switching.query(
          'UPDATE chunks SET "indexStatus"=\'ready\' WHERE id=$1',
          [chunk],
        );
        await switching.commitTransaction();
        const result = await editing;
        assert.equal(result.contentRevision, 1);
        assert.equal(result.content, '修改后的正文');
      } finally {
        if (switching.isTransactionActive)
          await switching.rollbackTransaction();
        await switching.release();
        if (editing) await editing.catch(() => undefined);
      }
    }),
);
