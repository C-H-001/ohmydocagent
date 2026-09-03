# OhMyDocAgent 解析服务修复镜像（基于 ohmydocagent/parser:2026.08.22-r1）
#
# 修复内容（实测验证，见 parser/README.md）：
#   1. 系统依赖：OpenCV 运行库（libxcb/libGL/libglib/libsm/libxrender）——
#      MinerU/OCR 管线必需
#   2. torch/torchvision ABI 修复：原镜像内 PyPI CUDA 版 torchvision 与
#      +cpu 版 torch 不匹配——从 PyPI CPU wheel 源重装配对（torch 2.7.1+cpu
#      / torchvision 0.22.1+cpu）
#   3. MinerU 安装：镜像缺 mineru 模块 + 打包遗漏的 ftfy 依赖
#   4. 模型固化：MinerU pipeline 模型（Layout/TableCls/MFR）预下载进镜像——
#      运行时不联网、无权限问题
#
# 注：docling 链路已下线（CPU 运行不稳）——本镜像只保留 MinerU 引擎；
#    docling 布局模型预热/inductor 工具链等不再安装。
#
# 运行时注意：
#   - 服务默认绑定容器内 127.0.0.1，部署必须设 OHMYDOCAGENT_PARSER_BIND=0.0.0.0
#   - 解析进程以 root 运行（内部专用服务；模型/配置读写无权限问题）
#   - 构建：docker build -t ohmydocagent/parser:fixed -f parser/Dockerfile .
FROM ohmydocagent/parser:2026.08.22-r1

USER root

# 1. 系统依赖（OpenCV 运行库——MinerU/OCR 管线必需）
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        libxcb1 libxext6 libgl1 libglib2.0-0 libsm6 libxrender1 \
    && rm -rf /var/lib/apt/lists/*

# 2. pip（镜像 venv 无 pip）+ 升级
RUN /app/.venv/bin/python3 -m ensurepip \
    && /app/.venv/bin/python3 -m pip install --no-cache-dir --upgrade pip

# 3. torch/torchvision ABI 修复（CPU 配对重装——MinerU 依赖 torch 推理）
RUN /app/.venv/bin/python3 -m pip uninstall -y torchvision \
    && /app/.venv/bin/python3 -m pip install --no-cache-dir \
        --index-url https://download.pytorch.org/whl/cpu \
        torch==2.7.1 torchvision==0.22.1

# 4. MinerU + 打包遗漏依赖
RUN /app/.venv/bin/python3 -m pip install --no-cache-dir mineru ftfy

# 5. 模型固化（MinerU 用 ModelScope 源——阿里系 CDN，服务器下载快且稳。
#    配置写默认路径 /root/mineru.json）
ENV HF_HOME=/root/.cache/huggingface MINERU_MODEL_SOURCE=modelscope
RUN HF_HOME=/root/.cache/huggingface \
    /app/.venv/bin/python3 -m mineru.cli.models_download -s modelscope -m pipeline

# 保持原入口；固定 bind 默认（部署仍建议显式设 OHMYDOCAGENT_PARSER_BIND=0.0.0.0）
ENV OHMYDOCAGENT_PARSER_BIND=0.0.0.0
ENTRYPOINT ["/app/.venv/bin/ohmydocagent-parser"]

# VLM 描述并发（多图文档串行超时 → ThreadPool 并发 4；放预热后——增量
# 构建命中缓存，只重建本层）
COPY router.py /app/src/ohmydocagent_parser/router.py
