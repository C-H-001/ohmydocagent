// Langfuse 观测服务（评测链路，可选开启）：
// - 生产默认不开启（LANGFUSE_ENABLED 缺省 false → 全 no-op，零开销）
// - 开启时追踪 ReAct 问答链路：会话 trace → LLM generation（输入/输出/
//   token 用量）→ RAG 检索/重排/图谱 span（查询/命中数/耗时）
// - 独立评测镜像：deploy/docker-compose 提供 langfuse 服务（profile:
//   evaluation），backend 通过 LANGFUSE_HOST 指向它
// 参考 WeKnora internal/tracing/langfuse（OTLP→Langfuse；本实现用官方 SDK）。
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Langfuse } from 'langfuse';

export interface ObsSpan {
  end(output?: Record<string, unknown>): void;
  /** 内部：Langfuse Trace/Generation 对象（挂子 span 用）——service 私有，
   *  外部调用方不应触碰；无引用（noop/独立 generation）为 undefined */
  __trace?: unknown;
}

@Injectable()
export class LangfuseService implements OnModuleDestroy {
  private readonly logger = new Logger(LangfuseService.name);
  private readonly client: Langfuse | null = null;
  private readonly enabled: boolean;

  constructor(private readonly config: ConfigService) {
    this.enabled = config.get('langfuseEnabled') === true;
    if (!this.enabled) return;
    const publicKey = config.get<string>('langfusePublicKey') ?? '';
    const secretKey = config.get<string>('langfuseSecretKey') ?? '';
    const host = config.get<string>('langfuseHost') ?? 'http://langfuse:3000';
    if (!publicKey || !secretKey) {
      this.logger.warn(
        'LANGFUSE_ENABLED=true 但缺少 LANGFUSE_PUBLIC_KEY/SECRET_KEY，观测关闭',
      );
      return;
    }
    try {
      this.client = new Langfuse({
        publicKey,
        secretKey,
        baseUrl: host,
        flushAt: 10,
        flushInterval: 5000,
      });
      this.logger.log(`Langfuse 观测已开启: ${host}`);
    } catch (err) {
      this.logger.warn(
        `Langfuse 初始化失败，观测关闭: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.client = null;
    }
  }

  get isEnabled(): boolean {
    return !!this.client;
  }

  /** 会话级 trace（每轮对话一次；input = 用户消息） */
  async trace(
    name: string,
    input: unknown,
    meta?: { sessionId?: string; userId?: string; tags?: string[] },
  ): Promise<ObsSpan> {
    if (!this.client) return this.noop();
    try {
      const t = await this.client.trace({
        name,
        input,
        sessionId: meta?.sessionId,
        userId: meta?.userId,
        tags: ['ohmydocagent', ...(meta?.tags ?? [])],
      });
      return {
        __trace: t,
        end: (o) => t.update({ output: o }),
      };
    } catch {
      return this.noop();
    }
  }

  /** LLM 生成 span（chat 调用：模型/输入/输出/token 用量） */
  async generation(
    parent: ObsSpan | null,
    name: string,
    input: unknown,
    meta?: { model?: string; temperature?: number; maxTokens?: number },
  ): Promise<ObsSpan> {
    if (!this.client) return this.noop();
    try {
      const body = {
        name,
        input,
        model: meta?.model,
        modelParameters: {
          ...(meta?.temperature !== undefined ? { temperature: meta.temperature } : {}),
          ...(meta?.maxTokens !== undefined ? { maxTokens: meta.maxTokens } : {}),
        },
      };
      // parent 有 trace 引用 → 挂到会话 trace 下（链路树完整）；parent 为
      // null（agent chatRound 顶层 LLM，无会话 trace 引用）→ 独立 generation
      //（Langfuse Generations 页可见——名称/耗时/token 均有）
      const g = parent?.__trace
        ? await (parent.__trace as { generation(b: unknown): Promise<{ end(o: unknown): void }> }).generation(body)
        : await this.client.generation(body);
      return {
        __trace: g as unknown,
        end: (o) => {
          const usage = (o?.usage ?? {}) as { input?: number; output?: number };
          g.end({
            output: o?.output,
            usage: usage.input !== undefined ? usage : undefined,
          });
        },
      };
    } catch {
      return this.noop();
    }
  }

  /** 检索/重排等过程 span（query/结果数/耗时） */
  async span(parent: ObsSpan | null, name: string, input: unknown): Promise<ObsSpan> {
    if (!this.client) return this.noop();
    try {
      // 简化：generation 语义承载过程 span（Langfuse 无裸 span API 于 SDK；
      // 用 generation 呈现检索事件，name 标识阶段）
      const g = parent?.__trace
        ? await (parent.__trace as { generation(b: unknown): Promise<{ end(o: unknown): void }> }).generation({ name, input })
        : await this.client.generation({ name, input });
      return {
        __trace: g as unknown,
        end: (o) => g.end({ output: o }),
      };
    } catch {
      return this.noop();
    }
  }

  /** 消息中新增/更新 LLM 输出与用量（流式生成收尾时调用） */
  async endGeneration(span: ObsSpan, output: unknown): Promise<void> {
    span.end({ output });
  }

  /** 异步 flush（避免进程退出丢事件；正常关闭时调用） */
  async flush(): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.flushAsync();
    } catch {
      // 观测失败静默
    }
  }

  private noop(): ObsSpan {
    return { end: () => {} };
  }

  async onModuleDestroy(): Promise<void> {
    await this.flush();
  }
}
