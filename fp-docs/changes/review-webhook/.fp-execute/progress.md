# Execution Progress

Plan files:
- `fp-docs/changes/review-webhook/tasks/backend/00-index.md`（split form canonical 入口）
- 按 manifest order：`01-context.md`、`05-interfaces.md`、`10-foundation-tasks.md`、`20-reviewer-tasks.md`、`30-http-tasks.md`、`90-coverage.md`

Base SHA: 4f2cc66fad70a3b0ec5758b1d656d2982d208934

## Completed

- `backend-001`（owner: `tasks/backend/10-foundation-tasks.md`）：commit `6065f6a`；`node --test test/config.test.ts` → 3 passed；inline 自审通过
- `backend-002`（owner: `tasks/backend/10-foundation-tasks.md`）：commit `89c8f49`；`node --test test/prompt.test.ts` → 3 passed
- `backend-003`（owner: `tasks/backend/10-foundation-tasks.md`）：commit `bc89c47`；`node --test test/gitlab.test.ts` → 4 passed
- `backend-004`（owner: `tasks/backend/20-reviewer-tasks.md`）：commit `46769e1`；`node --test test/reviewer.test.ts` → 2 passed
- `backend-005`（owner: `tasks/backend/20-reviewer-tasks.md`）：commit `2dca9d7`；`node --test test/reviewer.test.ts` → 6 passed；`npx tsc --noEmit` 退出码 0
- `backend-006`（owner: `tasks/backend/30-http-tasks.md`）：commit `2ae45b4`；`node --test test/app.test.ts` → 4 passed
- `backend-007`（owner: `tasks/backend/30-http-tasks.md`）：commit `22b59a6`；`node --test test/app.test.ts` → 9 passed
- `backend-008`（owner: `tasks/backend/30-http-tasks.md`）：commit `c46ada0`；`node --test test/server.test.ts` → 2 passed

全量验证：`npm test` → 27 passed / 0 failed；`npm run typecheck` → 退出码 0。

## Blocked

- None

## 执行期对计划的修正（均已按当前代码验证后落地）

1. **`noTools` 取值**：安装后读取 `dist/core/sdk.d.ts`，`noTools` 的类型是 `"all" | "builtin"` 而不是布尔值。设计 `D-002` 与计划 `Global Constraints` 已同步修正为 `"all"`。
2. **评审模型配置**：`CreateAgentSessionOptions.model` 的类型是 `Model<any>` 而不是字符串，`PI_MODEL` 环境变量无法直接落地。按工程质量契约的最简方案删除了该配置项，模型改由 pi 自身设置决定；已作为有意延后项写入设计。
3. **loader 选项类型**：`DefaultResourceLoaderOptions` 未从 SDK 包根导出，改为 `ConstructorParameters<typeof DefaultResourceLoader>[0]` 派生，避免维护会失配的本地副本。
4. **测试命令**：`node --test test/` 在 Node v22.19.0 上报 `Cannot find module ...\test`，改用 `node --test`（默认发现，27 个用例全部命中）。
5. **中断语义**：计划中 `backend-005` 的「信号已中断」用例断言释放次数为 1，与其自身实现（在创建会话前就抛出）矛盾。按最小正确行为改为不创建会话、释放次数为 0，用例名同步改为「不创建会话直接失败」。
6. **空评审文本边界**：`Reviewer` 是对外可替换契约，路由在边界上再校验一次空结果并返回 502，不只依赖适配层抛 `EmptyReviewError`。
7. **启动失败判定**：实测发现 Express 5 `app.listen(port, host, cb)` 的回调**不对应 `listening` 事件**——端口占用时它先于 `error` 触发，导致启动失败被当成成功（`address()` 为 null）。改为显式 `createServer` 并在 `listen()` 之前挂 `error` / `listening`。这是本次执行发现的真实缺陷。
8. **`package-lock.json`**：计划 File Structure 未列出，它是 `npm install` 对已声明依赖的生成物，按通行做法提交，未新增任何未声明依赖。

## 残余风险与人工跟进

- **未验证项（缺前置条件）**：本机不存在 `~/.pi/agent/`，也没有任何模型 API Key 环境变量，因此设计 `验证方案` 中「手工冒烟返回 200 与评审文本」和「隔离核验的端到端评审结果」两项无法完成。已按契约如实报告，不以测试通过替代。
- **已完成的替代验证**：以真实 pi SDK 跑通请求链路，确认 pi 会话被真正构造、模型被选择，失败点是没有凭证并正确映射为 502；并用真实 SDK 验证隔离机制——项目根 `cwd` 能发现 `AGENTS.md`，隔离 `cwd` 发现为空，loader skills 与 prompt 模板均为 0。
- **CodeGraph `post-write-sync`**：项目原本没有 `.codegraph/`，按契约跳过，不隐式执行 `init`。
- 设计记录的三个有意延后项（并发上限、GitLab 只读 API 与异步评审、评审模型选择）在代码中未引入任何提前实现。
