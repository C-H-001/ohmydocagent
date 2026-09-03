// ReferencesService 单元测试（Task 2.6 引用系统）：同文档多分块合并 +
// 生成后正文 [n] 兜底对齐。
// 覆盖：
// - build：同文档合并（多分块 → 1 引用 + chunks 位置数组；主引用 = 组内
//   最高分块）、跨文档编号（按首次出现顺序 1..N）、content 截断
//   （REFERENCE_CONTENT_MAX_LENGTH=200，带省略号）、标题来源（sources Map）、
//   缺省兜底「未知文档」、url 类型文档 sourceUrl 透传、空检索空数组
// - align：正文 [n] 提取、未引用剔除（index 保留原文编号——正文已含 [n]
//   无法改写，前端按 index 匹配）、正文无 [n] → 空数组（无引用不生成）、
//   越界编号（[99] 无对应引用）保留正文、references 空 + 正文有 [n] → 空
import { describe, expect, it } from 'vitest';
import {
  ReferencesService,
  REFERENCE_CONTENT_MAX_LENGTH,
} from './references.service.js';
import type { HybridSearchItem } from '../../vector/vector.service.js';
import type { RagReference } from './rag.types.js';

/** 检索结果构造助手（chunkId/knowledgeId/content/score） */
function chunk(overrides: Partial<HybridSearchItem> = {}): HybridSearchItem {
  return {
    chunkId: 'chunk-1',
    content: '分块内容',
    kbId: 'kb-base',
    knowledgeId: 'kb-1',
    score: 0.8,
    vectorScore: 0.8,
    keywordScore: 0.4,
    ...overrides,
  };
}

/** sources Map 构造助手（{ title, sourceUrl? } 结构，见 references.service.ts） */
function source(
  knowledgeId: string,
  title: string,
  sourceUrl?: string,
): [string, { title: string; sourceUrl?: string }] {
  return [knowledgeId, sourceUrl ? { title, sourceUrl } : { title }];
}

/** 构造完整引用（align 断言用） */
function ref(
  index: number,
  overrides: Partial<RagReference> = {},
): RagReference {
  return {
    index,
    chunkId: `c${index}`,
    kbId: 'kb-base',
    knowledgeId: 'kb-1',
    knowledgeTitle: '文档甲',
    content: '内容',
    score: 0.9,
    ...overrides,
  };
}

describe('ReferencesService.build（同文档合并 + 编号 + 截断）', () => {
  const service = new ReferencesService();

  it('同文档多分块合并为一个引用：主引用 = 组内最高分块，chunks 记录全部位置（score 降序）', () => {
    const refs = service.build(
      [
        chunk({ chunkId: 'c1', kbId: 'kb1', knowledgeId: 'kb-a', score: 0.9 }),
        chunk({ chunkId: 'c2', kbId: 'kb1', knowledgeId: 'kb-b', score: 0.7 }),
        chunk({ chunkId: 'c3', kbId: 'kb1', knowledgeId: 'kb-a', score: 0.8 }),
        chunk({ chunkId: 'c4', kbId: 'kb1', knowledgeId: 'kb-a', score: 0.6 }),
      ],
      new Map([source('kb-a', '文档甲'), source('kb-b', '文档乙')]),
    );
    expect(refs).toHaveLength(2);
    // 文档甲：3 块合并为 1 引用（chunks 全量位置，按 score 降序；主引用
    // content = 最高分块 c1）
    const docA = refs.find((r) => r.knowledgeId === 'kb-a')!;
    expect(docA.chunkId).toBe('c1');
    expect(docA.chunks).toEqual([
      { chunkId: 'c1', score: 0.9 },
      { chunkId: 'c3', score: 0.8 },
      { chunkId: 'c4', score: 0.6 },
    ]);
    // 文档乙：单块 → 1 引用（chunks 仅自身）
    const docB = refs.find((r) => r.knowledgeId === 'kb-b')!;
    expect(docB.chunkId).toBe('c2');
    expect(docB.chunks).toEqual([{ chunkId: 'c2', score: 0.7 }]);
  });

  it('跨文档编号：按首次出现顺序 1..N（= 各文档最高分块的出现顺序，非原始 topK 序号）', () => {
    const refs = service.build(
      [
        chunk({ chunkId: 'c1', kbId: 'kb1', knowledgeId: 'kb-b', score: 0.95 }),
        chunk({ chunkId: 'c2', kbId: 'kb1', knowledgeId: 'kb-a', score: 0.8 }),
        chunk({ chunkId: 'c3', kbId: 'kb1', knowledgeId: 'kb-b', score: 0.7 }),
      ],
      new Map([source('kb-a', '文档甲'), source('kb-b', '文档乙')]),
    );
    expect(refs.map((r) => r.index)).toEqual([1, 2]);
    expect(refs[0].knowledgeId).toBe('kb-b'); // 最高分块属于文档乙 → 编号 1
    expect(refs[1].knowledgeId).toBe('kb-a');
    // 编号与 references 数组下标对齐（正文 [n] ↔ refs[n-1]）
    expect(refs[0].index).toBe(1);
    expect(refs[1].index).toBe(2);
  });

  it('content 截断到 REFERENCE_CONTENT_MAX_LENGTH=200（带省略号），短内容原样', () => {
    const longContent = '长'.repeat(300);
    const refs = service.build(
      [chunk({ chunkId: 'c1', content: longContent })],
      new Map([source('kb-1', '文档甲')]),
    );
    expect(refs[0].content.length).toBe(REFERENCE_CONTENT_MAX_LENGTH + 1); // 200 + '…'
    expect(refs[0].content.startsWith('长'.repeat(200))).toBe(true);
    expect(refs[0].content.endsWith('…')).toBe(true);
    // 短内容不截断
    const refs2 = service.build(
      [chunk({ chunkId: 'c2', content: '短内容' })],
      new Map([source('kb-1', '文档甲')]),
    );
    expect(refs2[0].content).toBe('短内容');
  });

  it('标题从 sources Map 获取；缺省兜底「未知文档」（文档已删/孤儿 chunk 不报错）', () => {
    const refs = service.build(
      [
        chunk({ chunkId: 'c1', kbId: 'kb1', knowledgeId: 'kb-known' }),
        chunk({ chunkId: 'c2', kbId: 'kb1', knowledgeId: 'kb-ghost' }),
      ],
      new Map([source('kb-known', '已知文档')]),
    );
    expect(refs[0].knowledgeTitle).toBe('已知文档');
    expect(refs[1].knowledgeTitle).toBe('未知文档');
  });

  it('url 类型文档：引用含 url 字段（sourceUrl 透传）；非 url 类型无 url 字段', () => {
    const refs = service.build(
      [
        chunk({ chunkId: 'c1', kbId: 'kb1', knowledgeId: 'kb-url' }),
        chunk({ chunkId: 'c2', kbId: 'kb1', knowledgeId: 'kb-file' }),
      ],
      new Map([
        source('kb-url', '帮助中心', 'https://docs.example.com/help'),
        source('kb-file', '使用手册'),
      ]),
    );
    expect(refs[0].url).toBe('https://docs.example.com/help');
    expect(refs[1].url).toBeUndefined();
  });

  it('空检索 → 空数组（不查库）', () => {
    const refs = service.build([], new Map());
    expect(refs).toEqual([]);
  });
});

describe('ReferencesService.align（生成后正文 [n] 兜底对齐）', () => {
  const service = new ReferencesService();
  const three = [
    ref(1, { knowledgeId: 'kb-a', knowledgeTitle: '文档甲' }),
    ref(2, { knowledgeId: 'kb-b', knowledgeTitle: '文档乙' }),
    ref(3, { knowledgeId: 'kb-c', knowledgeTitle: '文档丙' }),
  ];

  it('正文 [n] 提取：被引用的编号保留对应引用，未引用的剔除', () => {
    const { content, references } = service.align(
      '根据资料 [1] 与 [3] 可知……',
      three,
    );
    expect(content).toBe('根据资料 [1] 与 [3] 可知……'); // 正文不改写
    expect(references.map((r) => r.index)).toEqual([1, 3]);
    expect(references.map((r) => r.knowledgeId)).toEqual(['kb-a', 'kb-c']);
  });

  it('剔除后 index 保留原文编号（不重映射——正文已含 [n] 无法改写，前端按 index 匹配）', () => {
    const { references } = service.align('仅引用 [2]', three);
    expect(references).toHaveLength(1);
    expect(references[0].index).toBe(2); // 仍为原文编号 2，不重排为 1
    expect(references[0].chunkId).toBe('c2');
  });

  it('正文无 [n] → references 空数组（无引用不生成 references）', () => {
    const { references } = service.align('没有任何引用的普通回答', three);
    expect(references).toEqual([]);
  });

  it('越界编号（[99] 无对应引用）→ 保留正文，references 无该 index（LLM 幻觉编号）', () => {
    const { content, references } = service.align('根据资料 [99] 回答', three);
    expect(content).toBe('根据资料 [99] 回答'); // 正文不删幻觉编号
    expect(references).toEqual([]);
  });

  it('references 空 + 正文有 [n] → 空数组（幻觉编号无任何可匹配引用）', () => {
    const { references } = service.align('引用 [1] 的内容', []);
    expect(references).toEqual([]);
  });

  it('正文多次引用同一编号 → 对应引用保留一次', () => {
    const { references } = service.align('见 [1] 与 [1] 详述', three);
    expect(references).toHaveLength(1);
    expect(references[0].index).toBe(1);
  });
});
