// MockChatModelService 单元测试（Task 1.7）：
// 1. chat() 返回固定中文摘要文本（P1 mock 语义——验证管线闭环而非生成质量；
//    Task 2.3 接入真实 LLM 供应商时换实现，本测试随之调整）
// 2. 参数透传：messages/options 被接口接受且不改变结果（mock 不消费入参，
//    真实实现须按 messages 生成回复、透传 options）
// 3. 流式接口形态：Task 2.4 扩展 chatStream（对话/流式输出场景）——
//    本任务仅定义非流式 chat()，摘要场景一次性拿到完整文本即可
import { describe, expect, it } from 'vitest';
import {
  MockChatModelService,
  MOCK_SUMMARY_TEXT,
} from './mock-chat-model.service.js';

describe('MockChatModelService（Task 1.7 P1 占位）', () => {
  it('chat() 返回固定中文摘要文本（确定性，e2e 可断言）', async () => {
    const svc = new MockChatModelService();
    const result = await svc.chat([
      {
        role: 'system',
        content: '请用 3-5 句话总结以下文档内容，直接输出中文摘要。',
      },
      { role: 'user', content: '文档正文……' },
    ]);
    expect(typeof result).toBe('string');
    expect(result).toBe(MOCK_SUMMARY_TEXT);
    // mock 语义：必须包含中文（P1 固定中文摘要，Task 2.3 替换后改语义断言）
    expect(result).toMatch(/[\u4e00-\u9fff]/);
  });

  it('参数透传：messages/options 被接口接受且结果与入参无关（占位语义）', async () => {
    const svc = new MockChatModelService();
    const a = await svc.chat([{ role: 'user', content: '内容 A' }]);
    const b = await svc.chat(
      [
        { role: 'system', content: '系统提示' },
        { role: 'user', content: '内容 B' },
      ],
      { temperature: 0.7, maxTokens: 512 },
    );
    expect(a).toBe(MOCK_SUMMARY_TEXT);
    expect(b).toBe(MOCK_SUMMARY_TEXT);
    expect(a).toBe(b); // 固定文本：与入参无关（占位语义，Task 2.3 替换后解除）
  });

  it('chat() 是异步接口（返回 Promise<string>）——队列处理器 await 语义可用', async () => {
    const svc = new MockChatModelService();
    const p = svc.chat([{ role: 'user', content: 'x' }]);
    expect(p).toBeInstanceOf(Promise);
    await expect(p).resolves.toBe(MOCK_SUMMARY_TEXT);
  });
});
