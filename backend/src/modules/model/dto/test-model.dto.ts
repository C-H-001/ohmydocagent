// 连通性测试 DTO（Task 2.3）：POST /models/test 的请求体——完整连接配置，
// 「只探活、不保存」（服务层不落库，见 model.service.ts testConnection）。
// provider/modelName 必填；baseUrl 必填（测试必须知道打哪个端点）；
// apiKey 可选（本地 Ollama 无需鉴权）。
// baseUrl 加 @IsUrl（http/https + 协议必带）：body 的 baseUrl 用户可控且会被
// provider 直接 fetch——DTO 层先拦非预期协议，私网/保留网段由调用层
// assertSafeBaseUrl 兜底（ssrf.guard.ts），两层共同构成 SSRF 防护。
import { Transform } from 'class-transformer';
import {
  IsIn,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  MinLength,
} from 'class-validator';
import { MODEL_PROVIDERS } from '../model.entity.js';
import type { ModelProvider } from '../model.entity.js';

export class TestModelDto {
  /** 供应商类型（决定打 OpenAI 兼容端点还是 Ollama 端点） */
  @IsIn([...MODEL_PROVIDERS], {
    message: '非法 provider（仅支持 openai-compatible / ollama）',
  })
  provider: ModelProvider;

  /** API 端点（测试必须显式指定，无默认值；http/https 协议必带） */
  @IsString({ message: 'baseUrl 必须是字符串' })
  @IsUrl(
    {
      protocols: ['http', 'https'],
      require_protocol: true,
      require_tld: false, // localhost 无 TLD，默认 require_tld 会误拒（Ollama 本地场景）
    },
    { message: 'baseUrl 必须是合法的 http/https URL' },
  )
  @MaxLength(500, { message: 'baseUrl 最长 500 个字符' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  baseUrl: string;

  /** API Key（可选：本地 Ollama 无需鉴权） */
  @IsOptional()
  @IsString({ message: 'apiKey 必须是字符串' })
  @MaxLength(500, { message: 'apiKey 最长 500 个字符' })
  apiKey?: string;

  /** 上游模型 ID */
  @IsString({ message: 'modelName 必须是字符串' })
  @MinLength(1, { message: 'modelName 不能为空' })
  @MaxLength(200, { message: 'modelName 最长 200 个字符' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  modelName: string;
}
