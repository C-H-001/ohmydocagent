// OllamaProvider 单元测试（Task 2.3）：本地 Ollama 端点（/api/chat、/api/embed）。
// 全部 mock fetch——不打真实 API。
// 断言维度：
// - chat：POST {baseUrl}/api/chat，body { model, messages, stream: false,
//   options: { temperature, num_predict } } → message.content
// - embed：POST {baseUrl}/api/embed → embeddings
// - 错误响应（Ollama 错误格式 { error }）→ 友好错误
// - SSRF 防护：baseUrl 指向私网/元数据端点 → 拒绝（ssrf.guard.ts）；
//   回环地址（127.0.0.1）放行（本地 Ollama 核心场景）
// - testConnection：最小 chat 请求 → { ok: true } / { ok: false, error }
import { afterEach, describe, expect, it, vi } from 'vitest';

/** DNS 解析结果的可变持有者：SSRF 防护需要解析域名，默认公网 IP 放行 */
const dnsMock = vi.hoisted(() => ({
  addresses: ['93.184.216.34'],
}));
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () =>
    dnsMock.addresses.map((address) => ({ address, family: 4 })),
  ),
}));

import { OllamaProvider } from '../src/modules/model/providers/ollama.provider.js';
import type { ChatMessage } from '../src/modules/model/chat-model.interface.js';
import type { ChatStreamChunk } from '../src/modules/model/providers/llm-provider.interface.js';

/** 构造 mock fetch 的 Response 形态（provider 消费 ok/status/statusText/json/text） */
function mockResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

/** 构造 NDJSON 流式响应（Task 2.4 chatStream）：res.body 为逐行产出的异步
 * 迭代器（模拟 Node fetch 的 ReadableStream 分片） */
function mockNdjsonStream(lines: string[]): Response {
  const encoder = new TextEncoder();
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    body: (async function* () {
      for (const line of lines) yield encoder.encode(line);
    })(),
  } as unknown as Response;
}

describe('OllamaProvider（本地 Ollama /api/chat、/api/embed）', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    // 复位 DNS mock：私网注入用例后恢复公网（防止泄漏到后续用例）
    dnsMock.addresses = ['93.184.216.34'];
  });

  it('chat：POST {baseUrl}/api/chat（stream:false 一次性返回）→ message.content', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        mockResponse({ message: { content: '你好，我是 qwen' } }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const provider = new OllamaProvider({
      baseUrl: 'http://127.0.0.1:11434/',
      apiKey: '',
      modelName: 'qwen2.5:7b',
    });
    const out = await provider.chat([{ role: 'user', content: '你好' }], {
      temperature: 0.3,
      maxTokens: 64,
    });
    expect(out).toBe('你好，我是 qwen');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    // baseUrl 尾部斜杠归一化（'http://127.0.0.1:11434/' → 'http://127.0.0.1:11434'）
    expect(url).toBe('http://127.0.0.1:11434/api/chat');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      model: 'qwen2.5:7b',
      messages: [{ role: 'user', content: '你好' }],
      stream: false,
      options: { temperature: 0.3, num_predict: 64 },
    });
  });

  it('chat：错误响应（Ollama 错误格式 { error }）→ 友好错误（含 HTTP 状态）', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        mockResponse(
          { error: "model 'xxx' not found, try pulling it first" },
          404,
        ),
      );
    vi.stubGlobal('fetch', fetchMock);
    const provider = new OllamaProvider({
      baseUrl: 'http://127.0.0.1:11434',
      apiKey: '',
      modelName: 'xxx',
    });
    const p = provider.chat([{ role: 'user', content: 'hi' }]);
    await expect(p).rejects.toThrow(/404/);
    await expect(p).rejects.toThrow(/not found/);
  });

  it('embed：POST {baseUrl}/api/embed → embeddings', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockResponse({
        embeddings: [
          [0.1, 0.2],
          [0.3, 0.4],
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const provider = new OllamaProvider({
      baseUrl: 'http://127.0.0.1:11434',
      apiKey: '',
      modelName: 'nomic-embed-text',
    });
    const vectors = await provider.embed(['a', 'b'], 'nomic-embed-text');
    expect(vectors).toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:11434/api/embed');
    expect(JSON.parse(String(init.body))).toEqual({
      model: 'nomic-embed-text',
      input: ['a', 'b'],
    });
  });

  it('SSRF 防护：baseUrl 指向私网/元数据端点 → chat/embed 拒绝', async () => {
    const provider = new OllamaProvider({
      baseUrl: 'http://192.168.1.1:11434',
      apiKey: '',
      modelName: 'm',
    });
    await expect(
      provider.chat([{ role: 'user', content: 'hi' }]),
    ).rejects.toThrow(/SSRF 防护/);
    await expect(provider.embed(['a'])).rejects.toThrow(/SSRF 防护/);
  });

  it('SSRF 防护：域名解析到私网（mock lookup 169.254.x）→ 拒绝', async () => {
    dnsMock.addresses = ['169.254.169.254'];
    const provider = new OllamaProvider({
      baseUrl: 'http://ollama.internal:11434',
      apiKey: '',
      modelName: 'm',
    });
    await expect(
      provider.chat([{ role: 'user', content: 'hi' }]),
    ).rejects.toThrow(/解析到私网\/保留地址/);
  });

  it('SSRF 防护：回环地址（127.0.0.1）放行——本地 Ollama 核心场景', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(mockResponse({ message: { content: 'pong' } }));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new OllamaProvider({
      baseUrl: 'http://127.0.0.1:11434',
      apiKey: '',
      modelName: 'qwen2.5:7b',
    });
    const out = await provider.chat([{ role: 'user', content: 'hi' }]);
    expect(out).toBe('pong');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('testConnection：私网 baseUrl → { ok: false, error }（SSRF 拒绝不抛异常）', async () => {
    const provider = new OllamaProvider();
    const result = await provider.testConnection({
      baseUrl: 'http://10.0.0.1:11434',
      apiKey: '',
      modelName: 'm',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/SSRF 防护/);
    }
  });

  it('chatStream：POST stream:true NDJSON 逐行 yield，done 行结束并透传 usage', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        mockNdjsonStream([
          '{"message":{"content":"你"}}\n',
          '{"message":{"content":"好"}}\n',
          '{"done":true,"prompt_eval_count":5,"eval_count":7}\n',
        ]),
      );
    vi.stubGlobal('fetch', fetchMock);
    const provider = new OllamaProvider({
      baseUrl: 'http://127.0.0.1:11434/',
      apiKey: '',
      modelName: 'qwen2.5:7b',
    });
    const chunks: ChatStreamChunk[] = [];
    for await (const c of provider.chatStream(
      [{ role: 'user', content: 'hi' }],
      { maxTokens: 64 },
    )) {
      chunks.push(c);
    }
    // 逐段 yield：content 增量 → done 行携带的 usage（prompt_eval_count/eval_count）
    expect(chunks).toEqual([
      { text: '你' },
      { text: '好' },
      { text: '', usage: { inputTokens: 5, outputTokens: 7 } },
    ]);
    // 请求形态：baseUrl 尾部斜杠归一化 + stream:true + options.num_predict
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:11434/api/chat');
    expect(JSON.parse(String(init.body))).toMatchObject({
      stream: true,
      options: { num_predict: 64 },
    });
  });

  it('chatStream：外部 signal 传入 fetch（断连取消信号与内部超时经 AbortSignal.any 组合）', async () => {
    let fetchedSignal: AbortSignal | undefined;
    const fetchMock = vi
      .fn()
      .mockImplementation(async (_url: string, init: RequestInit) => {
        fetchedSignal = init.signal as AbortSignal;
        return mockNdjsonStream([
          '{"message":{"content":"你好"}}\n',
          '{"done":true,"prompt_eval_count":2,"eval_count":3}\n',
        ]);
      });
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    const provider = new OllamaProvider({
      baseUrl: 'http://127.0.0.1:11434',
      apiKey: '',
      modelName: 'qwen2.5:7b',
    });
    const chunks: ChatStreamChunk[] = [];
    for await (const c of provider.chatStream(
      [{ role: 'user', content: 'hi' }],
      { signal: controller.signal },
    )) {
      chunks.push(c);
    }
    expect(chunks).toEqual([
      { text: '你好' },
      { text: '', usage: { inputTokens: 2, outputTokens: 3 } },
    ]);
    // fetch 收到组合后的信号；外部 abort（客户端断连）→ 组合信号同步中止
    expect(fetchedSignal).toBeInstanceOf(AbortSignal);
    expect(fetchedSignal?.aborted).toBe(false);
    controller.abort();
    expect(fetchedSignal?.aborted).toBe(true);
  });

  it('chatStream：错误行 {"error":...} → 抛友好错误', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(mockNdjsonStream(['{"error":"model not found"}\n'])),
    );
    const provider = new OllamaProvider({
      baseUrl: 'http://127.0.0.1:11434',
      apiKey: '',
      modelName: 'xxx',
    });
    await expect(async () => {
      for await (const _ of provider.chatStream([
        { role: 'user', content: 'hi' },
      ])) {
        // 错误行在迭代中抛错，无产出
      }
    }).rejects.toThrow(/model not found/);
  });

  it('chatStream：非 2xx → 友好错误（含 HTTP 状态）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(mockResponse({ error: 'boom' }, 500)),
    );
    const provider = new OllamaProvider({
      baseUrl: 'http://127.0.0.1:11434',
      apiKey: '',
      modelName: 'm',
    });
    await expect(async () => {
      for await (const _ of provider.chatStream([
        { role: 'user', content: 'hi' },
      ])) {
        // 非 2xx 在迭代开始即抛错，无产出
      }
    }).rejects.toThrow(/500/);
  });

  it('chatStream：SSRF 防护前置（私网 baseUrl → 拒绝且不发起 fetch）', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const provider = new OllamaProvider({
      baseUrl: 'http://192.168.1.1:11434',
      apiKey: '',
      modelName: 'm',
    });
    await expect(async () => {
      for await (const _ of provider.chatStream([
        { role: 'user', content: 'hi' },
      ])) {
        // SSRF 拒绝在迭代开始即抛错，无产出
      }
    }).rejects.toThrow(/SSRF 防护/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('testConnection：最小 chat 请求（stream:false）→ { ok: true }', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(mockResponse({ message: { content: 'pong' } }));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new OllamaProvider();
    const result = await provider.testConnection({
      baseUrl: 'http://127.0.0.1:11434',
      apiKey: '',
      modelName: 'qwen2.5:7b',
    });
    expect(result).toEqual({ ok: true });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({ stream: false });
  });

  it('testConnection：非 2xx → { ok: false, error }（不抛异常）', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(mockResponse({ error: 'connection refused' }, 500)),
    );
    const provider = new OllamaProvider();
    const result = await provider.testConnection({
      baseUrl: 'http://127.0.0.1:11434',
      apiKey: '',
      modelName: 'm',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/connection refused/);
    }
  });

  it('chatStream：tools 透传（body.tools）+ message.tool_calls 完整出现时 yield toolCalls', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        mockNdjsonStream([
          '{"message":{"role":"assistant","content":"","tool_calls":[{"function":{"name":"web_search","arguments":{"query":"今天天气"}}}]},"done":false}\n',
          '{"message":{"role":"assistant","content":"最终回答"},"done":false}\n',
          '{"done":true,"prompt_eval_count":3,"eval_count":5}\n',
        ]),
      );
    vi.stubGlobal('fetch', fetchMock);
    const provider = new OllamaProvider({
      baseUrl: 'http://127.0.0.1:11434/',
      apiKey: '',
      modelName: 'qwen2.5:7b',
    });
    const chunks: ChatStreamChunk[] = [];
    for await (const c of provider.chatStream(
      [{ role: 'user', content: '天气如何？' }],
      {
        tools: [
          { name: 'web_search', description: '联网搜索', parameters: {} },
        ],
      },
    )) {
      chunks.push(c);
    }
    // message.tool_calls 完整出现（Ollama 非分片）：一次 yield（arguments 为
    // 对象时序列化；id 由 provider 本地生成——Ollama 协议无 id）
    expect(chunks).toEqual([
      {
        text: '',
        toolCalls: [
          {
            id: expect.stringMatching(/^call_/),
            name: 'web_search',
            arguments: '{"query":"今天天气"}',
          },
        ],
      },
      { text: '最终回答' },
      { text: '', usage: { inputTokens: 3, outputTokens: 5 } },
    ]);
    // 请求形态：body.tools（OpenAI 同构的 function calling 形态）
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body)).tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'web_search',
          description: '联网搜索',
          parameters: {},
        },
      },
    ]);
  });

  it('chatStream：回填消息映射（assistant tool_calls 剥 id/type、tool 消息剥 tool_call_id——Ollama 原生协议）', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        mockNdjsonStream([
          '{"message":{"content":"好"},"done":false}\n',
          '{"done":true}\n',
        ]),
      );
    vi.stubGlobal('fetch', fetchMock);
    const provider = new OllamaProvider({
      baseUrl: 'http://127.0.0.1:11434',
      apiKey: '',
      modelName: 'qwen2.5:7b',
    });
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: '',
        // 推理回传字段（DeepSeek R1 工具模式）：Ollama 协议无此概念，映射时剥除
        reasoning_content: '先思考',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'search_kb', arguments: '{}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '检索结果' },
    ];
    const chunks: ChatStreamChunk[] = [];
    for await (const c of provider.chatStream(messages, {})) {
      chunks.push(c);
    }
    // Ollama 原生协议：tool_calls 无 id/type、tool 消息无 tool_call_id、
    // 无 reasoning_content（推理字段无回传语义，质量审查整改）
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body)).messages).toEqual([
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ function: { name: 'search_kb', arguments: '{}' } }],
      },
      { role: 'tool', content: '检索结果' },
    ]);
  });

  it('chatStream：空 tools 数组 → 请求体不发 tools 字段（质量审查整改：空数组省略）', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        mockNdjsonStream([
          '{"message":{"content":"好"},"done":false}\n',
          '{"done":true}\n',
        ]),
      );
    vi.stubGlobal('fetch', fetchMock);
    const provider = new OllamaProvider({
      baseUrl: 'http://127.0.0.1:11434',
      apiKey: '',
      modelName: 'qwen2.5:7b',
    });
    const chunks: ChatStreamChunk[] = [];
    for await (const c of provider.chatStream(
      [{ role: 'user', content: 'hi' }],
      { tools: [] },
    )) {
      chunks.push(c);
    }
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    // tools: [] 不再序列化（无工具场景不携带 tools 字段，既有请求形态不变）
    expect(JSON.parse(String(init.body)).tools).toBeUndefined();
    expect(chunks).toEqual([{ text: '好' }]);
  });
});
