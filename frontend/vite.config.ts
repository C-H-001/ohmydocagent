// Vite + React + Tailwind v4：@ 指向 src，开发环境 /api 代理到本地后端。
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
