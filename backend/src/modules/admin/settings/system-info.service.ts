// 系统信息服务（Task 4.6）：GET /api/v1/system/info 返回版本号 + 三个基础
// 服务（PostgreSQL/Redis/Neo4j）的连通性健康状态。
// 健康探测（各自原生最小命令）：DataSource.query('SELECT 1') / RedisService.ping
// / Neo4jService.run('RETURN 1')；任一探测失败只标记 down，不影响其他项与
// 响应（管理面板可见全部状态而非半途 500）。
// 版本号来源：backend/package.json（monorepo 约定 cwd 恒为 backend 目录；
// 用 import.meta.url 相对定位 src/ 与 dist/ 下均解析到 backend 根，见
// configuration.ts 文件头的 cwd 实测注释）。读取失败兜底 '0.0.1'。
import { Injectable } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { DataSource } from 'typeorm';
import { Neo4jService } from '../../../neo4j/neo4j.service.js';
import { RedisService } from '../../../redis/redis.service.js';

/** 健康状态（前端契约：{ ok, latencyMs?, detail? }——ok 布尔供直接判断；
 *  detail 为失败原因，前端展示） */
export interface ServiceHealth {
  ok: boolean;
  /** 探测延迟（毫秒；失败无值） */
  latencyMs?: number;
  /** 失败原因（ok=false 时给出，前端展示） */
  detail?: string;
}

function readVersion(): string {
  try {
    const raw = readFileSync(
      new URL('../../../../package.json', import.meta.url),
      'utf8',
    );
    const pkg = JSON.parse(raw) as { version?: string };
    return pkg.version ?? '0.0.1';
  } catch {
    return '0.0.1';
  }
}

@Injectable()
export class SystemInfoService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly redis: RedisService,
    private readonly neo4j: Neo4jService,
  ) {}

  /** 系统信息：版本 + 三服务健康（并行探测，互不影响） */
  async info() {
    const [postgres, redis, neo4j] = await Promise.all([
      this.checkPostgres(),
      this.checkRedis(),
      this.checkNeo4j(),
    ]);
    return {
      version: readVersion(),
      services: { postgres, redis, neo4j },
      timestamp: new Date().toISOString(),
    };
  }

  /** 通用探测：记录延迟与失败原因（任一服务 down 不影响其他项/响应） */
  private async probe(
    label: string,
    fn: () => Promise<unknown>,
  ): Promise<ServiceHealth> {
    const start = Date.now();
    try {
      await fn();
      return { ok: true, latencyMs: Date.now() - start };
    } catch (err) {
      return {
        ok: false,
        detail: err instanceof Error ? err.message.split('\n')[0] : String(err),
      };
    }
  }

  private checkPostgres(): Promise<ServiceHealth> {
    return this.probe('postgres', () => this.dataSource.query('SELECT 1'));
  }

  private checkRedis(): Promise<ServiceHealth> {
    return this.probe('redis', () => this.redis.ping());
  }

  private checkNeo4j(): Promise<ServiceHealth> {
    return this.probe('neo4j', () => this.neo4j.run('RETURN 1'));
  }
}
