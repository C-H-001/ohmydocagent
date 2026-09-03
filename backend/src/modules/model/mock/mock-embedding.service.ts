// backend/src/modules/model/mock/mock-embedding.service.ts
// MockEmbeddingService（Task 1.6 P1 占位实现；Task 2.3 起真实实现为
// EmbeddingServiceImpl，本 mock 保留在 mock/ 目录**仅供测试 overrideProvider
// 注入**——vector/chunk-revision 等既有 e2e 依赖 n-gram 特征哈希的确定性向量）：
// 用「字符 n-gram 特征哈希（hashing trick）」生成确定性向量，而非纯随机——
// 设计动机：纯随机向量（FNV 种子 → PRNG）无法支撑检索相关性可测（e2e 无法
// 断言「查询『知识管理』返回含该短语的 chunk」）；n-gram 哈希让「共享字符
// 片段」的文本获得相似向量（类似词袋模型），检索语义在 P1 即可端到端验证。
//
// 算法：
// 1. 对文本取全部字符二元组（bigram，短文本退化单字符），FNV-1a 哈希每个
//    n-gram → 桶号（dimension 取模）+ 符号（哈希高位比特），累加进 1024 维桶；
// 2. L2 归一化（模长 1）：pgvector 余弦距离 <=> 对零向量未定义（返回 NULL），
//    归一化保证非零向量且余弦相似度 = 点积，检索分数稳定；
// 3. 零向量兜底（空文本/符号抵消）：FNV 种子 PRNG（mulberry32）生成伪随机
//    向量再归一化——保证任何文本都不产生零向量。
//
// 性质（test/embedding.service.spec.ts 断言）：
// - 确定性：同文本必同向量（重试/多 worker 结果可预期）
// - 不同文本向量不同（hash 碰撞概率低）
// - 共享 n-gram 的文本余弦相似度更高（检索相关性可测）
import { Injectable } from '@nestjs/common';
import type { EmbeddingService } from '../embedding.interface.js';
import { EMBEDDING_DIMENSION } from '../embedding.interface.js';

/** FNV-1a 32 位哈希：确定性字符串哈希（与运行环境无关，跨进程稳定） */
function fnv1a(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    // Math.imul：32 位整数乘法（避免浮点精度丢失导致跨平台不一致）
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** mulberry32 伪随机数生成器（32 位种子确定性序列；零向量兜底用） */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

@Injectable()
export class MockEmbeddingService implements EmbeddingService {
  readonly dimension = EMBEDDING_DIMENSION;

  async embedWithUsage(
    texts: string[],
  ): Promise<{ vectors: number[][]; totalTokens: number }> {
    return { vectors: await this.embed(texts), totalTokens: 0 };
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.embedOne(t));
  }

  private embedOne(text: string): number[] {
    const buckets = new Float64Array(this.dimension);
    const t = text.trim();
    // 字符二元组（bigram）：中文按字符粒度切分（无需分词器），相邻字符对即特征。
    // 收尾单字符也作为特征（短文本如查询词 'a' 也有向量，且 'a'/'b' 可区分）。
    for (let i = 0; i < t.length; i++) {
      const gram = i + 1 < t.length ? t.slice(i, i + 2) : t.slice(i);
      const h = fnv1a(gram);
      const idx = h % this.dimension;
      // 哈希高位比特决定符号：同一 n-gram 恒同符号（确定性），不同 n-gram
      // 约各半概率正负 → 桶内累加近似随机游走，向量分布均匀
      const sign = (h >>> 31) & 1 ? 1 : -1;
      buckets[idx] += sign;
    }
    let vector: number[];
    // 零向量兜底：空文本或符号恰好抵消（概率极低但需防御）——pgvector <=>
    // 对零向量未定义（返回 NULL），检索会静默漏掉该块。兜底用整文本哈希
    // 种子 PRNG 生成确定性伪随机向量（仍满足同文本同向量）。
    const norm = Math.sqrt(Array.from(buckets).reduce((s, x) => s + x * x, 0));
    if (norm === 0) {
      const rand = mulberry32(fnv1a(t));
      vector = Array.from({ length: this.dimension }, () => rand() * 2 - 1);
    } else {
      vector = Array.from(buckets, (x) => x / norm);
    }
    // L2 归一化（兜底路径的 PRNG 向量同样归一化，保证非零且模长 1）
    const vn = Math.sqrt(vector.reduce((s, x) => s + x * x, 0));
    return vector.map((x) => x / (vn || 1));
  }
}
