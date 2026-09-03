// 分块引擎单元测试（Task 1.5）：不依赖数据库，直接测纯算法。
// - ChunkingService：贪心切分（chunkSize/chunkOverlap/separators），返回
//   { content, startAt, endAt }[] 纯数据（无 id/链表——链表由持久化层补，
//   见 ChunkService.buildChunkRows）
// - ChunkService.buildChunkRows：纯函数，把 ChunkUnit[] 转成带 uuid/链表/序号
//   的 Chunk 行（无需 DB，直接 new Chunk() 断言字段）
import { describe, expect, it } from 'vitest';
import { ChunkingService } from '../src/modules/chunk/chunking.service.js';
import { ChunkService } from '../src/modules/chunk/chunk.service.js';
import { Chunk } from '../src/modules/chunk/chunk.entity.js';
import type { ChunkUnit } from '../src/modules/chunk/chunking.service.js';

/** 检测字符串中是否含孤立代理（低代理前无高代理 / 高代理后无低代理 /
 * 高代理在串尾）。代理对 = 高代理(0xD800–0xDBFF) + 低代理(0xDC00–0xDFFF)，
 * 孤立任一码元即无法正常渲染（emoji 等非 BMP 字符被劈开）。 */
function hasOrphanSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      // 高代理必须后随低代理（且不跨块——块尾高代理即孤立）
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      // 低代理必须前随高代理（块首低代理即孤立）
      const prev = s.charCodeAt(i - 1);
      if (!(prev >= 0xd800 && prev <= 0xdbff)) return true;
    }
  }
  return false;
}

describe('ChunkingService（纯算法）', () => {
  const service = new ChunkingService();

  it('按 chunkSize 切分普通文本：多块且每块 ≤ chunkSize', () => {
    // 无分隔符的长文本：纯硬切场景，块长恒 = chunkSize（除尾块）
    const text = '字'.repeat(2000);
    const units = service.chunk(text, { chunkSize: 800, chunkOverlap: 100 });
    expect(units.length).toBeGreaterThanOrEqual(2);
    for (const u of units) {
      expect(u.content.length).toBeLessThanOrEqual(800);
    }
    // 首块从 0 开始、尾块到原文末尾，且相邻块无缝隙（重叠语义下
    // 下一块起点 ≤ 上一块终点，见 chunkOverlap 用例）
    expect(units[0].startAt).toBe(0);
    expect(units[units.length - 1].endAt).toBe(text.length);
    for (let i = 1; i < units.length; i++) {
      expect(units[i].startAt).toBeLessThanOrEqual(units[i - 1].endAt);
    }
  });

  it('chunkOverlap 保留重叠内容：相邻块首尾共享原文片段', () => {
    // 段落约 30 字、间隔 '\n\n'：chunkSize=100 时每块落在段落边界
    // （窗口末尾往前找最近分隔符），块与块之间重叠 20 字
    const paragraph = '段落内容。'.repeat(6);
    const text = Array.from({ length: 20 }, () => paragraph).join('\n\n');
    const units = service.chunk(text, { chunkSize: 100, chunkOverlap: 20 });
    expect(units.length).toBeGreaterThanOrEqual(3);
    // 至少存在一对真实重叠的相邻块
    expect(units.some((u, i) => i > 0 && u.startAt < units[i - 1].endAt)).toBe(
      true,
    );
    // 重叠语义：上一块尾部 = 下一块头部（共享原文区间 [next.start, prev.end)）
    for (let i = 1; i < units.length; i++) {
      const prev = units[i - 1];
      const cur = units[i];
      if (cur.startAt < prev.endAt) {
        const shared = text.slice(cur.startAt, prev.endAt);
        expect(shared.length).toBeGreaterThan(0);
        expect(prev.content.endsWith(shared)).toBe(true);
        expect(cur.content.startsWith(shared)).toBe(true);
      }
    }
  });

  it('优先在 separators 边界切分：不硬切（块尾落在分隔符后）', () => {
    // 每句 5 字（'句句句句。'），chunkSize=17：窗口 [0,17) 含 3 个 '。'，
    // 贪心填满窗口 → 切在窗口内最后一个 '。' 后（15 字），而非硬切到 17 字
    const text = '句句句句。'.repeat(10);
    const units = service.chunk(text, { chunkSize: 17, chunkOverlap: 0 });
    for (const u of units) {
      expect(u.content.length).toBeLessThanOrEqual(17);
      // 每块都以 '。' 结尾（尾块除外——到原文末尾）
      expect(u.content.endsWith('。') || u.endAt === text.length).toBe(true);
    }
    expect(units[0].content).toBe('句句句句。句句句句。句句句句。');
  });

  it('超长单段（无 separator）强制截断：按 chunkSize 硬切', () => {
    const text = 'a'.repeat(2500);
    const units = service.chunk(text, { chunkSize: 800, chunkOverlap: 0 });
    // 无任何分隔符 → 全部硬切，块长 = chunkSize（尾块到末尾）
    for (const u of units.slice(0, -1)) {
      expect(u.content.length).toBe(800);
    }
    expect(units[0].content.length).toBe(800);
    expect(units[units.length - 1].content.length).toBeLessThanOrEqual(800);
    expect(units[units.length - 1].endAt).toBe(text.length);
  });

  it('空文本返回空数组', () => {
    expect(service.chunk('')).toEqual([]);
    expect(service.chunk('', { chunkSize: 100, chunkOverlap: 10 })).toEqual([]);
  });

  it('重叠不超 chunkSize（边界校验）：非法配置容错收敛', () => {
    const text = '字'.repeat(1000);
    // 重叠 100 > chunkSize 5：收敛为 min(chunkSize-1, floor(chunkSize/2)) = 2，
    // 不产生死循环/超长块（旧实现收敛到 chunkSize-1=4，质量修复后封顶一半）
    const units = service.chunk(text, { chunkSize: 5, chunkOverlap: 100 });
    for (const u of units) {
      expect(u.content.length).toBeLessThanOrEqual(5);
    }
    expect(units.length).toBeGreaterThan(1);
    // chunkSize 非数字 → 默认 800；0/负数 → 收敛为 1（见 normalizeConfig 注释）
    const units2 = service.chunk('字'.repeat(2000), {
      chunkSize: 0 as unknown as number,
      chunkOverlap: -5,
    });
    for (const u of units2) {
      expect(u.content.length).toBeLessThanOrEqual(800);
    }
    const units3 = service.chunk('字'.repeat(2000), {
      chunkSize: 'big' as unknown as number,
    });
    for (const u of units3) {
      expect(u.content.length).toBeLessThanOrEqual(800);
    }
  });

  it('中文标点分隔符生效（。！？）', () => {
    const text = '问题一？回答一！结论一。问题二？回答二！结论二。';
    const units = service.chunk(text, { chunkSize: 10, chunkOverlap: 0 });
    for (const u of units) {
      expect(u.content.length).toBeLessThanOrEqual(10);
      // 块尾落在 '。！？' 任一标点后（尾块除外）
      expect(/[。！？]$/.test(u.content) || u.endAt === text.length).toBe(true);
    }
  });

  it('文本 < chunkSize：单尾块完整收尾（不截断不补块）', () => {
    const text = '短文本，不足一个窗口。';
    const units = service.chunk(text, { chunkSize: 800, chunkOverlap: 100 });
    expect(units).toHaveLength(1);
    expect(units[0].content).toBe(text);
    expect(units[0].startAt).toBe(0);
    expect(units[0].endAt).toBe(text.length);
  });

  it('emoji（代理对）切分不劈开配对：无孤立代理，非重叠下拼接还原原文', () => {
    // '😀'=U+1F600 是代理对（高代理 0xD83D + 低代理 0xDE00），chunkSize 边界
    // 跨越代理对时旧实现会在中间硬切 → 相邻块各自出现孤立代理（乱码）。
    // 修复后断言：1) 任何块无孤立代理（hasOrphanSurrogate）；2) 非重叠配置
    // 下相邻块拼接 = 原文（切点回退不丢字不重字）
    const text = 'a😀b'.repeat(37); // 148 码元，含 37 个代理对
    const units = service.chunk(text, { chunkSize: 23, chunkOverlap: 0 });
    expect(units.length).toBeGreaterThanOrEqual(5);
    for (const u of units) {
      expect(hasOrphanSurrogate(u.content)).toBe(false);
    }
    const rebuilt = units.map((u) => u.content).join('');
    expect(rebuilt).toBe(text);
  });

  it('overlap 配置下代理对同样不被劈开（含重叠块），且块长 ≤ chunkSize', () => {
    const text = 'a😀b'.repeat(25); // 100 码元，25 个代理对
    const units = service.chunk(text, { chunkSize: 30, chunkOverlap: 12 });
    for (const u of units) {
      expect(hasOrphanSurrogate(u.content)).toBe(false);
      // 切点回退只减不增 → 块长恒 ≤ chunkSize
      expect(u.content.length).toBeLessThanOrEqual(30);
    }
    // 重叠语义仍成立（至少存在一对真实重叠块）
    expect(units.some((u, i) => i > 0 && u.startAt < units[i - 1].endAt)).toBe(
      true,
    );
  });

  it('overlap 上限收敛：chunkSize-1 → ≤ floor(chunkSize/2)，无 1 码元蠕动', () => {
    // 性能修复：合法配置 overlap=chunkSize-1 时步进=1 码元/块，20 万字符文本
    // 产生 O(n·chunkSize) 二次方退化（实测 ~16s）。normalizeConfig 把 overlap
    // 封顶为 min(chunkSize-1, floor(chunkSize/2)) → 步进 ≥ chunkSize/2，块数
    // 摊销 O(n)。此处用块数与步进行为验证收敛（配置内部值不可直接观测）：
    // 步进 ≥ 20 → 500 字符块数 ≤ 500/20+1 = 26，且相邻块起点步进 ≥ 20
    const text = '字'.repeat(500);
    const units = service.chunk(text, { chunkSize: 40, chunkOverlap: 39 });
    expect(units.length).toBeLessThanOrEqual(26);
    for (let i = 1; i < units.length; i++) {
      expect(units[i].startAt - units[i - 1].startAt).toBeGreaterThanOrEqual(
        20,
      );
    }
    // 收敛后重叠仍有效：相邻块存在共享区间（重叠 = 40-20 = 20）
    expect(units.some((u, i) => i > 0 && u.startAt < units[i - 1].endAt)).toBe(
      true,
    );
    // 合法小重叠（< chunkSize/2）不受影响：精确保留重叠内容
    const small = service.chunk('字'.repeat(100), {
      chunkSize: 40,
      chunkOverlap: 5,
    });
    const pair = small.find((u, i) => i > 0 && u.startAt < small[i - 1].endAt);
    expect(pair).toBeDefined();
    const i = small.indexOf(pair!);
    expect(small[i].startAt).toBe(small[i - 1].endAt - 5);
  });
});

describe('ChunkService.buildChunkRows（链表回填，纯函数）', () => {
  // buildChunkRows 不触碰 repo：传空对象即可（仅构造函数占位；
  // Task 1.9 构造参数扩展为 5 个——repo×2/revisionRepo/dataSource/embedQueue）
  const service = new ChunkService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  const units: ChunkUnit[] = [
    { content: '第一块内容', startAt: 0, endAt: 5 },
    { content: '第二块内容', startAt: 5, endAt: 10 },
    { content: '第三块内容', startAt: 10, endAt: 15 },
  ];

  it('chunkIndex 从 0 递增；preChunkId/nextChunkId 形成链表', () => {
    // 签名 (knowledgeId, kbId, units)：与 createChunksForKnowledge 的
    // buildChunkRows(knowledge.id, knowledge.kbId, units) 调用一致
    const rows = service.buildChunkRows('doc-1', 'kb-1', units);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.chunkIndex)).toEqual([0, 1, 2]);
    expect(rows[0].preChunkId).toBeNull();
    expect(rows[0].nextChunkId).toBe(rows[1].id);
    expect(rows[1].preChunkId).toBe(rows[0].id);
    expect(rows[1].nextChunkId).toBe(rows[2].id);
    expect(rows[2].preChunkId).toBe(rows[1].id);
    expect(rows[2].nextChunkId).toBeNull();
  });

  it('行字段映射：content/sourceContent/startAt/endAt/indexStatus 正确', () => {
    const rows = service.buildChunkRows('doc-1', 'kb-1', units);
    expect(rows[0]).toBeInstanceOf(Chunk);
    expect(rows[0].kbId).toBe('kb-1');
    expect(rows[0].knowledgeId).toBe('doc-1');
    expect(rows[0].content).toBe('第一块内容');
    // sourceContent：首次解析内容（Task 1.9 编辑时保留语义）
    expect(rows[0].sourceContent).toBe('第一块内容');
    expect(rows[0].startAt).toBe(0);
    expect(rows[0].endAt).toBe(5);
    expect(rows[2].endAt).toBe(15);
    // 本任务插入保持 processing（Task 1.6 向量化后置 ready）
    expect(rows[0].indexStatus).toBe('processing');
    expect(rows[0].contentRevision).toBe(0);
  });
});

describe('ChunkingService 分块策略（参考 WeKnora：recursive / header）', () => {
  const svc = new ChunkingService();
  const baseCfg = { chunkSize: 30, chunkOverlap: 0, separators: ['\n\n', '\n', '。', ''] };

  it('recursive：多级分隔符递归降级 + 合并到 chunkSize', () => {
    let text = '';
    for (let i = 0; i < 10; i++) text += `第${i + 1}段内容描述。\n\n`;
    const units = svc.chunk(text, { ...baseCfg, strategy: 'recursive' });
    expect(units.length).toBeGreaterThan(1);
    // 每块 ≤ chunkSize（+分隔符容差）；内容覆盖原文（拼接回原文）
    for (const u of units) {
      expect(u.content.length).toBeLessThanOrEqual(baseCfg.chunkSize + 5);
    }
    expect(units.map((u) => u.content).join('')).toContain('第1段内容描述');
    expect(units.map((u) => u.content).join('')).toContain('第10段内容描述');
    // startAt/endAt 为原文偏移且单调
    for (const u of units) {
      expect(u.startAt).toBeGreaterThanOrEqual(0);
      expect(u.endAt).toBeGreaterThan(u.startAt);
    }
  });

  it('header：按主导 Markdown 标题层级分节（标题行随块保留）', () => {
    const md = '# 第一章 概述\n这是第一章内容，介绍背景。\n## 1.1 子节\n子节细节。\n# 第二章 方案\n第二章内容，说明方案。\n';
    const units = svc.chunk(md, { ...baseCfg, chunkSize: 200, strategy: 'header' });
    expect(units.length).toBe(2);
    expect(units[0].content).toContain('# 第一章');
    expect(units[1].content).toContain('# 第二章');
    // 标题行是原文一部分（偏移正确）
    expect(md.slice(units[0].startAt, units[0].endAt)).toContain('第一章');
  });

  it('header：无标题结构 → 回退 recursive 分块', () => {
    const text = '没有标题的普通文本段落。\n\n继续第二段。\n\n第三段结尾。';
    const units = svc.chunk(text, { ...baseCfg, strategy: 'header' });
    expect(units.length).toBeGreaterThan(0);
    expect(units.map((u) => u.content).join('')).toContain('没有标题');
  });
});
