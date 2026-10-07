# GitLab 行内评论与管理控制台 Task Plan Overview

## Canonical End Entrypoints

| End | Canonical entrypoint | Mode |
| --- | --- | --- |
| Backend | `tasks/backend/00-index.md` | split |
| Frontend | `tasks/frontend/00-index.md` | split |

## Cross-end Dependency Edges

| From task | To task | Shared contract / gate |
| --- | --- | --- |
| `backend-017` | `frontend-002` | `POST /api/auth/login` 返回 `{token, username}` 且失败返回 401，验证命令 `node --test test/interfaces/http/api.test.ts` |
| `backend-019` | `frontend-003` | `GET /api/reviews` 与 `/stats` 响应形状，验证命令 `node --test test/interfaces/http/api.test.ts` |
| `backend-021` | `frontend-004` | `/api/prompts` 五个端点的字段与 409 语义，验证命令 `node --test test/interfaces/http/api.test.ts` |
| `backend-020` | `frontend-005` | `GET/PUT /api/config` 的掩码字段与 `restartRequired`，验证命令 `node --test test/interfaces/http/api.test.ts` |
| `backend-018` | `frontend-006` | `/api/admins` 三个端点与删除约束的 400 语义，验证命令 `node --test test/interfaces/http/api.test.ts` |

## Cross-end Execution Stages

| Stage | Ends / cross-end gate | Exit condition |
| ---: | --- | --- |
| 1 | Backend 契约提供者 | `backend-017`~`backend-022` 全部通过，`/api/*` 端点契约稳定 |
| 2 | Frontend 契约消费者 | `frontend-002` 通过真实后端 E2E（`.fp-execute/e2e/frontend-002/login-flow/`） |
| 3 | 业务页面联调 | `frontend-003`~`frontend-006` 各自 E2E 通过并完成测试数据清理 |

## Progress Totals

Progress totals derived from the unique owner checkboxes are read-only roll-ups, never an independent completion authority.

| End | Total | Complete | Remaining |
| --- | ---: | ---: | ---: |
| Backend | 23 | 0 | 23 |
| Frontend | 6 | 0 | 6 |
