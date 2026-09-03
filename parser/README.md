# OhMyDocAgent 解析服务（parser）

## 现状

解析引擎为 **MinerU**（PDF/Word/图片）。MinerU 管线：光栅化 → 版面检测 → 阅读顺序 → 内容框识别（OCR/表格/图片框）→ 组装。

图片/VLM 链路：MinerU 内容框识别**不走 VLM**；OhMyDocAgent parser 端对"图片框"（`image`/`figure` raw_type，≥4KB）额外调 VLM 生成 description（图表 Caption，对齐 WeKnora ImageMultimodal），用 ThreadPool 并发（`router.py`，max_workers=4）防多图文档超时。

## 镜像（ohmydocagent/parser:fixed）

基于 `ohmydocagent/parser:2026.08.22-r1`，修复（见 `parser/Dockerfile`）：
1. 系统库：OpenCV 运行库（libxcb/libGL/libglib/libsm/libxrender）
2. torch/torchvision ABI 修复：CPU 配对重装（torch 2.7.1+cpu / torchvision 0.22.1+cpu）
3. MinerU 安装：mineru 模块 + 打包遗漏的 ftfy 依赖
4. 模型固化：MinerU pipeline 模型（Layout/TableCls/MFR）预下载进镜像（ModelScope 源，运行时不联网）
5. `router.py` 覆盖：VLM 描述并发（ThreadPool 4）

运行时注意：
- gRPC 服务端口 `50051`（env `OHMYDOCAGENT_PARSER_PORT`），默认绑定 127.0.0.1（容器内）——部署须设 `OHMYDOCAGENT_PARSER_BIND=0.0.0.0`（镜像已固化）
- 解析进程以 root 运行（内部专用服务）
- 构建：`docker build -t ohmydocagent/parser:fixed -f parser/Dockerfile .`

## 生产部署实测（阿里云 ECS，CPU）

- **mineru 引擎可用** ✅（~6.5s/页 CPU 推理）
- 部署注意：compose 内 backend 配 `PARSER_URL=parser:50051` + `PARSER_FILE_BASE_URL=http://backend:3000`；生产 `.env` 设 `PARSER_ENGINE=mineru`（默认已 mineru）
- VLM 图片描述（可选）：`.env` 设 `PARSER_VLM_ENDPOINT` / `PARSER_VLM_MODEL` / `PARSER_VLM_API_KEY`——未设则 parser 跳过图片处理（asset 事件 0）；多图文档需并发（镜像内 router.py）+ 后端 gRPC 超时 600s（`GRPC_TIMEOUT_MS`）

## ParserClient 契约（后端侧）

```typescript
interface ParsedDocument { text: string; title?: string; pages?: { page: number; text: string }[]; }
interface ParseInput { filePath?: string; fileType: string; url?: string; manualContent?: string; engine?: 'mineru'; }
interface ParserClient { parse(input: ParseInput): Promise<ParsedDocument>; }
```
实现：`backend/src/parser/grpc-parser.ts`（gRPC 客户端，proto 见 `backend/src/parser/proto/parser.proto`）。
