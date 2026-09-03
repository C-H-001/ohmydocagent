// GraphExtractionService 单测（Task 3.2）：mock ChatModelService 注入，覆盖：
// 抽取 prompt 组装（系统提示含 JSON 格式与抽取要求 / 用户提示含 chunk 内容 /
// temperature=0.1 透传）、超长 chunk 输入截断（clampSurrogateBoundary，Task 3.2
// 质量审查整改）、JSON 解析容错（markdown 代码块 / 前后缀文本 / 损坏 /
// 无 name 实体过滤 / attributes 清洗）、并行抽取并发上限 4（Promise pool）、
// 汇总行语义（实体带 chunkId、关系 weight=1、跨 chunk 端点过滤、chunk 镜像同步）、
// 跨文档端点两段判定（本文档 ∪ 图谱既有实体，Task 3.2 质量审查整改）、
// 单 chunk 失败隔离（部分失败照常汇总、全部失败抛错——调用方 ExtractProcessor
// 抛错即触发 BullMQ 重试，attempts=2 + backoff 2s 由入队配置决定）。
import { describe, expect, it, vi } from 'vitest';
import {
  EXTRACTION_SYSTEM_PROMPT,
  GraphExtractionService,
} from '../src/modules/graph/graph-extraction.service.js';
import type { ChatModelService } from '../src/modules/model/chat-model.interface.js';

/** 固定有效抽取 JSON（与 e2e 的脚本同构：3 实体 + 2 关系） */
const VALID_EXTRACTION_JSON = JSON.stringify({
  node: [
    { name: '张三', attributes: ['人物', '技术专家'] },
    { name: 'OhMyDocAgent 平台', attributes: ['产品'] },
    { name: '李四', attributes: ['人物'] },
  ],
  relation: [
    { node1: '张三', node2: 'OhMyDocAgent 平台', type: '开发' },
    { node1: '李四', node2: 'OhMyDocAgent 平台', type: '隶属于' },
  ],
});

/** 组装 service：chat 为可脚本化 mock（默认返回固定有效抽取 JSON） */
function buildService(
  chatImpl?: (messages: unknown[], options?: unknown) => Promise<string>,
) {
  const chat = vi.fn(chatImpl ?? (async () => VALID_EXTRACTION_JSON));
  const service = new GraphExtractionService({
    chat,
    chatStream: vi.fn(),
  } as unknown as ChatModelService, { query: vi.fn() } as never);
  return { service, chat };
}

describe('GraphExtractionService 抽取 prompt 组装', () => {
  it('系统提示包含 JSON 格式（node/relation）与抽取要求；用户提示包含 chunk 内容', () => {
    const { service } = buildService();
    // 系统提示：JSON 结构字段名 + 实体/关系要求 + 只输出 JSON 约束
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('"node"');
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('"relation"');
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('实体是具体名词');
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('只输出 JSON');
    // 用户提示：直接附 chunk 文本（系统提示已含抽取指令与格式说明）
    expect(service.buildUserPrompt('张三是 OhMyDocAgent 平台的技术专家')).toContain(
      '张三是 OhMyDocAgent 平台的技术专家',
    );
  });

  it('chat 调用消息为 [system, user] 且携带 temperature=0.1（低温保格式稳定）', async () => {
    const { service, chat } = buildService();
    await service.extractChunk({ id: 'c1', content: '张三是技术专家' });
    expect(chat).toHaveBeenCalledTimes(1);
    const [messages, options] = chat.mock.calls[0] as [
      Array<{ role: string; content: string }>,
      { temperature?: number },
    ];
    expect(messages.map((m) => m.role)).toEqual(['system', 'user']);
    expect(messages[1].content).toContain('张三是技术专家');
    expect(options?.temperature).toBe(0.1);
  });

  it('超长 chunk 输入截断到 2000 字符（LLM 上下文保护，Task 3.2 质量审查整改）', async () => {
    const { service, chat } = buildService();
    // 3000 字符长 chunk（超 EXTRACTION_INPUT_LIMIT 2000）
    const longContent = '实体A与实体B合作。'.repeat(200); // 200×9=1800 < 2000
    const padded = longContent + '实体C。'.repeat(150); // 再加 450 → 2250 > 2000
    await service.extractChunk({ id: 'c1', content: padded });
    const messages = chat.mock.calls[0][0] as Array<{
      role: string;
      content: string;
    }>;
    const sent = messages.find((m) => m.role === 'user')!.content;
    // 截断后 ≤ 2000，且不为空（截断只影响超长输入）
    expect(sent.length).toBeLessThanOrEqual(2000);
    expect(sent.length).toBeGreaterThan(0);
    // 短内容不截断（原样透传）
    expect(service.buildUserPrompt('张三是 OhMyDocAgent 平台的技术专家')).toContain(
      '张三是 OhMyDocAgent 平台的技术专家',
    );
  });

  it('截断边界不劈开代理对（emoji 落边界时回退，无孤立代理）', async () => {
    const { service } = buildService();
    // 构造「2000 码元处恰是 emoji 低代理」的输入：1999 个 'a' + emoji（占 2 码元）
    const content = 'a'.repeat(1999) + '😀'; // 位置 1999 是低代理（emoji 起点 1999）
    const out = service.buildUserPrompt(content);
    // clampSurrogateBoundary 回退到 1999（emoji 起点）→ 切点落在代理对之前
    expect(out.length).toBe(1999);
    // 截断结果不含孤立代理（无 0xD800–0xDFFF 区间字符）
    for (let i = 0; i < out.length; i++) {
      const code = out.charCodeAt(i);
      expect(code < 0xd800 || code > 0xdfff).toBe(true);
    }
  });
});

describe('parseExtractionJson JSON 解析容错', () => {
  it('markdown 代码块包裹（```json ... ```）→ 剥块后解析成功', () => {
    const parsed = GraphExtractionService.parseExtractionJson(
      '```json\n' + VALID_EXTRACTION_JSON + '\n```',
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.entities.map((e) => e.name)).toEqual([
      '张三',
      'OhMyDocAgent 平台',
      '李四',
    ]);
    expect(parsed!.relations).toHaveLength(2);
  });

  it('前后缀说明文字（LLM 废话）→ 取首个 { 到末尾 } 截取解析成功', () => {
    const parsed = GraphExtractionService.parseExtractionJson(
      '好的，以下是从文本中抽取的结果：\n' +
        VALID_EXTRACTION_JSON +
        '\n希望对您有帮助！',
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.entities).toHaveLength(3);
  });

  it('损坏 JSON → null（抽取失败，调用方抛错触发重试）', () => {
    expect(
      GraphExtractionService.parseExtractionJson('{"node": [{"name": '),
    ).toBeNull();
    expect(
      GraphExtractionService.parseExtractionJson(
        '这不是 JSON，是模型输出的废话',
      ),
    ).toBeNull();
    expect(GraphExtractionService.parseExtractionJson('')).toBeNull();
    expect(GraphExtractionService.parseExtractionJson('   ')).toBeNull();
  });

  it('node 无 name / name 空白 → 实体丢弃；关系行保留（端点过滤在聚合期跨 chunk 判定）', () => {
    const parsed = GraphExtractionService.parseExtractionJson(
      JSON.stringify({
        node: [
          { name: '   ', attributes: ['人物'] }, // 空白名 → 丢弃
          { attributes: ['技术'] }, // 缺 name → 丢弃
          { name: '有效实体', attributes: ['产品'] },
        ],
        relation: [
          { node1: '有效实体', node2: '缺失实体', type: '合作' }, // 端点缺失保留到聚合期
        ],
      }),
    );
    expect(parsed!.entities).toEqual([
      { name: '有效实体', attributes: ['产品'] },
    ]);
    expect(parsed!.relations).toEqual([
      { from: '有效实体', to: '缺失实体', type: '合作' },
    ]);
  });

  it('attributes 非字符串项过滤 + 去重', () => {
    const parsed = GraphExtractionService.parseExtractionJson(
      JSON.stringify({
        node: [
          { name: '甲', attributes: ['人物', '人物', 123, null, '技术专家'] },
        ],
        relation: [],
      }),
    );
    expect(parsed!.entities[0].attributes).toEqual(['人物', '技术专家']);
  });

  it('node/relation 非数组 → null（结构不合法）', () => {
    expect(
      GraphExtractionService.parseExtractionJson('{"node": "not-array"}'),
    ).toBeNull();
    expect(GraphExtractionService.parseExtractionJson('{}')).toBeNull();
  });
});

describe('extractAll 并行抽取与汇总', () => {
  it('并行度 4（Promise pool）：8 个 chunk 同时最多 4 个 LLM 调用', async () => {
    const chunks = Array.from({ length: 8 }, (_, i) => ({
      id: `c${i}`,
      content: `第 ${i} 块内容`,
    }));
    let inFlight = 0;
    let maxConcurrent = 0;
    const chat = vi.fn(async () => {
      inFlight++;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      return VALID_EXTRACTION_JSON;
    });
    const service = new GraphExtractionService({
    chat,
    chatStream: vi.fn(),
  } as unknown as ChatModelService, { query: vi.fn() } as never);
    const agg = await service.extractAll(chunks);
    expect(chat).toHaveBeenCalledTimes(8);
    expect(maxConcurrent).toBe(4);
    // 汇总：每个 chunk 3 实体 + 2 关系（weight=1）+ chunk 镜像
    expect(agg.entities).toHaveLength(24);
    expect(agg.relationships).toHaveLength(16);
    expect(agg.relationships[0]).toEqual(
      expect.objectContaining({
        from: '张三',
        to: 'OhMyDocAgent 平台',
        type: '开发',
        weight: 1,
        chunkId: 'c0',
      }),
    );
    expect(agg.chunks).toHaveLength(8);
    expect(agg.chunks[0]).toEqual({ id: 'c0', content: '第 0 块内容' });
  });

  it('关系端点过滤：跨 chunk 引用合法（全局实体集合判定），引用不存在的端点丢弃', async () => {
    // chunk1：实体 甲/乙 + 关系 甲→乙、甲→丙（丙在 chunk2 才出现——跨 chunk 合法）
    // chunk2：实体 丙 + 关系 丙→丁（丁全文档不存在 → 丢弃）
    const responses = [
      JSON.stringify({
        node: [
          { name: '甲', attributes: ['人物'] },
          { name: '乙', attributes: ['人物'] },
        ],
        relation: [
          { node1: '甲', node2: '乙', type: '合作' },
          { node1: '甲', node2: '丙', type: '合作' },
        ],
      }),
      JSON.stringify({
        node: [{ name: '丙', attributes: ['产品'] }],
        relation: [{ node1: '丙', node2: '丁', type: '引用' }],
      }),
    ];
    const chat = vi.fn(async () => responses.shift() ?? '{}');
    const service = new GraphExtractionService({
    chat,
    chatStream: vi.fn(),
  } as unknown as ChatModelService, { query: vi.fn() } as never);
    const agg = await service.extractAll([
      { id: 'c1', content: '块一' },
      { id: 'c2', content: '块二' },
    ]);
    // 实体：甲(c1)、乙(c1)、丙(c2) 各一行（带 chunkId）
    expect(agg.entities.map((e) => [e.name, e.chunkId])).toEqual([
      ['甲', 'c1'],
      ['乙', 'c1'],
      ['丙', 'c2'],
    ]);
    // 关系：甲→乙 与 甲→丙 保留（丙全局存在）；丙→丁 丢弃（丁不存在）
    expect(agg.relationships.map((r) => [r.from, r.to])).toEqual([
      ['甲', '乙'],
      ['甲', '丙'],
    ]);
    expect(agg.relationships.every((r) => r.weight === 1)).toBe(true);
  });

  it('空 chunk 列表 → 空汇总（不调 LLM）', async () => {
    const { service, chat } = buildService();
    const agg = await service.extractAll([]);
    expect(agg).toEqual({ entities: [], relationships: [], chunks: [] });
    expect(chat).not.toHaveBeenCalled();
  });

  it('损坏 JSON → extractChunk 抛错（JSON 解析失败）→ extractAll 整体失败（重试触发点）', async () => {
    const chat = vi.fn(async () => '模型输出了非 JSON 内容');
    const service = new GraphExtractionService({
    chat,
    chatStream: vi.fn(),
  } as unknown as ChatModelService, { query: vi.fn() } as never);
    await expect(
      service.extractChunk({ id: 'c1', content: 'x' }),
    ).rejects.toThrow(/JSON 解析失败/);
    await expect(
      service.extractAll([{ id: 'c1', content: 'x' }]),
    ).rejects.toThrow(/JSON 解析失败/);
  });

  it('单 chunk 失败隔离：部分失败 → 成功部分照常汇总（失败 chunk 跳过，Task 3.2 质量审查整改）', async () => {
    // 3 个 chunk：chunk0/chunk2 抽取成功（实体甲/乙/丙），chunk1 损坏 JSON 失败
    const responses = [
      JSON.stringify({
        node: [{ name: '甲', attributes: ['人物'] }],
        relation: [],
      }),
      '模型输出了非 JSON 内容', // chunk1 失败
      JSON.stringify({
        node: [{ name: '丙', attributes: ['产品'] }],
        relation: [{ node1: '甲', node2: '丙', type: '引用' }], // 甲在 chunk0——跨 chunk 合法
      }),
    ];
    const chat = vi.fn(async () => responses.shift() ?? '{}');
    const service = new GraphExtractionService({
    chat,
    chatStream: vi.fn(),
  } as unknown as ChatModelService, { query: vi.fn() } as never);
    const agg = await service.extractAll([
      { id: 'c0', content: '块零' },
      { id: 'c1', content: '块一' },
      { id: 'c2', content: '块二' },
    ]);
    // 成功 chunk 的实体照常汇总（失败 chunk 的实体缺失）
    expect(agg.entities.map((e) => [e.name, e.chunkId])).toEqual([
      ['甲', 'c0'],
      ['丙', 'c2'],
    ]);
    // 关系照常保留（跨 chunk 端点判定基于成功实体集合）
    expect(agg.relationships.map((r) => [r.from, r.to])).toEqual([
      ['甲', '丙'],
    ]);
    // chunk 镜像含全部 chunk（镜像反映文档实际分块，与抽取成败无关）
    expect(agg.chunks.map((c) => c.id)).toEqual(['c0', 'c1', 'c2']);
  });

  it('全部 chunk 失败 → extractAll 抛错（触发 job 重试，不静默产出空图）', async () => {
    const chat = vi.fn(async () => '全是坏 JSON');
    const service = new GraphExtractionService({
    chat,
    chatStream: vi.fn(),
  } as unknown as ChatModelService, { query: vi.fn() } as never);
    await expect(
      service.extractAll([
        { id: 'c1', content: 'x' },
        { id: 'c2', content: 'y' },
      ]),
    ).rejects.toThrow(/JSON 解析失败/);
  });

  it('跨文档端点两段判定：图谱既有实体可作为关系端点（Task 3.2 质量审查整改）', async () => {
    // 本文档只出现甲；乙/丙是图谱既有实体（历史文档抽取过，ExtractProcessor
    // 查 listEntityNames 传入）。关系 甲→乙（既有实体，保留——合法跨文档边）、
    // 甲→丁（本文档与图谱都不存在 → 丢弃）
    const chat = vi.fn(async () =>
      JSON.stringify({
        node: [{ name: '甲', attributes: ['人物'] }],
        relation: [
          { node1: '甲', node2: '乙', type: '合作' },
          { node1: '甲', node2: '丁', type: '引用' },
        ],
      }),
    );
    const service = new GraphExtractionService({
    chat,
    chatStream: vi.fn(),
  } as unknown as ChatModelService, { query: vi.fn() } as never);
    const agg = await service.extractAll(
      [{ id: 'c1', content: '块一' }],
      ['乙', '丙'], // 图谱既有实体集合
    );
    expect(agg.relationships.map((r) => [r.from, r.to])).toEqual([
      ['甲', '乙'],
    ]);
    // 不带既有实体集合（缺省空）→ 甲→乙 也被丢弃（与旧语义一致）
    const agg2 = await service.extractAll([{ id: 'c1', content: '块一' }]);
    expect(agg2.relationships).toEqual([]);
  });

  it('LLM 调用失败（503/上游错误）→ 传播抛错（调用方重试）', async () => {
    const chat = vi.fn(async () => {
      throw new Error('no default model');
    });
    const service = new GraphExtractionService({
    chat,
    chatStream: vi.fn(),
  } as unknown as ChatModelService, { query: vi.fn() } as never);
    await expect(
      service.extractChunk({ id: 'c1', content: 'x' }),
    ).rejects.toThrow('no default model');
  });
});
