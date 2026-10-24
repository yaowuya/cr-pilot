# 仓库上下文评审 Task Plan Overview

## Canonical End Entrypoints

| End | Canonical entrypoint | Mode |
| --- | --- | --- |
| Backend | [tasks/plan-backend.md](<fp-docs/changes/repository-context-review/tasks/plan-backend.md>) | small |
| Frontend | [tasks/plan-frontend.md](<fp-docs/changes/repository-context-review/tasks/plan-frontend.md>) | small |

## Cross-end Dependency Edges

| From task | To task | Shared contract / gate |
| --- | --- | --- |
| backend-003 | frontend-001 | Prompt CRUD/meta 配置字段与保值契约 |
| backend-010 | frontend-002 | 完整后端运行能力，可用于真实 UI 配置验证 |

## Cross-end Execution Stages

| Stage | Ends / cross-end gate | Exit condition |
| ---: | --- | --- |
| 1 | 后端配置与外部能力 | 端内测试通过，各唯一 owner 更新 |
| 2 | 前端状态与页面 | API 契约就绪，类型/构建及实际验证证据形成 |
| 3 | 完整验证与最终评审 | 区分已通过项与未覆盖的严格视觉/E2E 门禁，不虚构通过或归档就绪 |

## Progress Totals

| End | Total | Complete | Remaining |
| --- | ---: | ---: | ---: |
| Backend | 10 | 10 | 0 |
| Frontend | 2 | 1 | 1 |
