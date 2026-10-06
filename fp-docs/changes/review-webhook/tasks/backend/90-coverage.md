## Coverage Matrix

| Source | Requirement / Boundary | Tasks | Verification |
| --- | --- | --- | --- |
| `proposal.md` | 新建 Node.js 22 + TypeScript 服务骨架 | `backend-001` | `npm run typecheck`；`node --test test/config.test.ts` |
| `proposal.md` | 新增 `POST /review/webhook` 并兼容 GitLab payload 与纯代码 | `backend-006` | `node --test test/app.test.ts` |
| `proposal.md` | 自定义 prompt 从单个 Markdown 文件读取，路径可用环境变量覆盖 | `backend-002`、`backend-001` | `node --test test/prompt.test.ts`；`node --test test/config.test.ts` |
| `proposal.md` | 进程内嵌入 pi SDK，每请求一个内存会话 | `backend-005` | `node --test test/reviewer.test.ts` |
| `proposal.md` | 接口不做鉴权，默认只绑本机 | `backend-001`、`backend-006`、`backend-008` | `node --test test/config.test.ts`（`HOST` 默认 `127.0.0.1`）；`node --test test/app.test.ts` |
| `proposal.md` | `README.md` 补充运行说明 | `backend-008` | 人工核对 README 与 `loadConfig` 一致 |
| `design/backend.md` | `D-001` Express 5 承担解析、404 与错误响应 | `backend-006`、`backend-007` | `node --test test/app.test.ts` |
| `design/backend.md` | `D-002` 隔离工作目录、关闭项目资源发现、`noTools: "all"`、内存会话 | `backend-004`、`backend-005` | `node --test test/reviewer.test.ts` |
| `design/backend.md` | `D-003` 200 / 400 / 500 / 502 / 504 与统一错误体 | `backend-006`、`backend-007` | `node --test test/app.test.ts` |
| `design/backend.md` | `D-004` GitLab payload 只贡献上下文，代码由请求体提供 | `backend-003`、`backend-006` | `node --test test/gitlab.test.ts`；`node --test test/app.test.ts` |
| `design/backend.md` | `D-005` node:test + 注入假实现，不调真实模型 | 全部任务 | `npm test` |
| `design/backend.md` | 超时的会话释放只执行一次 | `backend-005` | `node --test test/reviewer.test.ts`（含中断用例） |
| Backend boundary | service/business logic：评审编排与消息组装 | `backend-005` | `node --test test/reviewer.test.ts` |
| Backend boundary | request/response contracts 与 API handler | `backend-006`、`backend-007` | `node --test test/app.test.ts` |
| Backend boundary | URL/router 与进程入口注册 | `backend-008` | `node --test test/server.test.ts` |
| Backend boundary | 外部服务调用：pi SDK 适配 | `backend-004`、`backend-005` | `node --test test/reviewer.test.ts`；真实调用由 `design/backend.md#验证方案` 的手工冒烟覆盖 |
| Backend boundary | 单元测试、集成测试与导入验证 | 全部任务 | `npm test`；`npm run typecheck` |

不涉及的边界不设任务：无数据模型与迁移、无 serializer、无 IAM、无 provider/registry、无异步任务与定时任务。
