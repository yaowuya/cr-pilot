# cr-pilot 对接 GitLab：webhook 触发、仓库级 prompt、分批评审与评论回写

本文定义 cr-pilot 的第二个能力：让 GitLab MR 自动触发代码评审，服务自行拉取变更、按仓库自定义 prompt 分批评审、汇总成一份评论并回写 GitLab。

## Why

- cr-pilot 目前只能「手动 POST 代码拿评审」。团队真正的入口是 GitLab MR，每次都要人工取 diff、手工回贴评审，链路不可用。
- 参考项目 AI-CodeReview 已验证了这条链路的四个关键机制：webhook 按 `object_kind` 分派、调用 GitLab API 拉取变更、按仓库加载自定义 prompt、按 token 分批评审。
- 但参考项目有缺口：没有「最后汇总」环节，分批评审的结果直接拼接回写；评论格式是硬编码的 `Auto Review Result:` 前缀。cr-pilot 已经具备 pi 适配层与逐步日志，可以在其上补齐「分批 + 汇总」与正式评论格式，而不是照搬参考实现。
- 现在做的理由是真实 MR 已可拉取（`auto-ops!5327` 实测通过），端到端闭环只差 webhook 触发与回写两步。

## What Changes

### 1. 默认端口改为 5001

`src/config.ts` 的默认 `PORT` 从 3000 改为 5001，与参考项目对齐。

### 2. `POST /review/webhook` 改为 GitLab webhook 入口

- 校验请求头 `X-Gitlab-Token` 与配置 `GITLAB_WEBHOOK_SECRET`，不匹配返回 401。
- 按 `object_kind` 分派：`merge_request` 进入后台处理并立即返回 200；其余事件类型返回 400。
- 原「请求体直接传代码」的同步评审形态停止支持，由本形态替代。接口不再是「传入代码」，而是「GitLab 事件入口」。

### 3. 新增 GitLab 客户端

新增 `src/gitlab-client.ts`，用 `GITLAB_URL` 与 `GITLAB_TOKEN` 调用 GitLab API。

- `GET /api/v4/projects/{project_id}/merge_requests/{iid}/changes?access_raw_diffs=true` 拉取变更；变更暂未生成时按参考项目做法重试，最多 3 次、间隔 10 秒。
- `GET /api/v4/projects/{project_id}/merge_requests/{iid}/commits` 拉取提交信息。
- `POST /api/v4/projects/{project_id}/merge_requests/{iid}/notes` 回写评审评论，body 为 `{"body": "<汇总评论>"}`。

### 4. 新增后台处理队列

新增 `src/queue.ts`：webhook 立即返回 200 后，把「拉 diff → 分批评审 → 汇总 → 回写」放进内存队列顺序执行。

队列不持久化，进程重启丢任务；处理失败时记录日志，不做重投。该简化与上限在 Out of Scope 中记录。

### 5. 新增仓库级 prompt 配置

- `prompts/rules/default.yaml` 为全局默认规则；目录下其余 YAML 每个仓库一份，含 `repository:` 字段（GitLab 项目全名，如 `rd-fy21-canway-GOAC/auto-ops`）。
- 规则结构对齐参考项目：`code_review_prompt.system_prompt` + `code_review_prompt.user_prompt`，`user_prompt` 支持 `{diffs_text}` 与 `{commits_text}` 占位符。
- 匹配优先级：仓库规则 > `default.yaml` > 现有 `prompts/review.md` 全文（作为 system prompt 的最后兜底）。
- 新增 `src/rules.ts` 负责加载目录与按 `path_with_namespace` 匹配。需要引入一个 YAML 解析依赖（`yaml`），这是本变更新增的唯一第三方运行时依赖。

### 6. 新增分批与汇总评审管线

新增 `src/pipeline.ts`，串起「分批 → 逐批评审 → 汇总 → 回写」。

- 拆分：按 `REVIEW_BATCH_MAX_TOKENS`（默认 6000）把变更文本分批；单个文件超预算时按 diff 行拆分，单行超预算时按字符拆分。token 估算沿用参考项目思路，用长度估算而非引入 tokenizer。
- 逐批评审：每批构造 `system_prompt`（仓库规则）与 `user_prompt`（`{diffs_text}` 填充本批内容、`{commits_text}` 填充提交信息），复用现有 pi 适配层，每批一个内存会话。
- 汇总：各批评审结果按批序拼接后，交给 pi 做一次汇总，去重、分级并给出总体结论，输出最终 Markdown 评论。汇总也使用仓库级 `system_prompt`。
- 全链路逐步日志：队列接收、拉取变更、分批数量、每批耗时、汇总耗时、回写结果。

## Capabilities

### New Capabilities

- `gitlab-webhook-review`: GitLab MR 事件触发全自动评审，无需人工取 diff。
- `per-repository-prompt`: 每个 GitLab 项目可配置独立的评审 prompt。
- `batched-review-with-summary`: 大变更自动分批评审并汇总为一份评论。
- `gitlab-comment-publish`: 评审完成后把评论发布到 MR。

### Modified Capabilities

- `code-review-webhook`: 由「传入代码同步返回评审」改为「GitLab 事件入口，后台处理并回写评论」。

## Out of Scope

- 不处理 `push` 事件，只处理 `merge_request`。
- 不把评论发到具体代码行（inline note），只发 MR 级普通评论。
- 不引入持久化队列或数据库；后台任务在内存中，进程重启丢任务。
- 不支持多 GitLab 实例，也不按项目配 token；`GITLAB_URL` 与 `GITLAB_TOKEN` 全局唯一。
- 不做评论幂等：同一 MR 的同一事件被 GitLab 重试或多次触发时会发多条评论。
- 不再支持「请求体直接传代码」的同步评审形态；该形态由 GitLab webhook 形态替代。

## Impact

- `src/config.ts` - 修改：默认端口改为 5001；新增 `GITLAB_URL`、`GITLAB_TOKEN`、`GITLAB_WEBHOOK_SECRET`、`REVIEW_BATCH_MAX_TOKENS`、`GITLAB_API_TIMEOUT` 等配置。
- `src/app.ts` - 修改：`POST /review/webhook` 改为 webhook 校验与事件分派，评审逻辑移出路由。
- `src/reviewer.ts` - 修改：适配层保持单个会话评审，供分批与汇总复用。
- `src/prompt.ts` - 修改：支持从 YAML 规则目录读取并渲染 `{diffs_text}` / `{commits_text}` 占位符。
- `src/server.ts` - 修改：装配后台队列与 GitLab 客户端，`createPiReviewer` 传入管线。
- `src/gitlab-client.ts` - 新增：GitLab API 客户端（拉变更、拉提交、回写评论）。
- `src/queue.ts` - 新增：内存顺序队列，后台执行任务。
- `src/rules.ts` - 新增：仓库规则加载、匹配与 prompt 渲染。
- `src/pipeline.ts` - 新增：分批、逐批评审、汇总编排。
- `package.json` - 修改：新增依赖 `yaml`。
- `prompts/rules/default.yaml` - 新增：全局默认规则。
- `prompts/review.md` - 保留：作为无 YAML 规则时的兜底 system prompt。
- `test/*` - 修改：覆盖新增模块与改造后的接口。
- `README.md` - 修改：重写对接 GitLab 的配置与使用说明。

### Handoff Decision Ledger

| ID | Decision | Source | Blocking | Status | Evidence / explicit confirmation |
| --- | --- | --- | --- | --- | --- |
| P-001 | 默认端口改为 5001 | user answer | yes | `user-confirmed` | `P-001: selected 「项目端口改成5001」; user message 用户需求原文「项目端口改成5001」` |
| P-002 | 对接 GitLab：webhook 触发、服务端拉 diff、评论回写 | user answer | yes | `user-confirmed` | `P-002: selected 「对接gitlab」「review完成之后，将评论发到gitlab中」; user message 用户需求原文` |
| P-003 | 仓库级 prompt 用 YAML 规则目录，对齐参考项目 | user answer | yes | `user-confirmed` | `P-003: selected 「YAML 规则目录（对齐参考项目）」; user message 本次会话 P-003 确认中用户明确选择该选项` |
| P-004 | 分批评审 + 二次汇总成一份评论 | user answer | yes | `user-confirmed` | `P-004: selected 「分批评审 + 二次汇总成一份评论（推荐）」; user message 本次会话 P-004 确认中用户明确选择该选项` |
| P-005 | 立即 200 + 后台处理 + 汇总后发一条 MR 评论 | user answer | yes | `user-confirmed` | `P-005: selected 「立即 200 + 后台处理 + 汇总后发一条 MR 评论（推荐）」; user message 本次会话 P-005 确认中用户明确选择该选项` |
| P-006 | 单 GitLab 实例 + 多项目，webhook 用 secret 校验来源 | user answer | yes | `user-confirmed` | `P-006: selected 「单 GitLab 实例 + 多项目（推荐）」; user message 本次会话 P-006 确认中用户明确选择该选项` |

### Pre-write Confirmation Evidence

- Covered IDs: `P-001`, `P-002`, `P-003`, `P-004`, `P-005`, `P-006`
- Outstanding blocking decisions: `none`
- Explicit user authorization to write: 用户选择「确认并按 P-001〜P-006 写入（不保留旧接口）」，授权按本文件展示的 Why / What Changes / Capabilities / Out of Scope / Impact 与 `P-001`〜`P-006` 写入 `fp-docs/changes/gitlab-integration/proposal.md`，纯代码接口不保留。
