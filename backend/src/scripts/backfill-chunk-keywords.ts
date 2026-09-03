// 一次性脚本：为已有 chunks 回填中文检索词（keywords 列）。
// 背景：chunks.keywords（jieba 词粒度检索）是新加列，历史 chunk 为空——
// 检索 SQL 已有 content ILIKE 词面兜底，但词粒度命中需要 keywords。
// 用法：npm run build 后 node dist/scripts/backfill-chunk-keywords.js
//   （生产容器：docker exec ohmydocagent-backend-1 node dist/scripts/backfill-chunk-keywords.js）
// 幂等：仅更新 keywords 为空（或 '{}'）的行。
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { config } from 'dotenv';
import { Chunk } from '../modules/chunk/chunk.entity.js';
import { segment } from '../common/utils/chinese-seg.js';

config();

async function main() {
  const ds = new DataSource({
    type: 'postgres',
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: Number(process.env.DB_PORT ?? 5432),
    username: process.env.DB_USER ?? 'ohmydocagent',
    password: process.env.DB_PASSWORD ?? '',
    database: process.env.DB_NAME ?? 'ohmydocagent',
    entities: [Chunk],
    synchronize: false,
  });
  await ds.initialize();
  const repo = ds.getRepository(Chunk);
  const total = await repo.count();
  // 分批拉取（内存友好），跳过已有 keywords 的行
  const batch = 200;
  let processed = 0;
  let updated = 0;
  for (let offset = 0; offset < total; offset += batch) {
    const rows = await repo.find({
      order: { id: 'ASC' },
      skip: offset,
      take: batch,
    });
    for (const r of rows) {
      processed++;
      const hasKeywords = Array.isArray(r.keywords) && r.keywords.length > 0;
      if (hasKeywords) continue;
      const words = segment(r.content ?? '');
      if (words.length > 0 && words[0] !== r.content) {
        await repo.update(r.id, { keywords: words });
        updated++;
      }
    }
    console.log(`已处理 ${processed}/${total}，更新 ${updated}`);
  }
  await ds.destroy();
  console.log(`完成：共 ${updated} 个 chunk 回填关键词`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
