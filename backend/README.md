# DocMind Backend（NestJS 后端服务）

DocMind 的企业级后端 REST API 服务，基于 **NestJS 12** + TypeScript（ESM，`type: module`），monorepo 结构见根目录 [`README.md`](../README.md)。

当前已实现（P0 阶段）：配置校验、PostgreSQL/Redis/Neo4j 基础设施接入、用户与 JWT 认证（注册/登录/刷新/登出）、首次部署初始化（Owner）、邀请制注册、RBAC（Owner/Admin 两种角色 + 全局守卫）、认证端点限流。

## 目录结构

```
backend/
├── src/
│   ├── main.ts                  # 入口：创建应用 → configureApp() → listen
│   ├── app.setup.ts             # 应用级统一配置（全局前缀 api/v1、CORS、ValidationPipe）
│   ├── app.module.ts            # 根模块（全局配置/JWT 守卫/角色守卫/限流参数）
│   ├── app.controller.ts        # 根控制器（健康检查 GET /api/v1/health）
│   ├── common/                  # 通用：pagination（分页 DTO 与助手）、装饰器、守卫
│   │   ├── decorators/          # @Public / @Roles / @CurrentUser
│   │   └── guards/              # jwt-auth.guard（全局默认登录）、roles.guard（RBAC）
│   ├── config/                  # configuration.ts（集中配置工厂）+ config.validation.ts（Joi 校验）
│   ├── database/                # TypeORM 连接（PostgreSQL/paradedb）+ 实体注册
│   ├── redis/                   # ioredis 接入层（refresh token 撤销/旋转、后续 BullMQ 复用）
│   ├── neo4j/                   # neo4j-driver 接入层（知识图谱，后续任务启用）
│   └── modules/
│       ├── auth/                # 认证：init/register/login/refresh/logout/me、JWT 策略、限流
│       ├── invitations/         # 邀请制注册：创建/列表/撤销，token 一次性/可过期/可撤销
│       └── users/               # 用户：分页列表、角色调整、所有权转移
└── test/                        # e2e 测试（走真实 configureApp 配置）
    ├── test-db.ts               # 测试库隔离助手（docmind_test）
    ├── app.e2e-spec.ts          # 健康检查
    ├── auth.e2e-spec.ts         # 注册/登录/刷新/登出/删除用户
    ├── auth-init.e2e-spec.ts    # 首次初始化（含并发 init 双 Owner 兜底）
    ├── invitations.e2e-spec.ts  # 邀请全流程（创建/lookup/注册/撤销/过期）
    ├── rbac.e2e-spec.ts         # 角色权限矩阵
    ├── database.e2e-spec.ts     # TypeORM 连通性
    └── infra.e2e-spec.ts        # Redis/Neo4j 连通性
```

> `app.setup.ts` 是 main.ts 与 e2e 测试共用的应用配置入口，避免配置漂移。

## 环境变量

`.env` 位于 `backend/.env`（已 gitignore，模板见 `.env.example`）。已实测：无论从根目录 `npm --workspace backend run ...` 还是 `cd backend && npm run ...`，脚本进程 cwd 都是 backend 目录，故 `envFilePath: ['.env']` 直接命中；`UPLOAD_DIR` 相对 backend 目录。全部键由 `config.validation.ts` 启动时 Joi 校验，配置错误立即 fail-fast（未知键允许，未来可扩展）。

| 键 | 说明 | 默认值 |
|---|---|---|
| `PORT` | 服务监听端口 | `3000` |
| `DB_HOST` / `DB_PORT` | PostgreSQL 地址/端口 | `127.0.0.1` / `5432` |
| `DB_USER` / `DB_PASSWORD` | PostgreSQL 账号 | `docmind` / `docmind` |
| `DB_NAME` | 数据库名（开发库 docmind，测试库 docmind_test 由 e2e 自动创建） | `docmind` |
| `DB_SYNC` | TypeORM synchronize 显式开关：`1`/`true` 开启（仅开发），生产必须 `0`/不设置并走 migration；生产误配直接启动失败（模板预置 `1` 仅为本地开发便利） | `0` |
| `REDIS_HOST` / `REDIS_PORT` | Redis 地址/端口 | `127.0.0.1` / `6379` |
| `NEO4J_URI` / `NEO4J_USER` / `NEO4J_PASSWORD` | Neo4j 连接（本地 docmind-local compose） | `bolt://127.0.0.1:7687` / `neo4j` / `docmind-local-secret` |
| `JWT_SECRET` | JWT 签名密钥；生产必须显式配置且不能是默认值，否则启动失败 | `dev-secret-change-me` |
| `DEFAULT_ROLE` | 公开注册默认角色：仅允许 `admin`（Owner 绝不能通过注册产生，误配启动失败） | `admin` |
| `INVITE_TTL_DAYS` | 邀请有效期天数，1~365（越界配置启动即失败） | `7` |
| `NODE_ENV` | 生产判定开关：`production` 时启用 JWT_SECRET/DB_SYNC fail-fast（`start:prod` 已内置，常规不入 `.env` 模板） | 空（development） |
| `UPLOAD_DIR` | 上传目录（相对 backend 目录） | `uploads` |

## 启动

```bash
# 首次安装依赖（推荐在仓库根目录执行，见下方说明）
cd /mnt/f/DocMind_pi && npm install

# 启动本地基础设施（PostgreSQL/Redis/Neo4j/MinIO，Docker compose）
cd /mnt/f/DocMind_pi/deploy && docker compose up -d

# 方式一：仓库根目录（npm workspaces）
cd /mnt/f/DocMind_pi && npm run dev:backend

# 方式二：直接进入 backend 目录
cd /mnt/f/DocMind_pi/backend && npm run start:dev
```

启动后健康检查：`GET http://127.0.0.1:3000/api/v1/health` → `{"status":"ok"}`。

> 依赖安装：本项目是 npm workspaces monorepo，请在**仓库根目录**执行 `npm install`，依赖统一提升到根 `node_modules`。在 backend 内单独 install 会产生嵌套 `node_modules`，仅作临时调试手段。

## 测试与检查

```bash
npm run lint        # oxlint 静态检查（src/ + test/）
npm run typecheck   # tsc --noEmit 全量类型检查（含 test/）
npm test            # 单元测试（Vitest）
npm run test:e2e    # e2e 测试（Vitest + supertest，走真实应用配置，串行执行）
npm run build       # nest build 编译到 dist/
```

### 测试隔离约定（e2e）

- **测试库 `docmind_test`**：`test/test-db.ts` 的 `ensureTestDatabase()` 幂等创建（直连 postgres 库，并发撞 `42P04` 容忍）；`prepareTestEnv()` 在创建 TestingModule 前把 `process.env.DB_NAME` 指向测试库——必须**先调用再建模块**，因为 dotenv 不覆盖已存在的 `process.env` 变量。开发库 `docmind` 不受 e2e 影响。
- **TRUNCATE 清单约定**：e2e 各文件 `beforeAll` 显式清空相关表，如 `TRUNCATE TABLE users, invitations CASCADE`。**约定：显式列出全部相关表，禁止依赖 CASCADE 静默清空外键相关表**——后续新增与用例数据相关的表（如 org_members）时必须同步扩展清单，避免隐性隔离失效。
- **Redis 清理约定**：Redis 是共享实例，e2e 各文件在 `afterAll` 中按测试用户 id 扫描删除其 `rt:{userId}:*` 键（`refreshToken` 撤销存储，格式见 `auth.constants.ts`）；对中途删除的用户（如 auth 删除用户用例）在用例内即时清理，避免孤儿键污染开发会话。
- e2e 必须**串行执行**（`vitest.config.e2e.ts` 已设 `fileParallelism: false`）：每个文件都会初始化 AppModule（TypeORM synchronize 建表），并行会并发 CREATE TABLE 撞唯一索引随机失败。

## API 速览

全局前缀 `api/v1`；除标注「公开」外均需 `Authorization: Bearer <accessToken>`。分页统一返回 `{ items, total, page, pageSize }`（page 从 1 起，pageSize 上限 100）。

### auth（认证，公开端点均有限流）

| 方法 | 路径 | 说明 | 鉴权 |
|---|---|---|---|
| GET | `/auth/init-status` | 初始化状态：存在任意用户即 `initialized: true` | 公开（60 次/分） |
| POST | `/auth/init` | 首次部署初始化：系统无用户时创建 Owner 并签发 token；已初始化一律 409 | 公开（10 次/分） |
| POST | `/auth/register` | 公开注册（默认角色 Admin） | 公开（10 次/分） |
| POST | `/auth/login` | 登录，返回 `{ accessToken, refreshToken, user }` | 公开（10 次/分） |
| POST | `/auth/refresh` | 刷新 accessToken（refreshToken 旋转，旧 token 原子失效防重放） | 公开（30 次/分） |
| POST | `/auth/logout` | 登出（销毁 refreshToken 的 jti，幂等） | 公开 |
| POST | `/auth/invitations/lookup` | 校验邀请 token（返回绑定邮箱/角色/过期时间，不返回 token） | 公开（30 次/分） |
| POST | `/auth/register-by-invite` | 邀请注册（token 一次性/可过期，邮箱必须与邀请绑定一致） | 公开（10 次/分） |
| GET | `/auth/me` | 当前登录用户信息（脱敏，绝不含 passwordHash） | 登录 |

### invitations（邀请管理，Owner/Admin 均可）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/invitations` | 创建邀请（201 返回完整 token，**仅此一次**展示）；邮箱已注册/已有待使用邀请 → 409 |
| GET | `/invitations` | 分页列表，token 脱敏为 `tokenPreview`，含状态字段（valid/used/expired） |
| DELETE | `/invitations/:id` | 撤销邀请（204，token 立即失效） |

### users（用户管理）

| 方法 | 路径 | 说明 | RBAC |
|---|---|---|---|
| GET | `/users` | 分页用户列表（公开用户信息，无 passwordHash） | Owner/Admin |
| PUT | `/users/:id/role` | 角色调整：恒有且仅有一个 Owner（提升第二 Owner / 降级唯一 Owner → 400；幂等 200） | 仅 Owner |
| POST | `/users/transfer-ownership` | 所有权转移（事务内原子交换角色），返回 `{ previousOwner, newOwner }` | 仅 Owner |

## 认证与 RBAC 设计要点

- 全局 `JwtAuthGuard`：所有路由默认要求登录，`@Public()` 放行；`JwtStrategy` 每次请求查库取最新用户与角色（token 内不冗余 email/role，避免过期快照）。
- 全局 `RolesGuard`（注册在 JwtAuthGuard 之后）：`@Roles(Role.Owner)` 标注的端点做角色判定，未标注自动放行。
- refresh token 存 Redis（键 `rt:{userId}:{jti}`，7 天 TTL），可撤销/旋转/幂等登出；旋转用原子 Lua 脚本防并发重放。
- 唯一 Owner 不变量由 DB 层部分唯一索引 `idx_users_single_owner` 兜底（并发 init 防双 Owner），服务层撞 23505 统一转 409。
- 敏感公开认证端点（register/login/refresh/init）挂 `ThrottlerGuard` 限流（防凭证填充/爆破/暴力枚举），限流参数见 `AppModule` 与 `auth.controller.ts`。

## 开发库冒烟账号

冒烟验证在开发库 `docmind` 创建的初始账号（P0 收尾时保留为开发用账号）：

- 邮箱 `owner@docmind.local` / 密码 `DevOwner123`，角色 `owner`

> 仅限本地开发库；如需还原为未初始化状态，可删除该行：`docker exec docmind-local-postgres-1 psql -U docmind -d docmind -c "DELETE FROM users WHERE email='owner@docmind.local';"`（并清理对应 `rt:` Redis 键）。

## 与根 README 的关系

本文件只描述 backend 模块自身；整体架构、基础设施（PostgreSQL/Redis/Neo4j）启动、前端/解析服务等说明请见根目录 [`README.md`](../README.md) 与 [`docs/`](../docs/)。
