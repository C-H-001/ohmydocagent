import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { DataSource } from 'typeorm';
import { EMBED_QUEUE } from './parse-queue.constants.js';
import type { EmbedJob } from './parse-queue.constants.js';
import { EmbeddingIndexingService } from '../vector/embedding-indexing.service.js';
import { KnowledgeProgressService } from '../knowledge/knowledge-progress.service.js';

/** 持久化任务消费；旧队列载荷映射为文档 outbox，兼容升级前的队列。 */
@Processor(EMBED_QUEUE)
export class EmbedProcessor extends WorkerHost {
  constructor(
    private readonly ds: DataSource,
    private readonly indexer: EmbeddingIndexingService,
    private readonly progress: KnowledgeProgressService,
  ) {
    super();
  }

  async process(job: Job<EmbedJob>): Promise<{ embedded: number }> {
    if ('embeddingJobId' in job.data)
      return this.processDurable(job.data.embeddingJobId);
    const source =
      'chunkId' in job.data
        ? await this.ds.query<{ kbId: string; knowledgeId: string }[]>(
            'SELECT "kbId","knowledgeId" FROM chunks WHERE id=$1',
            [job.data.chunkId],
          )
        : await this.ds.query<{ kbId: string; knowledgeId: string }[]>(
            'SELECT "kbId",id AS "knowledgeId" FROM knowledge WHERE id=$1',
            [job.data.knowledgeId],
          );
    if (!source.length) return { embedded: 0 };
    const { kbId, knowledgeId } = source[0];
    const [task] = await this.ds.query<{ id: string }[]>(
      `INSERT INTO embedding_jobs ("kbId","knowledgeId") VALUES ($1,$2)
      ON CONFLICT ("kbId","knowledgeId") WHERE "profileId" IS NULL AND status='pending'
      DO UPDATE SET "updatedAt"=now() RETURNING id`,
      [kbId, knowledgeId],
    );
    return this.processDurable(task.id);
  }

  private async processDurable(taskId: string): Promise<{ embedded: number }> {
    const [task] = await this.ds.query<
      {
        knowledgeId: string | null;
        profileId: string | null;
        status: string;
        activeEmbeddingProfileId: string | null;
      }[]
    >(
      `SELECT j."knowledgeId",j."profileId",j.status,kb."activeEmbeddingProfileId"
       FROM embedding_jobs j JOIN knowledge_bases kb ON kb.id=j."kbId" WHERE j.id=$1`,
      [taskId],
    );
    if (!task || task.status === 'done') return { embedded: 0 };
    const knowledgeId =
      !task.profileId || task.profileId === task.activeEmbeddingProfileId
        ? task.knowledgeId
        : null;
    if (knowledgeId)
      await this.progress
        .updateProgress(knowledgeId, {
          stage: {
            stage: 'embed',
            status: 'running',
            at: new Date().toISOString(),
          },
        })
        .catch(() => undefined);
    try {
      const result = await this.indexer.processJob(taskId);
      if (knowledgeId)
        await this.progress
          .updateProgress(knowledgeId, {
            stage: {
              stage: 'embed',
              status: 'done',
              at: new Date().toISOString(),
            },
          })
          .catch(() => undefined);
      return result;
    } catch (error) {
      if (knowledgeId)
        await this.progress
          .updateProgress(knowledgeId, {
            stage: {
              stage: 'embed',
              status: 'failed',
              detail: '向量化失败，可重试或检查知识库向量配置',
              at: new Date().toISOString(),
            },
          })
          .catch(() => undefined);
      throw error;
    }
  }
}
