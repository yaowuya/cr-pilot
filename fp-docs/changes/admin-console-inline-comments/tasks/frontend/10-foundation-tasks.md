# Frontend Foundation Tasks

> **For agentic workers:** REQUIRED FLOW: Use `fp-execute` to implement this plan task-by-task. Only task markers use checkbox (`- [ ] **Task frontend-NNN: ...**`) syntax for tracking; substeps are plain ordered instructions.

- [ ] **Task frontend-001: Vite 工程骨架与构建配置**

**Files:**
- Create: `web/package.json`、`web/vite.config.ts`、`web/tsconfig.json`、`web/index.html`、`web/src/main.ts`、`web/src/App.vue`
- Modify: `package.json`（新增 `build:frontend`、`dev:frontend` 脚本）

**Reasoning:**
- `D-016` 确认前端产物输出到 `web/dist` 并由 Express 托管。工程骨架是所有后续任务的前提。
- 独立边界：只建骨架与构建配置，不含任何页面逻辑。

**Depends on**: None

**Interfaces:**
- Consumes: 无
- Produces: 可构建的 Vite 工程；`npm run build:frontend` 产出 `web/dist/index.html`
- Contract checks: 构建成功产出 `web/dist/index.html`；开发期 `/api` 请求代理到后端

**Step 1: Write the failing test**

本任务无自动化测试（工程骨架由构建命令验证）。验证命令即测试：

```bash
npm run build:frontend
```

预期：失败，因 `web/` 目录不存在或依赖未安装。

**Step 2: Run test to verify it fails**

Run: `npm run build:frontend`
Expected: FAIL with `Cannot find module` 或 `目录不存在`

**Step 3: Write minimal implementation**

`web/package.json` 声明 `vue`、`vue-router`、`element-plus`、`@element-plus/icons-vue` 为依赖，`vite`、`@vitejs/plugin-vue`、`typescript`、`vue-tsc` 为开发依赖，脚本 `build` 为 `vite build`。

`web/vite.config.ts`：

```ts
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    // 开发期把 /api 与 /review 代理到后端，避免跨域与双服务并行启动
    proxy: {
      "/api": "http://127.0.0.1:5001",
      "/review": "http://127.0.0.1:5001",
    },
  },
});
```

`web/index.html` 只需一个 `<div id="app">` 与 `main.ts` 的模块引用。`main.ts` 挂载 Element Plus 与路由；`App.vue` 只有 `<router-view>`（路由在 `frontend-002` 接入）。

根 `package.json` 新增：

```json
"build:frontend": "npm --prefix web run build",
"dev:frontend": "npm --prefix web run dev"
```

`main.ts` 中全量引入 Element Plus 与中文语言包（`element-plus/es/locale/lang/zh-cn`）——管理界面文案以中文为主，部分组件默认文案（如分页、表格空态）需中文，否则与页面其他文案不一致。

**Step 4: Run test to verify it passes**

Run: `npm --prefix web install && npm run build:frontend`
Expected: PASS，`web/dist/index.html` 存在

自审：`vite.config.ts` 的 proxy 配置需注释说明「仅开发期使用，生产由 Express 同源托管」，否则后续维护者可能误以为生产也需要跨域配置。

**Step 5: Commit**

```bash
git add web/ package.json
git commit -m "feat: 新增 Vite + Vue3 + Element Plus 前端工程骨架"
```

- [ ] **Task frontend-002: API 客户端、登录页与路由守卫**

**Files:**
- Create: `web/src/api/client.ts`、`web/src/stores/auth.ts`、`web/src/router/index.ts`、`web/src/views/LoginView.vue`
- Test: 浏览器 E2E（`playwright-cli`），证据目录 `.fp-execute/e2e/frontend-002/login-flow/`

**Reasoning:**
- `D-008` 要求 Bearer 令牌 + localStorage；守卫是所有页面的前置。这是第一个可交付真实交互的任务，也是后续所有页面的登录前提。

**Depends on**: frontend-001, backend-017（后端登录接口）

**Interfaces:**
- Consumes: `POST /api/auth/login`、`GET /api/auth/me`（见 `#API 契约`）；`ensureAuth()` 守卫契约
- Produces: `client.get/post/put/delete`；`auth.login/logout/ensureAuth/token`；路由表与守卫
- Contract checks: 无令牌访问管理路由跳 `/login` 并带 `redirect`；正确凭证登录后进入 `/reviews`；错误凭证显示后端错误文案；401 只跳转一次

**UI Delivery Level**: `interactive`；**E2E Applicability**: `REQUIRED`

**Step 1: Write the failing test**

创建 `web/e2e/login-flow.spec.ts`（Playwright 脚本，经全局 `playwright-cli` 执行），断言：

```typescript
// 未登录访问管理路由 → 跳转登录页
await page.goto("/reviews");
await expect(page).toHaveURL(/\/login/);

// 错误凭证 → 显示错误提示，仍在登录页
await page.fill('input[placeholder="用户名"]', "admin");
await page.fill('input[type="password"]', "wrong-password");
await page.click('button:has-text("登录")');
await expect(page.locator(".el-message--error")).toBeVisible();
await expect(page).toHaveURL(/\/login/);

// 正确凭证 → 进入评审记录页
await page.fill('input[type="password"]', process.env.E2E_ADMIN_PASSWORD!);
await page.click('button:has-text("登录")');
await expect(page).toHaveURL(/\/reviews/);
```

**Step 2: Run test to verify it fails**

Run: `playwright-cli run web/e2e/login-flow.spec.ts`（需后端已启动且存在测试管理员）
Expected: FAIL，因路由与登录页尚未实现

**Step 3: Write minimal implementation**

`client.ts`：

```ts
/**
 * 统一 fetch 封装：附加 Bearer 令牌、解析 JSON、401 跳登录。
 *
 * 401 只跳转一次：多个并发请求同时 401 时，若各自跳转会产生多次导航与控制台告警。
 * redirecting 标志在跳转后由 router 守卫重置。
 */
let redirecting = false;

export async function request<T>(path: string, init: RequestInit & { params?: Record<string, unknown> } = {}): Promise<T> {
  const token = localStorage.getItem("crp_token");
  const headers: Record<string, string> = { "Content-Type": "application/json", ...(init.headers as Record<string, string> | undefined) };
  if (token) headers.Authorization = `Bearer ${token}`;
  let response: Response;
  try {
    response = await fetch(`${path}${toQuery(init.params)}`, { ...init, headers });
  } catch {
    throw { status: 0, message: "服务不可用" } satisfies ApiError;
  }
  if (response.status === 401) {
    localStorage.removeItem("crp_token");
    if (!redirecting) {
      redirecting = true;
      location.assign(`/login?redirect=${encodeURIComponent(location.pathname)}`);
    }
    throw { status: 401, message: "登录已失效，请重新登录" } satisfies ApiError;
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw { status: response.status, message: body.error ?? "请求失败" } satisfies ApiError;
  return body as T;
}
```

`auth.ts` 用模块级 `ref` 持有令牌与用户名，提供 `login`、`logout`、`ensureAuth`、`token`。`ensureAuth` 已有有效用户名时直接返回，不重复请求 `/me`。

`LoginView.vue` 用 `el-form` + 两个 `el-input` + 登录按钮；提交成功后从路由查询参数读 `redirect` 并跳转，缺省跳 `/reviews`。

`router/index.ts` 用 `createWebHistory`，`beforeEach` 中 `/login` 为白名单，其余路由先 `ensureAuth()`。

**Step 4: Run test to verify it passes**

Run: `playwright-cli run web/e2e/login-flow.spec.ts`
Expected: PASS，三段断言全部通过

**Step 5: Record E2E evidence**

在 `.fp-execute/e2e/frontend-002/login-flow/` 写入 `coverage-matrix.md`，覆盖：成功路径、错误凭证、401 跳转、并发 401 单次跳转、redirect 回跳。记录 `Executed command`、`Environment identity`、`Test IDs`、`Cleanup`（登出并清除浏览器存储）。

**Step 6: Commit**

```bash
git add web/src web/e2e .fp-execute/e2e/frontend-002
git commit -m "feat: 前端 API 客户端、登录页与路由守卫"
```
