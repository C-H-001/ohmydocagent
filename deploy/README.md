# OhMyDocAgent 本地基础设施（docker compose）

本目录的 `docker-compose.yml` 用于启动 OhMyDocAgent 后端开发所需的本地基础设施：PostgreSQL（含 pgvector）、Redis、MinIO、Neo4j。

## 快速开始

```bash
cd deploy
docker compose up -d        # 启动全部服务
docker compose ps           # 查看状态（期望 4 个容器 healthy）
docker compose logs -f      # 查看日志
docker compose down         # 停止（保留数据卷）
docker compose down -v      # 停止并删除数据卷（清空数据）
```

## 服务清单

| 服务     | 镜像                                        | 端口（仅绑定 127.0.0.1）     | 用途                                       |
| -------- | ------------------------------------------- | ---------------------------- | ------------------------------------------ |
| postgres | `paradedb/paradedb:v0.22.2-pg17`            | `5432`                       | 主数据库，PG 17 + pgvector（向量检索）     |
| redis    | `redis:7-alpine`                            | `6379`                       | 缓存 / 队列                                 |
| minio    | `minio/minio:RELEASE.2025-09-07T16-13-09Z`  | `9000`（API）、`9001`（控制台） | 对象存储（可选，本项目优先使用本地存储）   |
| neo4j    | `neo4j:2025.10.1`                           | `7474`（HTTP/Browser）、`7687`（Bolt） | 图数据库（知识图谱）            |

> 安全说明：所有端口均只绑定到 `127.0.0.1`，不对外暴露。密码为本地开发用弱口令，请勿用于生产。

## 连接配置

本地开发配置见 `docker-compose.yml` 与 `../backend/.env.example`。其中的演示凭据只适用于隔离的本地环境，不是在线网站的登录账号或生产凭据。

生产部署使用 `docker-compose.production.yml`，先复制 `.env.example` 为 `.env`，为数据库、对象存储及应用密钥分别设置独立的随机值。真实配置仅保存在部署环境中，不提交 Git。

## 连通性自检命令

```bash
# PostgreSQL（应输出 PG 17 版本号）
docker compose exec postgres psql -U ohmydocagent -d ohmydocagent -c "SELECT version();"

# pgvector 扩展（应输出 vector）
docker compose exec postgres psql -U ohmydocagent -d ohmydocagent -c \
  "CREATE EXTENSION IF NOT EXISTS vector; SELECT extname FROM pg_extension WHERE extname='vector';"

# Redis（应输出 PONG）
docker compose exec redis redis-cli ping

# Neo4j（应输出 ok=1）
docker compose exec neo4j cypher-shell -u neo4j
# 按提示输入本地配置的密码，再执行：RETURN 1 AS ok;
```

## 数据持久化

- 四个服务均挂载了命名卷，`docker compose down` / 容器重建后数据保留：
  - PostgreSQL → `postgres-data`（/var/lib/postgresql/data）
  - Redis → `redis-data`（/data）
  - MinIO → `minio-data`（/data）
  - Neo4j → `neo4j-data`（/data）、`neo4j-logs`（/logs）
- 如需彻底清空数据，执行 `docker compose down -v`（会删除全部命名卷）。
- pgvector 扩展在 postgres 数据卷**首次初始化**时由 `initdb/init.sql` 自动创建（`CREATE EXTENSION IF NOT EXISTS vector;`），无需手工执行；注意 initdb 脚本仅在首次初始化数据卷时执行，已有数据卷不会重复执行。

## 启动问题

- 镜像拉取失败时，请检查容器镜像源和网络连接；更换镜像版本前应验证数据与配置兼容性。
- MinIO 为可选服务（本项目用本地存储），启动失败**不影响其余服务**，可单独重试：`docker compose up -d minio`。
