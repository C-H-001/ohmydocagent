# OhMyDocAgent 解析服务（parser）

## 现状

解析引擎为 **MinerU**（PDF/Word/图片）。MinerU 管线：光栅化 → 版面检测 → 阅读顺序 → 内容框识别（OCR/表格/图片框）→ 组装。

图片/VLM 链路：MinerU 内容框识别**不走 VLM**；parser 保留原始 `source_type` 用于内部路由，对外仍输出已有图片块和资源。`chart` 使用专用数据提取提示词，`image`/`figure` 维持普通图片描述；表格仍走原有 OCR＋结构识别分支。已有的 `chart_caption`、`chart_body`、`chart_footnote` 保留为块文本。

| 内部分类 | VLM任务 | 每批最多图片 | 输出token上限 | 4 KiB过滤 |
|---|---|---:|---:|---|
| `image` / `figure` | 原有简短检索描述 | 16 | 每批1024 | 保留 |
| `chart` | 数值、类别、年份、单位和图例对应关系提取 | 2 | 每批8192 | 不过滤非空图表 |

两条通道分别组批，共享最多4个批次并发及原有20,000估算输入token分批阈值；按asset_key回填后恢复原资产顺序。图表单图回退沿用同一专用提示词与8192输出上限，不降级成普通概述；普通图片单图回退维持原行为。

图表响应若明确因长度截断，或批量编号/多行输出可能丢失数据，将回退单图；单图仍失败时保留资源并返回 `VLM_DESCRIPTION_FAILED`。这不是数值准确率校验，也不能发现供应商未标注的语义遗漏。

`source_type` 不加入对外gRPC协议或数据库。被MinerU误判成普通图片的图表仍走普通描述，独立上传图片也保持原流程；本版没有增加额外VLM分类调用。

## 镜像（ohmydocagent/parser:fixed）

基于 `ohmydocagent/parser:2026.08.22-r1`，修复（见 `parser/Dockerfile`）：
1. 系统库：OpenCV 运行库（libxcb/libGL/libglib/libsm/libxrender）
2. torch/torchvision ABI 修复：CPU 配对重装（torch 2.7.1+cpu / torchvision 0.22.1+cpu）
3. MinerU 安装：mineru 模块 + 打包遗漏的 ftfy 依赖
4. 模型固化：MinerU pipeline 模型（Layout/TableCls/MFR）预下载进镜像（ModelScope 源，运行时不联网）
5. `router.py` / `media.py` 覆盖：批量 VLM 描述及图片体积优化
6. `engines/mineru_engine.py` 覆盖：保留 MinerU 图表块，进入现有图片/VLM 通道
7. `server.py` 覆盖：同时支持 `ohmydocagent.parser.v1.Parser/Parse` 与旧 `docmind.parser.v1.Parser/Parse`，允许前后端独立升级；环境变量优先使用 `OHMYDOCAGENT_` 前缀，兼容旧 `DOCMIND_` 前缀
8. `contracts.py` / `prompts.py` 覆盖：原始图片分类传递与图表专用提取规则

运行时注意：
- gRPC 服务端口 `50051`（env `OHMYDOCAGENT_PARSER_PORT`），默认绑定 127.0.0.1（容器内）——部署须设 `OHMYDOCAGENT_PARSER_BIND=0.0.0.0`（镜像已固化）
- 解析进程以 root 运行（内部专用服务）
- 构建：`docker build -t ohmydocagent/parser:fixed -f parser/Dockerfile .`

## 生产部署实测（阿里云 ECS，CPU）

- **mineru 引擎可用** ✅（~6.5s/页 CPU 推理）
- 部署注意：compose 内 backend 配 `PARSER_URL=parser:50051` + `PARSER_FILE_BASE_URL=http://backend:3000`；生产 `.env` 设 `PARSER_ENGINE=mineru`（默认已 mineru）
- VLM 图片描述（可选）：`.env` 设 `PARSER_VLM_ENDPOINT` / `PARSER_VLM_MODEL` / `PARSER_VLM_API_KEY`；未设时解析结果保留图片资源，但不生成描述。VLM 请求失败时保留资源并返回警告。多图文档使用批量并发描述，后端 gRPC 超时为 600s（`GRPC_TIMEOUT_MS`）。

## 在现有运行镜像上构建

`Dockerfile.hotfix` 复用已安装的 MinerU、依赖及模型权重，只更新解析适配器和图片通道，不重新下载模型。以下命令在仓库根目录执行；基础镜像必须是已验证可用的完整 parser 镜像。

```bash
docker build --network=none --pull=false \
  --build-arg PARSER_BASE_IMAGE=ohmydocagent/parser:fixed \
  -t ohmydocagent/parser:chart-fix -f parser/Dockerfile.hotfix .
```

旧 `docmind/parser` 镜像需要同时指定其实际基础镜像和 `--build-arg PARSER_PACKAGE=docmind_parser`；热修复构建会检查目标包是否存在，避免复制到未使用的目录。

部署后应通过实际 Parse 请求确认 gRPC 服务名及环境变量兼容；不能仅凭端口就绪判断后端协议已联通。

修复只影响后续解析。历史文档缺失的图表需要显式重新解析，升级镜像不会自动重解析已有知识库，也不保证 VLM 能准确识别每个图内数字。

## ParserClient 契约（后端侧）

```typescript
interface ParsedDocument { text: string; title?: string; pages?: { page: number; text: string }[]; }
interface ParseInput { filePath?: string; fileType: string; url?: string; manualContent?: string; engine?: 'mineru'; }
interface ParserClient { parse(input: ParseInput): Promise<ParsedDocument>; }
```
实现：`backend/src/parser/grpc-parser.ts`（gRPC 客户端，proto 见 `backend/src/parser/proto/parser.proto`）。
