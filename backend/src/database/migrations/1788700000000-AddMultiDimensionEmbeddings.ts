import type { MigrationInterface, QueryRunner } from 'typeorm';

/** 增量迁移：不推断旧向量的模型来源，不改动 chunks.embedding。 */
export class AddMultiDimensionEmbeddings1788700000000 implements MigrationInterface {
  name = 'AddMultiDimensionEmbeddings1788700000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE embedding_profiles (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "ownerId" uuid NOT NULL, "modelId" uuid NOT NULL REFERENCES models(id) ON DELETE RESTRICT,
      provider varchar NOT NULL, "baseUrl" text NOT NULL, "modelName" text NOT NULL,
      dimension integer NOT NULL CONSTRAINT chk_embedding_profiles_dimension CHECK (dimension BETWEEN 1 AND 4000),
      "extraConfig" jsonb NOT NULL DEFAULT '{}', fingerprint varchar NOT NULL,
      "createdAt" timestamp NOT NULL DEFAULT now(),
      CONSTRAINT idx_embedding_profiles_owner_fingerprint UNIQUE ("ownerId", fingerprint),
      CONSTRAINT uq_embedding_profile_dimension UNIQUE (id, dimension)
    )`);
    await q.query(`ALTER TABLE knowledge_bases
      ADD COLUMN "activeEmbeddingProfileId" uuid REFERENCES embedding_profiles(id),
      ADD COLUMN "pendingEmbeddingProfileId" uuid REFERENCES embedding_profiles(id),
      ADD COLUMN "previousEmbeddingProfileId" uuid REFERENCES embedding_profiles(id)`);
    await q.query(`CREATE TABLE chunk_embeddings (
      "chunkId" uuid NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
      "kbId" uuid NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
      "profileId" uuid NOT NULL,
      dimension integer NOT NULL,
      "contentRevision" integer NOT NULL CHECK ("contentRevision" >= 0),
      embedding vector NOT NULL CHECK (vector_dims(embedding) = dimension),
      "createdAt" timestamp NOT NULL DEFAULT now(), "updatedAt" timestamp NOT NULL DEFAULT now(),
      PRIMARY KEY ("chunkId", "profileId"),
      FOREIGN KEY ("profileId", dimension) REFERENCES embedding_profiles(id, dimension) ON DELETE RESTRICT
    )`);
    await q.query(
      `CREATE INDEX idx_chunk_embeddings_kb_profile ON chunk_embeddings ("kbId", "profileId")`,
    );
    await q.query(`CREATE TABLE embedding_jobs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "kbId" uuid NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
      "knowledgeId" uuid, "chunkId" uuid,
      "profileId" uuid REFERENCES embedding_profiles(id),
      status varchar NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed')),
      "dispatchedAt" timestamp, error text,
      "createdAt" timestamp NOT NULL DEFAULT now(), "updatedAt" timestamp NOT NULL DEFAULT now()
    )`);
    await q.query(
      `CREATE INDEX idx_embedding_jobs_dispatch ON embedding_jobs (status, "dispatchedAt")`,
    );
    await q.query(`CREATE UNIQUE INDEX idx_embedding_jobs_pending_document ON embedding_jobs ("kbId", "knowledgeId")
      WHERE "profileId" IS NULL AND status = 'pending'`);
    // 插入时与 profile 切换共用 KB 行锁。编辑必须在应用 UPDATE 之前锁 KB，
    // 不能在 UPDATE 行级触发器中锁 KB（目标 chunk 行已锁定，会导致反向死锁）。
    await q.query(`CREATE FUNCTION lock_chunk_embedding_binding() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM id FROM knowledge_bases WHERE id = NEW."kbId" FOR SHARE;
        RETURN NEW;
      END $$`);
    await q.query(`CREATE TRIGGER lock_chunk_embedding_binding BEFORE INSERT ON chunks
      FOR EACH ROW EXECUTE FUNCTION lock_chunk_embedding_binding()`);
    // 每个 SQL 语句按文档合并 outbox；不为每个 chunk 创建一个队列任务。
    await q.query(`CREATE FUNCTION enqueue_inserted_chunk_embeddings() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        INSERT INTO embedding_jobs ("kbId", "knowledgeId")
          SELECT DISTINCT "kbId", "knowledgeId" FROM inserted_chunks
          ON CONFLICT ("kbId", "knowledgeId") WHERE "profileId" IS NULL AND status='pending'
          DO UPDATE SET "updatedAt"=now();
        RETURN NULL;
      END $$`);
    await q.query(`CREATE TRIGGER enqueue_inserted_chunk_embeddings AFTER INSERT ON chunks
      REFERENCING NEW TABLE AS inserted_chunks FOR EACH STATEMENT EXECUTE FUNCTION enqueue_inserted_chunk_embeddings()`);
    await q.query(`CREATE FUNCTION enqueue_updated_chunk_embeddings() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        INSERT INTO embedding_jobs ("kbId", "knowledgeId")
          SELECT DISTINCT n."kbId", n."knowledgeId" FROM updated_chunks n JOIN old_chunks o ON n.id=o.id
          WHERE n."contentRevision" IS DISTINCT FROM o."contentRevision"
          ON CONFLICT ("kbId", "knowledgeId") WHERE "profileId" IS NULL AND status='pending'
          DO UPDATE SET "updatedAt"=now();
        RETURN NULL;
      END $$`);
    await q.query(`CREATE TRIGGER enqueue_updated_chunk_embeddings AFTER UPDATE ON chunks
      REFERENCING NEW TABLE AS updated_chunks OLD TABLE AS old_chunks
      FOR EACH STATEMENT EXECUTE FUNCTION enqueue_updated_chunk_embeddings()`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(
      'DROP TRIGGER IF EXISTS enqueue_updated_chunk_embeddings ON chunks',
    );
    await q.query(
      'DROP TRIGGER IF EXISTS enqueue_inserted_chunk_embeddings ON chunks',
    );
    await q.query(
      'DROP TRIGGER IF EXISTS lock_chunk_embedding_binding ON chunks',
    );
    await q.query('DROP FUNCTION IF EXISTS enqueue_updated_chunk_embeddings()');
    await q.query(
      'DROP FUNCTION IF EXISTS enqueue_inserted_chunk_embeddings()',
    );
    await q.query('DROP FUNCTION IF EXISTS lock_chunk_embedding_binding()');
    await q.query('DROP TABLE embedding_jobs');
    await q.query('DROP TABLE chunk_embeddings');
    await q.query(`ALTER TABLE knowledge_bases DROP COLUMN "activeEmbeddingProfileId",
      DROP COLUMN "pendingEmbeddingProfileId", DROP COLUMN "previousEmbeddingProfileId"`);
    await q.query('DROP TABLE embedding_profiles');
  }
}
