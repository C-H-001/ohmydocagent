// 新增模型 DTO（Task 2.3）：name/modelName 必填；provider 枚举（400 校验）；
// type 枚举默认 chat；baseUrl/apiKey 可选（ollama 可留空用默认端点，
// openai-compatible 必须配置——服务层校验必填，见 model.service.ts create 注释）。
// apiKey 明文只在请求体出现：服务层加密后落库、响应脱敏（见 model.service.ts）。
//
// SSRF 防护（Task 2.3 质量审查整改）：baseUrl 限定 http/https 协议且必须带协议
// 前缀（@IsUrl protocols + require_protocol）——禁止 file:///ftp:// 等非预期协议；
// require_tld:false 允许 localhost 单标签主机（Ollama 本地部署 http://localhost:11434
// 是合法场景，见 ssrf.guard.ts 回环放行注释）。DTO 校验只是第一道闸——调用层
// （provider fetch 前）还有 assertSafeBaseUrl 兜底私网/保留网段，见 ssrf.guard.ts。
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

export class CreateModelDto {
  /** 显示名（如「DeepSeek V3」） */
  @IsString({ message: '模型显示名必须是字符串' })
  @MinLength(1, { message: '模型显示名不能为空' })
  @MaxLength(100, { message: '模型显示名最长 100 个字符' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  name: string;

  /** 供应商类型：'openai-compatible'（OpenAI/DeepSeek/Qwen）| 'ollama' */
  @IsIn([...MODEL_PROVIDERS], {
    message: '非法 provider（仅支持 openai-compatible / ollama）',
  })
  provider: ModelProvider;

  /** API 端点（可选：ollama 留空用默认 http://127.0.0.1:11434；
   * openai-compatible 必填——服务层校验，见 model.service.ts create） */
  @IsOptional()
  @IsString({ message: 'baseUrl 必须是字符串' })
  @IsUrl(
    {
      protocols: ['http', 'https'],
      require_protocol: true,
      // localhost 无 TLD，默认 require_tld 会误拒（Ollama 本地部署合法场景）
      require_tld: false,
    },
    { message: 'baseUrl 必须是合法的 http/https URL' },
  )
  @MaxLength(500, { message: 'baseUrl 最长 500 个字符' })
  baseUrl?: string;

  /** API Key（明文仅请求体出现；加密落库 + 响应脱敏） */
  @IsOptional()
  @IsString({ message: 'apiKey 必须是字符串' })
  @MaxLength(500, { message: 'apiKey 最长 500 个字符' })
  apiKey?: string;

  /** 上游模型 ID（如 deepseek-chat / qwen2.5:7b / text-embedding-3-small） */
  @IsString({ message: 'modelName 必须是字符串' })
  @MinLength(1, { message: 'modelName 不能为空' })
  @MaxLength(200, { message: 'modelName 最长 200 个字符' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  modelName: string;

  /** 用途类型：chat/embedding/rerank（默认 chat） */
  @IsOptional()
  @IsIn([...MODEL_TYPES], {
    message: '非法 type（仅支持 chat / embedding / rerank）',
  })
  type?: ModelType;

  /** 启用状态（默认 true；停用模型不参与路由） */
  @IsOptional()
  @IsBoolean({ message: 'enabled 必须是布尔值' })
  enabled?: boolean;

  /** 供应商透传默认参数（如 { temperature: 0.7 }） */
  @IsOptional()
  @IsObject({ message: 'extraConfig 必须是对象' })
  extraConfig?: Record<string, unknown>;
}
