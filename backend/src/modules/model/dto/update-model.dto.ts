// 更新模型 DTO（Task 2.3）：全部可选（PATCH 语义——只更新传入字段）。
// apiKey 语义：传入非空串 → 重新加密；传空串 '' → 清除已存密钥
// （hasApiKey 变 false）；不传 → 保留原密文（见 model.service.ts update 注释）。
// baseUrl 的 @IsUrl（http/https + 协议必带）是 SSRF 防护的 DTO 层闸门，
// 调用层兜底见 ssrf.guard.ts（create-model.dto.ts 注释同）。
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  MinLength,
} from 'class-validator';
import { MODEL_PROVIDERS, MODEL_TYPES } from '../model.entity.js';
import type { ModelProvider, ModelType } from '../model.entity.js';

export class UpdateModelDto {
  @IsOptional()
  @IsString({ message: '模型显示名必须是字符串' })
  @MinLength(1, { message: '模型显示名不能为空' })
  @MaxLength(100, { message: '模型显示名最长 100 个字符' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  name?: string;

  @IsOptional()
  @IsIn([...MODEL_PROVIDERS], {
    message: '非法 provider（仅支持 openai-compatible / ollama）',
  })
  provider?: ModelProvider;

  @IsOptional()
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
  baseUrl?: string;

  /** 新 API Key（非空串 → 重新加密；空串 → 清除；不传 → 保留原密钥） */
  @IsOptional()
  @IsString({ message: 'apiKey 必须是字符串' })
  @MaxLength(500, { message: 'apiKey 最长 500 个字符' })
  apiKey?: string;

  @IsOptional()
  @IsString({ message: 'modelName 必须是字符串' })
  @MinLength(1, { message: 'modelName 不能为空' })
  @MaxLength(200, { message: 'modelName 最长 200 个字符' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  modelName?: string;

  @IsOptional()
  @IsIn([...MODEL_TYPES], {
    message: '非法 type（仅支持 chat / embedding / rerank）',
  })
  type?: ModelType;

  @IsOptional()
  @IsBoolean({ message: 'enabled 必须是布尔值' })
  enabled?: boolean;

  @IsOptional()
  @IsObject({ message: 'extraConfig 必须是对象' })
  extraConfig?: Record<string, unknown>;
}
