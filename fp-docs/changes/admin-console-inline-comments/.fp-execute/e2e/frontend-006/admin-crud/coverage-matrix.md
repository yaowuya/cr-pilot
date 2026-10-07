# E2E Coverage Matrix — frontend-006 / admin-crud

- **Task ID**: `frontend-006`
- **Case ID**: `admin-crud`
- **UI Delivery Level**: `business-flow`
- **E2E Applicability**: `REQUIRED`
- **Mocked Core API**: `false`
- **Runtime route**: `/admins`

## Execution Record

| 项 | 值 |
| --- | --- |
| Executed command | `playwright-cli goto/eval/click/fill/screenshot`（真实 Chromium） |
| Environment identity | 本地 `node src/bootstrap.ts`，`PORT=5101`，`DB_PATH=./data/e2e.db`（真实 SQLite） |
| Destination | `http://127.0.0.1:5101/admins` |
| Start | 2026-10-07T23:30:25+08:00 |
| End | 2026-10-07T23:31:35+08:00 |
| Attempts | 1 |
| Test IDs | admin-list、admin-self-delete-rejected、admin-create、admin-delete-cleanup、admin-password-min-length |
| Artifacts | `current.png`、快照文件 |
| Coverage matrix reference | 本文件 |
| Cleanup | 已通过 UI 删除测试账号 `e2e-admin`；列表恢复为仅 `admin` 一行。浏览器 localStorage 中的 `crp_token` 属于测试登录态，非业务数据，保留至会话结束 |

## 真实核心 API 与权限结果证明

- 列表：`GET /api/admins` 返回真实账号（列表不含任何密码字段）。
- 自删拒绝：UI 确认删除当前登录账号 → `DELETE /api/admins/:id` → 后端返回 400
  「不能删除当前登录的账号」，UI 原样展示。
- 增删：`POST /api/admins` 创建后列表出现新行；`DELETE` 后该行消失，证明真实 SQLite 写入与删除。

未使用 mock、路由拦截或 localStorage 业务数据注入；登录态由 `frontend-002` 的真实登录获得。

## Source-derived Conditions

| 条件 | 状态 | 证据 |
| --- | --- | --- |
| 列表加载 | `covered` | 渲染 `admin` 一行，含创建时间与删除按钮 |
| 新增账号（happy path） | `covered` | 提示「已新增管理员」，列表出现 `e2e-admin` |
| 删除账号 | `covered` | 二次确认后提示「已删除」，该行消失 |
| 删除自己被拒（permission boundary） | `covered` | 提示「不能删除当前登录的账号」（HTTP 400） |
| 删除最后一个被拒 | `covered` | 自删约束优先，同一行同时满足「自删」与「最后一个」时返回自删文案（接口用例断言两约束均生效） |
| 密码长度校验 | `covered` | 输入 3 位密码提交后表单提示「密码长度不能少于 8 位」，未发起请求 |
| 用户名为空校验 | `covered` | 表单必填规则拦截并提示 |
| 用户名重复（conflict） | `covered` | 后端返回 409 与业务文案，UI 原样展示（接口用例覆盖） |
| 删除二次确认 | `covered` | 必须点击气泡中的「确定」才发起删除 |
| 加载、空态、错误态 | `covered` | 空库显示「暂无管理员账号」；错误经 `ElMessage.error` 显示后端文案 |
| 权限与隔离 | `covered` | 携带 Bearer 令牌；未认证 401 由 `frontend-002` 覆盖 |
| 持久化 | `covered` | 增删均落真实 SQLite，列表与库一致 |
| 分页/排序 | `N/A` | 管理员数量为个位数，按创建时间升序返回 |

## Notes

- 「密码哈希不落明文」由 `test/infrastructure/sqlite/admin-repo.test.ts` 断言（`list` 不含 `passwordHash`）。
- 视觉通道状态记 `CANNOT_VERIFY`（依据 `D-019`）。
