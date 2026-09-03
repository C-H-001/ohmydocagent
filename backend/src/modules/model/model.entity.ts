// backend/src/modules/model/model.entity.ts
// LLM 模型配置实体（Task 2.3）：供应商抽象（openai-compatible 覆盖
// OpenAI/DeepSeek/Qwen；ollama 本地）+ 连接信息 + 默认标记。
//
// 列设计决策：
// - provider：'openai-compatible' | 'ollama'（枚举列，扩展新供应商时在此
//   追加 + factory 分支，见 providers/llm-provider.factory.ts）；
// - apiKeyEncrypted：AES-256-GCM 密文（见 crypto.service.ts 注释）——DB 层
//   不存明文（e2e 断言「DB 查不到明文」），响应层再脱敏（model.service.ts
//   sanitize），双层防护；
// - isDefault：每 type 最多一个默认——由「部分唯一索引」DB 层兜底
//   （idx_models_default_type：type 上 isDefault=true 的行唯一），服务层
//   setDefault 事务内「先清后设」+ 23505 重试（见 model.service.ts 注释）；
// - extraConfig：供应商透传默认参数（如 temperature），真实 ChatModelService
//   调用时展开进 provider 选项（见 chat-model.service.ts）；
// - baseUrl：Ollama 可留空用默认 http://127.0.0.1:11434（create 时服务层填
//   默认值，见 model.service.ts）。
//
// 无外键/用户归属：模型是系统级配置（非用户私有），与 users 表解耦。
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/** 供应商类型常量（实体/DTO/校验共用，扩展时单点追加） */
export const MODEL_PROVIDERS = ['openai-compatible', 'ollama'] as const;
export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

/** 模型用途类型：chat（对话/摘要）/ embedding（向量化）/ rerank（重排，后续任务） */
export const MODEL_TYPES = ['chat', 'embedding', 'rerank'] as const;
export type ModelType = (typeof MODEL_TYPES)[number];

@Entity('models')
// 部分唯一索引：每 (type, userId) 最多一个 isDefault=true 的模型——
// userId=null 表示全局默认（super 配置，所有用户兜底）；userId 非空表示
// 用户私有默认（BYOK：每用户自己的模型配置，见 model.service getDefault）
@Index('idx_models_default_type', ['type', 'userId'], {
  unique: true,
  where: '"isDefault" = true',
})
export class Model {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** 显示名（如「DeepSeek V3」） */
  @Column()
  name: string;

  /** 供应商类型（'openai-compatible' 覆盖 OpenAI/DeepSeek/Qwen；'ollama' 本地） */
  @Column({ type: 'enum', enum: [...MODEL_PROVIDERS] })
  provider: ModelProvider;

  /** API 端点（Ollama 默认 http://127.0.0.1:11434，create 时服务层填默认值） */
  @Column({ default: '' })
  baseUrl: string;

  /** AES-256-GCM 加密后的 API Key（DB 不存明文，见 crypto.service.ts 注释） */
  @Column({ default: '' })
  apiKeyEncrypted: string;

  /** 上游模型 ID（如 deepseek-chat / qwen2.5:7b / text-embedding-3-small） */
  @Column()
  modelName: string;

  /** 用途类型：chat/embedding/rerank（默认 chat） */
  @Column({ type: 'enum', enum: [...MODEL_TYPES], default: 'chat' })
  type: ModelType;

  /** 启用状态：停用模型不参与路由（getDefault 只查 enabled，见 model.service.ts） */
  @Column({ default: true })
  enabled: boolean;

  /** 归属用户（BYOK：非空 = 用户私有配置；null = 全局默认，super 配置，
   *  所有用户兜底——见 model.service getDefault 解析顺序） */
  @Column({ type: 'uuid', nullable: true })
  userId: string | null;

  /** 是否为该 type 的默认模型（每 type 最多一个，见类上部分唯一索引） */
  @Column({ default: false })
  isDefault: boolean;

  /** 供应商透传默认参数（如 { temperature: 0.7 }），真实调用时展开进选项 */
  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  extraConfig: Record<string, unknown>;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
