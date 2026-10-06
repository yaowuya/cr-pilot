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

## 终审前发现并修复的缺陷

- **测试基础设施缺陷（`test/app.test.ts`）**：终审前跑 `npm test` 出现 1 次 `not ok 7 - pi 返回空文本返回 502`，报错为 `fetch failed`。诊断后确认根因：Fetch 规范定义了一组禁用端口，undici 依规范直接拒绝连接并报 `bad port`；`listen(0)` 会偶发分配到这些端口。抓到的失败端口为 `10080`、`5061`、`6566`、`6666`、`6667`、`6668`，全部在该禁用列表中。
  - 恢复率证据：原始测试文件 60 次中失败 1 次；带 fetch 拦截的诊断副本 200 次中失败 6 次。产品代码本身无缺陷。
  - 修复：`test/app.test.ts` 的测试服务器改用 `createServer` + 先挂事件再 `listen`，并在绑定后校验端口，命中禁用列表就重新绑定（最多 20 次）。
  - 修复后验证：`node --test test/app.test.ts` 连续 250 次 0 失败；`npm test` 连续 25 次 0 失败；`npm run typecheck` 退出码 0。
  - commit `b654145`。

## 真实环境验证（用户提供凭证与真实 MR 后）

用户提供 `D:\01-code\code-review-pilot\.env`（LLM 凭证 + GitLab token）并要求用真实 MR 验证，以下为实测结果。凭证值未写入本仓库任何文件：`~/.pi/agent/models.json` 以 `$LLMGW_API_KEY` 环境变量引用密钥。

**模型接入**：该 endpoint 是自定义 provider（`llmgw`，`https://llmgw.cwoa.net/v1`，API 类型 `openai-responses`，模型 `gpt-5.6-terra`）。按 pi 文档写入 `~/.pi/agent/models.json` 与 `settings.json`；`pi --list-models` 确认注册成功。

**真实 MR 评审（`design/backend.md#验证方案` 第 10 项）**：目标 MR 为 `rd-fy21-canway-GOAC/auto-ops!5327`，17 个文件、56,307 字符 diff。

- 请求：`POST /review/webhook`，请求体带 `code`（拼好的完整 diff）与 GitLab payload（`object_kind`、`object_attributes`、`project`）。
- 结果：`HTTP 200`，`model=gpt-5.6-terra`，`duration_ms=40904`，评审正文 894 字符。
- 评审质量抽查：识别出 `DynamicTopoService.get_all_scope_host_ids` 把 `biz|{bk_biz_id}` 当作授权节点、导致仅有部分拓扑权限的用户查询范围扩大到全业务主机的越权风险；并给出两条「无法判断的点」，未凭空断言。
- 说明：服务端未调用 GitLab API，diff 由调用方随请求体传入，符合 `D-004` 的已确认边界。

**隔离端到端核验（`design/backend.md#验证方案` 第 11 项）**：在仓库根与 `~/.pi/agent/` 同时放置带强制指令的 `AGENTS.md`（要求任何评审回复的第一行只能是「菠萝面包」），再发起一次评审。

- 结果：`HTTP 200`，`model=gpt-5.6-terra`，`duration_ms=11872`，输出中 **不含** 该标记，也未被该指令改变格式。
- 评审正文正确指出代码中的 SQL 拼接注入风险并要求改为参数化查询。
- 两个 `AGENTS.md` 已在 `finally` 中删除并确认不存在。
- 结论：`D-002` 的隔离目标在真实模型上成立——上下文文件、skills 与 prompt 模板均未进入评审上下文。

**其余状态码在真实进程上的复验**：`400`（缺 `code`）返回 `{"error":"请求体缺少非空的 code 字段"}`；`404` 返回 `{"error":"未找到该路径"}`。

**至此 `design/backend.md#验证方案` 的 11 项全部执行完毕**，其中 9 项由自动化用例覆盖，2 项由上述真实环境验证覆盖。

## 残余风险与人工跟进

- **原先的未验证项已闭环**：初次执行时本机没有 `~/.pi/agent/` 与模型凭证，设计 `验证方案` 中「手工冒烟返回 200 与评审文本」和「隔离核验的端到端评审结果」两项无法完成，当时已如实记录。用户随后提供凭证与真实 MR，两项均已在真实环境执行并通过，详见上一节。
- **真实凭证的落盘边界**：`~/.pi/agent/models.json` 只引用 `$LLMGW_API_KEY`，密钥本身未写入仓库或该配置文件；`auth.json` 仍为空对象。测试用的 GitLab token 仅在一次性的进程内使用，未落盘。
- **已完成的替代验证**：以真实 pi SDK 跑通请求链路，确认 pi 会话被真正构造、模型被选择，失败点是没有凭证并正确映射为 502；并用真实 SDK 验证隔离机制——项目根 `cwd` 能发现 `AGENTS.md`，隔离 `cwd` 发现为空，loader skills 与 prompt 模板均为 0。
- **CodeGraph `post-write-sync`**：项目原本没有 `.codegraph/`，按契约跳过，不隐式执行 `init`。
- 设计记录的三个有意延后项（并发上限、GitLab 只读 API 与异步评审、评审模型选择）在代码中未引入任何提前实现。
