// backend/src/modules/model/providers/ollama.provider.ts
// Ollama 本地供应商实现（Task 2.3）：Ollama REST API（/api/chat、/api/embed）。
// 与 OpenAI 兼容实现的差异：
// - 端点：POST {baseUrl}/api/chat（非 OpenAI 的 /chat/completions）——
//   stream:false 一次性返回完整响应 { message: { content } }；
//   POST {baseUrl}/api/embed → { embeddings: [[...]] }（Ollama 0.4+，
//   旧版 /api/embeddings 单文本接口不实现——本项目批量向量化走新接口）；
// - 鉴权：本地服务默认无需 API Key（配置里 apiKey 传空串，忽略之）；
// - 采样参数：Ollama 的 options 命名（temperature / num_predict）。
// 错误处理与 OpenAI 兼容实现同风格（友好化 + 超时），见该文件头注释。
// SSRF 防护：每次 fetch 前调用 assertSafeBaseUrl（ssrf.guard.ts）——baseUrl
// 用户可控，必须拒绝内网/云元数据端点；回环放行（Ollama 本地部署核心场景）。
// 校验在 fetch 的 try 块之外，拒绝信息不被「连接供应商失败」包装掩盖。
//
// testConnection 决策：最小 chat 请求（POST /api/chat）而非 GET /api/tags——
// 验证「模型已拉取 + 可对话」整条链路（GET /api/tags 只证明服务在，不证明
// 模型可用）；Ollama 本地调用成本可忽略。
//
// 流式 chatStream（Task 2.4）：POST /api/chat 带 stream:true → NDJSON 行
// （每行一个 JSON 对象）逐行 yield message.content；最后一行 done:true 携带
// eval_count/prompt_eval_count 统计 → 透传 usage（供 done 事件）后结束。
// 行缓冲解析模式与 OpenAI 兼容实现的 SSE 解析一致（见该文件 chatStream 注释：
// fetch 分片可能切行，TextDecoder stream:true 处理多字节 UTF-8 边界）。
import { Injectable, Optional } from '@nestjs/common';
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

/** 请求超时（毫秒）：与 OpenAI 兼容实现一致（本地模型加载可能慢，15s 起步） */
const REQUEST_TIMEOUT_MS = 15000;

/** 流式请求超时（毫秒）：与 OpenAI 兼容实现的流式放宽一致（含生成时间） */
const STREAM_TIMEOUT_MS = 120000;

/** 解析 200 响应体：非 JSON → 格式错误（含截断文本；同 OpenAI 兼容实现） */
function parseJsonBody(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `Ollama 返回非 JSON 响应（格式异常）: ${text.slice(0, 200)}`,
    );
  }
}

/** 提取非 2xx 响应体的错误详情（Ollama 错误格式 { error: string }，
 * 解析失败退回 HTTP 状态文本） */
async function extractErrorDetail(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string } | undefined;
    if (typeof body?.error === 'string') return body.error;
  } catch {
    // 响应体非 JSON → 退回状态文本
  }
  return res.statusText || `HTTP ${res.status}`;
}

@Injectable()
export class OllamaProvider implements LLMProvider {
  /** 实例绑定的连接配置（withConfig 返回新实例；@Optional 原因同
   * OpenAICompatibleProvider——接口类型参数不能做 DI 依赖，见该文件注释） */
  constructor(@Optional() private readonly config?: ProviderConnectionConfig) {}

  withConfig(config: ProviderConnectionConfig): LLMProvider {
    return new OllamaProvider(config);
  }

  /** baseUrl 尾部斜杠归一化（同 OpenAI 兼容实现） */
  private normalizeBaseUrl(baseUrl: string): string {
    return baseUrl.replace(/\/+$/, '');
  }

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
    // SSRF 防护：发起请求前校验目标（协议 + 私网/保留网段）；回环放行
    // （http://127.0.0.1:11434 本地 Ollama 是核心场景，见 ssrf.guard.ts 注释）
    await assertSafeBaseUrl(config.baseUrl);
    const url = `${this.normalizeBaseUrl(config.baseUrl)}/api/chat`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: options?.model ?? config.modelName,
          messages,
          // stream:false：一次性返回完整响应（非流式语义，与 Task 2.4 的
          // chatStream 区分——届时走 /api/chat stream:true + SSE 转发）
          stream: false,
          options: {
            ...(options?.temperature !== undefined
              ? { temperature: options.temperature }
              : {}),
            ...(options?.maxTokens !== undefined
              ? { num_predict: options.maxTokens }
              : {}),
          },
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`连接供应商失败（网络错误）: ${message}`);
    }
    if (!res.ok) {
      const detail = await extractErrorDetail(res);
      throw new Error(`Ollama 请求失败（HTTP ${res.status}）: ${detail}`);
    }
    const data = parseJsonBody(await res.text()) as {
      message?: { content?: string };
    };
    if (typeof data.message?.content !== 'string') {
      throw new Error('Ollama 响应缺少 message.content（格式异常）');
    }
    return data.message.content;
  }

  /**
   * 流式对话（Task 2.4）：NDJSON 行逐段 yield message.content；done:true 行
   * 结束并透传 usage（eval_count/prompt_eval_count，Ollama 流式响应的
   * token 统计；见方法头注释）。错误（连接/HTTP/流式错误行）在迭代中抛出。
   */
  async *chatStream(
    messages: ChatMessage[],
    options?: ChatProviderOptions,
  ): AsyncIterable<ChatStreamChunk> {
    const config = this.requireConfig();
    // SSRF 防护：同 chat（在 fetch 的 try 块之外，见文件头注释）
    await assertSafeBaseUrl(config.baseUrl);
    const url = `${this.normalizeBaseUrl(config.baseUrl)}/api/chat`;
    let res: Response;
    try {
      // signal 组合（Task 2.4 质量审查整改）：同 OpenAI 兼容实现——外部取消信号
      // （客户端断连）与内部超时合并，AbortSignal.any 任一源 abort 即中止请求
      // （Node 20.3+；本项目 Node 24 已验证）。无外部 signal 时退化为纯超时信号。
      const abortSignal = options?.signal
        ? AbortSignal.any([
            options.signal,
            AbortSignal.timeout(STREAM_TIMEOUT_MS),
          ])
        : AbortSignal.timeout(STREAM_TIMEOUT_MS);
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: options?.model ?? config.modelName,
          messages: this.mapApiMessages(messages),
          // stream:true：NDJSON 流式响应（每行一个 JSON 对象；与 chat() 的
          // stream:false 一次性响应区分，见文件头注释）
          stream: true,
          options: {
            ...(options?.temperature !== undefined
              ? { temperature: options.temperature }
              : {}),
            ...(options?.maxTokens !== undefined
              ? { num_predict: options.maxTokens }
              : {}),
          },
          // ReAct 工具（Task 2.8）：Ollama 接受 OpenAI 同构的 tools 形态——
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
    } catch (err) {
      // 断连/超时 abort（DOMException AbortError/TimeoutError）：原样上抛，
      // 不包装——编排器据此区分断连与超时（见 openai-compatible.provider.ts
      // 同段注释与 chat-orchestrator.service.ts 的 mapError）
      if (
        err instanceof Error &&
        (err.name === 'AbortError' || err.name === 'TimeoutError')
      ) {
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`连接供应商失败（网络错误）: ${message}`);
    }
    if (!res.ok) {
      const detail = await extractErrorDetail(res);
      throw new Error(`Ollama 请求失败（HTTP ${res.status}）: ${detail}`);
    }
    if (!res.body) {
      throw new Error('Ollama 响应缺少流式 body（格式异常）');
    }
    // NDJSON 行缓冲解析（跨分片拼行，同 OpenAI 兼容实现注释）
    let buffer = '';
    const decoder = new TextDecoder();
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk as Uint8Array, { stream: true });
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);
        const trimmed = line.trim();
        if (!trimmed) continue; // 空行跳过
        let json: {
          message?: {
            content?: string;
            tool_calls?: Array<{
              function?: { name?: string; arguments?: unknown };
            }>;
          };
          done?: boolean;
          error?: string;
          eval_count?: number;
          prompt_eval_count?: number;
        };
        try {
          json = JSON.parse(trimmed) as typeof json;
        } catch {
          continue; // 非 JSON 行（心跳等）跳过
        }
        // Ollama 流式错误：{ error: '...' } → 友好错误
        if (json.error) {
          throw new Error(`Ollama 流式错误: ${json.error}`);
        }
        const content = json.message?.content;
        if (typeof content === 'string' && content.length > 0) {
          yield { text: content };
        }
        // 工具调用（Task 2.8）：Ollama 流式响应中 message.tool_calls 完整出现
        // （非分片）——一次 yield 完整列表；arguments 可能是对象或字符串（统一
        // 序列化为字符串——与 OpenAI 兼容流的字符串形态对齐，Agent 按
        // JSON.parse 解析）。id：Ollama 协议无调用 id，本地生成（Agent 回填
        // 消息的 tool_call_id 引用同一 id，见 openai-compatible 同段注释）
        const toolCalls = json.message?.tool_calls;
        if (Array.isArray(toolCalls) && toolCalls.length > 0) {
          yield {
            text: '',
            toolCalls: toolCalls.map((tc) => ({
              id: `call_${randomUUID()}`,
              name: tc.function?.name ?? '',
              arguments:
                typeof tc.function?.arguments === 'string'
                  ? tc.function.arguments
                  : JSON.stringify(tc.function?.arguments ?? {}),
            })),
          };
        }
        // done:true 为该响应最后一行：携带 token 统计 → 透传 usage 后结束
        if (json.done === true) {
          if (
            typeof json.prompt_eval_count === 'number' ||
            typeof json.eval_count === 'number'
          ) {
            yield {
              text: '',
              usage: {
                inputTokens: json.prompt_eval_count,
                outputTokens: json.eval_count,
              },
            };
          }
          return;
        }
      }
    }
    // 上游断开但未见 done:true：正常结束（容错，不抛错）
  }

  /**
   * 消息映射（Ollama 原生协议，Task 2.8）：OpenAI 形态的 assistant tool_calls
   * （id/type 字段）与 tool 消息（tool_call_id 字段）在 Ollama 协议中不需要——
   * 剥除避免未知字段报错（Ollama 按消息顺序关联 tool 结果与调用）。普通消息
   * 原样透传（既有请求形态不变）。reasoning_content（DeepSeek R1 工具模式的
   * 回传字段）Ollama 协议无此概念——剥除（忽略或注释语义，见任务书；未知
   * 字段虽一般被忽略，显式剥除双保险）。
   */
  private mapApiMessages(messages: ChatMessage[]): ChatMessage[] {
    return messages.map((m) => {
      if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
        // 剥 id/type + reasoning_content：Ollama tool_calls 只认 function
        // （name/arguments）；推理字段无回传语义
        return {
          role: 'assistant',
          content: m.content,
          tool_calls: m.tool_calls.map((tc) => ({
            function: {
              name: tc.function.name,
              arguments: tc.function.arguments,
            },
          })),
        } as ChatMessage;
      }
      if (m.role === 'tool') {
        // 剥 tool_call_id：Ollama 结果按顺序关联调用，无 id 字段
        return { role: 'tool', content: m.content } as ChatMessage;
      }
      // 普通消息（system/user/无 tool_calls 的 assistant）：剥 reasoning_content
      // （Ollama 无推理回传概念，见方法头注释）
      const plain: ChatMessage = { ...m };
      delete plain.reasoning_content;
      return plain;
    });
  }

  async embed(texts: string[], model?: string): Promise<number[][]> {
    const config = this.requireConfig();
    // SSRF 防护：同 chat（见该处注释与 ssrf.guard.ts）
    await assertSafeBaseUrl(config.baseUrl);
    const url = `${this.normalizeBaseUrl(config.baseUrl)}/api/embed`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
      throw new Error(`Ollama 请求失败（HTTP ${res.status}）: ${detail}`);
    }
    const data = parseJsonBody(await res.text()) as { embeddings?: number[][] };
    if (!Array.isArray(data.embeddings)) {
      throw new Error('Ollama 响应缺少 embeddings 数组（格式异常）');
    }
    return data.embeddings;
  }

  async testConnection(
    config: ProviderConnectionConfig,
  ): Promise<TestConnectionResult> {
    // 决策：最小 chat 请求（见文件头注释——比 GET /api/tags 更真实）
    try {
      await new OllamaProvider(config).chat(
        [{ role: 'user', content: 'ping' }],
        { maxTokens: 1 },
      );
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    }
  }
}
