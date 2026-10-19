## Backend Interface Ledger

| Interface | Owner Task | Contract | Consumers | Verification |
| --- | --- | --- | --- | --- |
| `AppConfig` | `backend-001` | 新增 `gitlabUrl: string; gitlabToken: string; gitlabWebhookSecret: string; gitlabInsecureTls: boolean; gitlabApiTimeoutMs: number; batchMaxTokens: number; rulesDir: string;`；`port` 默认 5001 | `server.ts`、`pipeline.ts`、`gitlab-client.ts`、`rules.ts` | `test/config.test.ts` |
| `loadConfig(env?)` | `backend-001` | 原有签名不变，新增上述字段；缺失必填项时抛错（启动快速失败） | `server.ts`、测试 | `test/config.test.ts` |
| `RuleSet` | `backend-002` | `{ systemPrompt: string; userPrompt: string }` | `pipeline.ts` | `test/rules.test.ts` |
| `ReviewRules` | `backend-002` | `{ load(dir: string): Promise<ReviewRules>; resolve(fullName?: string): RuleSet }`；匹配优先级：仓库规则 > default.yaml > md 兜底 | `pipeline.ts` | `test/rules.test.ts` |
| `renderUserPrompt(template, vars)` | `backend-002` | `(template: string, vars: { diffsText: string; commitsText: string }) => string`；替换 `{diffs_text}` / `{commits_text}` | `pipeline.ts` | `test/rules.test.ts` |
| `GitlabClient` | `backend-003` | `{ getMergeRequestChanges(projectId, iid): Promise<Change[]>; getMergeRequestCommits(projectId, iid): Promise<Commit[]>; postMergeRequestNote(projectId, iid, body): Promise<void> }`；`Change = { newPath: string; oldPath: string; diff: string }`，`Commit = { id: string; message: string }` | `pipeline.ts` | `test/gitlab-client.test.ts` |
| `createGitlabClient(options)` | `backend-003` | `(options: { url: string; token: string; timeoutMs: number; insecureTls: boolean; logger: Logger; fetchFn?: typeof fetch }) => GitlabClient`；changes 空结果重试 3 次间隔 10 秒；非 2xx 抛 `GitlabApiError`（含 status） | `pipeline.ts`、`server.ts` | `test/gitlab-client.test.ts` |
| `GitlabApiError` | `backend-003` | `class GitlabApiError extends Error { status: number }` | `pipeline.ts` | `test/gitlab-client.test.ts` |
| `TaskQueue` | `backend-004` | `{ push(task: () => Promise<void>): void; readonly pending: number }`；全局串行，任务失败不阻塞后续 | `app.ts` | `test/queue.test.ts` |
| `createTaskQueue(logger?)` | `backend-004` | `(logger?: Logger) => TaskQueue` | `server.ts` | `test/queue.test.ts` |
| `estimateTokens(text)` | `backend-005` | `(text: string) => number`；`Math.ceil(text.length / 4)` | `pipeline.ts` | `test/pipeline.test.ts` |
| `splitChangesIntoBatches(changes, maxTokens, promptOverhead)` | `backend-005` | `(changes: Change[], maxTokens: number, promptOverheadTokens: number) => Change[][]`；按 85% 阈值分箱；单文件超预算按 diff 行拆；单行超预算按字符拆 | `pipeline.ts` | `test/pipeline.test.ts` |
| `ReviewPipeline` | `backend-006` | `{ run(task: MergeRequestTask): Promise<void> }`；`MergeRequestTask = { projectId: number; iid: number; fullName: string; sourceBranch: string; targetBranch: string }` | `queue.ts`（经由 server 装配） | `test/pipeline.test.ts` |
| `createReviewPipeline(deps)` | `backend-006` | `(deps: { client: GitlabClient; rules: ReviewRules; reviewer: Reviewer; logger: Logger; batchMaxTokens: number }) => ReviewPipeline` | `server.ts` | `test/pipeline.test.ts` |
| `summarizeReviews(reviewer, ruleSet, batchResults)` | `backend-006` | 各批评审文本按序拼接后交给一次独立会话汇总，返回最终评论文本 | `pipeline.ts` 内部 | `test/pipeline.test.ts` |
| `createApp(deps)` | `backend-007` | `AppDeps` 改为 `{ queue: TaskQueue; webhookSecret: string; logger: Logger }`；`POST /review/webhook` 只做校验与分派 | `server.ts`、测试 | `test/app.test.ts` |
| `POST /review/webhook` | `backend-007` | 请求头 `X-Gitlab-Token`；401 / 400 / 200 契约见 Global Constraints | GitLab | `test/app.test.ts` |
| `startServer(config, deps)` | `backend-008` | `(config: AppConfig, deps: { app deps..., queue, client, pipeline }, logger) => Promise<Server>`；装配并监听 | 直接执行入口、测试 | `test/server.test.ts` |
