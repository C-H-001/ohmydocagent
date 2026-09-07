import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

// 仅连接显式提供的临时测试库，绝不加载应用 .env。
const url = process.env.MULTIDIM_TEST_DATABASE_URL;
test(
  '多维度迁移保留旧向量，约束维度与配置，并级联删除新向量',
  { skip: !url },
  async () => {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    const schema = `multidim_${Date.now()}`;
    try {
      await client.query('CREATE EXTENSION IF NOT EXISTS vector');
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET search_path TO ${schema}, public`);
      await client.query(`CREATE TABLE models (id uuid PRIMARY KEY);
      CREATE TABLE knowledge_bases (id uuid PRIMARY KEY, "creatorId" uuid, "embeddingModelId" uuid);
      CREATE TABLE chunks (id uuid PRIMARY KEY, "kbId" uuid, "knowledgeId" uuid,
        content text, "contentRevision" integer DEFAULT 0, "indexStatus" text DEFAULT 'processing', embedding vector(1024));`);
      const kb = '00000000-0000-4000-8000-000000000001';
      const chunk = '00000000-0000-4000-8000-000000000002';
      const model = '00000000-0000-4000-8000-000000000003';
      const owner = '00000000-0000-4000-8000-000000000004';
      const p1 = '00000000-0000-4000-8000-000000000005';
      const p2 = '00000000-0000-4000-8000-000000000006';
      const legacy = `[${[1, ...Array(1023).fill(0)].join(',')}]`;
      await client.query('INSERT INTO models VALUES ($1)', [model]);
      await client.query('INSERT INTO knowledge_bases VALUES ($1,$2,$3)', [
        kb,
        owner,
        model,
      ]);
      await client.query(
        'INSERT INTO chunks (id,"kbId",content,embedding) VALUES ($1,$2,$3,$4)',
        [chunk, kb, '正文', legacy],
      );
      const module =
        await import('../dist/database/migrations/1788700000000-AddMultiDimensionEmbeddings.js').catch(
          () => ({}),
        );
      assert.equal(
        typeof module.AddMultiDimensionEmbeddings1788700000000,
        'function',
        '必须提供多维度增量迁移',
      );
      const migration = new module.AddMultiDimensionEmbeddings1788700000000();
      const runner = {
        query: (sql, params) => client.query(sql, params).then((r) => r.rows),
      };
      await migration.up(runner);
      for (const [id, dimension] of [
        [p1, 768],
        [p2, 1536],
      ]) {
        await client.query(
          `INSERT INTO embedding_profiles
        (id,"ownerId","modelId",provider,"baseUrl","modelName",dimension,"extraConfig",fingerprint)
        VALUES ($1::uuid,$2,$3,'openai-compatible','https://example.com','fixture',$4,'{}',($1::uuid)::text)`,
          [id, owner, model, dimension],
        );
        const vec = `[${[1, ...Array(dimension - 1).fill(0)].join(',')}]`;
        await client.query(
          `INSERT INTO chunk_embeddings ("chunkId","kbId","profileId",dimension,"contentRevision",embedding)
        VALUES ($1,$2,$3,$4,0,$5::vector)`,
          [chunk, kb, id, dimension, vec],
        );
      }
      assert.deepEqual(
        (
          await client.query(
            'SELECT vector_dims(embedding) AS dim FROM chunk_embeddings ORDER BY dimension',
          )
        ).rows.map((r) => r.dim),
        [768, 1536],
      );
      assert.equal(
        (await client.query('SELECT vector_dims(embedding) AS dim FROM chunks'))
          .rows[0].dim,
        1024,
      );
      await assert.rejects(
        client.query(
          `UPDATE chunk_embeddings SET dimension=1024 WHERE "profileId"=$1`,
          [p1],
        ),
      );
      await assert.rejects(
        client.query(
          `UPDATE chunk_embeddings SET embedding='[1,0]'::vector WHERE "profileId"=$1`,
          [p2],
        ),
      );
      await client.query('DELETE FROM chunks WHERE id=$1', [chunk]);
      assert.equal(
        (await client.query('SELECT count(*)::int AS n FROM chunk_embeddings'))
          .rows[0].n,
        0,
      );
      await migration.down(runner);
      assert.equal(
        (await client.query("SELECT to_regclass('chunk_embeddings') AS name"))
          .rows[0].name,
        null,
      );
      assert.equal(
        (await client.query("SELECT to_regclass('chunks') AS name")).rows[0]
          .name,
        'chunks',
      );
    } finally {
      await client.query('SET search_path TO public');
      await client.query(`DROP SCHEMA ${schema} CASCADE`);
      await client.end();
    }
  },
);
