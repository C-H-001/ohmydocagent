// 模型模块（Task 1.6 + Task 1.7 + Task 2.3）：
// - 提供 EmbeddingService / ChatModelService 抽象的实现（Task 2.3 起为真实
//   实现 EmbeddingServiceImpl / ChatModelServiceImpl，按默认模型配置路由到
//   对应供应商，见各实现注释）；既有 mock 保留在 mock/ 目录，测试用
//   overrideProvider 注入（既有 e2e 依赖确定性 mock，见 test/ 下各文件
//   override 注释）。
// - 模型管理（Task 2.3）：Model 实体 + CRUD + 默认模型 + 连通性测试端点
//   （ModelController/ModelService/CryptoService/供应商实现/工厂）。
// 依赖方向：本模块被 ParseModule（向量化/摘要管线）与 ChatModule（标题生成）
// import；真实实现消费 ModelService（读默认模型配置），无环。
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CHAT_MODEL_SERVICE } from './chat-model.interface.js';
import { ChatModelServiceImpl } from './chat-model.service.js';
import { CryptoService } from './crypto.service.js';
import { EMBEDDING_SERVICE } from './embedding.interface.js';
import { EmbeddingServiceImpl } from './embedding.service.js';
import { ModelController } from './model.controller.js';
import { Model } from './model.entity.js';
import { ModelService } from './model.service.js';
import { RerankService } from './rerank.service.js';
import { LLMProviderFactory } from './providers/llm-provider.factory.js';
import { OpenAICompatibleProvider } from './providers/openai-compatible.provider.js';
import { OllamaProvider } from './providers/ollama.provider.js';

@Module({
  imports: [TypeOrmModule.forFeature([Model])],
  controllers: [ModelController],
  providers: [
    RerankService,
    // 模型管理核心
    ModelService,
    CryptoService,
    // 供应商实现（DI map：LLMProviderFactory 注入二者做类型分支，
    // 见 llm-provider.factory.ts 注释）
    OpenAICompatibleProvider,
    OllamaProvider,
    LLMProviderFactory,
    // LLM 抽象绑定（Task 2.3 起默认真实实现；测试 overrideProvider 注入 mock）
    { provide: CHAT_MODEL_SERVICE, useClass: ChatModelServiceImpl },
    { provide: EMBEDDING_SERVICE, useClass: EmbeddingServiceImpl },
  ],
  exports: [EMBEDDING_SERVICE, CHAT_MODEL_SERVICE, CryptoService, ModelService, RerankService],
})
export class ModelModule {}
