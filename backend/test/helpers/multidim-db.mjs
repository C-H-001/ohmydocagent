import 'reflect-metadata';
import pg from 'pg';
import { DataSource } from 'typeorm';
import { Model } from '../../dist/modules/model/model.entity.js';
import { EmbeddingProfile } from '../../dist/modules/model/embedding-profile.entity.js';
import { Chunk } from '../../dist/modules/chunk/chunk.entity.js';
import { ChunkRevision } from '../../dist/modules/chunk/chunk-revision.entity.js';
import { AddMultiDimensionEmbeddings1788700000000 } from '../../dist/database/migrations/1788700000000-AddMultiDimensionEmbeddings.js';

export const testUrl = process.env.MULTIDIM_TEST_DATABASE_URL;
export const uuid = (n) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export async function withDatabase(fn) {
  const schema = `embedding_test_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  const admin = new pg.Client({ connectionString: testUrl });
  await admin.connect();
  let ds;
  try {
    await admin.query('CREATE EXTENSION IF NOT EXISTS vector');
    await admin.query(`CREATE SCHEMA ${schema}`);
    ds = new DataSource({
      type: 'postgres',
      url: testUrl,
      schema,
      entities: [Model, EmbeddingProfile, Chunk, ChunkRevision],
      synchronize: false,
      extra: {
        options: `-c search_path=${schema},public`,
        application_name: schema,
      },
      logging: ['error'],
      logger: {
        logQueryError: (error, sql) =>
          console.error(
            '临时测试库 SQL 错误:',
            String(error),
            sql.slice(0, 120),
          ),
        logQuery() {},
        logQuerySlow() {},
        logSchemaBuild() {},
        logMigration() {},
        log() {},
      },
    });
    await ds.initialize();
    await ds.query(`CREATE TABLE users(id uuid PRIMARY KEY,role text NOT NULL);
      CREATE TABLE models(id uuid PRIMARY KEY,name varchar NOT NULL,provider varchar NOT NULL,"baseUrl" text NOT NULL,
        "apiKeyEncrypted" text NOT NULL DEFAULT '',"modelName" varchar NOT NULL,type varchar NOT NULL,
        enabled boolean NOT NULL DEFAULT true,"userId" uuid,"isDefault" boolean NOT NULL DEFAULT false,
        "extraConfig" jsonb NOT NULL DEFAULT '{}',"createdAt" timestamp DEFAULT now(),"updatedAt" timestamp DEFAULT now());
      CREATE TABLE knowledge_bases(id uuid PRIMARY KEY,"creatorId" uuid NOT NULL,"embeddingModelId" uuid);
      CREATE TABLE knowledge(id uuid PRIMARY KEY,"kbId" uuid NOT NULL,status varchar DEFAULT 'ready');
      CREATE TABLE knowledge_base_shares("kbId" uuid,"userId" uuid);
      CREATE TABLE chunks(id uuid PRIMARY KEY,"kbId" uuid NOT NULL,"knowledgeId" uuid NOT NULL,content text NOT NULL,
        "contentRevision" integer NOT NULL DEFAULT 0,"indexStatus" text DEFAULT 'processing',embedding vector(1024),
        "sourceContent" text NOT NULL DEFAULT '',keywords text[] DEFAULT '{}',"startAt" integer DEFAULT 0,"endAt" integer DEFAULT 0,
        "preChunkId" uuid,"nextChunkId" uuid,
        "keywordText" text NOT NULL DEFAULT '',"chunkIndex" integer DEFAULT 0,type text DEFAULT 'text',"assetKey" text,"imageInfo" jsonb,
        "createdAt" timestamp DEFAULT now(),"updatedAt" timestamp DEFAULT now());
      CREATE TABLE chunk_revisions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),"chunkId" uuid,content text,revision integer,
        "editorId" uuid,"createdAt" timestamp DEFAULT now(),UNIQUE("chunkId",revision));`);
    await new AddMultiDimensionEmbeddings1788700000000().up({
      query: (sql, params) => ds.query(sql, params),
    });
    await fn(ds);
  } finally {
    if (ds?.isInitialized) await ds.destroy();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
}
