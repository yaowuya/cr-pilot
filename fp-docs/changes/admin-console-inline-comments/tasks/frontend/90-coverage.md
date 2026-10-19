# Frontend Coverage Matrix

本矩阵证明 proposal 的前端范围、design-frontend 的全部契约与视觉/证据要求都被任务覆盖。

## Proposal 覆盖

| Source | Requirement | Tasks | Verification |
| --- | --- | --- | --- |
| proposal.md | 变更点 15 内置管理前端（Vue3 + Vite + Element Plus，Express 托管） | `frontend-001` | `npm run build:frontend` 产出 `web/dist/index.html` |
| proposal.md | 管理前端含五个模块 | `frontend-002`（登录）、`frontend-003`（评审记录）、`frontend-004`（prompt）、`frontend-005`（环境变量）、`frontend-006`（管理员） | 各自 E2E 脚本 |
| proposal.md | 变更点 7 评审记录与统计在页面呈现 | `frontend-003` | `.fp-execute/e2e/frontend-003/reviews-query/coverage-matrix.md` |
| proposal.md | 变更点 10 环境变量管理在页面呈现 | `frontend-005` | `.fp-execute/e2e/frontend-005/config-edit/coverage-matrix.md` |
| proposal.md | 变更点 13 prompt 管理在页面呈现 | `frontend-004` | `.fp-execute/e2e/frontend-004/prompt-edit/coverage-matrix.md` |
| proposal.md | 变更点 9 管理员账号管理在页面呈现 | `frontend-006` | `.fp-execute/e2e/frontend-006/admin-crud/coverage-matrix.md` |
| proposal.md | 变更点 8 登录体系在页面呈现 | `frontend-002` | `.fp-execute/e2e/frontend-002/login-flow/coverage-matrix.md` |

## Design 契约覆盖

| Source | Contract | Tasks | Verification |
| --- | --- | --- | --- |
| design/frontend.md | 组件树：后台骨架、侧边菜单、顶栏 | `frontend-003` | E2E 断言当前路由高亮与下拉退出 |
| design/frontend.md | 组件树：评审列表（筛选/表格/分页）与统计卡片 | `frontend-003` | E2E 断言四张 `el-statistic` 与筛选请求 |
| design/frontend.md | 组件树：`PromptEditor.vue` 双栏与占位符提示 | `frontend-004` | E2E 断言 `{diffs_text}` 与 `{commits_text}` 可见 |
| design/frontend.md | 组件树：环境变量页掩码展示 | `frontend-005` | E2E 断言掩码值与切换 |
| design/frontend.md | 组件树：管理员页 `el-popconfirm` 二次确认 | `frontend-006` | E2E 断言确认气泡 |
| design/frontend.md | 路由契约：五路由 + `/` 重定向 + 守卫 | `frontend-002`, `frontend-003` | E2E 断言未登录跳转与 `redirect` 回跳 |
| design/frontend.md | 状态契约：令牌在 localStorage，用户名内存单例 | `frontend-002` | E2E 断言刷新后仍登录 |
| design/frontend.md | API 契约：401 统一跳登录且只跳一次 | `frontend-002` | 覆盖矩阵中的并发 401 条目 |
| design/frontend.md | 交互契约：loading / 空态 / 错误三态 | `frontend-003`, `frontend-004`, `frontend-005`, `frontend-006` | 各页面 E2E 的空态与错误断言 |
| design/frontend.md | 视觉契约：无已批准基准，视觉证据记 `CANNOT_VERIFY` | 全部前端任务 | 见下方「视觉证据说明」 |
| `D-008` | 令牌存 localStorage，不用 Cookie | `frontend-002` | E2E 断言请求头含 Bearer 且无 Cookie 依赖 |
| `D-012` | 密钥掩码展示 | `frontend-005` | E2E 断言掩码值不含明文片段 |
| `D-014` | 配置立即生效 + 需重启标注 | `frontend-005` | E2E 断言 warning 提示含「重启」 |
| `D-015` | prompt 删除即删 | `frontend-004` | 覆盖矩阵的删除条目 |
| `D-016` | 产物 `web/dist` + Express 托管 | `frontend-001` | `npm run build:frontend` + 后端 `backend-022` 的 fallback 测试 |
| `D-019` | 无视觉基准，交互 E2E 为主要证据 | 全部前端任务 | 见下方「视觉证据说明」 |

## 浏览器能力

本机已安装全局 `playwright-cli`（探测结果：`node_modules/playwright` 不存在、`npx playwright` 需要下载包、全局 `playwright-cli` 可用），因此不进入 `BROWSER_CAPABILITY_GATE`，无需新增依赖或下载浏览器。前端 E2E 统一用 `playwright-cli run <spec>`。

## 视觉证据说明

依据 `D-019` 与 `${CLAUDE_PLUGIN_ROOT}/skills/_shared/ui-e2e-contract.md`：

- 项目无 Figma、无用户截图、无既有前端页面，**无已批准视觉基准**，因此不存在可生成的 `reference.png`。
- 各 case 的 Visual Evidence 状态记 `CANNOT_VERIFY`（= `BLOCKED` 于视觉通道），**不得记 `PASS` 或 `VISUAL_REVIEW_PASS`**。
- 交付证据来自真实浏览器 E2E：五个 case 均为 `interactive` 或 `business-flow`，`E2E Applicability: REQUIRED`，`Mocked Core API: false`。
- 若后续提供 Figma 或截图，需回到 `D-019` 重新确认，并为对应 case 补 `reference.png` 后重跑视觉评审。

## 设计缺口

无。proposal 的前端范围与 design-frontend 的全部契约均映射到任务；视觉基准缺失已由 `D-019` 显式确认为可接受状态（以交互 E2E 为主要证据），不构成设计缺口。
