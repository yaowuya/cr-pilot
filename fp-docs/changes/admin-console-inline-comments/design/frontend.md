# GitLab 行内评论与管理控制台 — 前端技术方案设计

## 第一部分：架构决策

本端持有的决策只有 D-013（视觉来源）与 D-016（构建产物位置）；D-001~D-012、D-014、D-015、D-017、D-018 由 `design/backend.md` 唯一持有，本文件只链接不复制。跨端一致性由后端 API 契约保证。

### Pre-write Confirmation Evidence

- Covered IDs: `D-013`, `D-016`
- Outstanding blocking decisions: `none`
- Explicit user authorization to write: 用户消息「确认方案并授权写入」，批准 small form `design/frontend.md`；D-013 的证据为用户消息「A. 按 Element Plus 组件库规范推导（推荐）」，D-016 的证据为用户消息「A. 构建产物输出到 web/dist，Express 静态托管（推荐）」。本端仅消费已确认的后端 API 契约，不新增未确认决策。

## 第二部分：技术方案详述

### 设计范围适用性

| 评审范围 | 要求 | Canonical owner section | 证据或不适用理由 |
| --- | --- | --- | --- |
| 架构主线 | 必填 | `#架构主线` | proposal 变更点 15；D-016 |
| 核心对象与职责 | 必填 | `#核心对象与职责` | 五个页面与共享模块边界 |
| 数据模型 | 条件适用 | `N/A` | 前端不持久化业务数据，接口契约由 `design/backend.md#接口、权限与兼容边界` 唯一持有 |
| 状态、并发与执行流程 | 条件适用 | `#状态管理与数据获取` | 令牌生命周期与路由守卫 |
| 接口、权限与兼容边界 | 条件适用 | `#API 模块` | 只声明消费契约，字段定义链接后端 |
| 前端方案 | 条件适用 | `#页面与路由` + `#组件映射` + `#视觉契约` | 本文件为前端唯一 detailed owner |
| 风险、迁移、发布、回滚与监控 | 必填 | `#风险与发布` | 前端侧独立风险 |
| 验证方案 | 必填 | `#验证方案` | 构建、路由守卫、视觉检查项 |

### 架构主线

前端是一个纯静态单页应用，不参与任何后端业务逻辑：启动时读取 `localStorage` 中的令牌并调用 `GET /api/auth/me` 校验；校验失败跳转登录页；校验通过则渲染后台布局（左侧菜单 + 顶部信息栏 + 内容区），并按路由懒加载对应页面组件。页面通过统一封装的 API 客户端访问后端，令牌由客户端自动附加，401 统一跳转登录页。

构建链路：Vite 以 `web/` 为根目录产出静态资源到 `web/dist`，Dockerfile 新增构建阶段把产物 COPY 进 runner，Express 用 `express.static` 托管 `web/dist` 并对非 `/api`、非 `/review` 的未匹配路径回落 `index.html`（SPA fallback，D-016）。

### 核心对象与职责

| 对象/模块 | 职责 | 不负责 | 协作对象 | 证据 |
| --- | --- | --- | --- | --- |
| `web/src/api/client.ts` | 统一 fetch 封装：附加 Bearer 令牌、解析 JSON、401 跳登录 | 不含业务逻辑、不缓存 | 所有页面 | `D-008`；后端契约见 `design/backend.md#接口、权限与兼容边界` |
| `web/src/stores/auth.ts` | 持有令牌与当前管理员；提供 login/logout/ensureAuth | 不存业务数据 | 路由守卫、布局 | `D-008`、`D-009` |
| `web/src/router/index.ts` | 路由表与全局守卫 | 不做数据获取 | `auth` store、各页面 | `#页面与路由` |
| `web/src/layouts/AdminLayout.vue` | 后台骨架：侧边菜单、顶栏、面包屑、内容容器 | 不含业务逻辑 | 各页面组件 | `#组件映射` |
| `web/src/views/*` | 五个页面，各自只做展示与表单交互 | 不直接调 fetch | `api/client.ts` | `#页面与路由` |
| `web/src/components/PromptEditor.vue` | prompt 双栏编辑（system/user），含占位符提示 | 不校验业务语义 | `views/Prompts.vue` | `#组件映射` |

### 页面与路由

| 路由 | 页面组件 | 入口 | 数据来源 |
| --- | --- | --- | --- |
| `/login` | `LoginView.vue` | 未登录时所有路由自动跳转 | `POST /api/auth/login` |
| `/reviews` | `ReviewsView.vue` | 侧边菜单「评审记录」 | `GET /api/reviews`、`GET /api/reviews/stats` |
| `/prompts` | `PromptsView.vue` | 侧边菜单「Prompt 管理」 | `/api/prompts/*` |
| `/config` | `ConfigView.vue` | 侧边菜单「环境变量」 | `GET/PUT /api/config` |
| `/admins` | `AdminsView.vue` | 侧边菜单「管理员」 | `/api/admins` |
| `/` | 重定向到 `/reviews` | — | — |

守卫逻辑：`ensureAuth()` 在路由进入前执行——无令牌跳转 `/login`；有令牌但 `/api/auth/me` 返回 401 时清除本地令牌并跳转 `/login`；有效则放行。`/login` 是白名单，已登录访问时重定向到 `/reviews`。

### 组件映射

复用 Element Plus 组件，不自建视觉组件。组件选型与布局策略：

| 设计区域 | 目标 DOM/组件层级 | 项目组件 | 布局策略 | 关键 token/尺寸 | 备注 |
| --- | --- | --- | --- | --- | --- |
| 后台骨架 | `el-container` > `el-aside` + `el-container` > `el-header` + `el-main` | Element Plus `Container/Aside/Header/Main` | Flex，aside 固定宽 200px | `--el-menu-width: 200px` | 侧边栏可折叠为图标模式 |
| 侧边菜单 | `el-menu` + `el-menu-item` | Element Plus `Menu` | 纵向列表 | 默认菜单项高 56px | 五项 + 图标 |
| 顶栏 | `el-header` 内 `el-dropdown` 显示当前用户名 | Element Plus `Dropdown` | 右对齐 | 默认 header 高 60px | 下拉项为「退出登录」 |
| 评审列表页 | `el-card` + `el-form`(筛选) + `el-table` + `el-pagination` | Element Plus `Card/Form/Table/Pagination` | 筛选区在上、表格居中、分页在下 | 表格行高默认 40px | 筛选：项目 ID、提交人、日期范围 |
| 统计卡片 | `el-row` + `el-col` + `el-statistic` | Element Plus `Row/Col/Statistic` | 24 栅格，每卡占 6 格（4 列） | 默认间距 | 展示总次数、项目数、提交人数、平均分 |
| prompt 管理页 | `el-table` + `el-dialog` + `PromptEditor` | Element Plus `Table/Dialog` + 自建 `PromptEditor` | 表格列表 + 弹窗编辑 | 对话框默认宽 800px | 编辑器为两个 `el-input type=textarea` |
| 环境变量页 | `el-form` + `el-table` + `el-input`/`el-switch` | Element Plus `Form/Table/Input/Switch` | 按 key 逐行编辑 | — | 密钥项输入框显示掩码占位，需显式点击「显示」 |
| 管理员页 | `el-table` + `el-dialog` + `el-form` | Element Plus `Table/Dialog/Form` | 表格 + 新增弹窗 | — | 删除用 `el-popconfirm` 二次确认 |

`PromptEditor.vue` 是唯一自建组件，因为它承载双栏 prompt 编辑与占位符提示，Element Plus 无对应组件。system 与 user 两个文本域各自独立，`user_prompt` 下方展示可用占位符 `{diffs_text}` 与 `{commits_text}`（依据现有 `renderUserPrompt` 的占位符约定，见 `src/domain/review-rules.ts`）。

### API 模块

后端在 `design/backend.md#接口、权限与兼容边界` 唯一声明字段与语义，前端只消费。本端约定：

| 前端调用 | 对应后端契约 |
| --- | --- |
| `client.post('/api/auth/login', {username, password})` | 登录，返回 `{token, username}` |
| `client.get('/api/auth/me')` | 返回 `{username}`，用于启动校验 |
| `client.get('/api/reviews', {params})` | 评审列表，参数含筛选与分页 |
| `client.get('/api/reviews/stats', {params})` | 统计聚合 |
| `client.get/put/post/delete('/api/prompts')` | prompt 增删改查与导入 |
| `client.get/put('/api/config')` | 配置查询与更新，读取时密钥字段返回掩码 |
| `client.get/post/delete('/api/admins')` | 管理员账号管理 |

`client.ts` 行为约定：所有请求附加 `Authorization: Bearer <token>`；响应非 2xx 时抛出带后端 `error` 文案的错误对象；401 触发全局跳登录并清空令牌；网络错误统一提示「服务不可用」。前端不在客户端缓存业务数据，页面数据由组件自身状态持有，切换路由时重新拉取。

### 路由与状态管理

路由由 `vue-router` 管理，使用 history 模式（配合 Express SPA fallback）。守卫在 `router.beforeEach` 中调用 `auth.ensureAuth()`。

状态管理采用轻量方案：`auth` 用组合式函数加模块级单例（不引入 Pinia），因为仅有令牌与用户名两个状态；页面级数据用 `ref`/`reactive` 局部持有，管理页面之间无共享数据需求。不引入全局 store 避免为一个状态引入依赖。

令牌生命周期：登录成功写入 `localStorage`；`ensureAuth` 校验通过后缓存用户名于内存（不重复请求）；退出登录清除 `localStorage` 与内存状态并跳转 `/login`（对应 `D-009` 的无状态语义，前端无需处理服务端吊销）。

### 状态管理与数据获取

页面数据获取均在 `onMounted` 触发并处理 loading、空态与错误三态，全部用 Element Plus 的 `v-loading`、`el-empty` 与 `ElMessage`。评审列表的筛选与分页变更通过 `watch` 触发重新拉取。表单提交期间禁用提交按钮并显示 loading，防止重复提交。

### 视觉契约

#### UI/UX Settings Source

- Settings read: 无 `fp-docs/settings/` 目录（已确认不存在），`frontend.md`、`prototype-style.md`、`agent.md` 均缺失
- Existing references: 项目无任何现有前端源码或前端依赖（`package.json` 仅 express/yaml/pi），无可继承的既有页面
- Confirmed tokens/components: Element Plus 默认主题 token 与组件（`D-013` 用户确认按组件库规范推导）
- Confirmed UX rules: 未配置，全部采用 Element Plus 默认交互规范
- Unknowns requiring user confirmation: 无（`D-013` 已确认为「按 Element Plus 组件库规范推导」，且项目无既有页面可继承，不存在需回问的视觉分歧）

#### Visual Source

- 类型：UI/UX spec + 组件库默认规范
- 来源：Element Plus 组件库默认主题（`D-013` 用户确认）。项目无 Figma 链接、无用户截图、无 `fp-docs/settings/frontend.md`、无既有前端页面，因此不存在可继承的视觉基准
- 可信边界：已确认组件选型、布局结构与交互模式均以 Element Plus 官方组件能力为准；具体像素值（间距、圆角、阴影）由组件库默认主题决定，实现阶段不在设计层自定义覆盖。若后续提供 Figma 或截图，需回到 `D-013` 重新确认并更新本节

#### UI 组件树与映射

见上节「组件映射」表格：后台骨架、侧边菜单、顶栏、评审列表页、统计卡片、prompt 管理页、环境变量页、管理员页八个区域各自映射到 Element Plus 组件与布局策略，关键尺寸取组件库默认值（aside 200px、header 60px、菜单项 56px、表格行高 40px、编辑对话框 800px）。

#### Visual Checks

- [ ] 侧边栏宽度 200px，菜单项五项与路由一一对应，当前路由高亮（来源：Element Plus Menu 默认规范 + `#组件映射`）
- [ ] 顶栏右对齐显示当前用户名，下拉仅「退出登录」一项（来源：Element Plus Dropdown + `#组件映射`）
- [ ] 评审列表筛选区（项目 ID、提交人、日期范围）在表格上方，分页在下方且显示总数（来源：Element Plus Table/Pagination + `#组件映射`）
- [ ] 统计区四张卡片单行等宽排列（el-row 24 栅格每卡 6 格）（来源：Element Plus Row/Col + `#组件映射`）
- [ ] prompt 编辑弹窗宽度 800px，system 与 user 两个文本域上下排列，user 文本域下方展示两个占位符提示（来源：Element Plus Dialog + `PromptEditor` + `src/domain/review-rules.ts` 占位符约定）
- [ ] 环境变量页密钥项输入框默认显示掩码，点击「显示」才明文（来源：后端掩码契约 `D-012` + `#API 模块`）
- [ ] 管理员删除操作使用二次确认气泡，确认按钮为主色警告态（来源：Element Plus Popconfirm）
- [ ] 所有表格具备 loading、空态（el-empty）、错误提示三态（来源：Element Plus 默认 + `#状态管理与数据获取`）
- [ ] 未登录访问任意管理路由自动跳转 `/login`，登录后回跳（来源：`#路由与状态管理`）

### 风险与发布

| 具体失败场景 | 影响 | 预防或处理 | 发布/回滚/监控安排 | 证据 |
| --- | --- | --- | --- | --- |
| 令牌存于 localStorage，页面存在 XSS 时令牌被窃取 | 攻击者获得管理员权限 | 严格避免 `v-html` 渲染未转义内容；不引入来源不明的依赖 | 随前端构建产物一并上线 | `D-008` 已知代价，后端风险表已登记 |
| 构建产物未同步到 runner 镜像，访问 `/` 返回 404 | 管理页面不可用 | Dockerfile 构建阶段校验产物存在；`GET /health` 之外增加静态资源存在性检查 | 上线后人工访问 `/` 验证 | `D-016` |
| SPA fallback 规则覆盖 `/api` 未匹配路由 | API 404 返回 HTML 而非 JSON | fallback 显式排除 `/api` 与 `/review` 前缀 | 接口测试覆盖未匹配路径返回 404 JSON | `#架构主线` |
| 前端依赖版本与 Element Plus 不兼容导致构建失败 | 无法产出静态资源 | lockfile 固定版本；CI 中执行前端构建 | 构建失败即阻断发布 | `D-016` |
| 浏览器 localStorage 被禁用 | 登录态无法保存 | 检测 localStorage 可用性，禁用时提示服务不可用 | 部署文档说明浏览器要求 | `#状态管理与数据获取` |

发布顺序：先发布后端（含数据库与 API），再发布前端构建产物；两者同镜像交付故实际为一次 `docker compose up -d --build`。回滚时回退镜像即可，前端无独立数据迁移。前端无独立监控信号，通过浏览器控制台错误与后端访问日志观察。

### 验证方案

| 验证项 | 命令或操作 | 预期结果 | 覆盖的设计结论 | 证据 owner |
| --- | --- | --- | --- | --- |
| 前端构建 | `npm run build:frontend` | 产出 `web/dist/index.html` 与资源文件 | `D-016` | 本节 |
| 类型检查 | `npm run typecheck`（含前端 tsconfig） | 退出码 0 | 页面与 API 客户端类型契约 | 本节 |
| 静态托管 | 构建后访问 `/` 与 `/reviews` | 均返回 `index.html` | SPA fallback | 本节 |
| API 未匹配隔离 | 访问 `/api/not-exist` | 返回 404 JSON 而非 HTML | fallback 前缀排除 | 本节 |
| 登录与守卫 | 未登录访问 `/reviews`；登录后访问 | 前者跳 `/login`，后者放行 | `#路由与状态管理` | 本节 |
| 令牌失效 | 手工写入无效令牌后访问 | 触发 401 并跳登录 | `#API 模块` | 本节 |
| 五个页面渲染 | 逐页访问 | 表格/表单/卡片按映射渲染，三态齐全 | `#组件映射`、Visual Checks | 本节 |
| prompt 编辑保存 | 修改 system/user prompt 并保存，刷新页面 | 内容持久且下次评审生效 | `#组件映射`、`D-016` | 本节 |
| 密钥掩码显示 | 打开环境变量页 | 密钥项显示掩码，可手动显示 | Visual Checks 第 5 项 | 本节 |
| Visual Checks 逐项 | 对照 Visual Checks 九项人工核对 | 全部符合 | 视觉契约 | 本节 |
