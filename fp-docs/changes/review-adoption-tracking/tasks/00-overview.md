# AI 评审建议采纳追踪 Task Plan Overview

## Canonical End Entrypoints

| End | Canonical entrypoint | Mode |
| --- | --- | --- |
| Backend | `tasks/plan-backend.md` | small |
| Frontend | `tasks/plan-frontend.md` | small |

## Cross-end Dependency Edges

| From task | To task | Shared contract / gate |
| --- | --- | --- |
| `backend-007` | `frontend-001` | `GET /api/reviews/adoption` 响应结构，由 `test/interfaces/http/adoption.test.ts` 验证 |

## Cross-end Execution Stages

| Stage | Ends / cross-end gate | Exit condition |
| ---: | --- | --- |
| 1 | Backend 全部任务 | `npm test` 与 `npm run typecheck` 通过 |
| 2 | Frontend 类型与数据接入 | `npm --prefix web run typecheck` 通过，接口契约与后端一致 |
| 3 | Frontend 展示与视觉核对 | `npm run build:frontend` 通过，Visual Checks 记录完成 |

## Progress Totals

| End | Total | Complete | Remaining |
| --- | ---: | ---: | ---: |
| Backend | 9 | 0 | 9 |
| Frontend | 2 | 0 | 2 |
