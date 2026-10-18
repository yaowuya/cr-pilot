import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

/**
 * 前端构建配置。
 *
 * `base` 保持默认 `/`：后端挂在根路径，不使用子路径前缀。
 *
 * **产物输出到 Vite root 之外**（`../dist`，即仓库根的 `dist/`）。
 * dev server 的 SPA fallback 会把 `root + build.outDir + /index.html` 当作回落
 * 目标；产物在 root 内（`web/dist`）时，dev server 读到的是构建版 index.html
 * （引用 `/assets/*.js`），而这些文件 dev server 并不提供，于是 `/assets/*`
 * 也回落成 HTML —— 浏览器把 `text/html` 当 JS 执行，报 ERR_ABORTED 404 并白屏。
 * 后端托管目录同步改为 `dist`（见 src/bootstrap.ts 的 WEB_DIST_DIR）。
 */
export default defineConfig({
  plugins: [vue()],
  build: { outDir: "../dist", emptyOutDir: true },
  server: {
    // 开发服务器端口。与后端 5001 错开，避免端口冲突。
    port: 5002,
    // 端口被占用时直接报错而不是静默切到 5003：
    // 静默换端口会让浏览器里存的旧地址失效，也容易和后端代理配置混淆。
    strictPort: true,
    proxy: {
      // 只代理后端接口前缀。
      //
      // `/review` 必须写成精确匹配 `^/review/` 而不是裸字符串 `"/review"`：
      // Vite 的字符串 key 是**前缀匹配**，会把前端路由 `/reviews` 也代理到后端，
      // 后端没有该路径（或未启动）时返回 404/连接失败 → 刷新页面白屏。
      "/api": "http://127.0.0.1:5001",
      "^/review/": "http://127.0.0.1:5001",
    },
  },
});
