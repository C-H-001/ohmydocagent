// test 共享的 mock 模型注入助手（Task 2.3）：
// ModelModule 的默认 provider 绑定已切到真实实现（ChatModelServiceImpl /
// EmbeddingServiceImpl——按默认模型配置路由，无默认模型抛 503）。既有解析/
// 摘要/向量化 e2e 依赖确定性 mock（MockChatModelService 固定中文摘要文本 /
// MockEmbeddingService n-gram 特征哈希向量），统一用本助手在模块编译时
// override 回 mock——每个受影响 e2e 只改一行（包一层 withMockModels），
// 避免逐文件复制 override 链。
import type { TestingModuleBuilder } from '@nestjs/testing';
import { CHAT_MODEL_SERVICE } from '../src/modules/model/chat-model.interface.js';
import { EMBEDDING_SERVICE } from '../src/modules/model/embedding.interface.js';
import { MockChatModelService } from '../src/modules/model/mock/mock-chat-model.service.js';
import { MockEmbeddingService } from '../src/modules/model/mock/mock-embedding.service.js';

/** 给 TestingModuleBuilder 注入 mock 模型实现（返回同一 builder 供链式调用） */
export function withMockModels(
  builder: TestingModuleBuilder,
): TestingModuleBuilder {
  return builder
    .overrideProvider(CHAT_MODEL_SERVICE)
    .useClass(MockChatModelService)
    .overrideProvider(EMBEDDING_SERVICE)
    .useClass(MockEmbeddingService);
}
