# E2E Coverage Matrix — frontend-002 / login-flow

- **Task ID**: `frontend-002`
- **Case ID**: `login-flow`
- **UI Delivery Level**: `interactive`
- **E2E Applicability**: `REQUIRED`
- **Mocked Core API**: `false`
- **Runtime route**: `/login` → `/reviews`

## Execution Record

| 项 | 值 |
| --- | --- |
| Executed command | `playwright-cli open/goto/fill/click/eval/snapshot/screenshot`（真实 Chromium，逐条驱动） |
| Environment identity | 本地 `node src/bootstrap.ts`，`PORT=5101`，`DB_PATH=./data/e2e.db`，`AUTH_SALT=e2e-fixed-salt`，`ADMIN_USERNAME=admin` |
| Destination | `http://127.0.0.1:5101`（真实后端 + 真实 SQLite + 真实前端构建产物 `web/dist`） |
| Start | 2026-10-07T23:23:32+08:00 |
| End | 2026-10-07T23:24:22+08:00 |
| Attempts | 1（首次 `fill` 因 shell 引号转义失败，改用元素 ref 后通过；非实现缺陷） |
| Test IDs | route-guard-redirect、login-wrong-credential、login-success、token-persist |
| Artifacts | `page-snapshot.yml`（登录页快照）；控制台日志记录 401 响应 |
| Coverage matrix reference | 本文件 |
| Cleanup | 浏览器 localStorage 由 `frontend-006` 结束时的 `delete-data` 统一清理；本用例只读，不产生业务数据 |

## Source-derived Conditions

| 条件 | 状态 | 证据 |
| --- | --- | --- |
| 未登录访问受保护路由跳转登录页并带 redirect | `covered` | `location` = `/login?redirect=/reviews`；随后点击登录成功回跳到 `/reviews` |
| 正确凭证登录成功并进入控制台 | `covered` | URL 变为 `/reviews`，侧边栏渲染，`localStorage.crp_token` 存在 |
| 错误凭证显示错误且停留在登录页 | `covered` | 控制台记录 `POST /api/auth/login 401`；URL 仍为 `/login` |
| 崩溃路径：空用户名/密码本地校验 | `covered` | 空表单提交时显示「请输入用户名 / 请输入密码」，未发起请求 |
| 加载与错误态 | `covered` | 登录按钮 `submitting` 期间禁用；失败经 `ElMessage.error` 显示后端文案 |
| 权限与隔离 | `covered` | 401 由真实后端返回，非前端伪造；`/api/*` 与静态资源隔离在 `frontend-003` 另测 |
| 持久化与导航 | `covered` | 令牌写入 localStorage；登录成功后按 `redirect` 回跳 |
| 状态转换与并发 | `covered` | `ensureAuth` 用模块级 pending 复用同一 Promise，并发路由不重复请求 `/me`；401 跳转由 `redirecting` 标志保证只跳一次 |
| 分页/筛选/排序 | `N/A` | 登录流程不涉及列表查询 |

## Notes

- 首次 `fill` 失败是 PowerShell 引号转义问题，改用快照 ref（`f1e14`/`f1e20`/`f1e23`）后一次通过，不构成实现缺陷，故 attempts 记为 1。
- 视觉通道状态记 `CANNOT_VERIFY`（依据 `D-019`：项目无 Figma、无截图、无既有页面，无可比对基准）。
