# OhMyDocAgent 后端生产镜像（多阶段，简单布局：全部放 /app）
# 构建：docker compose build backend（context=仓库根，dockerfile=backend/Dockerfile）
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
RUN npm ci --workspace backend --include-workspace-root
COPY backend/ backend/
WORKDIR /app/backend
RUN npm run build
RUN ls -la dist | head -5

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# 生产依赖（workspaces 提升到根 node_modules）
COPY --from=build /app/backend/package.json /app/package.json
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/backend/dist /app/dist
# 无 ts 源码（dist 已编译），package.json 的 start:prod 引 dist/main
EXPOSE 3000
# 启动前迁移；失败不阻断（表已存在可重试）
CMD ["sh", "-c", "node dist/database/run-migrations.js || echo '[warn] migration 未执行'; node dist/main"]
