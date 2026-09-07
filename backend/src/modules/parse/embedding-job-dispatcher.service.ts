import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { DataSource } from 'typeorm';
import { Queue } from 'bullmq';
import { EMBED_QUEUE } from './parse-queue.constants.js';

/** PostgreSQL outbox → BullMQ。服务重启和 Redis 短暂不可用不会丢失已提交分块。 */
@Injectable()
export class EmbeddingJobDispatcher
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(EmbeddingJobDispatcher.name);
  private timer?: ReturnType<typeof setInterval>;
  private dispatching = false;
  constructor(
    private readonly ds: DataSource,
    @InjectQueue(EMBED_QUEUE) private readonly queue: Queue,
  ) {}

  onApplicationBootstrap() {
    this.timer = setInterval(
      () =>
        void this.dispatch().catch(() =>
          this.logger.warn('向量任务投递失败，将自动重试'),
        ),
      2000,
    );
    this.timer.unref();
  }
  onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
  }

  async dispatch(): Promise<void> {
    if (this.dispatching) return;
    this.dispatching = true;
    try {
      const rows = await this.ds.query<
        { id: string; status: string }[]
      >(`SELECT id,status FROM embedding_jobs
        WHERE (status='pending' AND ("dispatchedAt" IS NULL OR "dispatchedAt"<now()-interval '30 seconds'))
          OR (status='running' AND "updatedAt"<now()-interval '5 minutes')
        ORDER BY "createdAt" LIMIT 25`);
      for (const row of rows) {
        const jobId = `embedding_${row.id}`;
        const existing = await this.queue.getJob(jobId);
        if (existing) {
          const state = await existing.getState();
          if (
            row.status === 'running' &&
            (state === 'active' || state === 'waiting' || state === 'delayed')
          )
            continue;
          // 数据库仍 pending，而 Redis 留有完成记录：可靠重放，不永久被同名 job 吞掉。
          if (state === 'completed' || state === 'failed') {
            await this.ds.query(
              "UPDATE embedding_jobs SET status='pending',error=NULL WHERE id=$1 AND status IN ('pending','running')",
              [row.id],
            );
            await existing.retry(state);
          }
        } else {
          if (row.status === 'running')
            await this.ds.query(
              "UPDATE embedding_jobs SET status='pending',error=NULL WHERE id=$1 AND status='running'",
              [row.id],
            );
          await this.queue.add(
            EMBED_QUEUE,
            { embeddingJobId: row.id },
            {
              jobId,
              attempts: 5,
              backoff: { type: 'exponential', delay: 2000 },
              removeOnComplete: { count: 1000 },
              removeOnFail: { count: 1000 },
            },
          );
        }
        await this.ds.query(
          'UPDATE embedding_jobs SET "dispatchedAt"=now() WHERE id=$1 AND status=\'pending\'',
          [row.id],
        );
      }
    } finally {
      this.dispatching = false;
    }
  }
}
