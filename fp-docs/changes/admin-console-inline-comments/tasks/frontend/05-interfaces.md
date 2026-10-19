# Frontend Interface Contracts

本文件是前端组件、状态、API、路由、交互、样式与 Visual/E2E 契约的唯一 owner。任务的 `**Interfaces:**` 链接本文件契约，不复制正文。

## API 契约

字段定义由 `design/backend.md#接口、权限与兼容边界` 与 `tasks/backend/05-interfaces.md` 唯一持有，本文件只声明前端调用形态。

| 前端方法 | 后端端点 | 请求 | 响应要点 |
| --- | --- | --- | --- |
| `client.post('/api/auth/login')` | `POST /api/auth/login` | `{username, password}` | `{token, username}`；401 表示凭证错误 |
| `client.get('/api/auth/me')` | `GET /api/auth/me` | — | `{username}` |
| `client.get('/api/reviews', {params})` | `GET /api/reviews` | `project_id` / `committer` / `from` / `to` / `page` / `page_size` | `{items, total, page, pageSize}` |
| `client.get('/api/reviews/stats', {params})` | `GET /api/reviews/stats` | `from` / `to` | `{total, projectCount, committerCount, avgScore, daily[]}` |
| `client.get('/api/prompts')` | `GET /api/prompts` | — | 摘要数组，**不含** `systemPrompt` / `userPrompt` |
| `client.get('/api/prompts/:id')` | `GET /api/prompts/:id` | — | 完整记录含正文 |
| `client.post('/api/prompts')` | `POST /api/prompts` | `{repository, system_prompt, user_prompt, wecom_webhook_url?, wecom_score_threshold?}` | 完整记录；409 表示 repository 重复 |
| `client.put('/api/prompts/:id')` | `PUT /api/prompts/:id` | 同上去掉 `repository` | 完整记录 |
| `client.delete('/api/prompts/:id')` | `DELETE /api/prompts/:id` | — | `{ok:true}` |
| `client.post('/api/prompts/import')` | `POST /api/prompts/import` | — | `{imported, skipped}` |
| `client.get('/api/config')` | `GET /api/config` | — | `{items:[{key, value, masked, restartRequired}]}` |
| `client.put('/api/config')` | `PUT /api/config` | `{items:[{key, value}]}` | `{items, restartRequired[]}` |
| `client.get('/api/admins')` | `GET /api/admins` | — | `[{id, username, createdAt}]` |
| `client.post('/api/admins')` | `POST /api/admins` | `{username, password}` | `{id, username}`；409 重复、400 密码过短 |
| `client.delete('/api/admins/:id')` | `DELETE /api/admins/:id` | — | `{ok:true}`；400 表示删自己或删最后一个 |

## 客户端契约

| 契约 | 内容 |
| --- | --- |
| 令牌附加 | 每个请求附加 `Authorization: Bearer <token>`；无令牌时不附加，由后端返回 401 |
| 401 处理 | 清除 `localStorage` 中的令牌、跳转 `/login`；**并发请求只跳转一次**（用模块级标志位防重复） |
| 错误对象 | 非 2xx 时抛出 `{status, message}`，`message` 取后端 `error` 字段；网络异常时 `message` 为「服务不可用」 |
| 密钥掩码 | `masked === true` 的项默认显示 `value`（后端已掩码）；用户点击「显示」才请求后端返回的真实值——后端不回传真实密钥，因此该操作仅切换本地展示，不产生网络请求 |

## 状态契约

| 状态 | 持有位置 | 内容 | 生命周期 |
| --- | --- | --- | --- |
| 令牌 | `localStorage` key `crp_token` + `auth.ts` 模块单例 | 字符串 | 登录写入，退出清除，401 清除 |
| 当前管理员 | `auth.ts` 模块单例（内存） | `username` | `ensureAuth()` 成功后写入，不重复请求 |
| 页面数据 | 各页面组件局部 `ref`/`reactive` | 列表、统计、表单、加载与错误状态 | 组件挂载时拉取，筛选或分页变更时重新拉取 |

## 路由契约

| 路径 | 组件 | 守卫 | 菜单入口 |
| --- | --- | --- | --- |
| `/login` | `LoginView` | 白名单；已登录时重定向 `/reviews` | 无 |
| `/reviews` | `ReviewsView` | 需登录 | 侧边菜单第 1 项 |
| `/prompts` | `PromptsView` | 需登录 | 侧边菜单第 2 项 |
| `/config` | `ConfigView` | 需登录 | 侧边菜单第 3 项 |
| `/admins` | `AdminsView` | 需登录 | 侧边菜单第 4 项 |
| `/` | — | 重定向到 `/reviews` | — |

守卫实现：`router.beforeEach` 调用 `auth.ensureAuth()`；无令牌跳转 `/login` 并带 `redirect` 查询参数；登录成功后跳回该参数指向的路由。

## 组件树契约

| 设计区域 | 组件层级 | Element Plus 组件 | 布局策略 | 关键尺寸 |
| --- | --- | --- | --- | --- |
| 后台骨架 | `AdminLayout` | `el-container` > `el-aside` + `el-container` > `el-header` + `el-main` | Flex | aside 200px，可折叠为图标 |
| 侧边菜单 | `AdminLayout` 内 | `el-menu` + `el-menu-item` | 纵向列表 | 菜单项 56px |
| 顶栏 | `AdminLayout` 内 | `el-header` + `el-dropdown` | 右对齐 | header 60px |
| 评审列表 | `ReviewsView` | `el-card` + `el-form` + `el-table` + `el-pagination` | 筛选在上、表格居中、分页在下 | 表格行高 40px |
| 统计卡片 | `ReviewsView` | `el-row` + `el-col` + `el-statistic` | 24 栅格，每卡 6 格（4 列） | 默认间距 |
| prompt 管理 | `PromptsView` + `PromptEditor` | `el-table` + `el-dialog` + `el-input[type=textarea]` | 表格 + 弹窗编辑 | 对话框 800px |
| 环境变量 | `ConfigView` | `el-form` + `el-table` + `el-input` | 按 key 逐行编辑 | — |
| 管理员 | `AdminsView` | `el-table` + `el-dialog` + `el-form` + `el-popconfirm` | 表格 + 新增弹窗 | — |

`PromptEditor.vue` 是唯一自建组件：承载 system 与 user 两个文本域，`user` 文本域下方展示占位符 `{diffs_text}` 与 `{commits_text}` 提示（占位符约定见 `src/domain/review-rules.ts`）。

## 交互与状态契约

| 场景 | 契约 |
| --- | --- |
| 加载中 | 表格与表单容器加 `v-loading` |
| 空态 | 无数据时用 `el-empty` 描述文案 |
| 错误 | 用 `ElMessage.error` 显示后端 `message` |
| 表单校验 | 提交时校验，非提交时不即时报错（避免打扰） |
| 提交中 | 禁用提交按钮并显示 loading，防重复提交 |
| 删除确认 | 用 `el-popconfirm` 二次确认 |
| 密钥展示 | 默认显示后端返回的掩码值，点击图标切换显示状态（纯本地，不请求后端） |

## Visual / UX Checks

无已批准视觉基准（`D-019`），因此不设像素级 `Visual Checks` 清单。以下为可执行的结构检查项，供浏览器 E2E 与人工核对：

| 检查项 | 期望 |
| --- | --- |
| 侧边栏宽度 | 200px，四项菜单与路由一一对应，当前路由高亮 |
| 顶栏 | 右对齐显示当前用户名，下拉仅「退出登录」 |
| 评审列表 | 筛选区在表格上方，分页在下方并显示总数 |
| 统计卡片 | 四张卡片单行等宽排列 |
| prompt 编辑弹窗 | 宽度 800px，两个文本域上下排列，user 下方有两个占位符提示 |
| 环境变量页 | 密钥项显示掩码，可点击切换 |
| 管理员删除 | 二次确认气泡才发起删除 |
| 表格三态 | loading、空态、错误提示均可观察 |
| 路由守卫 | 未登录访问管理路由跳 `/login`，登录后回跳原目标 |

## UI/E2E Delivery Contract

| Task ID | Case ID | Source-derived condition | UI Delivery Level | Runtime route | E2E Applicability | Lifecycle evidence | Coverage matrix path | Rationale |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `frontend-002` | `login-flow` | 正确凭证登录成功并进入控制台；错误凭证显示错误提示 | `interactive` | `/login` → `/reviews` | `REQUIRED` | `SOURCE_READY -> STATIC_UI_READY -> INTERACTION_READY -> FRONTEND_E2E_PASS` | `.fp-execute/e2e/frontend-002/login-flow/coverage-matrix.md` | 登录是所有页面的前置入口，必须真实跑通 |
| `frontend-003` | `reviews-query` | 评审记录列表、统计卡片、筛选与分页 | `business-flow` | `/reviews` | `REQUIRED` | 全链路含 `FRONTEND_E2E_PASS` | `.fp-execute/e2e/frontend-003/reviews-query/coverage-matrix.md` | 读取真实持久化数据，需证明真实 API 与真实数据 |
| `frontend-004` | `prompt-edit` | 新建项目 prompt 并保存，刷新后内容仍在，下次评审使用新 prompt | `business-flow` | `/prompts` | `REQUIRED` | 全链路含 `FRONTEND_E2E_PASS` | `.fp-execute/e2e/frontend-004/prompt-edit/coverage-matrix.md` | 写入真实数据库并影响真实评审行为，`Mocked Core API: false`，需清理测试数据 |
| `frontend-005` | `config-edit` | 修改环境变量并保存，响应标注需重启项 | `business-flow` | `/config` | `REQUIRED` | 全链路含 `FRONTEND_E2E_PASS` | `.fp-execute/e2e/frontend-005/config-edit/coverage-matrix.md` | 写入真实配置覆盖表，需验证持久化与密钥掩码 |
| `frontend-006` | `admin-crud` | 新增管理员后可删除；删除自己或最后一个被拒绝 | `business-flow` | `/admins` | `REQUIRED` | 全链路含 `FRONTEND_E2E_PASS` | `.fp-execute/e2e/frontend-006/admin-crud/coverage-matrix.md` | 涉及账号增删与删除约束的真实权限结果，需清理测试账号 |

全部 case 的 `Mocked Core API: false`，禁止 `page.route`、MSW、fixture JSON、localStorage 业务数据注入与数据库 seed。真实测试账号通过 UI 正常登录获取，不伪造认证态。
