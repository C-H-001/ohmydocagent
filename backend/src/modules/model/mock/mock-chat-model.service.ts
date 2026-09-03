// backend/src/modules/model/mock/mock-chat-model.service.ts
// MockChatModelService（Task 1.7 P1 占位实现；Task 2.3 起真实实现为
// ChatModelServiceImpl，本 mock 保留在 mock/ 目录**仅供测试 overrideProvider
// 注入**——title/knowledge-status 等既有 e2e 依赖确定性固定文本）：
// chat() 返回固定中文摘要文本——mock 语义：验证管线闭环（入队 → 调用 →
// summary 落库 → parserStages 时间线）而非生成质量。确定性（同入参同结果）
// 保证 e2e 可断言（knowledge-status.e2e-spec 断言 summary === MOCK_SUMMARY_TEXT）。
// 不消费 messages/options（占位，与 MockEmbeddingService 的占位哲学一致）；
// 真实实现（ChatModelServiceImpl）按 messages 生成回复、透传 options。
// chatStream（Task 2.4）：固定单块 yield 全文（mock 语义：验证流式回路闭环
// ——e2e 里 FakeChatModelService 才是脚本化的聊天 mock，本类供标题/摘要等
// 非流式场景的既有 e2e override 使用）。
import { Injectable } from '@nestjs/common';
import type {
  ChatMessage,
  ChatModelService,
  ChatOptions,
  ChatStreamChunk,
} from '../chat-model.interface.js';

/** 固定中文摘要模板（P1 mock 语义：返回固定中文文本即可——真实实现替换后
 * 此常量随 mock 移除；e2e 断言届时改语义相关性，见 knowledge-status 注释） */
export const MOCK_SUMMARY_TEXT =
  '这是系统生成的文档自动摘要：文档已完成自动解析、分块与向量化，' +
  '内容已纳入知识库，可供检索与问答使用。（mock 摘要，Task 2.3 接入真实模型后替换）';

@Injectable()
export class MockChatModelService implements ChatModelService {
  async chat(
    _messages: ChatMessage[],
    _options?: ChatOptions,
  ): Promise<string> {
    // mock 语义：不消费入参，返回固定中文文本（真实实现须按 messages 生成回复）
    return MOCK_SUMMARY_TEXT;
  }

  async *chatStream(
    _messages: ChatMessage[],
    _options?: ChatOptions,
  ): AsyncIterable<ChatStreamChunk> {
    // mock 语义：单块 yield 固定全文（真实实现逐块增量生成）
    yield { text: MOCK_SUMMARY_TEXT };
  }
}
