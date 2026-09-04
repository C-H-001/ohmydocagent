# OhMyDocAgent Backend

OhMyDocAgent 的企业级后端 REST API 服务：NestJS 12 + TypeScript（ESM，`type: module`）+ PostgreSQL (pgvector) + Redis + Neo4j + MinIO。

## 目录结构

```
src/
├── common/            # 通用（装饰器/守卫/分页）
├── config/            # 配置加载与校验
├── database/          # TypeORM 数据源与迁移
├── modules/           # 业务模块
│   ├── auth/          # 认证（JWT/初始化/注册）
│   ├── chat/          # 会话与对话（SSE 流式 + ReAct Agent）
│   ├── graph/         # 知识图谱（Neo4j 实体抽取与检索）
│   ├── kb/            # 知识库管理
│   ├── knowledge/     # 文档管理（解析/分块/状态机）
│   ├── model/         # 模型管理（BYOK 对话/向量/重排）
│   ├── parse/         # 异步解析队列
│   ├── search/        # 检索相关
│   ├── storage/       # 存储抽象（本地/MinIO）
│   └── users/         # 用户与 RBAC
├── neo4j/             # Neo4j 客户端
├── parser/            # 解析服务客户端（gRPC 对接 Python 解析服务）
└── scripts/           # 运维脚本
```

## 环境变量

| 变量 | 说明 |
|---|---|
| `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_NAME` | PostgreSQL 连接 |
| `REDIS_HOST` / `REDIS_PORT` | Redis 连接 |
| `NEO4J_URI` / `NEO4J_USER` / `NEO4J_PASSWORD` | Neo4j 连接 |
| `JWT_SECRET` | JWT 签名密钥（生产必须显式配置非默认值） |
| `ENCRYPTION_KEY` | 模型 API Key 加密密钥（AES-256-GCM 派生源） |
| `PARSER_URL` | 解析服务 gRPC 地址（设置后启用真实解析） |
| `STORAGE_BACKEND` | 存储后端（`local` / `minio`） |

完整变量见 `.env.example`。生产部署用 `deploy/docker-compose.production.yml`（环境变量经 `deploy/.env` 注入）。

## 启动

```bash
# 根目录（npm workspaces monorepo）
cd /path/to/ohmydocagent && npm install
npm run dev:backend
```

## API 概览

- `auth` — 登录 / 注册 / 初始化（限流保护）
- `kbs` — 知识库 CRUD / 文档管理 / 检索
- `chat` — 会话 / 流式对话（SSE）/ 历史
- `models` — 模型管理（每用户私有对话/向量/重排模型）
- `users` — 用户与角色

完整路由在启动日志中列出（`RouterExplorer`）。

## 解析服务

文档解析由独立 Python 服务（`parser/`）承担：MinerU 版面解析 + VLM 图片描述。后端通过 gRPC 调用（proto 见 `parser/proto/parser.proto`）。
