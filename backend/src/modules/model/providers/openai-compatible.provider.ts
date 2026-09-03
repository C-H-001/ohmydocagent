// backend/src/modules/model/providers/openai-compatible.provider.ts
// OpenAI 兼容供应商实现（Task 2.3）：覆盖 OpenAI / DeepSeek / Qwen 等所有
// OpenAI 兼容端点（/chat/completions、/embeddings）。用 fetch 直连——
// 不引入 openai SDK 大依赖（兼容端点只需 HTTP POST，SDK 是锦上添花；
// 注释说明：若未来需要重试/超时/流式等 SDK 能力，可替换为 openai 包，
// 接口不变，见 llm-provider.interface.ts）。
//
// URL 拼接约定：baseUrl 是 API 根（如 https://api.deepseek.com 或
// https://api.openai.com/v1），chat = ${baseUrl}/chat/completions、
// embed = ${baseUrl}/embeddings；baseUrl 尾部斜杠归一化（配置时用户常带
// 末尾 '/'，直接拼会出 '//chat/completions'）。
//
// 错误处理（友好化）：
// - 非 2xx：尝试解析 OpenAI 风格错误体 { error: { message } } 或
//   { error: 'msg' }，包装为「供应商请求失败（HTTP xxx）: detail」；
// - 网络异常（DNS/连接拒绝/超时）：包装为「连接供应商失败（网络错误）」——
//   不让底层 TypeError 堆栈直接穿透到 API 响应；
// - 响应缺 content / 200 非 JSON 响应体：格式错误（上游返回 200 但结构异常，
//   res.text + JSON.parse 包装，含截断文本便于排查）；
// - embed 缺向量/长度不一致：fail-fast 抛格式错误（不静默返回空数组——
//   空向量落库会污染向量索引，宁可在调用链上显式失败）。
//
// SSRF 防护（Task 2.3 质量审查整改）：每次 fetch 前调用 assertSafeBaseUrl
// （ssrf.guard.ts）——baseUrl 用户可控（新增模型/连通性测试直传配置），必须
// 拒绝指向内网/云元数据端点（169.254.169.254 等）的目标；回环地址放行
// （Ollama 本地部署核心场景）。校验在 fetch 的 try 块之外：SSRF 拒绝信息
// 保持清晰（不被「连接供应商失败」包装掩盖）。
//
// 超时：AbortSignal.timeout(15s)——供应商无响应时快速失败（默认 fetch 无
// 超时会挂起 socket 直到系统超时，队列场景不可接受）。
//
// 流式 chatStream（Task 2.4）：POST /chat/completions 带 stream:true +
// stream_options.include_usage（末尾多一个 usage-only chunk，供 done 事件
// 展示 token 用量）→ res.body 逐块读 + SSE 行缓冲解析（见方法内注释）→
// choices[0].delta.content yield { text }；delta.reasoning_content /
// reasoning → yield { reasoning }（DeepSeek R1 / Qwen3 风格深度思考，无则
// 忽略）；data: [DONE] 结束；data: {"error":...} 抛友好错误。
// 流式超时放宽到 120s（非流式 15s 是「一次性等完整响应」；流式包含生成
// 时间，推理模型思考可能较久——120s 防挂死同时覆盖常规长生成，可按需调）。
import { Injectable, Logger, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { assertSafeBaseUrl } from '../../../common/ssrf.guard.js';
import type { ChatMessage } from '../chat-model.interface.js';
import type {
  ChatProviderOptions,
  ChatStreamChunk,
  LLMProvider,
  ProviderConnectionConfig,
  TestConnectionResult,
} from './llm-provider.interface.js';

/** 请求超时（毫秒）：供应商无响应时快速失败（默认 fetch 无超时，见文件头注释） */
const REQUEST_TIMEOUT_MS = 120000;
// LLM API 重试（参考 WeKnora models/embedding/*.go：网络错误指数退避重试）：
// - maxRetries=3，退避 1s/2s/4s（指数 ×2），上限 10s
// - 重试条件：网络错误（fetch 抛错/超时）+ HTTP 429/5xx（上游限流/瞬时故障）；
//   4xx（400/401/404 等语义错误）不重试（重试无意义且浪费配额）
const LLM_MAX_RETRIES = 3;
const LLM_BACKOFF_BASE_MS = 1000;
const LLM_BACKOFF_CAP_MS = 10000;

/** 是否可重试的状态码（429/5xx 重试；4xx 不重试） */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/** 指数退避延迟（ms）：2^(attempt-1) * base，上限 cap */
function backoffDelay(attempt: number): number {
  return Math.min(LLM_BACKOFF_CAP_MS, Math.pow(2, attempt - 1) * LLM_BACKOFF_BASE_MS);
}

/**
 * fetch + 指数退避重试（网络错误 / 429 / 5xx）。
 * - 返回 { res, attempts }（attempts 用于日志）
 * - 重试仅对「请求发起前」失败有效——调用方拿到 res 后自行处理业务逻辑；
 *   流式场景（chatStream）在 fetch 成功后不再重试（流中失败无法回退）
 */
async function retryFetch(
  url: string,
  init: RequestInit,
): Promise<{ res: Response; attempts: number }> {
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= LLM_MAX_RETRIES + 1; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (err) {
      // 网络错误（DNS/连接拒绝/超时）
      lastErr = err;
      if (attempt <= LLM_MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, backoffDelay(attempt)));
        continue;
      }
      throw err;
    }
    if (isRetryableStatus(res.status) && attempt <= LLM_MAX_RETRIES) {
      // 429/5xx：读掉 body（释放连接）后退避重试
      await res.text().catch(() => '');
      await new Promise((r) => setTimeout(r, backoffDelay(attempt)));
      continue;
    }
    return { res, attempts: attempt };
  }
  throw lastErr ?? new Error('retry exhausted');
}

/** 流式请求超时（毫秒）：含生成时间（推理模型思考可能较久），放宽到 120s
 * （见文件头 chatStream 注释；按需可调） */
const STREAM_TIMEOUT_MS = 120000;

/** 解析 200 响应体：非 JSON（网关 HTML 页/纯文本等）→ 格式错误
 * （含截断文本便于排查；fail-fast 不静默） */
function parseJsonBody(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `供应商返回非 JSON 响应（格式异常）: ${text.slice(0, 200)}`,
    );
  }
}

/** 提取非 2xx 响应体的错误详情（OpenAI 风格 { error: { message } | string }，
 * 解析失败退回 HTTP 状态文本） */
async function extractErrorDetail(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as
      { error?: { message?: string } | string } | undefined;
    if (typeof body?.error === 'string') return body.error;
    if (typeof body?.error?.message === 'string') return body.error.message;
  } catch {
    // 响应体非 JSON（网关 HTML 页等）→ 退回状态文本
  }
  return res.statusText || `HTTP ${res.status}`;
}

@Injectable()
export class OpenAICompatibleProvider implements LLMProvider {
  private readonly logger = new Logger(OpenAICompatibleProvider.name);

  /** 实例绑定的连接配置（withConfig 返回新实例；无绑定配置时 chat/embed 抛错，
   * testConnection 直接用入参 config，无需绑定）。
   * @Optional：DI 容器注入单例时无参（连接配置是接口类型、运行时被擦除，
   * 不能作为依赖注入项）；业务绑定走 withConfig → new 直接传参（绕开容器） */
  constructor(@Optional() private readonly config?: ProviderConnectionConfig) {}

  withConfig(config: ProviderConnectionConfig): LLMProvider {
    // 不可变：绑定配置 = 新实例（注入的单例不带配置，避免共享可变状态）
    return new OpenAICompatibleProvider(config);
  }

  /** baseUrl 尾部斜杠归一化：'https://api.deepseek.com/' → 'https://api.deepseek.com' */
  private normalizeBaseUrl(baseUrl: string): string {
    return baseUrl.replace(/\/+$/, '');
  }

  /**
   * 请求体消息映射（Task 2.8 质量审查整改）：OpenAI 兼容协议透传
   * reasoning_content（DeepSeek R1 工具模式要求把 assistant 的推理内容回传，
   * 否则第二轮思考上下文断裂——编排器在回填 assistant 消息时携带本轮累积
   * reasoning，见 agent-orchestrator.service.ts）。仅在消息携带该字段时添加
   * （无思考输出/常规模型缺省——请求形态与既有行为一致）；tool_calls/
   * tool_call_id 按原样透传（OpenAI function calling 协议）。
   */
  private toApiMessages(messages: ChatMessage[]): unknown[] {
    return messages.map((m) => ({
      role: m.role,
      content: m.content,
      ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
      ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
      ...(m.reasoning_content
        ? { reasoning_content: m.reasoning_content }
        : {}),
    }));
  }

  /** 取绑定配置：未绑定（调用方忘记 withConfig）→ 抛错提示（fail-fast） */
  private requireConfig(): ProviderConnectionConfig {
    if (!this.config) {
      throw new Error('供应商未绑定模型配置（请先通过 withConfig 绑定）');
    }
    return this.config;
  }

  async chat(
    messages: ChatMessage[],
    options?: ChatProviderOptions,
  ): Promise<string> {
    const config = this.requireConfig();
    // SSRF 防护：发起请求前校验目标（协议 + 私网/保留网段）；放行回环
    // （Ollama 本地端点）；在 try 块外——拒绝信息不被网络错误包装掩盖
    await assertSafeBaseUrl(config.baseUrl);
    const url = `${this.normalizeBaseUrl(config.baseUrl)}/chat/completions`;
    let res: Response;
    try {
      const retried = await retryFetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Ollama 等本地端点无 key 时不带 Authorization 头（兼容网关）
          ...(config.apiKey
            ? { Authorization: `Bearer ${config.apiKey}` }
            : {}),
        },
        body: JSON.stringify({
          model: options?.model ?? config.modelName,
          messages: this.toApiMessages(messages),
          // OpenAI 兼容参数命名（snake_case：max_tokens）；temperature 缺省 0.7
          // （业界通用默认，DeepSeek/OpenAI 官方建议区间内）
          temperature: options?.temperature ?? 0.7,
          ...(options?.maxTokens !== undefined
            ? { max_tokens: options.maxTokens }
            : {}),
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      res = retried.res;
    } catch (err) {
      // 网络层异常（DNS/连接拒绝/超时）：友好化，不泄露底层堆栈
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`连接供应商失败（网络错误）: ${message}`);
    }
    if (!res.ok) {
      const detail = await extractErrorDetail(res);
      throw new Error(`供应商请求失败（HTTP ${res.status}）: ${detail}`);
    }
    const data = parseJsonBody(await res.text()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new Error('供应商响应缺少 choices[0].message.content（格式异常）');
    }
    return content;
  }

  /**
   * 流式对话（Task 2.4）：逐段 yield 正文增量（text）/ 深度思考增量（reasoning）。
   * fetch 流式读取要点（Node 中的读法）：
   * - res.body 是 web ReadableStream，for await 逐块产出 Uint8Array；
   * - SSE 事件可能跨分片（一行 data 被拆在相邻两个 chunk）——不能假设一个
   *   chunk 就是完整一行，必须行缓冲：buffer 累积 + 按 '\n' 切行，剩余残片
   *   留到下一轮；
   * - TextDecoder({ stream: true }) 正确处理多字节 UTF-8 跨分片边界
   *   （中文/emoji 被拆在分片边界时不会乱码）。
   * 结束语义：data: [DONE] 显式结束；上游直接断开（无 [DONE]）也正常收尾
   * （部分实现不发送 [DONE]）。
   */
  async *chatStream(
    messages: ChatMessage[],
    options?: ChatProviderOptions,
  ): AsyncIterable<ChatStreamChunk> {
    const config = this.requireConfig();
    // SSRF 防护：同 chat（在 fetch 的 try 块之外，拒绝信息不被网络错误包装掩盖）
    await assertSafeBaseUrl(config.baseUrl);
    const url = `${this.normalizeBaseUrl(config.baseUrl)}/chat/completions`;
    let res: Response | undefined;
    try {
      // signal 组合（Task 2.4 质量审查整改）：外部取消信号（客户端断连）与内部
      // 超时合并为单个信号传给 fetch——AbortSignal.any 任一源 abort 即中止请求
      // （Node 20.3+ 支持；本项目 Node 24 已验证）。无外部 signal 时退化为纯
      // 超时信号。
      const abortSignal = options?.signal
        ? AbortSignal.any([
            options.signal,
            AbortSignal.timeout(STREAM_TIMEOUT_MS),
          ])
        : AbortSignal.timeout(STREAM_TIMEOUT_MS);
      const retried = await retryFetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(config.apiKey
            ? { Authorization: `Bearer ${config.apiKey}` }
            : {}),
        },
        body: JSON.stringify({
          model: options?.model ?? config.modelName,
          messages: this.toApiMessages(messages),
          temperature: options?.temperature ?? 0.7,
          // 流式：stream:true + include_usage（OpenAI/DeepSeek 均支持；末尾
          // 追加 usage-only chunk，供 done 事件展示 token 用量）
          stream: true,
          stream_options: { include_usage: true },
          ...(options?.maxTokens !== undefined
            ? { max_tokens: options.maxTokens }
            : {}),
          // ReAct 工具（Task 2.8）：OpenAI function calling 形态——
          // { type:'function', function: { name, description, parameters } }；
          // 无工具/空 tools 数组时省略（质量审查整改：空数组不发 tools 字段，
          // 既有请求形态不变）
          ...(options?.tools && options.tools.length > 0
            ? {
                tools: options.tools.map((t) => ({
                  type: 'function',
                  function: t,
                })),
              }
            : {}),
        }),
        signal: abortSignal,
      });
      res = retried.res;
    } catch (err) {
      // 断连/超时 abort（DOMException AbortError/TimeoutError）：原样上抛，
      // 不包装——编排器据此区分「断连」（连接已关，不对外报错）与「超时」
      // （'模型响应超时'），见 chat-orchestrator.service.ts 的 mapError
      if (
        err instanceof Error &&
        (err.name === 'AbortError' || err.name === 'TimeoutError')
      ) {
        throw err;
      }
      // 网络层异常（DNS/连接拒绝等）：友好化，不泄露底层堆栈
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`连接供应商失败（网络错误）: ${message}`);
    }
    // retryFetch 成功才走到此处（网络错误/429/5xx 已重试或抛出）
    res = res as Response;
    if (!res.ok) {
      const detail = await extractErrorDetail(res);
      throw new Error(`供应商请求失败（HTTP ${res.status}）: ${detail}`);
    }
    if (!res.body) {
      throw new Error('供应商响应缺少流式 body（格式异常）');
    }
    // 行缓冲解析（跨分片拼行，见方法头注释）
    let buffer = '';
    const decoder = new TextDecoder();
    // 流式 tool_calls 分片累积（Task 2.8）：OpenAI 兼容流的 delta.tool_calls
    // 按 index 定位分片——id/name 只在首片出现、arguments 逐片拼接（可能跨
    // UTF-8 字符，拼接即还原）；工具轮不需要增量，流结束时统一一次 yield
    // （见 flushToolCalls）。无工具调用时不产生额外块（既有流形态不变）
    const toolCallAcc = new Map<
      number,
      { id?: string; name?: string; arguments: string }
    >();
    // 累积完整后一次 yield：按 index 排序（多工具调用保持上游顺序）；上游缺
    // id（部分网关实现）→ 本地生成（与 Ollama 同约定 call_ 前缀——Agent
    // 回填消息的 tool_call_id 引用同一 id）
    const flushToolCalls = function* (): Generator<ChatStreamChunk> {
      if (toolCallAcc.size === 0) return;
      const toolCalls = [...toolCallAcc.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, v]) => ({
          id: v.id ?? `call_${randomUUID()}`,
          name: v.name ?? '',
          arguments: v.arguments,
        }));
      toolCallAcc.clear();
      yield { text: '', toolCalls };
    };
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk as Uint8Array, { stream: true });
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);
        const trimmed = line.trim();
        // SSE 数据行 'data: ...'；注释行（':' 开头）/空行跳过
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice('data:'.length).trim();
        // OpenAI 兼容流结束标记：先冲刷累积的 tool_calls（若有）再结束
        if (payload === '[DONE]') {
          yield* flushToolCalls();
          return;
        }
        let json: {
          choices?: Array<{
            delta?: {
              content?: unknown;
              reasoning_content?: unknown;
              reasoning?: unknown;
              tool_calls?: Array<{
                index?: number;
                id?: string;
                function?: { name?: string; arguments?: string };
              }>;
            };
          }>;
          usage?: {
            prompt_tokens?: number;
            completion_tokens?: number;
            prompt_cache_hit_tokens?: number;
            prompt_tokens_details?: { cached_tokens?: number };
          };
          error?: { message?: string } | string;
        };
        try {
          json = JSON.parse(payload) as typeof json;
        } catch {
          // 非 JSON 数据行（部分网关透传杂质/心跳）：跳过不中断流
          continue;
        }
        // 上游流式错误：data: {"error":...}（OpenAI 错误格式）→ 友好错误
        if (json.error) {
          const detail =
            typeof json.error === 'string'
              ? json.error
              : (json.error.message ?? JSON.stringify(json.error));
          throw new Error(`供应商流式错误: ${detail}`);
        }
        const delta = json.choices?.[0]?.delta;
        if (typeof delta?.content === 'string' && delta.content.length > 0) {
          yield { text: delta.content };
        }
        // 深度思考（Task 2.8）：DeepSeek R1 / Qwen3 把思考过程放在
        // delta.reasoning_content（部分实现用 delta.reasoning）；无则忽略
        const reasoning = delta?.reasoning_content ?? delta?.reasoning;
        if (typeof reasoning === 'string' && reasoning.length > 0) {
          // 协议要求 text 必填——纯 reasoning 块 text 为空串（编排器按
          // chunk.reasoning / chunk.text 分别处理）
          yield { text: '', reasoning };
        }
        // 流式 tool_calls（Task 2.8）：按 index 累积分片（id/name 首片出现、
        // arguments 逐片拼接；分片可能跨 UTF-8 字符——TextDecoder 已重组字节，
        // 此处字符串拼接即还原）；完整列表在流结束时统一 yield（见
        // flushToolCalls 注释）
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            const acc = toolCallAcc.get(idx) ?? { arguments: '' };
            if (tc.id) acc.id = tc.id;
            if (tc.function?.name) acc.name = tc.function.name;
            if (tc.function?.arguments) acc.arguments += tc.function.arguments;
            toolCallAcc.set(idx, acc);
          }
        }
        // include_usage 的 usage chunk（choices 为空 + usage 有值）；
        // 部分实现每块都带 usage——取最后一块即可（编排器后者覆盖）；
        // 门槛放宽（质量审查整改 #8）：prompt_tokens / completion_tokens 任一
        // 存在即透传（部分网关只回 completion_tokens）
        if (
          json.usage &&
          (typeof json.usage.prompt_tokens === 'number' ||
            typeof json.usage.completion_tokens === 'number')
        ) {
          // 缓存命中 token：DeepSeek 用 prompt_cache_hit_tokens；OpenAI 兼容
          // 用 prompt_tokens_details.cached_tokens（两类都兜底，无则 0/undefined）
          const promptTokens = json.usage.prompt_tokens ?? 0;
          const cachedHit =
            typeof json.usage.prompt_cache_hit_tokens === 'number'
              ? json.usage.prompt_cache_hit_tokens
              : typeof json.usage.prompt_tokens_details?.cached_tokens === 'number'
                ? json.usage.prompt_tokens_details.cached_tokens
                : undefined;
          yield {
            text: '',
            usage: {
              inputTokens: json.usage.prompt_tokens,
              outputTokens: json.usage.completion_tokens,
              ...(cachedHit !== undefined ? { cacheHitTokens: cachedHit } : {}),
            },
          };
        }
      }
    }
    // 上游直接断开且无 [DONE]：冲刷累积的 tool_calls（若有）后正常结束
    // （部分实现不发送 [DONE]，见方法头注释）
    yield* flushToolCalls();
  }

  async embed(texts: string[], model?: string): Promise<number[][]> {
    const { vectors } = await this.embedCore(texts, model);
    return vectors;
  }

  /** 向量化 + 实际 token 消耗（dashscope/OpenAI 兼容 embed 响应带
   *  usage.total_tokens——文档 tokenCost 用真实值而非估算，见
   *  embed.processor 注释） */
  async embedWithUsage(
    texts: string[],
    model?: string,
  ): Promise<{ vectors: number[][]; totalTokens: number }> {
    return this.embedCore(texts, model);
  }

  /** embed 核心：请求 + 校验 + 解析（返回向量与 usage.total_tokens） */
  private async embedCore(
    texts: string[],
    model?: string,
  ): Promise<{ vectors: number[][]; totalTokens: number }> {
    const config = this.requireConfig();
    // SSRF 防护：同 chat（见该处注释与 ssrf.guard.ts）
    await assertSafeBaseUrl(config.baseUrl);
    const url = `${this.normalizeBaseUrl(config.baseUrl)}/embeddings`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(config.apiKey
            ? { Authorization: `Bearer ${config.apiKey}` }
            : {}),
        },
        body: JSON.stringify({
          model: model ?? config.modelName,
          input: texts,
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`连接供应商失败（网络错误）: ${message}`);
    }
    if (!res.ok) {
      const detail = await extractErrorDetail(res);
      throw new Error(`供应商请求失败（HTTP ${res.status}）: ${detail}`);
    }
    const data = parseJsonBody(await res.text()) as {
      data?: Array<{ embedding?: number[] }>;
      usage?: { total_tokens?: number };
    };
    if (!Array.isArray(data.data)) {
      throw new Error('供应商响应缺少 data 数组（格式异常）');
    }
    // fail-fast：缺向量/空向量/批内维度不一致 → 格式错误（不静默返回空数组——
    // 空向量会污染向量索引，静默吞掉会让错误在索引层爆炸）
    const vectors = data.data.map((d) => d.embedding);
    const firstDim = vectors.find((v) => Array.isArray(v))?.length;
    for (let i = 0; i < vectors.length; i++) {
      const v = vectors[i];
      if (!Array.isArray(v) || v.length === 0) {
        throw new Error(
          `供应商响应第 ${i} 个向量缺失或为空（格式异常，期望 ${texts.length} 个向量）`,
        );
      }
      if (firstDim !== undefined && v.length !== firstDim) {
        throw new Error(
          `供应商响应向量维度不一致（第 ${i} 个 ${v.length} 维，首个 ${firstDim} 维，格式异常）`,
        );
      }
    }
    return { vectors: vectors as number[][], totalTokens: data.usage?.total_tokens ?? 0 };
  }

  /**
   * 连通性测试（按用途类型分流，Task 修复：此前一律发 chat 请求，对
   * embedding/rerank 模型必然失败——embedding 发 /chat/completions 报
   * 404（模型名不识别），rerank 发 chat 格式到 rerank 端点报 400）：
   * - chat：最小对话请求（max_tokens=1，验证模型存在+鉴权+可生成）
   * - embedding：POST /embeddings（1 条文本，验证 embedding 端点与模型名）
   * - rerank：POST 原生 rerank 端点（dashscope 格式，验证 key 与模型）
   * 测试语义：错误作为结果返回（前端展示），不抛异常。
   */
  async testConnection(
    config: ProviderConnectionConfig,
    type?: string,
  ): Promise<TestConnectionResult> {
    try {
      const p = new OpenAICompatibleProvider(config);
      if (type === 'embedding') {
        await p.embed(['连通性测试'], config.modelName);
        return { ok: true };
      }
      if (type === 'rerank') {
        const url = this.normalizeBaseUrl(config.baseUrl);
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(config.apiKey
              ? { Authorization: `Bearer ${config.apiKey}` }
              : {}),
          },
          body: JSON.stringify({
            model: config.modelName,
            input: { query: 'ping', documents: ['pong'] },
          }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!res.ok) {
          const detail = await extractErrorDetail(res);
          throw new Error(`供应商请求失败（HTTP ${res.status}）: ${detail}`);
        }
        return { ok: true };
      }
      // chat（默认）：最小对话请求
      await p.chat(
        [{ role: 'user', content: 'ping' }],
        { maxTokens: 1, temperature: 0 },
      );
      return { ok: true };
    } catch (err) {
      // 测试语义：错误作为结果返回（前端展示），不抛异常
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    }
  }
}
