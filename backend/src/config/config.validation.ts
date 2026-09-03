// backend/src/config/config.validation.ts
// 环境变量 Joi 校验 schema：启动时校验配置，错误（如 DB_PORT 非数字）立即失败，避免静默
//
// 宽松策略：未知变量允许（allowUnknown，未来新增键不破坏启动），
// 各字段带默认值，与 configuration.ts 的兜底值保持一致。
import Joi from 'joi';

export const validationSchema = Joi.object({
  PORT: Joi.number().default(3000),
  DB_HOST: Joi.string().required(),
  DB_PORT: Joi.number().default(5432),
  DB_USER: Joi.string().default('ohmydocagent'),
  DB_PASSWORD: Joi.string().default('ohmydocagent'),
  DB_NAME: Joi.string().default('ohmydocagent'),
  // synchronize 显式开关：'1'/'true' 开启（仅开发），其余视为关闭
  DB_SYNC: Joi.string().valid('0', '1', 'true', 'false').default('0'),
  REDIS_HOST: Joi.string().default('127.0.0.1'),
  REDIS_PORT: Joi.number().default(6379),
  NEO4J_URI: Joi.string().uri().default('bolt://127.0.0.1:7687'),
  NEO4J_USER: Joi.string().default('neo4j'),
  NEO4J_PASSWORD: Joi.string().default('ohmydocagent-local-secret'),
  JWT_SECRET: Joi.string().min(8).default('dev-secret-change-me'),
  // Task 2.3：API Key 加密密钥派生源（min(16)：过短密钥无安全余量，
  // 与 JWT_SECRET 同模式——生产 fail-fast 由 configuration.ts 承接）
  ENCRYPTION_KEY: Joi.string().min(16).default('dev-encryption-key-change-me'),
  // 注册默认角色：仅允许 'admin'（Owner 绝不能通过注册产生，配置层 fail-fast 兜底）
  DEFAULT_ROLE: Joi.string().valid('admin').default('admin'),
  // 邀请有效期天数：1~365，默认 7（越界配置启动即失败，避免误配永久邀请）
  INVITE_TTL_DAYS: Joi.number().integer().min(1).max(365).default(7),
  UPLOAD_DIR: Joi.string().default('uploads'),
  INIT_TOKEN: Joi.string().allow('').default(''),
  STORAGE_BACKEND: Joi.string().valid('local', 'minio').default('local'),
  MINIO_ENDPOINT: Joi.string().allow('').default('127.0.0.1'),
  MINIO_PORT: Joi.number().default(9000),
  MINIO_USE_SSL: Joi.string().allow('', 'true', 'false').default('false'),
  MINIO_ACCESS_KEY: Joi.string().allow('').default('ohmydocagent'),
  MINIO_SECRET_KEY: Joi.string().allow('').default('ohmydocagent-local-secret'),
  MINIO_BUCKET: Joi.string().allow('').default('ohmydocagent'),
  PARSER_URL: Joi.string().allow('').default(''),
  PARSER_ENGINE: Joi.string().valid('mineru').allow('').default('mineru'),
  PARSER_FILE_BASE_URL: Joi.string().allow('').default(''),
});
