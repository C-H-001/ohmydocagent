import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { KbSearchTool } from '../dist/modules/chat/agent/tools/kb-search.tool.js';
import { ReferencesService } from '../dist/modules/chat/pipeline/references.service.js';

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const kbId = id(100);
const documentId = id(101);

function chunk(n, content, extra = {}) {
  return {
    chunkId: id(n),
    kbId,
    knowledgeId: documentId,
    content,
    score: 1 - n / 100,
    vectorScore: 0.9,
    keywordScore: 0.8,
    type: 'text',
    ...extra,
  };
}

// Only DB/provider boundaries are replaced; retrieval assembly and references run
// through the production KbSearchTool.execute and ReferencesService methods.
function harness(candidates, adjacent = []) {
  const rows = [...candidates, ...adjacent].map((c) => ({
    ...c,
    id: c.chunkId,
  }));
  const events = [];
  const tool = new KbSearchTool(
    { hybridSearch: async () => candidates },
    { findOne: async () => ({ retrievalConfig: {} }) },
    {
      find: async ({ where }) =>
        where.id.value.map((knowledgeId) => ({
          id: knowledgeId,
          title: knowledgeId === documentId ? '图表报告' : '补充资料',
          type: knowledgeId === documentId ? 'file' : 'url',
          sourceUrl: 'https://example.com/source',
        })),
    },
    new ReferencesService(),
    {
      find: async ({ where }) =>
        rows.filter(
          (row) =>
            where.id.value.includes(row.id) &&
            (!where.knowledgeId ||
              where.knowledgeId.value.includes(row.knowledgeId)),
        ),
    },
    { chat: async () => '{"queries":[]}' },
    { rerank: async () => null },
    { signUrl: (url) => `signed:${url}` },
  );
  return {
    events,
    search: (topK = 12) =>
      tool.execute(
        { query: '报告中的完整数据是什么？', topK },
        {
          kbIds: [kbId],
          userId: id(102),
          signal: new AbortController().signal,
          sse: { send: (event) => events.push(event) },
        },
      ),
  };
}

test('单个文本块在200字符后的答案完整返回，展示摘要仍保持简短', async () => {
  const text = `${'背景信息。'.repeat(80)}结论：目标值为85%。`;
  const result = await harness([chunk(1, text)]).search();
  assert.ok(result.content.includes(text), '模型上下文丢失了单块末尾答案');
  assert.ok(result.references[0].content.length <= 201);
  assert.ok(!result.references[0].content.includes('目标值为85%'));
});

test('图片主引用保留完整数值以及同文档文本，不用图片短摘要替代模型上下文', async () => {
  const caption = `${'图例、坐标与统计对象；'.repeat(50)}Some college or more: 2008=65, 2015=85, Change=+20.`;
  const result = await harness([
    chunk(1, caption, {
      type: 'image',
      assetKey: 'chart-1',
      imageInfo: {
        url: '/images/chart-1',
        caption,
        page: 14,
        assetKey: 'chart-1',
      },
    }),
    chunk(2, '本图指标为未来家庭经济状况的信心，不是当前财务状况。'),
  ]).search();
  assert.ok(result.content.includes(caption), '完整图表数值没有传给模型');
  assert.ok(result.content.includes('本图指标为未来家庭经济状况的信心'));
  assert.ok(result.references[0].content.length <= 201);
  assert.equal(result.references[0].type, 'image');
  assert.equal(result.references[0].page, 14);
  assert.equal(result.references[0].images[0].url, 'signed:/images/chart-1');
  assert.equal(result.references[0].chunks.length, 2);
});

test('相邻块合并超过3000字符时保留后半部分证据', async () => {
  const head = chunk(1, 'A'.repeat(2000), { nextChunkId: id(2) });
  const tail = chunk(2, `${'B'.repeat(1800)}邻块末尾：年度增长20个百分点。`);
  const result = await harness([head], [tail]).search();
  assert.ok(
    result.content.includes(`${head.content}\n\n${tail.content}`),
    '邻块合并截断了3000字符后的证据',
  );
  assert.ok(result.references[0].content.length <= 201);
});

test('同文档上下文超过6000字符时保留各个已选片段', async () => {
  const candidates = [1, 2, 3, 4].map((n) =>
    chunk(n, `${String(n).repeat(1900)}第${n}片段完整结论。`),
  );
  const result = await harness(candidates).search();
  assert.ok(result.content.length > 7600);
  for (const candidate of candidates) {
    assert.ok(
      result.content.includes(candidate.content),
      '6000字符后的片段被裁掉',
    );
  }
  assert.ok(result.references[0].content.length <= 201);
});

test('TopK范围内第9至12个片段仍进入同文档上下文', async () => {
  const candidates = Array.from({ length: 12 }, (_, i) =>
    chunk(i + 1, `证据编号${i + 1}。`),
  );
  const result = await harness(candidates).search(12);
  assert.ok(result.content.includes('证据编号9。'), '第9个已检索片段被排除');
  assert.ok(result.content.includes('证据编号12。'), '第12个已检索片段被排除');
  assert.equal(result.references[0].chunks.length, 12);
});

test('多文档上下文与展示引用的编号一致，保留来源信息', async () => {
  const result = await harness([
    chunk(1, '文档甲的第一段。'),
    chunk(2, '文档乙的第一段。', { knowledgeId: id(103) }),
    chunk(3, '文档甲的第二段。'),
  ]).search();
  assert.equal(
    result.content,
    '[1] 图表报告：文档甲的第一段。\n\n文档甲的第二段。\n[2] 补充资料：文档乙的第一段。',
  );
  assert.deepEqual(
    result.references.map((r) => [r.index, r.knowledgeId]),
    [
      [1, documentId],
      [2, id(103)],
    ],
  );
  assert.equal(result.references[1].url, 'https://example.com/source');
  assert.equal(result.references[0].url, undefined);
});

test('放开内容长度不放开检索TopK上限', async () => {
  const candidates = Array.from({ length: 25 }, (_, i) =>
    chunk(i + 1, `第${i + 1}号候选。`),
  );
  const result = await harness(candidates).search(100);
  assert.ok(result.content.includes('第20号候选。'));
  assert.ok(!result.content.includes('第21号候选。'));
  assert.equal(result.references[0].chunks.length, 20);
});

test('没有检索结果时保持空引用，不拼接任何文档', async () => {
  const { search, events } = harness([]);
  const result = await search();
  assert.equal(result.status, 'done');
  assert.deepEqual(result.references, []);
  assert.ok(!events.some((event) => event.stage === 'merge'));
});
