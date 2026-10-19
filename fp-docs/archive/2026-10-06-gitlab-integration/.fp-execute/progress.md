# Execution Progress

Plan files:
- `fp-docs/changes/gitlab-integration/tasks/backend/00-index.md`（split form canonical 入口）
- 按 manifest order：`01-context.md`、`05-interfaces.md`、`10-foundation-tasks.md`、`20-pipeline-tasks.md`、`30-delivery-tasks.md`、`90-coverage.md`

Base SHA: f657580

## Completed

- `backend-001`（owner: `10-foundation-tasks.md`）：commit `3600b73`；`node --test test/config.test.ts` → 6 passed；inline 自审通过
- `backend-002`（owner: `10-foundation-tasks.md`）：commit `db8f971`；`node --test test/rules.test.ts` → 5 passed
- `backend-003`（owner: `10-foundation-tasks.md`）：commit `88f11ad`；`node --test test/gitlab-client.test.ts` → 8 passed
- `backend-004`（owner: `20-pipeline-tasks.md`）：commit `f27e553`；`node --test test/queue.test.ts` → 3 passed
- `backend-005`（owner: `20-pipeline-tasks.md`）：commit `e06364c` + `2fdb613`（断言修正）；`node --test test/pipeline.test.ts` → 5 passed
- `backend-006`（owner: `20-pipeline-tasks.md`）：commit `9a49735`；`node --test test/pipeline.test.ts` → 9 passed
- `backend-007`（owner: `30-delivery-tasks.md`）：commit `a0bd6c9`；`node --test test/app.test.ts` → 6 passed
- `backend-008`（owner: `30-delivery-tasks.md`）：commit `a0bd6c9` + `85044ae`；`node --test test/server.test.ts` → 2 passed；README 重写完成

全量验证：`npm test` → 54 passed / 0 failed；`npm run typecheck` → 退出码 0。

## Blocked

- None

## 执行期对计划的修正（均已按当前代码验证后落地）

1. **batching 测试断言与实现阈值不一致（commit `2fdb613`）**：计划用例按「批数=3、每批字符<=900」断言，与实现的 token 阈值语义不符。改为「批数>3 且每批 token 不超阈值」，实现无缺陷。
2. **删除死代码（commit `a0bd6c9` 一并处理）**：`src/gitlab.ts` 与 `src/prompt.ts` 及其测试在本变更后无人调用（GitLab payload 不含 diff，上下文提取被 `app.ts` 内联解析取代；prompt 兜底读取改由 `server.ts` 直接 `readFile` + `rules.ts` 兜底参数承担）。按工程质量契约「不保留死代码」删除，与 design 核心对象清单一致。
3. **`createGitlabClient` 默认 `fetchFn` 缺失（commit `85044ae`）**：`options.fetchFn!` 非空断言在不注入时运行时崩溃。修正为 `?? fetch`，并用真实 e2e 验证默认路径。
4. **`insecureTls` dispatcher 不可用（commit `85044ae`）**：Node 22 的全局 fetch 拒绝第三方 undici `Agent` 实例（instanceof 失败，`UND_ERR_INVALID_ARG`）。单请求关闭 TLS 校验在 Node 侧不可行；改为进程级 `NODE_TLS_REJECT_UNAUTHORIZED` / `NODE_EXTRA_CA_CERTS` 语义，客户端只在未配置时给出告警。设计 `D-001` 的「dispatcher 关闭校验」路径据此修正，真实环境（`code.cwoa.net` 证书对 Node 可信）已验证不需要该开关。
5. **真实端到端验证**：用真实 GitLab 拉取 `auto-ops!5327`（17 文件 / 6 提交），管线分 3 批 → 逐批评审（82s / 101s / 78s）→ 汇总（32s，2256 字符）→ no-op 回写，总耗时 294 秒。回写评论实际未发送（脚本中替换为 no-op，不修改真实 MR）。

## 残余风险与人工跟进

- **真实回写评论未验证**：`postMergeRequestNote` 的 URL 与 body 已由 `test/gitlab-client.test.ts` 用 fake fetch 断言（URL、`PRIVATE-TOKEN` 头、`body` 字段），但未对真实 MR 发送过。建议用户在测试 MR 上推送一次 webhook 做最终确认。
- **评审耗时长**：单个 MR（17 文件）端到端约 294 秒。webhook 侧立即 200，GitLab 不超时；但若同一 MR 连续推送，串行队列会排队。该边界已在设计有意延后项记录。
- **CodeGraph `post-write-sync`**：项目原本没有 `.codegraph/`，按契约跳过，不隐式执行 `init`。
- 设计记录的三个有意延后项（并发上限、任务持久化、评论幂等）在代码中未引入任何提前实现。
