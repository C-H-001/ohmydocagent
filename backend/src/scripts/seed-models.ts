// backend/scripts/seed-models.ts
// 开发测试模型种子脚本（dev-only）：
// 读取 .env 中的 OHMYDOCAGENT_TEST_* 配置，幂等创建模型记录（API Key 加密存储）并设置默认。
// 用法：npm run seed:models
// 说明：仅本地开发使用；生产环境模型请通过「设置中心 → 模型」配置。
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.js';
import { ModelService } from '../modules/model/model.service.js';
import { CreateModelDto } from '../modules/model/dto/create-model.dto.js';

interface TestModelSpec {
  name: string;
  envBase: string;
  envModel: string;
  envKey: string;
  type: 'chat' | 'embedding' | 'rerank';
  isDefault: boolean;
  note?: string;
}

function env(name: string): string {
  return process.env[name] ?? '';
}

const SPECS: TestModelSpec[] = [
  {
    name: 'DeepSeek V4 Flash（测试）',
    envBase: 'OHMYDOCAGENT_TEST_CHAT_BASE_URL',
    envModel: 'OHMYDOCAGENT_TEST_CHAT_MODEL',
    envKey: 'OHMYDOCAGENT_TEST_CHAT_API_KEY',
    type: 'chat',
    isDefault: true,
    note: '推理模型（reasoning_content），DeepSeek 官方端点',
  },
  {
    name: '通义千问 VL（测试）',
    envBase: 'OHMYDOCAGENT_TEST_VLM_BASE_URL',
    envModel: 'OHMYDOCAGENT_TEST_VLM_MODEL',
    envKey: 'OHMYDOCAGENT_TEST_VLM_API_KEY',
    type: 'chat',
    isDefault: false,
    note: '多模态（图片理解），DashScope 兼容端点',
  },
  {
    name: '通义千问 Embedding（测试）',
    envBase: 'OHMYDOCAGENT_TEST_EMBEDDING_BASE_URL',
    envModel: 'OHMYDOCAGENT_TEST_EMBEDDING_MODEL',
    envKey: 'OHMYDOCAGENT_TEST_EMBEDDING_API_KEY',
    type: 'embedding',
    isDefault: true,
  },
  {
    name: '通义千问 Rerank（测试）',
    envBase: 'OHMYDOCAGENT_TEST_RERANK_BASE_URL',
    envModel: 'OHMYDOCAGENT_TEST_RERANK_MODEL',
    envKey: 'OHMYDOCAGENT_TEST_RERANK_API_KEY',
    type: 'rerank',
    isDefault: true,
    note: 'DashScope rerank 端点；API 请求格式（input.query/documents）待管线接入时校准',
  },
];

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
  });
  const modelService = app.get(ModelService);
  let created = 0;
  let skipped = 0;

  for (const spec of SPECS) {
    const baseUrl = env(spec.envBase);
    const modelName = env(spec.envModel);
    const apiKey = env(spec.envKey);
    if (!baseUrl || !modelName || !apiKey) {
      console.log(
        `[skip] ${spec.name}：缺少 ${spec.envBase}/${spec.envModel}/${spec.envKey} 环境变量`,
      );
      skipped++;
      continue;
    }
    const existing = (await modelService.list()).find(
      (m) => m.name === spec.name,
    );
    if (existing) {
      // 已存在：确保默认标记正确（幂等）
      if (spec.isDefault && !existing.isDefault) {
        await modelService.setDefault(existing.id);
        console.log(`[default] ${spec.name}`);
      }
      skipped++;
      continue;
    }
    const dto: CreateModelDto = {
      name: spec.name,
      provider: 'openai-compatible',
      baseUrl,
      modelName,
      apiKey,
      type: spec.type,
      enabled: true,
    };
    const createdModel = await modelService.create(dto);
    if (spec.isDefault) {
      await modelService.setDefault(createdModel.id);
    }
    console.log(`[created] ${spec.name}（${spec.type}）${spec.note ?? ''}`);
    created++;
  }

  console.log(`完成：新增 ${created}，跳过/幂等 ${skipped}`);
  await app.close();
}

main().catch((err) => {
  console.error('seed-models 失败：', err);
  process.exit(1);
});
