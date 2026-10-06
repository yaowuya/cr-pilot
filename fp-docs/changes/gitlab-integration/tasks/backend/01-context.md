# cr-pilot 对接 GitLab Backend Implementation Plan

> **For agentic workers:** REQUIRED FLOW: Use `fp-execute` to implement this plan task-by-task. Only task markers use checkbox (`- [ ] **Task backend-NNN: ...**`) syntax for tracking; substeps are plain ordered instructions.

**Goal:** 让 GitLab MR webhook 触发全自动评审：校验来源 → 立即 200 → 后台串行队列拉取变更 → 按仓库规则分批评审 → 二次汇总 → 评论回写 GitLab。端口默认 5001。

**Architecture:** webhook 校验与分派（`app.ts`）→ 内存串行队列（`queue.ts`）→ GitLab 客户端拉取与回写（`gitlab-client.ts`）→ 仓库规则匹配（`rules.ts`）→ 分批/逐批评审/汇总编排（`pipeline.ts`），复用现有 `reviewer.ts`（每请求一会话，恰好匹配「每批一会话」）。失败一律记日志、任务结束、不重投、不阻塞后续任务。

**Tech Stack:** Node.js 22.19（原生类型剥离）、TypeScript 5.9（仅类型检查）、Express 5、`yaml@^2`（新唯一运行时依赖）、Node 内置 `node:test` 与全局 `fetch`。

## Global Constraints

- 沿用 `review-webhook` 变更的全部硬约束：`.ts` 相对导入必须写扩展名；禁用 `enum`/`namespace`/构造器参数属性；`noTools: "all"`、`SessionManager.inMemory()`；不新增除 `yaml` 之外的运行时依赖。
- 端口默认值改为 5001；`HOST` 默认仍为 `127.0.0.1`。
- GitLab 契约固定：拉取 `GET /api/v4/projects/{project_id}/merge_requests/{iid}/changes?access_raw_diffs=true`（空变更重试最多 3 次、间隔 10 秒）、提交 `GET .../commits`、回写 `POST .../notes`，body `{"body": string}`；`GITLAB_URL` 不带尾部斜杠，拼接时由客户端规范化。
- webhook 契约固定：`X-Gitlab-Token` 匹配 `GITLAB_WEBHOOK_SECRET` 才处理；`object_kind=merge_request` 入队并立即 200，其余 400，secret 不匹配 401。原「请求体传 `code`」形态停止支持。
- 分批评审契约固定：`estimateTokens(text) = ceil(text.length / 4)`；单批预算 `REVIEW_BATCH_MAX_TOKENS`（默认 6000）的 85% 作为阈值；汇总只基于各批评审结果文本，不得拼接原始 diff 重发。
- 每批、每次汇总各建一个独立 pi 会话（复用 `createPiReviewer`）；批次间与汇总间零共享。
- 日志不记录代码正文、评审正文与任何 token；只记录长度、耗时、数量。
- 有意延后项（并发上限、任务持久化、评论幂等）不得提前实现，边界见 `design/backend.md#风险迁移发布回滚与监控`。
- Engineering quality: `${CLAUDE_PLUGIN_ROOT}/skills/_shared/engineering-quality.md`；中文注释与 TSDoc，公开导出对象必须有职责与契约说明，非显然约束在实现附近说明原因。

## File Structure

| Path | Action | Responsibility |
| --- | --- | --- |
| `package.json` | modify | 新增 `yaml` 依赖 |
| `src/config.ts` | modify | 端口默认 5001；新增 GitLab / 分批 / 规则配置 |
| `src/rules.ts` | create | 规则加载、仓库匹配、prompt 渲染 |
| `src/gitlab-client.ts` | create | GitLab API 客户端（changes/commits/notes） |
| `src/queue.ts` | create | 内存串行队列 |
| `src/pipeline.ts` | create | 分批 / 逐批评审 / 汇总编排 |
| `src/app.ts` | modify | webhook 校验与分派，移除旧评审逻辑 |
| `src/reviewer.ts` | 不变 | 单个 pi 会话评审，供 pipeline 复用 |
| `src/prompt.ts` | modify | 保留 Markdown 兜底读取；YAML 逻辑在 rules.ts |
| `src/server.ts` | modify | 装配队列、客户端、管线并监听 |
| `prompts/rules/default.yaml` | create | 全局默认规则 |
| `prompts/review.md` | 保留 | 无 YAML 规则时的兜底 system prompt |
| `test/config.test.ts` | modify | 新配置默认值与非法值 |
| `test/rules.test.ts` | create | 规则加载、匹配优先级、占位符渲染 |
| `test/gitlab-client.test.ts` | create | 三接口的 URL/头/重试（fake fetch） |
| `test/queue.test.ts` | create | 串行语义与顺序 |
| `test/pipeline.test.ts` | create | 分批预算、批序、汇总参数 |
| `test/app.test.ts` | modify | webhook 401/400/200 与入队 |
| `test/server.test.ts` | modify | 装配后的监听与启动 |
| `README.md` | modify | GitLab 对接配置与使用说明 |
