// 前端构建配置（frontend/vite.config.ts）
// 说明：原型自带的 Figma Make Kit 插件体系（.figma/ 下的预览/故事工具链）与
// 产品无关，本文件改为标准 Vite + React + Tailwind v4 配置，保留原型同款
// alias（@ → ./src）与 dev server 行为，并新增 /api 代理 → 后端 3000。
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import path from "node:path"

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        "@": path.resolve(import.meta.dirname, "./src"),
      },
    },
    server: {
      host: "0.0.0.0",
      port: parseInt(process.env.PORT || "5173"),
      strictPort: true,
      // dev 时 /api 转发到后端（NestJS 默认 3000），生产由部署层反代
      proxy: {
        "/api": {
          target: "http://127.0.0.1:3000",
          changeOrigin: true,
        },
      },
    },
    preview: {
      host: "0.0.0.0",
      port: parseInt(process.env.PORT || "5173"),
    },
  }
})
