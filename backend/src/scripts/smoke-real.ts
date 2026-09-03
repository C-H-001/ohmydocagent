// backend/src/scripts/smoke-real.ts
// 真实模型冒烟（dev-only）：验证配置的默认模型真实可用——
//  1) ChatModelServiceImpl.chat：默认 chat 模型路由 + 密钥解密 + 真实 DeepSeek 调用
//  2) EmbeddingServiceImpl.embed：默认 embedding 模型真实调用（维度验证）
// 用法：npm run smoke:real
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.js';
import { CHAT_MODEL_SERVICE } from '../modules/model/chat-model.interface.js';
import { EMBEDDING_SERVICE } from '../modules/model/embedding.interface.js';
import type { ChatModelService } from '../modules/model/chat-model.interface.js';
import type { EmbeddingService } from '../modules/model/embedding.interface.js';

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
  });
  const chat = app.get<ChatModelService>(CHAT_MODEL_SERVICE);
  const embed = app.get<EmbeddingService>(EMBEDDING_SERVICE);

  // 1. 真实对话（DeepSeek V4 Flash，推理模型）
  console.log('[1] 真实对话 DeepSeek...');
  const answer = await chat.chat([
    { role: 'system', content: '你是 OhMyDocAgent 测试助手，用一句话回答。' },
    { role: 'user', content: 'OhMyDocAgent 是什么？' },
  ]);
  console.log('    回答：', answer.slice(0, 200));

  // 2. 真实向量化（通义千问 embedding）
  console.log('[2] 真实向量化 Qwen Embedding...');
  const vecs = await embed.embed(['OhMyDocAgent 企业知识工作台']);
  console.log(
    `    向量维度：${vecs[0]?.length ?? 0}（应为 ${embed.dimension}）`,
  );

  console.log('[smoke] 真实模型链路全部通过');
  await app.close();
}

main().catch((err) => {
  console.error('[smoke] 失败：', err?.message ?? err);
  process.exit(1);
});
