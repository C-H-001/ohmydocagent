// MockEmbeddingService 单元测试（Task 1.6；Task 2.3 起 mock 移至
// src/modules/model/mock/——仅供测试 override 注入，本文件直接实例化验证算法）
// - 维度正确（1024）
// - 确定性：同文本必同向量（向量化/重试/多 worker 场景下结果稳定可预期）
// - 不同文本向量不同（hash 碰撞概率低，用不同内容断言不相等）
// - 检索语义：共享字符片段（n-gram）的文本向量相似度更高——这是 mock 能被
//   e2e 检索用例验证的关键（见 vector.e2e-spec 的「向量检索」用例设计注释）；
//   Task 2.3 换真实模型后本用例仍应成立（真实模型语义相似度更高）
// - 向量 L2 归一化（模长 1）：pgvector 余弦距离 <=> 对零向量未定义（返回 NULL），
//   归一化保证非零向量且余弦相似度 = 点积，检索分数稳定
import { describe, expect, it } from 'vitest';
import { MockEmbeddingService } from '../src/modules/model/mock/mock-embedding.service.js';

/** 余弦相似度（两向量均为归一化向量时 = 点积） */
function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

describe('MockEmbeddingService（确定性 n-gram 特征哈希）', () => {
  const service = new MockEmbeddingService();

  it('维度 = 1024（与 chunk.entity embedding vector(1024) 列一致）', async () => {
    expect(service.dimension).toBe(1024);
    const vectors = await service.embed(['OhMyDocAgent 知识管理平台']);
    expect(vectors[0]).toHaveLength(1024);
  });

  it('同文本必同向量（确定性：重试/多 worker 结果可预期）', async () => {
    const [v1, v2] = await service.embed([
      'OhMyDocAgent 知识管理平台支持 RAG 检索',
      'OhMyDocAgent 知识管理平台支持 RAG 检索',
    ]);
    expect(v1).toEqual(v2);
  });

  it('不同文本向量不同（大概率，hash 碰撞概率低）', async () => {
    const [v1, v2] = await service.embed(['知识管理', '全文检索']);
    expect(v1).not.toEqual(v2);
  });

  it('共享字符片段的文本与查询向量更相似（n-gram 特征哈希的检索语义）', async () => {
    const [query] = await service.embed(['知识管理']);
    const [related, unrelated] = await service.embed([
      '知识管理系统',
      'zzzzzzzzqqqqqqqq',
    ]);
    expect(cosine(query, related)).toBeGreaterThan(cosine(query, unrelated));
  });

  it('向量已 L2 归一化（模长 ≈ 1，保证非零向量且余弦距离稳定）', async () => {
    const [v] = await service.embed(['OhMyDocAgent 知识管理平台支持 RAG 检索']);
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
  });

  it('空文本不产生零向量（pgvector <=> 对零向量未定义）', async () => {
    const [v] = await service.embed(['']);
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeGreaterThan(0);
  });
});
