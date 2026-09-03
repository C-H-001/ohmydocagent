import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    // e2e 串行执行：每个文件都会初始化 AppModule（TypeORM synchronize），
    // 并行时会并发 CREATE TABLE 同一张表，撞 pg_type 唯一索引导致随机失败
    fileParallelism: false,
  },
});
