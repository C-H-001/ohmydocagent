# OhMyDocAgent 本地基础设施（docker compose）

本目录的 `docker-compose.yml` 用于启动 OhMyDocAgent 后端开发所需的本地基础设施：PostgreSQL（含 pgvector）、Redis、MinIO、Neo4j。

> 来源说明：本文件从 `F:\OhMyDocAgent\.worktrees\ohmydocagent-foundation\deploy\docker-compose.yml` 拷贝而来（`name: ohmydocagent-local`），并保持与源一致。

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

## 账号与连接信息

| 服务     | 地址                  | 账号   | 密码                    | 说明                                    |
| -------- | --------------------- | ------ | ----------------------- | --------------------------------------- |
| postgres | `127.0.0.1:5432`      | ohmydocagent | `ohmydocagent`               | 数据库名：`ohmydocagent`                     |
| redis    | `127.0.0.1:6379`      | 无     | 无                      | 无需认证                                |
| minio    | `127.0.0.1:9000/9001` | ohmydocagent | `ohmydocagent-local-secret`  | 控制台地址：`http://127.0.0.1:9001`     |
| neo4j    | `127.0.0.1:7474`      | neo4j  | `ohmydocagent-local-secret`  | Browser 地址：`http://127.0.0.1:7474`   |

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
docker compose exec neo4j cypher-shell -u neo4j -p ohmydocagent-local-secret "RETURN 1 AS ok"
```

## 数据持久化

- 四个服务均挂载了命名卷，`docker compose down` / 容器重建后数据保留：
  - PostgreSQL → `postgres-data`（/var/lib/postgresql/data）
  - Redis → `redis-data`（/data）
  - MinIO → `minio-data`（/data）
  - Neo4j → `neo4j-data`（/data）、`neo4j-logs`（/logs）
- 如需彻底清空数据，执行 `docker compose down -v`（会删除全部命名卷）。
- pgvector 扩展在 postgres 数据卷**首次初始化**时由 `initdb/init.sql` 自动创建（`CREATE EXTENSION IF NOT EXISTS vector;`），无需手工执行；注意 initdb 脚本仅在首次初始化数据卷时执行，已有数据卷不会重复执行。

## 镜像调整记录

- 若 `neo4j:2025.10.1` 拉取缓慢或失败，可将 compose 中 neo4j 的 `image` 改为本机已有的 `neo4j:2026.06.0-community`。当前环境本地已有 `neo4j:2025.10.1` 镜像且启动成功，故保持默认镜像不变。
- MinIO 为可选服务（本项目用本地存储），启动失败**不影响其余服务**，可单独重试：`docker compose up -d minio`。
