## Backend Interface Ledger

| Interface | Owner Task | Contract | Consumers | Verification |
| --- | --- | --- | --- | --- |
| `AppConfig` | `backend-001` | `{ port: number; host: string; promptPath: string; timeoutMs: number }` | `server.ts`、`app.ts` 测试 | `test/config.test.ts` |
| `loadConfig(env?)` | `backend-001` | `(env?: NodeJS.ProcessEnv) => AppConfig`；默认 `3000` / `127.0.0.1` / `prompts/review.md` / `120000`；非法数字抛 `Error` | `server.ts`、测试 | `test/config.test.ts` |
| `PromptFileError` | `backend-002` | `class PromptFileError extends Error`，`name` 为 `PromptFileError` | `app.ts` | `test/prompt.test.ts` |
| `loadReviewPrompt(path)` | `backend-002` | `(path: string) => Promise<string>`；返回去首尾空白全文；文件不可读或去空白后为空时抛 `PromptFileError` | `app.ts` | `test/prompt.test.ts` |
| `isGitlabPayload(body)` | `backend-003` | `(body: unknown) => boolean`；body 是对象且 `object_kind` 是非空字符串时为真 | `app.ts` | `test/gitlab.test.ts` |
| `extractGitlabContext(body)` | `backend-003` | `(body: unknown) => string \| null`；支持 `merge_request` 与 `push`，其他类型或缺失关键字段返回 `null` | `app.ts` | `test/gitlab.test.ts` |
| `PiSessionLike` | `backend-004` | `{ prompt(text: string): Promise<void>; getLastAssistantText(): string \| undefined; readonly model: { id: string } \| undefined; dispose(): void }` | `createPiReviewer`、测试 | `test/reviewer.test.ts` |
| `PiSessionFactory` | `backend-004` | `(options: { systemPrompt: string; cwd: string }) => Promise<PiSessionLike>` | `createPiReviewer`、测试 | `test/reviewer.test.ts` |
| `createIsolatedWorkspace()` | `backend-004` | `() => string`；返回新建空目录的绝对路径，每次调用互不相同 | `createPiReviewer` | `test/reviewer.test.ts` |
| `buildLoaderOptions(input)` | `backend-004` | `(input: { prompt: string; cwd: string; agentDir: string }) => DefaultResourceLoaderOptions`；`noContextFiles`、`noSkills`、`noPromptTemplates` 均为 `true`，`systemPromptOverride()` 返回 `prompt`，`appendSystemPromptOverride()` 返回 `[]` | `createPiReviewer` | `test/reviewer.test.ts` |
| `buildUserMessage(code, context?)` | `backend-005` | `(code: string, context?: string) => string`；有 context 时前置「背景信息」段，代码段恒存在 | `createPiReviewer` | `test/reviewer.test.ts` |
| `EmptyReviewError` | `backend-005` | `class EmptyReviewError extends Error`；pi 返回空文本时抛出 | `app.ts` | `test/app.test.ts` |
| `ReviewInput` / `ReviewResult` | `backend-005` | `{ systemPrompt: string; code: string; context?: string; signal: AbortSignal }` → `{ text: string; model: string }` | `app.ts` | `test/app.test.ts` |
| `Reviewer` | `backend-005` | `{ review(input: ReviewInput): Promise<ReviewResult> }` | `app.ts`、`server.ts`、测试 | `test/app.test.ts` |
| `createPiReviewer(options?)` | `backend-005` | `(options?: { sessionFactory?: PiSessionFactory }) => Reviewer`；构造时创建一次隔离工作目录并复用 | `server.ts`、测试 | `test/reviewer.test.ts` |
| `createApp(deps)` | `backend-006` | `(deps: { reviewer: Reviewer; promptPath: string; timeoutMs: number }) => Express` | `server.ts`、测试 | `test/app.test.ts` |
| `POST /review/webhook` | `backend-006` `backend-007` | 请求体 `{ code: string; context?: string; object_kind?: string }`；状态码见 Global Constraints | 外部调用方 | `test/app.test.ts` |
| `startServer(config, reviewer)` | `backend-008` | `(config: AppConfig, reviewer: Reviewer) => Promise<http.Server>`；监听成功后才 resolve | `server.ts` 直接执行入口、测试 | `test/server.test.ts` |

