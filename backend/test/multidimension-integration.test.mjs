import test from 'node:test';
import assert from 'node:assert/strict';
import { testUrl, uuid, withDatabase } from './helpers/multidim-db.mjs';
import { EmbeddingProfileService } from '../dist/modules/model/embedding-profile.service.js';
import { EmbeddingIndexService } from '../dist/modules/vector/embedding-index.service.js';
import { EmbeddingBindingService } from '../dist/modules/vector/embedding-binding.service.js';
import { EmbeddingIndexingService } from '../dist/modules/vector/embedding-indexing.service.js';
import { SearchScopeService } from '../dist/modules/vector/search-scope.service.js';
import { VectorService } from '../dist/modules/vector/vector.service.js';

test(
  '真实 PostgreSQL：多维度入库、共享鉴权、版本保护、重建切换和回滚',
  { skip: !testUrl },
  async () =>
    withDatabase(async (ds) => {
      const owner = uuid(1),
        other = uuid(2),
        viewer = uuid(3),
        m1 = uuid(11),
        m2 = uuid(12),
        m3 = uuid(13),
        kb1 = uuid(21),
        kb2 = uuid(22),
        doc1 = uuid(31),
        doc2 = uuid(32),
        c1 = uuid(41),
        c2 = uuid(42);
      await ds.query(
        `INSERT INTO users VALUES ($1,'member'),($2,'member'),($3,'member')`,
        [owner, other, viewer],
      );
      for (const [id, user, dim] of [
        [m1, owner, 768],
        [m2, other, 1536],
        [m3, owner, 1536],
      ]) {
        await ds.query(
          `INSERT INTO models(id,name,provider,"baseUrl","modelName",type,"userId","extraConfig","isDefault")
      VALUES ($1,'测试模型','openai-compatible','https://example.com','embedding-fixture','embedding',$2,$3,true)`,
          [id, user, { dimensions: dim }],
        );
      }
      await ds.query(
        'INSERT INTO knowledge_bases(id,"creatorId","embeddingModelId") VALUES ($1,$2,$3),($4,$5,$6)',
        [kb1, owner, m1, kb2, other, m2],
      );
      await ds.query(
        'INSERT INTO knowledge(id,"kbId") VALUES ($1,$2),($3,$4)',
        [doc1, kb1, doc2, kb2],
      );
      const calls = [];
      const profiles = new EmbeddingProfileService(ds, {
        create: (model) => ({
          embedWithUsage: async (texts) => {
            calls.push({
              modelId: model.id,
              dimension: model.extraConfig.dimensions,
              texts,
            });
            return {
              vectors: texts.map(() => [
                1,
                ...Array(model.extraConfig.dimensions - 1).fill(0),
              ]),
              totalTokens: texts.length,
            };
          },
        }),
      });
      const indexes = new EmbeddingIndexService(ds),
        bindings = new EmbeddingBindingService(ds, profiles, indexes);
      const indexer = new EmbeddingIndexingService(
        ds,
        profiles,
        bindings,
        indexes,
      );
      await ds.query(
        'INSERT INTO chunks(id,"kbId","knowledgeId",content) VALUES ($1,$2,$3,\'测试文本\'),($4,$5,$6,\'测试文本\')',
        [c1, kb1, doc1, c2, kb2, doc2],
      );
      const jobs = await ds.query(
        'SELECT id FROM embedding_jobs ORDER BY "kbId"',
      );
      assert.equal(jobs.length, 2, '多行插入按文档创建持久化任务');
      for (const job of jobs) await indexer.processJob(job.id);
      assert.deepEqual(
        (
          await ds.query(
            'SELECT dimension FROM chunk_embeddings ORDER BY dimension',
          )
        ).map((r) => r.dimension),
        [768, 1536],
      );
      const initial = await bindings.getState(kb1);
      assert.equal(initial.status, 'ready');
      assert.equal(initial.active.dimension, 768);
      const scopes = new SearchScopeService(ds);
      const vector = new VectorService(ds, profiles, scopes);
      await ds.query('INSERT INTO knowledge_base_shares VALUES ($1,$2)', [
        kb1,
        viewer,
      ]);
      const before = calls.length;
      await assert.rejects(
        vector.hybridSearch(
          [kb1, kb2],
          '测试',
          5,
          undefined,
          undefined,
          viewer,
        ),
        { status: 404 },
      );
      assert.equal(calls.length, before, '权限失败前不得调用供应商');
      await ds.query('INSERT INTO knowledge_base_shares VALUES ($1,$2)', [
        kb2,
        viewer,
      ]);
      const found = await vector.hybridSearch(
        [kb1, kb2],
        '测试',
        5,
        undefined,
        undefined,
        viewer,
      );
      assert.deepEqual(new Set(found.map((r) => r.kbId)), new Set([kb1, kb2]));
      assert.ok(calls.slice(before).some((c) => c.dimension === 768));
      assert.ok(calls.slice(before).some((c) => c.dimension === 1536));
      await ds.query(
        'UPDATE chunks SET content=\'新版文本\',"contentRevision"=1,"indexStatus"=\'processing\' WHERE id=$1',
        [c1],
      );
      assert.equal(
        await indexer.writeBatch(kb1, initial.active.id, 768, [
          {
            chunkId: c1,
            contentRevision: 0,
            vector: [1, ...Array(767).fill(0)],
          },
        ]),
        0,
        '旧响应不可写回新正文',
      );
      const revisionJobs = await ds.query(
        'SELECT id FROM embedding_jobs WHERE "kbId"=$1 AND status=\'pending\'',
        [kb1],
      );
      for (const job of revisionJobs) await indexer.processJob(job.id);
      assert.equal(
        (
          await ds.query(
            'SELECT "contentRevision" FROM chunk_embeddings WHERE "chunkId"=$1',
            [c1],
          )
        )[0].contentRevision,
        1,
      );
      const rebuilding = await bindings.startRebuild(kb1, owner, m3);
      assert.equal(rebuilding.active.dimension, 768);
      assert.equal(rebuilding.pending.dimension, 1536);
      await assert.rejects(bindings.activate(kb1, owner), { status: 409 });
      const [pendingJob] = await ds.query(
        'SELECT id FROM embedding_jobs WHERE "kbId"=$1 AND "profileId"=$2 AND status=\'pending\'',
        [kb1, rebuilding.pending.id],
      );
      await indexer.processJob(pendingJob.id);
      const switched = await bindings.activate(kb1, owner);
      assert.equal(switched.active.dimension, 1536);
      assert.equal(switched.previous.dimension, 768);
      await ds.query(
        'UPDATE chunks SET content=\'再次编辑\',"contentRevision"=2,"indexStatus"=\'processing\' WHERE id=$1',
        [c1],
      );
      for (const job of await ds.query(
        'SELECT id FROM embedding_jobs WHERE "kbId"=$1 AND status=\'pending\'',
        [kb1],
      ))
        await indexer.processJob(job.id);
      assert.deepEqual(
        (
          await ds.query(
            'SELECT "contentRevision" FROM chunk_embeddings WHERE "chunkId"=$1',
            [c1],
          )
        ).map((r) => r.contentRevision),
        [2, 2],
        '回滚窗口内新旧配置都应追平正文修改',
      );
      assert.equal((await bindings.rollback(kb1, owner)).active.dimension, 768);
      await assert.rejects(bindings.startRebuild(kb1, viewer, m3), {
        status: 403,
      });
      await ds.query('DELETE FROM chunks WHERE id=$1', [c1]);
      assert.equal(
        (
          await ds.query(
            'SELECT count(*)::int AS n FROM chunk_embeddings WHERE "chunkId"=$1',
            [c1],
          )
        )[0].n,
        0,
      );
    }),
);
