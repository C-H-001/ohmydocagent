// 真实 ChatModelService / EmbeddingService 单元测试（Task 2.3）：
// 断言「无默认模型 → 503 ServiceUnavailableException」语义与「按默认模型路由」
// 行为——解析/摘要/向量化管线在未配置默认模型时显式失败而非静默，
// 配置层通过模型管理「设为默认」补齐（见 chat-model.service.ts 注释）。
import { ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { ChatModelServiceImpl } from '../src/modules/model/chat-model.service.js';
import { EmbeddingServiceImpl } from '../src/modules/model/embedding.service.js';
import type { Model } from '../src/modules/model/model.entity.js';
import { ModelService } from '../src/modules/model/model.service.js';
import { LLMProviderFactory } from '../src/modules/model/providers/llm-provider.factory.js';

/** 构造被测实例：ModelService/Factory 全 mock */
function makeServices() {
  // mock 对象保持无类型（方法有 mockResolvedValue 等助手），构造时整体断言类型
  const modelService = {
    // 无类型 vi.fn()：mockResolvedValue 可注入任意值，避免 async () => null
    // 收窄 resolved 类型（TS2345）
    getDefault: vi.fn(),
  };
  const factory = {
    create: vi.fn(),
  };
  const chat = new ChatModelServiceImpl(
    modelService as unknown as ModelService,
    factory as unknown as LLMProviderFactory,
  );
  const embedding = new EmbeddingServiceImpl(
    modelService as unknown as ModelService,
    factory as unknown as LLMProviderFactory,
  );
  return { chat, embedding, modelService, factory };
}

/** 构造默认模型行（extraConfig 携带模型级默认参数） */
function defaultModel(overrides: Partial<Model> = {}): Model {
  return {
    id: 'm1',
    name: '默认模型',
    provider: 'openai-compatible',
    baseUrl: 'https://api.example.com',
    apiKeyEncrypted: 'enc:sk',
    modelName: 'deepseek-chat',
    type: 'chat',
    enabled: true,
    isDefault: true,
    extraConfig: { temperature: 0.9 },
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Model;
}

describe('真实 ChatModelServiceImpl / EmbeddingServiceImpl（Task 2.3）', () => {
  it('chat：无默认对话模型 → 503 ServiceUnavailableException（显式失败而非静默）', async () => {
    const { chat } = makeServices();
    await expect(
      chat.chat([{ role: 'user', content: 'hi' }]),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('chat：有默认模型 → 按模型配置路由到 provider，模型级 extraConfig 展开 + 模型名透传', async () => {
    const { chat, modelService, factory } = makeServices();
    modelService.getDefault.mockResolvedValue(defaultModel());
    const provider = { chat: vi.fn().mockResolvedValue('回复文本') };
    factory.create.mockReturnValue(provider);
    const out = await chat.chat([{ role: 'user', content: '你好' }], {
      maxTokens: 64,
    });
    expect(out).toBe('回复文本');
    expect(modelService.getDefault).toHaveBeenCalledWith('chat', undefined);
    expect(factory.create).toHaveBeenCalledWith(
      expect.objectContaining({ isDefault: true, type: 'chat' }),
    );
    // extraConfig.temperature 展开 + modelName 透传 + 调用方 maxTokens 覆盖
    expect(provider.chat).toHaveBeenCalledWith(
      [{ role: 'user', content: '你好' }],
      expect.objectContaining({
        temperature: 0.9,
        maxTokens: 64,
        model: 'deepseek-chat',
      }),
    );
  });

  it('embed：无默认向量模型 → 503 ServiceUnavailableException', async () => {
    const { embedding } = makeServices();
    await expect(embedding.embed(['文本'])).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('embed：有默认模型 → 按默认 embedding 模型路由（模型名透传 + 维度契约 1024）', async () => {
    const { embedding, modelService, factory } = makeServices();
    modelService.getDefault.mockResolvedValue(
      defaultModel({ type: 'embedding', modelName: 'text-embedding-3-small' }),
    );
    const provider = {
      embed: vi.fn().mockResolvedValue([[0.1], [0.2]]),
    };
    factory.create.mockReturnValue(provider);
    const vectors = await embedding.embed(['a', 'b']);
    expect(vectors).toEqual([[0.1], [0.2]]);
    expect(modelService.getDefault).toHaveBeenCalledWith('embedding', undefined);
    expect(provider.embed).toHaveBeenCalledWith(
      ['a', 'b'],
      'text-embedding-3-small',
    );
    // 维度契约：与 chunk.entity embedding vector(1024) 列一致（见接口注释）
    expect(embedding.dimension).toBe(1024);
  });
});
