## Coverage Matrix

| Source | Requirement / Boundary | Tasks | Verification |
| --- | --- | --- | --- |
| `proposal.md` 变更点 1 | 端口默认 5001 | `backend-001` | `node --test test/config.test.ts` |
| `proposal.md` 变更点 2 | webhook 校验与分派、立即 200 | `backend-007` | `node --test test/app.test.ts` |
| `proposal.md` 变更点 3 | GitLab 客户端（changes/commits/notes + 重试） | `backend-003` | `node --test test/gitlab-client.test.ts` |
| `proposal.md` 变更点 4 | 内存串行队列 | `backend-004` | `node --test test/queue.test.ts` |
| `proposal.md` 变更点 5 | 仓库级 YAML 规则 + 兜底链 | `backend-002` | `node --test test/rules.test.ts` |
| `proposal.md` 变更点 6 | 分批 + 二次汇总 + 回写 | `backend-005`、`backend-006` | `node --test test/pipeline.test.ts` |
| `proposal.md` Out of Scope | 不处理 push、无行内评论、无持久化、无幂等 | `backend-007`（分派 400）、`backend-004`（无持久化） | `node --test test/app.test.ts`；`node --test test/queue.test.ts` |
| `design D-001` | 全局 fetch、TLS 开关 | `backend-003` | `node --test test/gitlab-client.test.ts` |
| `design D-002` | yaml 包、规则目录加载 | `backend-002` | `node --test test/rules.test.ts` |
| `design D-003` | 全局串行 | `backend-004` | `node --test test/queue.test.ts` |
| `design D-004` | 每批独立会话 | `backend-006` | `node --test test/pipeline.test.ts`（reviewer 调用次数断言） |
| `design D-005` | 字符/4 + 85% 阈值 | `backend-005` | `node --test test/pipeline.test.ts` |
| `design D-006` | 装配与文档 | `backend-008` | `node --test test/server.test.ts` |
| Backend boundary | 外部服务调用（GitLab API） | `backend-003`、`backend-006` | 两个测试文件 |
| Backend boundary | 单元与集成测试 | 全部 | `npm test`；`npm run typecheck` |
