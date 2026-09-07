import { BadRequestException, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

export function checkedDimension(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 4000) {
    throw new BadRequestException('向量维度必须是 1～4000 的整数');
  }
  return value;
}

/** DDL 仅从后台建库任务调用，独立连接执行，不能包在事务迁移中。 */
@Injectable()
export class EmbeddingIndexService {
  constructor(private readonly dataSource: DataSource) {}

  async isReady(dimension: number): Promise<boolean> {
    const name = `idx_chunk_embeddings_hnsw_${checkedDimension(dimension)}`;
    const rows = await this.dataSource.query<{ ready: boolean }[]>(
      `SELECT i.indisvalid AND i.indisready AS ready FROM pg_index i
       JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE c.relname=$1 AND n.nspname=current_schema()`,
      [name],
    );
    return rows[0]?.ready === true;
  }

  async ensure(dimension: number): Promise<void> {
    const d = checkedDimension(dimension);
    if (await this.isReady(d)) return;
    const runner = this.dataSource.createQueryRunner();
    await runner.connect();
    const name = `idx_chunk_embeddings_hnsw_${d}`;
    try {
      await runner.query('SELECT pg_advisory_lock(782041, $1)', [d]);
      if (await this.isReady(d)) return;
      // 失败的并发建索引可能留下 invalid 索引；限定当前维度的固定名称。
      await runner.query(`DROP INDEX CONCURRENTLY IF EXISTS "${name}"`);
      await runner.query(`CREATE INDEX CONCURRENTLY "${name}" ON chunk_embeddings
        USING hnsw ((embedding::halfvec(${d})) halfvec_cosine_ops)
        WITH (m=16, ef_construction=64) WHERE dimension=${d}`);
    } finally {
      await runner
        .query('SELECT pg_advisory_unlock(782041, $1)', [d])
        .catch(() => undefined);
      await runner.release();
    }
  }
}
