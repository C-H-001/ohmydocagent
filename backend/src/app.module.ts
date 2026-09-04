import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { BullModule } from '@nestjs/bullmq';
import { ThrottlerModule } from '@nestjs/throttler';
import { AppController } from './app.controller.js';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard.js';
import { RolesGuard } from './common/guards/roles.guard.js';
import { KbAccessGuard } from './modules/kb-share/kb-access.guard.js';
import { KbShareModule } from './modules/kb-share/kb-share.module.js';
import configuration from './config/configuration.js';
import { validationSchema } from './config/config.validation.js';
import { DatabaseModule } from './database/database.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { InvitationsModule } from './modules/invitations/invitations.module.js';
import { KbModule } from './modules/kb/kb.module.js';
import { ChunkModule } from './modules/chunk/chunk.module.js';
import { KnowledgeModule } from './modules/knowledge/knowledge.module.js';
import { ModelModule } from './modules/model/model.module.js';
import { ParseModule } from './modules/parse/parse.module.js';
import { StorageModule } from './modules/storage/storage.module.js';
import { UsersModule } from './modules/users/users.module.js';
import { UsageModule } from './modules/usage/usage.module.js';
import { ObservabilityModule } from './modules/observability/observability.module.js';
import { VectorModule } from './modules/vector/vector.module.js';
import { ChatModule } from './modules/chat/chat.module.js';
import { RedisModule } from './redis/redis.module.js';
import { Neo4jModule } from './neo4j/neo4j.module.js';
import { GraphModule } from './modules/graph/graph.module.js';
import { AdminModule } from './modules/admin/admin.module.js';

@Module({
  imports: [
    // 全局配置模块：从 backend/.env 读取（cwd 实测为 backend 目录，见 configuration.ts 注释）
    // validationSchema：启动时校验环境变量，配置错误立即失败而非静默；
    // @nestjs/config v12 走 Standard Schema 桥接（Joi 18 原生支持，vendor='joi'），
    // libraryOptions 对应原 Joi.validate 的 options：allowUnknown 允许未来新增键，
    // abortEarly=false 一次性报告全部错误（v12 对 joi 默认即如此，这里显式声明）
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      envFilePath: ['.env'],
      validationSchema,
      validationOptions: {
        libraryOptions: { allowUnknown: true, abortEarly: false },
      },
    }),
    // 认证端点限流配置（I4：防凭证填充/爆破）：只提供限流参数，
    // ThrottlerGuard 未注册为 APP_GUARD（当前无全局兜底），
    // guard 由 AuthController 的公开认证端点（登录/注册/刷新/初始化）
    // 用 @UseGuards(ThrottlerGuard) + @Throttle 显式挂载生效
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 100 }]),
    // 任务队列（Task 1.4）：BullMQ 独立连接（与 RedisService 的 ioredis 客户端
    // 分离——RedisService 配了 maxRetriesPerRequest=3 不适合 BullMQ 阻塞命令语义，
    // 见 redis.service.ts 注释）。host/port 从集中配置注入（configuration.ts redis 段）
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          host: config.get<string>('redis.host') ?? '127.0.0.1',
          port: config.get<number>('redis.port') ?? 6379,
        },
      }),
    }),
    DatabaseModule,
    // 基础设施接入层：Redis（ioredis）与 Neo4j（neo4j-driver），
    // 均为按需注入的非全局模块；BullMQ 在 Task 1.4 引入并复用 RedisService
    RedisModule,
    Neo4jModule,
    // 知识图谱（Task 3.1）：GraphRepository 封装 Neo4j 实体/关系/chunk 镜像
    // 读写与子图查询（约束初始化/幂等 upsert/文档与 KB 级联删除），
    // 供 Task 3.2 抽取管线（写入）与 Task 3.3 可视化 API（查询）消费
    GraphModule,
    // 用户实体与 JWT 认证（Task 0.4）：UsersModule 提供用户数据访问，
    // AuthModule 注册 passport-jwt 策略与全局 JwtService
    UsersModule,
    UsageModule,
    ObservabilityModule,
    AuthModule,
    // 邀请制注册（Task 0.6）：Owner/Admin 创建一次性邀请，受邀人凭 token 注册
    InvitationsModule,
    // 存储（Task 1.2）：本地磁盘上传文件读写/清理，供文档与 KB 级联删除消费
    StorageModule,
    // 知识文档（Task 1.2）：文件上传/URL 导入/手动创建 + 列表/详情/更新/删除；
    // 本模块注册 PARSE_QUEUE（入队入口）与 KnowledgeProgressService（解析进度写回）
    KnowledgeModule,
    // 分块（Task 1.5）：ChunkingService 纯算法 + ChunkService 持久化/列表；
    // 解析管线与文档删除级联消费（见 ParseModule / KnowledgeModule）
    ChunkModule,
    // 解析队列（Task 1.4）：ParseProcessor worker 消费 PARSE_QUEUE，占位文本抽取
    ParseModule,
    // 模型：EmbeddingService / ChatModelService 抽象（按默认模型配置路由）
    ModelModule,
    // 向量检索（Task 1.6）：VectorService（pgvector 读写 + 混合检索），
    // 被 KbModule（hybrid-search 端点）与 ParseModule（批量 upsert）消费；
    // 此处显式注册使模块图清晰（KbModule/ParseModule 已隐式引入）
    VectorModule,
    // 知识库（Task 1.1）：KB CRUD + 用户级置顶 + 复制；
    // 文档/分块/文件夹等子模块在 Task 1.2+ 陆续挂载并消费 KbService
    KbModule,
    // 组织/空间（Task 4.1）：组织 CRUD + 成员管理 + 邀请（组织是知识库
    // 共享的最小归属单元，Task 4.2 的共享行挂到组织维度）
    // KB 组织共享（Task 4.2）：共享管理（KbShareService）+ 访问权限判定
    // （KbAccessService）+ 全局守卫（KbAccessGuard，见下方 APP_GUARD 注册）
    KbShareModule,
    // 会话（Task 2.1）：Session/Message 实体 + 会话管理 API（CRUD/置顶/
    // 批量删除/清空/重命名 + 消息列表）；对话生成（Task 2.2 起）在本模块扩展
    ChatModule,
    // 系统管理（Task 4.3~4.6）：任务队列仪表盘 + 审计日志（@Global 接线）+
    // 平台 API Keys + 全局设置/系统信息；个人资料（/settings/profile）在
    // UsersModule（任务简化决策，见 profile.controller.ts 注释）
    AdminModule,
  ],
  controllers: [AppController],
  providers: [
    // 全局 JWT 守卫：所有路由默认要求登录，@Public() 路由放行（见 jwt-auth.guard.ts）
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    // 全局角色守卫：读取 @Roles() 元数据做角色判定（未标注自动放行，见 roles.guard.ts）。
    // 注册顺序必须在 JwtAuthGuard 之后——NestJS 按 APP_GUARD 注册顺序执行全局守卫，
    // 保证 RolesGuard 运行时 request.user 已被 JwtStrategy 填充（每次请求查库取最新角色）。
    {
      provide: APP_GUARD,
      useClass: RolesGuard,
    },
    // 全局 KB 访问守卫（Task 4.2）：读取 @RequireKbPermission() 元数据做 KB 级
    // 访问控制（未标注自动放行，见 kb-access.guard.ts）。注册顺序在 RolesGuard
    // 之后——两者都要求 request.user 已填充；KB 权限判定不通过统一 404（隐藏）。
    {
      provide: APP_GUARD,
      useClass: KbAccessGuard,
    },
  ],
})
export class AppModule {}
