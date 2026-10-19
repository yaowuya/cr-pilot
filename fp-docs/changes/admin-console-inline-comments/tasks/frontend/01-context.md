# GitLab 行内评论与管理控制台 Frontend Implementation Plan

> **For agentic workers:** REQUIRED FLOW: Use `fp-execute` to implement this plan task-by-task. Only task markers use checkbox (`- [ ] **Task frontend-NNN: ...**`) syntax for tracking; substeps are plain ordered instructions.

**Goal:** 交付 cr-pilot 的内置管理前端：管理员登录、评审记录与统计、prompt 管理、环境变量管理、管理员账号五个模块，构建产物由 Express 静态托管。

**Architecture:** Vite + Vue 3 单页应用，Element Plus 作为唯一组件库。history 模式路由配合后端 SPA fallback。`api/client.ts` 统一 fetch 封装（自动附加 Bearer 令牌、401 跳登录）。状态管理用组合式函数加模块级单例，不引入 Pinia。页面数据用局部 `ref`/`reactive`，切换路由时重新拉取。

**Tech Stack:** Vue 3、Vite 5、Element Plus、Vue Router 4、TypeScript。浏览器 E2E 使用本机已安装的 `playwright-cli`（无需新增依赖）。

## Global Constraints

- 依赖约束：前端依赖全部为 `devDependencies`，构建产物为纯静态文件，运行时不向后端加载任何脚本依赖。依据 `design/frontend.md#架构主线`。
- 组件库约束：只使用 Element Plus 组件，不引入第二套 UI 库，不自建视觉组件。唯一例外是 `PromptEditor.vue`（双栏 prompt 编辑），因为 Element Plus 无对应组件。依据 `design/frontend.md#组件映射`。
- 视觉约束：不得自定义颜色、间距、圆角、阴影等视觉 token，全部取 Element Plus 默认主题；关键尺寸（侧边栏 200px、顶栏 60px、菜单项 56px、表格行高 40px、编辑对话框 800px）已在设计确认，设计层不覆盖。依据 `design/frontend.md#视觉契约` 与 `D-013`。
- 令牌约束：令牌存 `localStorage`，通过 `Authorization: Bearer` 头发送，**不用 Cookie**（后端为无状态 Bearer 设计）。依据 `D-008` 与 `design/backend.md#决策 5`。
- 401 约束：任何请求返回 401 时，客户端清除本地令牌并跳转 `/login`，且只跳转一次（并发请求不得重复跳转）。依据 `design/frontend.md#API 模块`。
- 路由约束：`/login` 是唯一白名单路由，其余路由需通过守卫；根路径 `/` 重定向到 `/reviews`。依据 `design/frontend.md#页面与路由`。
- 前缀隔离约束：前端不得拦截或改变 `/api` 与 `/review` 前缀的请求行为；后端 fallback 已保证未匹配 API 返回 JSON。依据 `design/backend.md#接口、权限与兼容边界`。
- 安全约束：严禁使用 `v-html` 渲染任何后端返回的内容（防止 XSS 导致 `localStorage` 中的令牌被窃取）。依据 `design/backend.md#风险、迁移、发布、回滚与监控`。
- 状态约束：不引入 Pinia/Vuex 全局 store；`auth` 用组合式函数加模块级单例（仅令牌与用户名两个状态）。依据 `design/frontend.md#路由与状态管理`。
- 证据约束（`D-019`）：项目无 Figma、无截图、无既有页面，无已批准视觉基准，视觉证据只能记 `CANNOT_VERIFY`；主要交付证据是**真实浏览器 E2E**（全局 `playwright-cli`），禁止用 mock 数据、路由拦截或绕过 UI 的后端直写替代。依据 `${CLAUDE_PLUGIN_ROOT}/skills/_shared/ui-e2e-contract.md`。

## File Structure

| Path | Action | Responsibility |
| --- | --- | --- |
| `web/package.json` | create | 前端依赖与 `build`/`dev` 脚本 |
| `web/vite.config.ts` | create | 构建配置，产物输出到 `web/dist`，开发期代理 `/api` 到后端 |
| `web/tsconfig.json` | create | 前端 TypeScript 配置 |
| `web/index.html` | create | SPA 入口 HTML |
| `web/src/main.ts` | create | 应用引导：挂载 Element Plus、注册路由 |
| `web/src/App.vue` | create | 根组件，仅 `<router-view>` |
| `web/src/api/client.ts` | create | 统一 fetch：附加令牌、解析 JSON、401 跳登录 |
| `web/src/stores/auth.ts` | create | 令牌与当前管理员的组合式单例 |
| `web/src/router/index.ts` | create | 路由表与全局守卫 |
| `web/src/layouts/AdminLayout.vue` | create | 后台骨架：侧边菜单、顶栏、内容区 |
| `web/src/components/PromptEditor.vue` | create | prompt 双栏编辑与占位符提示 |
| `web/src/views/LoginView.vue` | create | 登录页 |
| `web/src/views/ReviewsView.vue` | create | 评审记录与统计页 |
| `web/src/views/PromptsView.vue` | create | prompt 管理页 |
| `web/src/views/ConfigView.vue` | create | 环境变量管理页 |
| `web/src/views/AdminsView.vue` | create | 管理员账号页 |
| `.fp-execute/e2e/*/coverage-matrix.md` | create | 每个 E2E case 的覆盖矩阵（执行时生成） |

## Page Goals

| 路由 | 页面 | 用户目标 | UI Delivery Level |
| --- | --- | --- | --- |
| `/login` | LoginView | 用管理员账号登录进入控制台 | `interactive` |
| `/reviews` | ReviewsView | 查看评审明细与基础统计，按项目/提交人/时间筛选 | `business-flow` |
| `/prompts` | PromptsView | 按项目编辑评审 prompt，保存后下次评审生效 | `business-flow` |
| `/config` | ConfigView | 查看与修改环境变量，识别需重启项 | `business-flow` |
| `/admins` | AdminsView | 新增与删除管理员账号 | `business-flow` |

## Visual Context

- **类型**：UI/UX spec + 组件库默认规范
- **来源**：Element Plus 默认主题。`fp-docs/settings/frontend.md` 不存在，项目无任何既有前端代码或依赖（`package.json` 原本仅 express/yaml/pi），无可继承的视觉基准。
- **可信边界**：组件选型、布局结构、交互模式以 Element Plus 官方能力为准；像素值由组件库默认主题决定，实现阶段不自定义覆盖。
- **验收方式**（`D-019`）：无 `reference.png` 可比对，视觉证据记 `CANNOT_VERIFY`；交付证据以真实浏览器 E2E 覆盖的交互与业务流程为准。
