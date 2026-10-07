# Pipeline Tasks

> **For agentic workers:** REQUIRED FLOW: Use `fp-execute` to implement this plan task-by-task. Only task markers use checkbox (`- [ ] **Task backend-NNN: ...**`) syntax for tracking; substeps are plain ordered instructions.

- [ ] **Task backend-009: 评审记录写入编排**

**Files:**
- Modify: `src/application/review-pipeline.ts:17-27`（PipelineDeps）、`src/application/review-pipeline.ts:42-181`（run）
- Test: `test/application/review-pipeline.test.ts`

**Reasoning:**
- proposal 变更点 6 要求每次评审落一条明细，失败也落。这是记录写入的唯一调用点。
- 独立边界：只加记录写入，不改评审与回写行为，既有测试应全部不受影响。

**Depends on**: backend-005

**Interfaces:**
- Consumes: `ReviewRecordRepository.insert(record)`、现有 `ParseRequest`/task 字段
- Produces: `PipelineDeps.recordWriter?: ReviewRecordWriter`（可选，缺省时行为与现在完全一致）
- Contract checks: 失败路径写入 `result="failed"` 且 `errorMessage` 非空；成功路径写入 `score` 与 `commentUrl`

**Step 1: Write the failing test**

```typescript
test("评审失败时仍写入失败记录", async () => {
  const inserted: ReviewRecord[] = [];
  const pipeline = createReviewPipeline({
    client: fakeClient(),
    rules: { resolve: () => ({ systemPrompt: "s", userPrompt: "u {diffs_text}" }) },
    reviewer: { review: async () => { throw new Error("boom"); } },
    logger: createSilentLogger(),
    batchMaxTokens: 6000,
    recordWriter: { insert: (r) => inserted.push(r) },
  });
  await pipeline.run(taskFixture());
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].result, "failed");
  assert.equal(inserted[0].errorMessage, "boom");
});

test("未注入 recordWriter 时管线行为不变", async () => {
  const pipeline = createReviewPipeline({
    client: fakeClient(),
    rules: { resolve: () => ({ systemPrompt: "s", userPrompt: "u {diffs_text}" }) },
    reviewer: { review: async () => ({ text: "总分：90 分", model: "m" }) },
    logger: createSilentLogger(),
    batchMaxTokens: 6000,
  });
  await assert.doesNotReject(() => pipeline.run(taskFixture()));
});
```

**Step 2: Run test to verify it fails**

Run: `node --test test/application/review-pipeline.test.ts`
Expected: FAIL with `recordWriter` 未被识别（`inserted.length` 为 0）

**Step 3: Write minimal implementation**

在 `PipelineDeps` 增加可选依赖，并把现有每个 `return` 分支改为「写记录后 return」：

```typescript
/** 评审记录写入端口。缺省时不写记录，便于既有调用方与测试保持原行为。 */
export interface ReviewRecordWriter {
  insert(record: ReviewRecord): void;
}
```

管线开始处捕获 `startedAt`，每个失败分支组装 `{ result: "failed", errorMessage, finishedAt: Date.now() }` 写入；成功路径在回写评论后写入 `{ result: "success", score, commentUrl, finishedAt }`。`score` 用现有 `parseReviewScore(finalComment)`，但**无匹配时写 `null` 而非 0**——`parseReviewScore` 返回 0 表示「未解析出分数」，与真实 0 分不同，直接写 0 会污染平均分（`design/backend.md#字段与存储取舍`）。

组装重复代码应提取为管线内的私有辅助函数 `writeRecord(outcome)`，避免每个分支重复构造字段。

**Step 4: Run test to verify it passes**

Run: `node --test test/application/review-pipeline.test.ts`
Expected: PASS（既有测试全部通过 + 2 个新测试）

自审：`score` 写 `null` 的判断依据需在代码注释中说明（`parseReviewScore` 返回 0 的两种含义），否则后续维护者会「修正」成直接写返回值。

**Step 5: Commit**

```bash
git add src/application/review-pipeline.ts test/application/review-pipeline.test.ts
git commit -m "feat: 评审管线写入明细记录，失败路径同样落库"
```

- [ ] **Task backend-010: 结构化解析接入与 prompt 改按需读库**

**Files:**
- Modify: `src/application/review-pipeline.ts`
- Test: `test/application/review-pipeline.test.ts`

**Reasoning:**
- `P-015` 确认 prompt 全部入库；`D-016` 确认保存即生效。评审必须改为每次从 `PromptRepository` 读取，否则页面改完 prompt 仍需重启。
- 与 `backend-009` 分开的理由：记录写入与 prompt 来源是两个独立行为变更，可分别 review 与回滚。

**Depends on:** backend-008, backend-009

**Interfaces:**
- Consumes: `PromptRepository.resolve(repositoryFullName?)`、现有 `RuleSet`
- Produces: `PipelineDeps.promptSource?: PromptRepository`（可选，缺省时走现有 yaml 解析结果）
- Contract checks: 数据库命中时不使用 yaml；数据库与 default 都未命中时回落现有 yaml 与 Markdown 兜底

**Step 1: Write the failing test**

```typescript
test("数据库命中 prompt 时不使用 yaml 规则", async () => {
  const used: string[] = [];
  const pipeline = createReviewPipeline({
    client: fakeClient(),
    rules: { resolve: () => ({ systemPrompt: "from-yaml", userPrompt: "u {diffs_text}" }) },
    promptSource: {
      resolve: () => ({ id: 1, repository: "g/p", systemPrompt: "from-db", userPrompt: "u {diffs_text}", updatedAt: 1 }),
    } as PromptRepository,
    reviewer: { review: async ({ systemPrompt }) => { used.push(systemPrompt); return { text: "总分：90 分", model: "m" }; } },
    logger: createSilentLogger(),
    batchMaxTokens: 6000,
  });
  await pipeline.run(taskFixture());
  assert.ok(used.every((p) => p.includes("from-db")), "数据库 prompt 必须优先于 yaml");
});

test("数据库未命中时回落 yaml", async () => {
  const used: string[] = [];
  const pipeline = createReviewPipeline({
    client: fakeClient(),
    rules: { resolve: () => ({ systemPrompt: "from-yaml", userPrompt: "u {diffs_text}" }) },
    promptSource: { resolve: () => undefined } as unknown as PromptRepository,
    reviewer: { review: async ({ systemPrompt }) => { used.push(systemPrompt); return { text: "总分：90 分", model: "m" }; } },
    logger: createSilentLogger(),
    batchMaxTokens: 6000,
  });
  await pipeline.run(taskFixture());
  assert.ok(used.some((p) => p.includes("from-yaml")));
});
```

**Step 2: Run test to verify it fails**

Run: `node --test test/application/review-pipeline.test.ts`
Expected: FAIL（`promptSource` 未被识别，`used` 中仍是 `from-yaml`）

**Step 3: Write minimal implementation**

管线中把 `const ruleSet: RuleSet = rules.resolve(task.fullName);` 改为：先查 `promptSource?.resolve(task.fullName)`，命中则映射为 `RuleSet`（`wecomWebhookUrl` / `wecomScoreThreshold` 直接透传），未命中才用现有 `rules.resolve`。

映射时需保留 `renderStyleTemplate` 已渲染的结果——数据库中的 prompt 是最终文本，不应再套用风格模板渲染（否则 `{{ style }}` 占位会残留）。

**Step 4: Run test to verify it passes**

Run: `node --test test/application/review-pipeline.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/application/review-pipeline.ts test/application/review-pipeline.test.ts
git commit -m "feat: 评审 prompt 改为按需读数据库，未命中回落 yaml"
```

- [ ] **Task backend-011: 行内评论发布编排与汇总去重**

**Files:**
- Modify: `src/application/review-pipeline.ts`
- Test: `test/application/review-pipeline.test.ts`

**Reasoning:**
- proposal 变更点 2、3 要求行内评论发布与汇总去重；`D-005` 要求幂等与发布后校验。这是本次最复杂的编排，也是评审对外行为的核心变化。
- 独立边界：只加发布步骤，既有回写行为保持不变。

**Depends on:** backend-001, backend-002, backend-010

**Interfaces:**
- Consumes: `parseReviewJson`、`buildPosition`、`buildMarker`、`parseDiffLines`、`GitlabClient.getMergeRequestVersions` / `postDiscussion` / `getDiscussions`、`getMergeRequestChanges`
- Produces: 管线内 `publishInlineComments` 步骤；汇总评论剔除已成功发行内评论的条目
- Contract checks: 行号不在 added/removed 集合的 finding 并入汇总；`reviewedHeadSha` 不一致时全部并入汇总；已含 marker 的 finding 不重复发布

**Step 1: Write the failing test**

```typescript
test("行号不在 diff 变更行上的 finding 并入汇总而非发行内评论", async () => {
  const posted: { body: string; position?: unknown }[] = [];
  let summaryBody = "";
  const client = {
    getMergeRequestChanges: async () => [{ newPath: "a.ts", oldPath: "a.ts", diff: "@@ -1,1 +1,2 @@\n ctx\n+added\n" }],
    getMergeRequestCommits: async () => [],
    getMergeRequestVersions: async () => ({ baseSha: "b", startSha: "s", headSha: "h" }),
    getDiscussions: async () => [],
    postDiscussion: async (_p: number, _i: number, body: string, position: unknown) => { posted.push({ body, position }); return { id: "d", notes: [] }; },
    postMergeRequestNote: async (_p: number, _i: number, body: string) => { summaryBody = body; },
  };
  // reviewer 返回 new_line: 999（不在 added 集合 {2} 内）
  const pipeline = buildPipelineWithReviewer({
    client,
    reviewJson: { reviewed_head_sha: "h", summary: { body: "总分：90 分" }, findings: [{ id: "f1", severity: "high", path: "a.ts", new_line: 999, body: "越界行号" }] },
  });
  await pipeline.run(taskFixture());
  assert.equal(posted.length, 0, "越界行号不得发行内评论");
  assert.ok(summaryBody.includes("越界行号"), "该 finding 必须出现在汇总评论中");
});

test("已含 marker 的 finding 不重复发布", async () => {
  const posted: string[] = [];
  const client = {
    getMergeRequestChanges: async () => [{ newPath: "a.ts", oldPath: "a.ts", diff: "@@ -1,0 +1,1 @@\n+added\n" }],
    getMergeRequestCommits: async () => [],
    getMergeRequestVersions: async () => ({ baseSha: "b", startSha: "s", headSha: "h" }),
    getDiscussions: async () => [{ id: "existing", notes: [{ id: 1, body: "内容\n\n<!-- marker:h:f1 -->" }] }],
    postDiscussion: async (_p: number, _i: number, body: string) => { posted.push(body); return { id: "d", notes: [] }; },
    postMergeRequestNote: async () => {},
  };
  const pipeline = buildPipelineWithReviewer({
    client,
    reviewJson: { reviewed_head_sha: "h", summary: { body: "总分：90 分" }, findings: [{ id: "f1", severity: "low", path: "a.ts", new_line: 1, body: "重复项" }] },
  });
  await pipeline.run(taskFixture());
  assert.equal(posted.length, 0, "已发布的 marker 不得重复发布");
});
```

**Step 2: Run test to verify it fails**

Run: `node --test test/application/review-pipeline.test.ts`
Expected: FAIL（当前无行内评论调用，`summaryBody` 不含该 finding）

**Step 3: Write minimal implementation**

在管线汇总之后、回写汇总评论之前插入发布步骤，逻辑顺序严格按 `design/backend.md#状态、并发与执行流程`：

1. `getMergeRequestVersions` 取三个 SHA；失败则全部 finding 并入汇总并继续。
2. 对每个变更文件跑 `parseDiffLines`，建立「路径 → DiffLineSets」映射（重命名文件同时以 oldPath 与 newPath 为键，与参考实现 `gitlab_mr_review.py:145-147` 一致）。
3. `parseReviewJson` 解析各批输出；解析失败的批次其 findings 整体并入汇总。
4. `reviewedHeadSha !== headSha` 时全部并入汇总（MR 在评审期间有新提交，行号已失效）。
5. 逐条校验：路径在变更集内，且 `lineKey === "new_line"` 时行号在 `added` 内、`old_line` 时在 `removed` 内。不通过则并入汇总。
6. `getDiscussions` 拉已有评论，检查正文是否含 `buildMarker(headSha, finding.id)`；含则跳过。
7. `postDiscussion` 发布，正文为 `finding.body + "\n\n" + marker`。
8. 发布后 `getDiscussions` 回读校验该 discussion 的 `position.lineKey === line` 且路径匹配；不一致记 warn，不重复发布。

汇总评论需剔除已成功发行内评论的 finding，避免同一问题出现两次。

**Step 4: Run test to verify it passes**

Run: `node --test test/application/review-pipeline.test.ts`
Expected: PASS

自审：发布步骤的每个降级分支都需注释说明「为什么不丢弃」——这是 `design/backend.md` 的核心约束，reviewer 应重点核对。

**Step 5: Commit**

```bash
git add src/application/review-pipeline.ts test/application/review-pipeline.test.ts
git commit -m "feat: 行内评论发布编排，含幂等 marker、行号校验与降级"
```

- [ ] **Task backend-012: 新增配置项**

**Files:**
- Modify: `src/shared/config.ts:24-31`（AppConfig）、`src/shared/config.ts:33-42`（默认常量）、`src/shared/config.ts:53-69`（loadConfig）
- Test: `test/shared/config.test.ts`

**Reasoning:**
- `D-011` 需要初始管理员环境变量；`D-010` 需要部署盐；持久化需要 DB 路径。这是装配的前置。

**Depends on**: backend-004

**Interfaces:**
- Consumes: 现有 `readPositiveInt`、`normalizeUrl`
- Produces: `AppConfig` 新增 `dbPath`、`adminUsername`、`adminPassword`、`authSalt`；`applyConfigOverrides(env, overrides): void`
- Contract checks: 默认值正确；环境变量覆盖生效；`applyConfigOverrides` 让 DB 值覆盖环境变量

**Step 1: Write the failing test**

```typescript
test("loadConfig 读取新增的数据库与管理员配置项", () => {
  const config = loadConfig({
    DB_PATH: "/data/cr-pilot.db",
    ADMIN_USERNAME: "root",
    ADMIN_PASSWORD: "pw",
    AUTH_SALT: "s",
  });
  assert.equal(config.dbPath, "/data/cr-pilot.db");
  assert.equal(config.adminUsername, "root");
  assert.equal(config.authSalt, "s");
});

test("applyConfigOverrides 让数据库值覆盖环境变量", () => {
  const env: NodeJS.ProcessEnv = { QUEUE_CONCURRENCY: "2" };
  applyConfigOverrides(env, { QUEUE_CONCURRENCY: "9" });
  assert.equal(env.QUEUE_CONCURRENCY, "9");
});
```

**Step 2: Run test to verify it fails**

Run: `node --test test/shared/config.test.ts`
Expected: FAIL with `dbPath` 不在返回对象上

**Step 3: Write minimal implementation**

```typescript
/** 数据库文件默认路径；容器内解析到 WORKDIR 下的 data 目录。 */
const DEFAULT_DB_PATH = "./data/cr-pilot.db";
```

在 `AppConfig` 增加四个字段并在 `loadConfig` 中读取：`dbPath`（`env.DB_PATH?.trim() || DEFAULT_DB_PATH`）、`adminUsername`、`adminPassword`、`authSalt`（后三者空串兜底）。

```typescript
/**
 * 把数据库中的配置覆盖写入环境变量（P-005「启动时 DB 优先」）。
 *
 * 调用顺序必须是「先应用覆盖再 loadConfig」，这样 loadConfig 读到的是最终值。
 * 空串覆盖视为清空：不写入环境变量，保留进程原有值。
 */
export function applyConfigOverrides(env: NodeJS.ProcessEnv, overrides: Record<string, string>): void {
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== "") env[key] = value;
  }
}
```

`authSalt` 为空时应在 `bootstrap` 记 warn——固定盐为空会让令牌可预测，与 `D-010` 的安全意图冲突。

**Step 4: Run test to verify it passes**

Run: `node --test test/shared/config.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/shared/config.ts test/shared/config.test.ts
git commit -m "feat: 新增数据库路径、初始管理员与部署盐配置项"
```
