import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

/**
 * 前端构建配置。
 *
 * 产物输出到 `dist/`，由后端 Express 静态托管（D-016）。`base` 保持默认 `/`：
 * 后端挂在根路径，不使用子路径前缀。
 */
export default defineConfig({
  plugins: [vue()],
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    port: 5173,
    // 仅开发期使用：把 /api 与 /review 代理到本地后端，避免跨域与双服务并行启动。
    // 生产环境由 Express 同源托管，不需要也不应配置跨域。
    proxy: {
      "/api": "http://127.0.0.1:5001",
      "/review": "http://127.0.0.1:5001",
    },
  },
});
