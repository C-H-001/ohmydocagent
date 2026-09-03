// backend/src/neo4j/neo4j.service.ts
// Neo4j 驱动封装：提供 run() 执行 Cypher，应用关闭时释放连接
import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import neo4j, { Driver, ManagedTransaction, Session } from 'neo4j-driver';

@Injectable()
export class Neo4jService implements OnApplicationShutdown {
  private driver: Driver;
  constructor(config: ConfigService) {
    this.driver = neo4j.driver(
      // 兜底值与 configuration.ts / config.validation.ts 保持一致
      config.get('neo4j.uri', 'bolt://127.0.0.1:7687'),
      neo4j.auth.basic(
        config.get('neo4j.user', 'neo4j'),
        config.get('neo4j.password', 'ohmydocagent-local-secret'),
      ),
      { maxConnectionLifetime: 3 * 60 * 60 * 1000 },
    );
  }

  getSession(): Session {
    return this.driver.session();
  }

  /**
   * 执行 Cypher 查询，返回 driver 的 result（records/summary 等）。
   * 每次调用开一个新 session，finally 中确保关闭，防止连接泄漏。
   * 注意：每条语句独立事务（无跨语句原子性），批量写入请用 withWriteTransaction。
   */
  async run(cypher: string, params?: Record<string, unknown>) {
    const session = this.getSession();
    try {
      return await session.run(cypher, params);
    } finally {
      await session.close();
    }
  }

  /**
   * 在单个写事务中执行回调（session.executeWrite 封装）：回调内多个 tx.run()
   * 共享同一事务，全部成功自动 commit；回调抛错或 commit 失败时整体回滚，
   * 且 driver 按指数退避自动重试（初始 1s、上限 30s，driver 默认配置）。
   * 与 run() 的区别：run() 每语句独立 session/事务，中途失败会留部分写入；
   * 需要原子性的多语句写入（如 GraphRepository.upsertDocumentGraphInTx）必须走本方法。
   */
  async withWriteTransaction<T>(
    work: (tx: ManagedTransaction) => Promise<T>,
  ): Promise<T> {
    const session = this.getSession();
    try {
      return await session.executeWrite(work);
    } finally {
      await session.close();
    }
  }

  async onApplicationShutdown() {
    await this.driver.close();
  }
}
