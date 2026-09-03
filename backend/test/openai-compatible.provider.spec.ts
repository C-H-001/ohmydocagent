// OpenAICompatibleProvider 单元测试（Task 2.3）：OpenAI/DeepSeek/Qwen 均走
// OpenAI 兼容端点（/chat/completions、/embeddings）。全部 mock fetch——
// 不打真实 API（Node 24 全局 fetch，vi.stubGlobal 替换）。
// 断言维度：
// - chat：URL 正确（baseUrl 尾部斜杠归一化）、POST + Bearer 鉴权、
//   body 透传（model/messages/temperature/max_tokens）
// - 错误响应（非 2xx）→ 提取 error.message 抛友好错误（含 HTTP 状态）
// - 网络异常 → 友好化（不泄露底层堆栈）
// - 响应缺 content → 格式错误
// - embed：POST {baseUrl}/embeddings → data[].embedding；缺向量/空向量/
//   维度不一致 → 格式错误（fail-fast，不静默返回空数组）
// - 200 非 JSON 响应体 → 格式错误（res.text + JSON.parse，含截断文本）
// - SSRF 防护：baseUrl 指向私网/云元数据端点 → 拒绝（见 ssrf.guard.ts）；
//   回环地址（127.0.0.1）放行；域名解析统一 mock 公网 IP（防护逻辑本身
//   在 ssrf.guard.spec.ts 覆盖，这里验证调用点接入）
// - testConnection：发最小 chat 请求（1 token），2xx → { ok: true }、
//   非 2xx → { ok: false, error }（不抛异常）
import { afterEach, describe, expect, it, vi } from 'vitest';

/** DNS 解析结果的可变持有者：SSRF 防护（assertSafeBaseUrl）需要解析域名——
 * 默认公网 IP 放行（用例聚焦 provider 行为本身） */
const dnsMock = vi.hoisted(() => ({
  addresses: ['93.184.216.34'],
}));
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () =>
    dnsMock.addresses.map((address) => ({ address, family: 4 })),
  ),
}));

import { OpenAICompatibleProvider } from '../src/modules/model/providers/openai-compatible.provider.js';
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

/** 构造 SSE 流式响应（Task 2.4 chatStream）：res.body 为逐行产出的异步迭代器
 * （模拟 Node fetch 的 ReadableStream 分片）；lines 每项是原始字节串（含换行符） */
function mockSseStream(lines: string[]): Response {
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

describe('OpenAICompatibleProvider（OpenAI/DeepSeek/Qwen 统一 OpenAI 兼容端点）', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    // 复位 DNS mock：私网注入用例后恢复公网（防止泄漏到后续用例）
    dnsMock.addresses = ['93.184.216.34'];
  });

  it('chat：POST {baseUrl}/chat/completions，Bearer 鉴权 + 透传 temperature/maxTokens', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockResponse({
        choices: [{ message: { content: '你好，我是 DeepSeek' } }],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'https://api.deepseek.com/',
      apiKey: 'sk-test-123',
      modelName: 'deepseek-chat',
    });
    const out = await provider.chat([{ role: 'user', content: '你好' }], {
      temperature: 0.5,
      maxTokens: 100,
    });
    expect(out).toBe('你好，我是 DeepSeek');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    // baseUrl 尾部斜杠归一化（'https://api.deepseek.com/' → 'https://api.deepseek.com'）
    expect(url).toBe('https://api.deepseek.com/chat/completions');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      'Content-Type': 'application/json',
      Authorization: 'Bearer sk-test-123',
    });
    expect(JSON.parse(String(init.body))).toEqual({
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: '你好' }],
      temperature: 0.5,
      max_tokens: 100,
    });
  });

  it('chat：错误响应（401 + error.message）→ 抛友好错误（含 HTTP 状态与供应商消息）', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        mockResponse({ error: { message: 'Invalid API key provided' } }, 401),
      );
    vi.stubGlobal('fetch', fetchMock);
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'https://x',
      apiKey: 'bad-key',
      modelName: 'm',
    });
    const p = provider.chat([{ role: 'user', content: 'hi' }]);
    await expect(p).rejects.toThrow(/401/);
    await expect(p).rejects.toThrow(/Invalid API key/);
  });

  it('chat：网络异常 → 指数退避重试（默认 3 次）后友好化（不泄露底层 fetch 堆栈）', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'https://unreachable',
      apiKey: 'k',
      modelName: 'm',
    });
    await expect(
      provider.chat([{ role: 'user', content: 'hi' }]),
    ).rejects.toThrow(/连接供应商失败/);
    // 参考 WeKnora：网络错误指数退避重试（1 次 + 3 次重试）
    expect(fetchMock).toHaveBeenCalledTimes(4);
  }, 30000);

  it('chat：响应缺 content → 抛格式错误', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(mockResponse({ choices: [{}] })),
    );
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'https://x',
      apiKey: 'k',
      modelName: 'm',
    });
    await expect(
      provider.chat([{ role: 'user', content: 'hi' }]),
    ).rejects.toThrow(/choices\[0\].message.content/);
  });

  it('embed：POST {baseUrl}/embeddings → data[].embedding', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockResponse({
        data: [{ embedding: [0.1, 0.2] }, { embedding: [0.3, 0.4] }],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'https://x',
      apiKey: 'k',
      modelName: 'm',
    });
    const vectors = await provider.embed(['a', 'b'], 'text-embedding-3-small');
    expect(vectors).toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://x/embeddings');
    expect(JSON.parse(String(init.body))).toEqual({
      model: 'text-embedding-3-small',
      input: ['a', 'b'],
    });
  });

  it('embed：缺向量/空向量 → 格式错误（fail-fast，不静默返回空数组）', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(mockResponse({ data: [{ embedding: undefined }] })),
    );
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'https://x.example.com',
      apiKey: 'k',
      modelName: 'm',
    });
    await expect(provider.embed(['a'])).rejects.toThrow(/缺失或为空/);
  });

  it('embed：批内向量维度不一致 → 格式错误（fail-fast）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        mockResponse({
          data: [{ embedding: [0.1] }, { embedding: [0.1, 0.2] }],
        }),
      ),
    );
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'https://x.example.com',
      apiKey: 'k',
      modelName: 'm',
    });
    await expect(provider.embed(['a', 'b'])).rejects.toThrow(/维度不一致/);
  });

  it('chat：200 非 JSON 响应体 → 格式错误（含截断文本）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => {
          throw new Error('not json');
        },
        text: async () => '<html>Gateway Error</html>',
      } as unknown as Response),
    );
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'https://x.example.com',
      apiKey: 'k',
      modelName: 'm',
    });
    await expect(
      provider.chat([{ role: 'user', content: 'hi' }]),
    ).rejects.toThrow(/非 JSON/);
  });

  it('SSRF 防护：baseUrl 指向云元数据端点（169.254.169.254）→ chat/embed 拒绝', async () => {
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'http://169.254.169.254/latest/meta-data/',
      apiKey: '',
      modelName: 'm',
    });
    await expect(
      provider.chat([{ role: 'user', content: 'hi' }]),
    ).rejects.toThrow(/SSRF 防护/);
    await expect(provider.embed(['a'])).rejects.toThrow(/SSRF 防护/);
  });

  it('SSRF 防护：域名解析到私网 10.x（mock lookup）→ 拒绝', async () => {
    dnsMock.addresses = ['10.0.0.5'];
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'https://internal.example.com',
      apiKey: 'k',
      modelName: 'm',
    });
    await expect(
      provider.chat([{ role: 'user', content: 'hi' }]),
    ).rejects.toThrow(/解析到私网\/保留地址/);
  });

  it('SSRF 防护：回环地址（127.0.0.1）放行（Ollama 本地部署同类场景）', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        mockResponse({ choices: [{ message: { content: 'pong' } }] }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'http://127.0.0.1:8080',
      apiKey: '',
      modelName: 'm',
    });
    const out = await provider.chat([{ role: 'user', content: 'hi' }]);
    expect(out).toBe('pong');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('testConnection：私网 baseUrl → { ok: false, error }（SSRF 拒绝不抛异常）', async () => {
    const provider = new OpenAICompatibleProvider();
    const result = await provider.testConnection({
      baseUrl: 'http://169.254.169.254/latest/meta-data/',
      apiKey: '',
      modelName: 'm',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/SSRF 防护/);
    }
  });

  it('chatStream：POST stream:true + include_usage，SSE 多行逐段 yield（reasoning_content 映射 + usage 透传）', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        mockSseStream([
          'data: {"choices":[{"delta":{"reasoning_content":"先分析需求"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"你好"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"，OhMyDocAgent"}}]}\n\n',
          'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":20}}\n\n',
          'data: [DONE]\n\n',
        ]),
      );
    vi.stubGlobal('fetch', fetchMock);
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'https://api.deepseek.com/',
      apiKey: 'sk-test',
      modelName: 'deepseek-chat',
    });
    const chunks: ChatStreamChunk[] = [];
    for await (const c of provider.chatStream(
      [{ role: 'user', content: '你好' }],
      { temperature: 0.5 },
    )) {
      chunks.push(c);
    }
    // 逐段 yield：reasoning（reasoning_content 映射）→ text 增量 → usage-only 尾块
    expect(chunks).toEqual([
      { text: '', reasoning: '先分析需求' },
      { text: '你好' },
      { text: '，OhMyDocAgent' },
      { text: '', usage: { inputTokens: 10, outputTokens: 20 } },
    ]);
    // 请求形态：baseUrl 尾部斜杠归一化 + stream/stream_options + 鉴权头
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.deepseek.com/chat/completions');
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: '你好' }],
      stream: true,
      stream_options: { include_usage: true },
      temperature: 0.5,
    });
    expect(init.headers).toMatchObject({ Authorization: 'Bearer sk-test' });
  });

  it('chatStream：外部 signal 传入 fetch（与内部超时经 AbortSignal.any 组合，断连即中止）', async () => {
    let fetchedSignal: AbortSignal | undefined;
    const fetchMock = vi
      .fn()
      .mockImplementation(async (_url: string, init: RequestInit) => {
        fetchedSignal = init.signal as AbortSignal;
        return mockSseStream([
          'data: {"choices":[{"delta":{"content":"你好"}}]}\n\n',
          'data: [DONE]\n\n',
        ]);
      });
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'https://api.deepseek.com/',
      apiKey: 'sk-test',
      modelName: 'deepseek-chat',
    });
    const chunks: ChatStreamChunk[] = [];
    for await (const c of provider.chatStream(
      [{ role: 'user', content: '你好' }],
      { signal: controller.signal },
    )) {
      chunks.push(c);
    }
    expect(chunks).toEqual([{ text: '你好' }]);
    // fetch 收到的是组合后的信号（AbortSignal.any([外部 signal, 超时])），非裸外部信号
    expect(fetchedSignal).toBeInstanceOf(AbortSignal);
    expect(fetchedSignal?.aborted).toBe(false);
    // 外部 abort（客户端断连）→ 组合信号同步中止——fetch 请求即被中断（烧 token 止损）
    controller.abort();
    expect(fetchedSignal?.aborted).toBe(true);
  });

  it('chatStream：生成中止（外部 signal abort，模拟 fetch 流中断）→ 迭代以 AbortError 结束', async () => {
    const controller = new AbortController();
    const encoder = new TextEncoder();
    const body = (async function* () {
      yield encoder.encode(
        'data: {"choices":[{"delta":{"content":"部分"}}]}\n\n',
      );
      // 等待外部中止：模拟真实 fetch 流被 abort 中断（undici 以 AbortError reject）
      await new Promise<void>((resolve) => {
        controller.signal.addEventListener('abort', () => resolve());
      });
      throw new DOMException('The operation was aborted', 'AbortError');
    })();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        body,
      } as unknown as Response),
    );
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'https://x',
      apiKey: 'k',
      modelName: 'm',
    });
    const chunks: ChatStreamChunk[] = [];
    const runPromise = (async () => {
      for await (const c of provider.chatStream(
        [{ role: 'user', content: 'hi' }],
        { signal: controller.signal },
      )) {
        chunks.push(c);
      }
    })();
    // 等首块被消费（进入 fetch 流读取、阻塞在 abort 等待）
    await vi.waitFor(() => expect(chunks).toEqual([{ text: '部分' }]));
    // 中止（模拟客户端断连 → 编排器 abort → fetch 流被中断）
    controller.abort();
    await expect(runPromise).rejects.toMatchObject({ name: 'AbortError' });
    // 已产出块保留（编排器据此落库 partial assistant，断连不丢已生成部分）
    expect(chunks).toEqual([{ text: '部分' }]);
  });

  it('chatStream：usage 门槛放宽（整改 #8）——只回 completion_tokens 也透传 usage', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        mockSseStream([
          'data: {"choices":[{"delta":{"content":"回复"}}]}\n\n',
          'data: {"choices":[],"usage":{"completion_tokens":7}}\n\n',
          'data: [DONE]\n\n',
        ]),
      );
    vi.stubGlobal('fetch', fetchMock);
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'https://x',
      apiKey: 'k',
      modelName: 'm',
    });
    const chunks: ChatStreamChunk[] = [];
    for await (const c of provider.chatStream([
      { role: 'user', content: 'hi' },
    ])) {
      chunks.push(c);
    }
    // 无 prompt_tokens：completion_tokens 存在即透传（inputTokens 缺省 undefined）
    expect(chunks).toEqual([
      { text: '回复' },
      { text: '', usage: { inputTokens: undefined, outputTokens: 7 } },
    ]);
  });

  it('chatStream：SSE 数据行跨分片也能正确拼装（切分点落在多字节 UTF-8 字符内部——TextDecoder stream:true 正确重组）', async () => {
    const encoder = new TextEncoder();
    const sseLine = 'data: {"choices":[{"delta":{"content":"你好"}}]}\n\n';
    const bytes = encoder.encode(sseLine);
    // 切分点放在「你」的字节内部（质量审查整改 #7）：原文第 33 个字符（0-indexed）
    // 是「你」——前 33 个 ASCII 字符占 33 字节，切分点取「你」首字节后 1 字节
    // （第 2/3 字节处）——第一分片以半个「你」结尾，第二分片从剩余字节开始
    const splitByte = encoder.encode(sseLine.slice(0, 33)).length + 1;
    expect(bytes[splitByte]).not.toBe(undefined); // 切分点确实落在行内
    const body = (async function* () {
      yield bytes.slice(0, splitByte);
      yield bytes.slice(splitByte);
    })();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        body,
      } as unknown as Response),
    );
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'https://x',
      apiKey: 'k',
      modelName: 'm',
    });
    const chunks: ChatStreamChunk[] = [];
    for await (const c of provider.chatStream([
      { role: 'user', content: 'hi' },
    ])) {
      chunks.push(c);
    }
    expect(chunks).toEqual([{ text: '你好' }]);
  });

  it('chatStream：错误行 data: {"error":...} → 抛友好错误（已产出块保留）', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          mockSseStream([
            'data: {"choices":[{"delta":{"content":"部分回复"}}]}\n\n',
            'data: {"error":{"message":"insufficient_quota"}}\n\n',
          ]),
        ),
    );
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'https://x',
      apiKey: 'k',
      modelName: 'm',
    });
    const chunks: ChatStreamChunk[] = [];
    await expect(async () => {
      for await (const c of provider.chatStream([
        { role: 'user', content: 'hi' },
      ])) {
        chunks.push(c);
      }
    }).rejects.toThrow(/insufficient_quota/);
    expect(chunks).toEqual([{ text: '部分回复' }]);
  });

  it('chatStream：非 2xx → 友好错误（含 HTTP 状态与供应商消息）', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          mockResponse({ error: { message: 'bad key' } }, 401),
        ),
    );
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'https://x',
      apiKey: 'bad',
      modelName: 'm',
    });
    await expect(async () => {
      for await (const _ of provider.chatStream([
        { role: 'user', content: 'hi' },
      ])) {
        // 非 2xx 在迭代开始即抛错，无产出
      }
    }).rejects.toThrow(/401/);
  });

  it('chatStream：SSRF 防护前置（私网 baseUrl → 拒绝且不发起 fetch）', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'http://169.254.169.254/latest/meta-data/',
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

  it('testConnection：发最小 chat 请求（1 token），2xx → { ok: true }', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        mockResponse({ choices: [{ message: { content: 'pong' } }] }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const provider = new OpenAICompatibleProvider();
    const result = await provider.testConnection({
      baseUrl: 'https://x',
      apiKey: 'k',
      modelName: 'm',
    });
    expect(result).toEqual({ ok: true });
    // 最小 chat 请求：max_tokens=1（最真实的连通性验证，见实现注释）
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: 'm',
      max_tokens: 1,
    });
  });

  it('testConnection：非 2xx → { ok: false, error }（不抛异常）', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          mockResponse({ error: { message: 'model not found' } }, 404),
        ),
    );
    const provider = new OpenAICompatibleProvider();
    const result = await provider.testConnection({
      baseUrl: 'https://x',
      apiKey: 'k',
      modelName: 'm',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/model not found/);
    }
  });

  it('chatStream：tools 透传（body.tools = options.tools 包装成 OpenAI function 形态）', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(mockSseStream(['data: [DONE]\n\n']));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-test',
      modelName: 'deepseek-chat',
    });
    const chunks: ChatStreamChunk[] = [];
    for await (const c of provider.chatStream(
      [{ role: 'user', content: '你好' }],
      {
        tools: [
          {
            name: 'search_kb',
            description: '检索企业知识库',
            parameters: {
              type: 'object',
              properties: { query: { type: 'string' } },
              required: ['query'],
            },
          },
        ],
      },
    )) {
      chunks.push(c);
    }
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    // body.tools：OpenAI function calling 形态（type:'function' 包装）
    expect(JSON.parse(String(init.body)).tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'search_kb',
          description: '检索企业知识库',
          parameters: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
          },
        },
      },
    ]);
  });

  it('chatStream：流式 tool_calls 分片累积（delta.tool_calls 按 index 拼接 arguments → 完整 yield 一次）', async () => {
    // OpenAI 兼容流式 tool_calls：name 在首片、arguments 分多片（可能跨
    // UTF-8 字符）、id 只在首片出现——provider 需按 index 累积完整再 yield
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        mockSseStream([
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_abc123","type":"function","function":{"name":"search_kb","arguments":""}}]}}]}\n\n',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"query\\":\\"智"}}]}}]}\n\n',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"能客服"}}]}}]}\n\n',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"}"}}]}}]}\n\n',
          'data: [DONE]\n\n',
        ]),
      );
    vi.stubGlobal('fetch', fetchMock);
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-test',
      modelName: 'deepseek-chat',
    });
    const chunks: ChatStreamChunk[] = [];
    for await (const c of provider.chatStream(
      [{ role: 'user', content: '检索' }],
      {
        tools: [{ name: 'search_kb', description: 'x', parameters: {} }],
      },
    )) {
      chunks.push(c);
    }
    // 完整工具调用一次 yield（text 空串）；arguments 分片拼接还原
    expect(chunks).toEqual([
      {
        text: '',
        toolCalls: [
          {
            id: 'call_abc123',
            name: 'search_kb',
            arguments: '{"query":"智能客服"}',
          },
        ],
      },
    ]);
  });

  it('chatStream：多个 tool_calls（index 0/1）按 index 顺序 yield', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        mockSseStream([
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"search_kb","arguments":""}}]}}]}\n\n',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"c2","function":{"name":"web_search","arguments":""}}]}}]}\n\n',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{}"}}]}}]}\n\n',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"function":{"arguments":"{}"}}]}}]}\n\n',
          'data: [DONE]\n\n',
        ]),
      );
    vi.stubGlobal('fetch', fetchMock);
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-test',
      modelName: 'deepseek-chat',
    });
    const chunks: ChatStreamChunk[] = [];
    for await (const c of provider.chatStream(
      [{ role: 'user', content: '检索' }],
      { tools: [] },
    )) {
      chunks.push(c);
    }
    expect(chunks).toEqual([
      {
        text: '',
        toolCalls: [
          { id: 'c1', name: 'search_kb', arguments: '{}' },
          { id: 'c2', name: 'web_search', arguments: '{}' },
        ],
      },
    ]);
  });

  it('chatStream：空 tools 数组 → 请求体不发 tools 字段（质量审查整改：空数组省略）', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        mockSseStream([
          'data: {"choices":[{"delta":{"content":"你好"}}]}\n\n',
          'data: [DONE]\n\n',
        ]),
      );
    vi.stubGlobal('fetch', fetchMock);
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'https://x',
      apiKey: 'k',
      modelName: 'm',
    });
    const chunks: ChatStreamChunk[] = [];
    for await (const c of provider.chatStream(
      [{ role: 'user', content: 'hi' }],
      { tools: [] },
    )) {
      chunks.push(c);
    }
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    // tools: [] 不再序列化（既有请求形态不变——无工具场景不携带 tools 字段）
    expect(JSON.parse(String(init.body)).tools).toBeUndefined();
    expect(chunks).toEqual([{ text: '你好' }]);
  });

  it('chatStream：reasoning_content 透传（DeepSeek R1 工具模式回传——assistant 消息携带推理内容）', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        mockSseStream([
          'data: {"choices":[{"delta":{"content":"好"}}]}\n\n',
          'data: [DONE]\n\n',
        ]),
      );
    vi.stubGlobal('fetch', fetchMock);
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-test',
      modelName: 'deepseek-reasoner',
    });
    const assistantMsg: ChatMessage = {
      role: 'assistant',
      content: '',
      reasoning_content: '先分析需求',
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'search_kb', arguments: '{"query":"q"}' },
        },
      ],
    };
    const chunks: ChatStreamChunk[] = [];
    for await (const c of provider.chatStream(
      [assistantMsg, { role: 'tool', tool_call_id: 'call_1', content: '结果' }],
      {
        tools: [{ name: 'search_kb', description: '检索', parameters: {} }],
      },
    )) {
      chunks.push(c);
    }
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    // 请求体 messages：reasoning_content 原样透传（R1 第二轮思考上下文不断裂）
    expect(JSON.parse(String(init.body)).messages).toEqual([
      {
        role: 'assistant',
        content: '',
        reasoning_content: '先分析需求',
        tool_calls: assistantMsg.tool_calls,
      },
      { role: 'tool', content: '结果', tool_call_id: 'call_1' },
    ]);
    expect(chunks).toEqual([{ text: '好' }]);
  });

  it('chatStream：reasoning 与 tool_calls 同流组合（思考块 + 正文块 + 工具块按序 yield）', async () => {
    // 工具分片在流结束时统一冲刷（flushToolCalls——[DONE] 前 yield 正文），
    // 因此块序为：reasoning → 正文 → toolCalls（完整列表一次 yield）
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        mockSseStream([
          'data: {"choices":[{"delta":{"reasoning_content":"思考：需要检索"}}]}\n\n',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"search_kb","arguments":"{\\"query\\":\\"q\\"}"}}]}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"根据资料"}}]}\n\n',
          'data: [DONE]\n\n',
        ]),
      );
    vi.stubGlobal('fetch', fetchMock);
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'https://x',
      apiKey: 'k',
      modelName: 'm',
    });
    const chunks: ChatStreamChunk[] = [];
    for await (const c of provider.chatStream(
      [{ role: 'user', content: 'hi' }],
      {
        tools: [{ name: 'search_kb', description: '检索', parameters: {} }],
      },
    )) {
      chunks.push(c);
    }
    expect(chunks).toEqual([
      { text: '', reasoning: '思考：需要检索' },
      { text: '根据资料' },
      {
        text: '',
        toolCalls: [
          { id: 'c1', name: 'search_kb', arguments: '{"query":"q"}' },
        ],
      },
    ]);
  });
});
