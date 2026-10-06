# pi 驱动的代码评审 Webhook 服务 Backend Plan Index

本索引是后端任务计划的唯一 canonical 入口，只登记分片顺序与 ownership。任务正文、约束、接口账本与覆盖矩阵分别由下列分片唯一持有。

## Fragment Manifest

| Order | File | Kind | Owns |
| ---: | --- | --- | --- |
| 1 | `01-context.md` | context | Header、Goal、Architecture、Tech Stack、Global Constraints、File Structure |
| 2 | `05-interfaces.md` | interface | Backend Interface Ledger |
| 3 | `10-foundation-tasks.md` | tasks | `backend-001`–`backend-003` |
| 4 | `20-reviewer-tasks.md` | tasks | `backend-004`–`backend-005` |
| 5 | `30-http-tasks.md` | tasks | `backend-006`–`backend-008` |
| 6 | `90-coverage.md` | coverage | Coverage Matrix |

## Reading Order

按上表 Order 顺序读取即得到完整的 logical plan。本次变更只有后端一个端，因此没有 `tasks/00-overview.md`，也没有前端计划。
