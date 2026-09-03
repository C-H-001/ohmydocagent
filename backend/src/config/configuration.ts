// backend/src/config/configuration.ts
// 集中读取环境变量的配置工厂，各模块通过 ConfigService 获取配置
//
// .env 读取位置说明（已实测）：
// 本仓库为 npm workspaces monorepo，无论从根目录 `npm --workspace backend run ...`
// 还是 `cd backend && npm run ...` 启动，脚本进程 cwd 都是 backend 目录
// （实测输出：cwd=F:\OhMyDocAgent_pi\backend），因此 ConfigModule 默认的
// `envFilePath: ['.env']` 指向 backend/.env，无需额外处理。
// 同理，UPLOAD_DIR=uploads 是相对 backend 目录的路径（见根 .gitignore）。
//
// 本工厂函数会读取用户实体中的 Role 枚举（纯常量，无副作用），用于注册默认角色配置。
import { Role } from '../modules/users/user.entity.js';

// 生产环境 fail-fast 判定时点说明：
// JWT_SECRET / synchronize 的生产检查必须放在本工厂函数体内，而非模块顶层
// import 求值期——因为 dotenv 由 NestJS ConfigModule 初始化时才把 .env 灌入
// process.env，顶层检查早于 .env 加载，会把「.env 中已配置的密钥」误判为缺失。
// 工厂函数在 ConfigModule 加载 .env 之后才执行，此时 process.env 已包含 .env 值。
export default () => {
  // 生产环境 fail-fast：JWT_SECRET 必须显式配置，禁止使用开发默认值
  if (process.env.NODE_ENV === 'production') {
    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret || jwtSecret === 'dev-secret-change-me') {
      throw new Error(
        '生产环境必须配置 JWT_SECRET，且不能使用开发默认值 dev-secret-change-me',
      );
    }
    // Task 2.3：ENCRYPTION_KEY（API Key 加密的 AES 密钥派生源）同样必须显式
    // 配置——默认值是开发兜底，生产用它加密的密文等于没加密（密钥公开）
    const encryptionKey = process.env.ENCRYPTION_KEY;
    if (!encryptionKey || encryptionKey === 'dev-encryption-key-change-me') {
      throw new Error(
        '生产环境必须配置 ENCRYPTION_KEY，且不能使用开发默认值 dev-encryption-key-change-me',
      );
    }
  }

  // synchronize 显式开关：DB_SYNC='1'/'true' 开启（仅开发），默认关闭，生产走 migration
  const synchronize = ['1', 'true'].includes(
    (process.env.DB_SYNC ?? '0').toLowerCase(),
  );
  // 生产环境强制禁止 synchronize：误配 DB_SYNC=1 会让 TypeORM 直接按实体改表，fail-fast 拦截
  if (process.env.NODE_ENV === 'production' && synchronize) {
    throw new Error(
      '生产环境禁止开启 TypeORM synchronize（DB_SYNC 必须为 0 或不设置），请使用 migration 管理表结构',
    );
  }

  // 注册默认角色（I3 配置化）：固定 Admin。DEFAULT_ROLE 的读取与校验由
  // config.validation.ts 承接（仅允许 'admin'，误配 'owner' 等启动即 fail-fast），
  // 此处不再读环境变量（原先「等于 'admin' 返回 Admin 否则也返回 Admin」的三元
  // 是两分支相同的死代码）——Owner 绝不能通过公开注册产生，只能由初始化/转移产生
  // （见 Task 0.5/0.7），故直接取常量即可。
  const defaultRole: Role = Role.Member;

  return {
    port: parseInt(process.env.PORT || '3000', 10),
    database: {
      host: process.env.DB_HOST || '127.0.0.1',
      port: parseInt(process.env.DB_PORT || '5432', 10),
      username: process.env.DB_USER || 'ohmydocagent',
      password: process.env.DB_PASSWORD || 'ohmydocagent',
      database: process.env.DB_NAME || 'ohmydocagent',
      synchronize,
    },
    redis: {
      host: process.env.REDIS_HOST || '127.0.0.1',
      port: parseInt(process.env.REDIS_PORT || '6379', 10),
    },
    neo4j: {
      uri: process.env.NEO4J_URI || 'bolt://127.0.0.1:7687',
      user: process.env.NEO4J_USER || 'neo4j',
      password: process.env.NEO4J_PASSWORD || 'ohmydocagent-local-secret',
    },
    jwt: {
      secret: process.env.JWT_SECRET || 'dev-secret-change-me',
      expiresIn: '2h',
      refreshExpiresIn: '7d',
    },
    // Task 2.3：API Key 加密密钥派生源（sha256 后作 AES-256-GCM 密钥，
    // 见 crypto.service.ts 注释）；生产 fail-fast 检查见文件头
    encryptionKey: process.env.ENCRYPTION_KEY || 'dev-encryption-key-change-me',
    // Task 5.12：初始化安全令牌——生产设置 INIT_TOKEN 后 /auth/init 需携带
    // 匹配的 X-Init-Token 头（防公网部署被抢先初始化，见 auth.controller.ts）
    initToken: process.env.INIT_TOKEN || '',
    // 真实解析服务（ohmydocagent/parser:fixed，gRPC）：设置后 ParserModule 用
    // GrpcParser 替代占位实现（见 parser/parser.module.ts）；fileBaseUrl 是
    // 后端自身地址（解析服务拉取签名文件 URL 用——dev 127.0.0.1:3000，
    // compose 内 http://backend:3000）
    parserUrl: process.env.PARSER_URL || '',
    // 默认解析引擎（MinerU：PDF/Word/图片版式还原，见 parser/README.md）
    parserEngine: (process.env.PARSER_ENGINE ?? 'mineru') as 'mineru',
    // 图片 VLM（图表 Caption 生成，对齐 WeKnora ImageMultimodal）：parser 对
    // 文档图片调 VLM 生成描述；未配则 parser 跳过图片处理
    parserVlmEndpoint: process.env.PARSER_VLM_ENDPOINT ?? '',
    parserVlmModel: process.env.PARSER_VLM_MODEL ?? '',
    parserVlmApiKey: process.env.PARSER_VLM_API_KEY ?? '',
    // Langfuse 观测（评测链路，可选；生产默认关闭）
    langfuseEnabled: (process.env.LANGFUSE_ENABLED ?? 'false') === 'true',
    // pgvector HNSW 检索精度（查询侧 ef_search；参考 WeKnora HNSW M=32 调参）
    // 索引侧 m/ef_construction 在建索引时指定（HNSW_M/HNSW_EF_CONSTRUCTION），
    // 见 deploy/scripts/hnsw-index.sql 与 eval/README 调参说明
    hnswEfSearch: Number(process.env.HNSW_EF_SEARCH ?? 40),
    langfuseHost: process.env.LANGFUSE_HOST ?? 'http://langfuse:3000',
    langfusePublicKey: process.env.LANGFUSE_PUBLIC_KEY ?? '',
    langfuseSecretKey: process.env.LANGFUSE_SECRET_KEY ?? '',
    parserFileBaseUrl:
      process.env.PARSER_FILE_BASE_URL || `http://127.0.0.1:${process.env.PORT || 3000}`,
    auth: {
      defaultRole,
    },
    invite: {
      // 邀请有效期天数（INVITE_TTL_DAYS 可配，默认 7），范围校验见 config.validation.ts
      ttlDays: parseInt(process.env.INVITE_TTL_DAYS || '7', 10),
    },
    uploadDir: process.env.UPLOAD_DIR || 'uploads',
    // 存储后端：local（磁盘，默认）| minio（对象存储）——见 storage.service.ts
    storageBackend: process.env.STORAGE_BACKEND || 'local',
    minio: {
      endpoint: process.env.MINIO_ENDPOINT || '127.0.0.1',
      port: parseInt(process.env.MINIO_PORT || '9000', 10),
      useSSL: process.env.MINIO_USE_SSL === 'true',
      accessKey: process.env.MINIO_ACCESS_KEY || 'ohmydocagent',
      secretKey: process.env.MINIO_SECRET_KEY || 'ohmydocagent-local-secret',
      bucket: process.env.MINIO_BUCKET || 'ohmydocagent',
    },
  };
};
