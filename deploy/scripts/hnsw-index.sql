-- pgvector HNSW 索引（精细调参，参考 WeKnora Doris HNSW M=32）
-- 用法（本地/生产）：psql -f deploy/scripts/hnsw-index.sql
--
-- 调参说明：
--   m（每节点最大连接数）：高维向量（1024）建议 16~32——m 大召回更全、索引更大；
--     WeKnora Doris 用 M=32，此处对齐（m=32）。
--   ef_construction（建索引贪心搜索范围）：越大索引质量越高、构建越慢；
--     128 是召回/构建时间的良好折中（默认 64 偏低）。
--   ef_search（查询精度）：运行时 GUC（见 database.module extra options，
--     HNSW_EF_SEARCH 默认 40）；越大召回越全、延迟越高。
--
-- 注：ivfflat 是旧版近似索引（构建快但召回差、查询慢）；HNSW 是 pgvector 0.5+
-- 默认推荐的图索引（查询快、召回高）。删除列后建索引会重建，先 DROP 旧索引。

-- 用余弦距离（embedding 已归一化，检索用 <=> 见 vector.service.ts）
CREATE INDEX IF NOT EXISTS idx_chunks_embedding_hnsw
  ON chunks
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 32, ef_construction = 128);
