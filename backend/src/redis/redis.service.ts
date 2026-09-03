// backend/src/redis/redis.service.ts
// Redis 接入层：ioredis 客户端封装，供业务模块与后续 BullMQ（Task 1.4）复用。
// 方法均为薄封装，保持语义直白；getClient() 暴露原始实例，
// 需要直接操作 Redis 命令或把客户端交给 BullMQ 时使用。
import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';

@Injectable()
export class RedisService implements OnApplicationShutdown {
  private readonly logger = new Logger(RedisService.name);
  private readonly client: Redis;

  constructor(config: ConfigService) {
    // host/port 来自集中配置（configuration.ts 的 redis 段，兜底 127.0.0.1:6379）
    const host = config.get<string>('redis.host') ?? '127.0.0.1';
    const port = config.get<number>('redis.port') ?? 6379;
    // maxRetriesPerRequest: 3 —— Redis 故障时请求最多重试 3 次即失败，避免长时间挂起。
    // 说明：BullMQ（Task 1.4）将使用独立连接（BullModule.forRoot({ connection: redisConfig })），
    // 因此这里可以放心 fail-fast，不会影响队列重试语义；缓存读取失败让上层快速降级/报错即可。
    this.client = new Redis({ host, port, maxRetriesPerRequest: 3 });
    // 连接失败/断线时打日志便于排查；ioredis 自带重连，不在此 fail-fast
    this.client.on('error', (err) =>
      this.logger.error(`Redis 连接错误: ${err.message}`),
    );
  }

  /** 连通性探测：Redis 返回 PONG */
  ping(): Promise<string> {
    return this.client.ping();
  }

  get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  /**
   * 写入字符串值；ttlSeconds 缺省时不设过期时间。
   * 需要过期时显式传秒数，避免测试/临时数据残留。
   */
  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds === undefined) {
      await this.client.set(key, value);
    } else {
      await this.client.set(key, value, 'EX', ttlSeconds);
    }
  }

  del(key: string): Promise<number> {
    return this.client.del(key);
  }

  /** Hash 读取：字段不存在返回 null */
  hget(key: string, field: string): Promise<string | null> {
    return this.client.hget(key, field);
  }

  hset(key: string, field: string, value: string): Promise<number> {
    return this.client.hset(key, field, value);
  }

  /**
   * 暴露原始 ioredis 实例：供 BullMQ 连接配置、Pipeline/事务、
   * 或封装外的高级命令使用。调用方需自行负责生命周期。
   */
  getClient(): Redis {
    return this.client;
  }

  /** 应用关闭时释放连接，避免进程悬挂 */
  async onApplicationShutdown(): Promise<void> {
    await this.client.quit();
  }
}
