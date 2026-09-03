// Vitest 配置（frontend/vitest.config.ts）
// 与 vite.config.ts 分离，避免把测试专用配置混进构建配置。
// environment: jsdom —— 提供 localStorage / FormData 等浏览器 API（auth store 与
// client 测试依赖）；client.spec 通过 vi.stubGlobal 注入 mock fetch。
import { defineConfig } from "vitest/config"
import path from "node:path"

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.spec.ts", "src/**/*.spec.tsx"],
  },
})
