// backend/src/redis/redis.module.ts
// Redis 模块：提供 RedisService 供全局按需注入（非全局模块，使用方自行 import）
import { Module } from '@nestjs/common';
import { RedisService } from './redis.service.js';

@Module({
  providers: [RedisService],
  exports: [RedisService],
})
export class RedisModule {}
