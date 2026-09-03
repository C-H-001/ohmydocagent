# OhMyDocAgent

企业级 AI 知识工作台：面向组织的文档智能问答平台。融合 **检索增强生成（RAG）**、**多模态图表理解**、**知识图谱推理** 与 **组织共享**，帮助团队把 PDF / Word / 图片文档沉淀为可检索、可溯源、可推理的知识资产。

## 核心能力

- **多模态文档解析**：MinerU 版面解析（版面检测 / 阅读顺序 / 表格识别 / 图表提取），图片内容走 VLM 批量语义描述（多图一次请求、按编号输出、token 感知自动分批并发）；图表生成独立检索单元，问答引用可带图溯源
- **中文检索管线**：词粒度中文分词索引 + 向量/关键词双路召回 + RRF 融合 + 重排精排；TopK 由模型动态控制（提示词引导逐步扩大）
- **Agent 编排**：语义检索（search_kb）与知识图谱检索（search_graph）解耦双工具 + 固定工作流
- **可溯源问答**：回答标注引用 [n]，引用携带文档位置 / 页码 / 图片缩略图，一键跳转原文
- **企业级**：多租户模型配置、异步任务队列、文档级与知识库级分块策略、RBAC + 知识库共享权限、链路追踪可观测

## 技术栈

TypeScript (React + NestJS)、Python、PostgreSQL (pgvector)、Redis、Neo4j、MinerU、Langfuse

## 目录结构

```
├── backend/    # NestJS 后端（REST + SSE 流式对话 + 异步任务队列）
├── frontend/   # React 前端（知识库管理 + 对话界面）
├── parser/     # Python 文档解析服务（MinerU 版面解析 + VLM 图片描述）
├── deploy/     # 部署编排（PostgreSQL + Redis + Neo4j + MinIO 等）
└── package.json# npm workspaces 根配置
```

## 本地启动

### 1. 启动基础设施

```bash
cd deploy
docker compose up -d
```

### 2. 后端与前端

```bash
npm install          # 仓库根目录（monorepo）
npm run dev:backend  # 启动后端（NestJS，默认 :3000）
npm run dev:frontend # 启动前端（React，默认 :5173）
```

### 3. 模型配置

首次使用在「设置 → 模型管理」配置对话 / 向量 / 重排模型（OpenAI 兼容 / 兼容供应商均可）。

## 测试

```bash
cd backend
npm run test        # 单元测试
npm run test:e2e    # 端到端测试
```
