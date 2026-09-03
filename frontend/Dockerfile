# DocMind 前端生产镜像：构建静态资源 → nginx 托管
# 构建：docker build -t docmind/web:<tag> -f frontend/Dockerfile frontend
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY frontend/package.json frontend/package.json
RUN npm ci --workspace frontend --include-workspace-root
COPY frontend/ frontend/
WORKDIR /app/frontend
RUN npm run build

FROM nginx:alpine AS runtime
COPY --from=build /app/frontend/dist /usr/share/nginx/html
# nginx 配置在 deploy/（构建上下文为仓库根，见 docker-compose.production.yml build.context）
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
