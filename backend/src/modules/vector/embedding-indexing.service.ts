import { Injectable } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import { EmbeddingProfileService } from '../model/embedding-profile.service.js';
import { EmbeddingBindingService } from './embedding-binding.service.js';
import { EmbeddingIndexService } from './embedding-index.service.js';

export interface EmbeddingBatchItem {
  chunkId: string;
  contentRevision: number;
  vector: number[];
}

interface Job {
  id: string;
  kbId: string;
  knowledgeId: string | null;
  chunkId: string | null;
  profileId: string | null;
  status: string;
}

interface Binding {
  activeEmbeddingProfileId: string | null;
  pendingEmbeddingProfileId: string | null;
  previousEmbeddingProfileId: string | null;
}

interface ChunkVersion {
  id: string;
  content: string;
  contentRevision: number;
}

type Profile = { id: string; dimension: number };
type Sql = Pick<DataSource, 'query'> | Pick<EntityManager, 'query'>;
const FAILURE_MESSAGE = '向量化失败，请检查模型配置或重试';
const BATCH_SIZE = 10;
const MAX_BATCHES = 100;

@Injectable()
export class EmbeddingIndexingService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly profiles: EmbeddingProfileService,
    private readonly bindings: EmbeddingBindingService,
    private readonly indexes: EmbeddingIndexService,
  ) {}

  async processJob(jobId: string): Promise<{ embedded: number }> {
    let embedded = 0;
    let job: Job | undefined;
    try {
      [job] = await this.dataSource.query<Job[]>(
        'SELECT * FROM embedding_jobs WHERE id=$1',
        [jobId],
      );
      if (!job || job.status === 'done') return { embedded };
      // running 也可重入：worker 崩溃后 BullMQ 重试依赖已提交向量去重。
      // TypeORM PostgreSQL 的 UPDATE RETURNING 返回 [rows, affected]。
      const [started] = await this.dataSource.query<[{ id: string }[], number]>(
        `UPDATE embedding_jobs SET status='running', error=NULL, "updatedAt"=now()
         WHERE id=$1 AND status <> 'done' RETURNING id`,
        [jobId],
      );
      if (started.length === 0) return { embedded };
      let targets: Profile[];
      if (job.profileId) {
        const kb = await this.readBinding(this.dataSource, job.kbId);
        targets = this.isBound(kb, job.profileId)
          ? [await this.profiles.getProfile(job.profileId)]
          : [];
      } else {
        targets = await this.bindings.ensureWritableProfiles(job.kbId);
      }
      // 一个 job 的额度由全部 profile 共享，最多 100 次外部批量请求。
      targets = [
        ...new Map(targets.map((profile) => [profile.id, profile])).values(),
      ];
      let batches = 0;
      const failedProfiles = new Set<string>();
      for (const profile of targets) {
        if (batches >= MAX_BATCHES) break;
        try {
          if (
            !this.isBound(
              await this.readBinding(this.dataSource, job.kbId),
              profile.id,
            )
          )
            continue;
          await this.indexes.ensure(profile.dimension);
          while (batches < MAX_BATCHES) {
            if (
              !this.isBound(
                await this.readBinding(this.dataSource, job.kbId),
                profile.id,
              )
            )
              break;
            const chunks = await this.missingChunks(
              this.dataSource,
              job,
              profile.id,
              BATCH_SIZE,
            );
            if (chunks.length === 0) break;
            batches++;
            // 网络调用不能持有数据库事务/行锁；writeBatch 重新验证 binding 和版本。
            const { vectors } = await this.profiles.embed(
              profile.id,
              chunks.map((chunk) => chunk.content),
            );
            if (!Array.isArray(vectors) || vectors.length !== chunks.length)
              throw new Error(FAILURE_MESSAGE);
            embedded += await this.writeBatch(
              job.kbId,
              profile.id,
              profile.dimension,
              chunks.map((chunk, i) => ({
                chunkId: chunk.id,
                contentRevision: chunk.contentRevision,
                vector: vectors[i],
              })),
            );
          }
        } catch {
          // 单个空间故障不阻塞其他绑定；只记 profile ID，不保留上游异常。
          // 已提交批次保留，下一次 job 重试通过版本缺口查询继续。
          failedProfiles.add(profile.id);
        }
      }
      if (failedProfiles.size > 0) {
        // 后续 profile 工作期间也可能取消旧 binding；只聚合仍绑定的故障。
        const kb = await this.readBinding(this.dataSource, job.kbId);
        if (
          [...failedProfiles].some((profileId) => this.isBound(kb, profileId))
        ) {
          // 包括额度耗尽的情况：由失败 job 自身重试，不额外创建重复续建任务。
          throw new Error(FAILURE_MESSAGE);
        }
      }
      await this.finish(job, targets, batches >= MAX_BATCHES);
      return { embedded };
    } catch {
      // 取消中的外部请求也可能失败；不得把已取消任务重新变为 failed。
      try {
        const [failed] = await this.dataSource.query<
          [{ id: string }[], number]
        >(
          `UPDATE embedding_jobs SET status='failed', error=$2, "updatedAt"=now()
           WHERE id=$1 AND status <> 'done' RETURNING id`,
          [jobId, FAILURE_MESSAGE],
        );
        if (failed.length === 0) return { embedded };
      } catch {
        // 记录失败也可能因数据库不可用而失败，仍以固定脱敏异常触发队列重试。
      }
      throw new Error(FAILURE_MESSAGE);
    }
  }

  async writeBatch(
    kbId: string,
    profileId: string,
    dimension: number,
    items: EmbeddingBatchItem[],
  ): Promise<number> {
    this.validateBatch(dimension, items);
    if (items.length === 0) return 0;
    return this.dataSource.transaction(async (manager) => {
      const kb = await this.readBinding(manager, kbId, true);
      if (!this.isBound(kb, profileId)) return 0;
      // 固定锁序避免同一批乱序输入导致交叉加锁；KB 锁阻止绑定切换。
      const locked = await manager.query<ChunkVersion[]>(
        `SELECT id, "contentRevision" FROM chunks
         WHERE "kbId"=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE`,
        [kbId, items.map((item) => item.chunkId)],
      );
      const revisions = new Map(
        locked.map((chunk) => [chunk.id, chunk.contentRevision]),
      );
      const current = items.filter(
        (item) => revisions.get(item.chunkId) === item.contentRevision,
      );
      if (current.length === 0) return 0;
      const payload = current.map((item) => ({
        chunkId: item.chunkId,
        contentRevision: item.contentRevision,
        vector: JSON.stringify(item.vector),
      }));
      const written = await manager.query<
        { chunkId: string; contentRevision: number }[]
      >(
        `INSERT INTO chunk_embeddings
           ("chunkId", "kbId", "profileId", dimension, "contentRevision", embedding)
         SELECT c.id, $1, $2, $3, v."contentRevision", v.vector::vector
         FROM jsonb_to_recordset($4::jsonb)
           AS v("chunkId" uuid, "contentRevision" integer, vector text)
         JOIN chunks c ON c.id=v."chunkId" AND c."contentRevision"=v."contentRevision"
         WHERE c."kbId"=$1
         ON CONFLICT ("chunkId", "profileId") DO UPDATE
         SET dimension=EXCLUDED.dimension, "contentRevision"=EXCLUDED."contentRevision",
             embedding=EXCLUDED.embedding, "updatedAt"=now()
         WHERE chunk_embeddings."contentRevision" < EXCLUDED."contentRevision"
         RETURNING "chunkId", "contentRevision"`,
        [kbId, profileId, dimension, JSON.stringify(payload)],
      );
      if (kb?.activeEmbeddingProfileId === profileId && written.length > 0) {
        await manager.query(
          `UPDATE chunks c SET "indexStatus"='ready', "updatedAt"=now()
           FROM jsonb_to_recordset($2::jsonb) AS v("chunkId" uuid, "contentRevision" integer)
           WHERE c.id=v."chunkId" AND c."kbId"=$1 AND c."contentRevision"=v."contentRevision"`,
          [kbId, JSON.stringify(written)],
        );
      }
      return written.length;
    });
  }

  private validateBatch(dimension: number, items: EmbeddingBatchItem[]): void {
    if (
      !Number.isInteger(dimension) ||
      dimension < 1 ||
      dimension > 4000 ||
      !Array.isArray(items)
    ) {
      throw new Error(FAILURE_MESSAGE);
    }
    const seen = new Set<string>();
    for (const item of items) {
      if (
        !item ||
        typeof item.chunkId !== 'string' ||
        !item.chunkId ||
        seen.has(item.chunkId) ||
        !Number.isSafeInteger(item.contentRevision) ||
        item.contentRevision < 0 ||
        !Array.isArray(item.vector) ||
        item.vector.length !== dimension
      )
        throw new Error(FAILURE_MESSAGE);
      seen.add(item.chunkId);
      let nonzero = false;
      // for..of 同时拒绝稀疏数组，不能用会跳过空槽的 every。
      for (const value of item.vector) {
        if (typeof value !== 'number' || !Number.isFinite(value))
          throw new Error(FAILURE_MESSAGE);
        nonzero ||= value !== 0;
      }
      if (!nonzero) throw new Error(FAILURE_MESSAGE);
    }
  }

  private async readBinding(
    sql: Sql,
    kbId: string,
    lock = false,
  ): Promise<Binding | undefined> {
    const rows: Binding[] = await sql.query(
      `SELECT "activeEmbeddingProfileId", "pendingEmbeddingProfileId", "previousEmbeddingProfileId"
       FROM knowledge_bases WHERE id=$1${lock ? ' FOR SHARE' : ''}`,
      [kbId],
    );
    return rows[0];
  }

  private isBound(kb: Binding | undefined, profileId: string): boolean {
    return (
      !!kb &&
      [
        kb.activeEmbeddingProfileId,
        kb.pendingEmbeddingProfileId,
        kb.previousEmbeddingProfileId,
      ].includes(profileId)
    );
  }

  private async missingChunks(
    sql: Sql,
    job: Job,
    profileId: string,
    limit: number,
  ): Promise<ChunkVersion[]> {
    return sql.query(
      `SELECT c.id, c.content, c."contentRevision" FROM chunks c
       LEFT JOIN chunk_embeddings e ON e."chunkId"=c.id AND e."kbId"=c."kbId"
         AND e."profileId"=$2 AND e."contentRevision"=c."contentRevision"
       WHERE c."kbId"=$1 AND ($3::uuid IS NULL OR c."knowledgeId"=$3)
         AND ($4::uuid IS NULL OR c.id=$4) AND e."chunkId" IS NULL
       ORDER BY c.id LIMIT $5`,
      [job.kbId, profileId, job.knowledgeId, job.chunkId, limit],
    );
  }

  /** 在同一事务安排余量并完成当前任务；冲突在 SQL 内处理，避免 23505 中止事务。 */
  private async finish(
    job: Job,
    targets: Profile[],
    checkRemaining: boolean,
  ): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const kb = await this.readBinding(manager, job.kbId, true);
      const jobs = await manager.query<Job[]>(
        'SELECT * FROM embedding_jobs WHERE id=$1 FOR UPDATE',
        [job.id],
      );
      if (!jobs[0] || jobs[0].status === 'done') return;
      if (checkRemaining && kb) {
        for (const profile of targets) {
          if (!this.isBound(kb, profile.id)) continue;
          if (
            (await this.missingChunks(manager, job, profile.id, 1)).length === 0
          )
            continue;
          await manager.query(
            `INSERT INTO embedding_jobs ("kbId", "knowledgeId", "chunkId", "profileId", status)
             VALUES ($1, $2, $3, $4, 'pending')
             ON CONFLICT ("kbId", "knowledgeId") WHERE "profileId" IS NULL AND status='pending'
             DO UPDATE SET "updatedAt"=now(),
               "chunkId"=CASE WHEN embedding_jobs."chunkId" IS NOT DISTINCT FROM EXCLUDED."chunkId"
                 THEN embedding_jobs."chunkId" ELSE NULL END`,
            [job.kbId, job.knowledgeId, job.chunkId, job.profileId],
          );
          break;
        }
      }
      await manager.query(
        `UPDATE embedding_jobs SET status='done', error=NULL, "updatedAt"=now()
         WHERE id=$1 AND status <> 'done'`,
        [job.id],
      );
    });
  }
}
