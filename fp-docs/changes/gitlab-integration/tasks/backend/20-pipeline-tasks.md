- [x] **Task backend-004: 内存串行队列**

**Files:**
- Create: `src/queue.ts`
- Test: `test/queue.test.ts`

**Reasoning:**
- `D-003` 确认全局串行。队列是「webhook 立即返回」与「后台处理」之间的边界，语义必须独立验证（顺序、串行、失败不阻塞）。

**Depends on:** `backend-001`

**Interfaces:**
- Consumes: `Logger`（可选）
- Produces: `TaskQueue`、`createTaskQueue`
- Contract checks: 两个任务串行执行、顺序保持；任务抛错不阻塞后续；`pending` 计数正确

**Step 1: Write the failing test**

```ts
// test/queue.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTaskQueue } from "../src/queue.ts";

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

test("任务按入队顺序串行执行", async () => {
  const queue = createTaskQueue();
  const order: number[] = [];
  const done1 = new Promise<void>((resolve) => {
    queue.push(async () => { order.push(1); await tick(); await tick(); order.push(2); resolve(); });
  });
  const done2 = new Promise<void>((resolve) => {
    queue.push(async () => { order.push(3); resolve(); });
  });
  await Promise.all([done1, done2]);
  assert.deepEqual(order, [1, 2, 3]);
});

test("任务抛错不阻塞后续任务", async () => {
  const queue = createTaskQueue();
  let secondRan = false;
  queue.push(async () => { throw new Error("boom"); });
  queue.push(async () => { secondRan = true; });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(secondRan, true);
});

test("pending 计数反映排队与完成", async () => {
  const queue = createTaskQueue();
  assert.equal(queue.pending, 0);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  queue.push(async () => { await gate; });
  await tick();
  assert.equal(queue.pending, 1);
  release();
  await tick();
  assert.equal(queue.pending, 0);
});
```

**Step 2: Run test to verify it fails**

Run: `node --test test/queue.test.ts`
Expected: FAIL —— `src/queue.ts` 不存在

**Step 3: Write minimal implementation**

`src/queue.ts`：内部维护 `tail: Promise<void>`，`push(task)` 时 `tail = tail.then(task).catch(err => logger?.error(...))`，保证串行与失败不阻塞。`pending` 为排队中未完成的任务数。TSDoc 说明「内存队列、重启丢任务」边界与失败语义。

**Step 4: Run test to verify it passes**

Run: `node --test test/queue.test.ts`
Expected: PASS（3 个用例）

自审：串行语义与失败隔离与 `D-003` 一致；注释写明有意延后项（无持久化、无重试）。

**Step 5: Commit**

```bash
git add src/queue.ts test/queue.test.ts
git commit -m "feat: in-memory serial task queue"
```

- [x] **Task backend-005: 分批拆分纯函数**

**Files:**
- Create: `src/pipeline.ts`（本任务先落地拆分部分）
- Test: `test/pipeline.test.ts`

**Reasoning:**
- 分批是 pipeline 的核心纯逻辑，先独立落地：token 估算与分箱策略是 `D-005` 的直接产物，必须不依赖 GitLab/模型可验证。

**Depends on:** `backend-003`（复用 `Change` 类型）

**Interfaces:**
- Consumes: `Change` 类型（backend-003）
- Produces: `estimateTokens`、`splitChangesIntoBatches`、`ChangeBatch`（内部 `Change[]`）
- Contract checks: 估算公式；小变更单批；大变更分多批且每批不超过阈值；单文件超预算按行拆；单行超预算按字符拆

**Step 1: Write the failing test**

```ts
// test/pipeline.test.ts（本任务部分）
import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateTokens, splitChangesIntoBatches } from "../src/pipeline.ts";

function change(diff: string, newPath = "a.ts"): { newPath: string; oldPath: string; diff: string } {
  return { newPath, oldPath: newPath, diff };
}

test("estimateTokens 按字符数/4 向上取整", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("abc"), 1);
  assert.equal(estimateTokens("abcdefgh"), 2);
});

test("小变更保持单批", () => {
  const batches = splitChangesIntoBatches([change("diff".repeat(10))], 6000, 100);
  assert.equal(batches.length, 1);
});

test("超过预算的多个变更拆成多批", () => {
  const big = "x".repeat(4000); // ≈1000 tokens
  const changes = [change(big, "a.ts"), change(big, "b.ts"), change(big, "c.ts")];
  const batches = splitChangesIntoBatches(changes, 1200, 100); // 预算 1200，85% 阈值 1020，开销 100
  assert.equal(batches.length, 3);
  for (const batch of batches) {
    assert.equal(batch.length, 1);
  }
});

test("单文件超预算时按 diff 行拆分", () => {
  const lines = Array.from({ length: 8 }, (_, i) => `+line-${i}-${"y".repeat(200)}`);
  const diff = lines.join("\n");
  const batches = splitChangesIntoBatches([change(diff, "big.ts")], 600, 100);
  assert.ok(batches.length > 1);
  // 每个 batch 的 diff 总字符数不超过阈值（保守断言）
  for (const batch of batches) {
    const total = batch.reduce((sum, c) => sum + c.diff.length, 0);
    assert.ok(total <= 900, `批过大：${total}`);
  }
});
```

**Step 2: Run test to verify it fails**

Run: `node --test test/pipeline.test.ts`
Expected: FAIL —— `src/pipeline.ts` 不存在

**Step 3: Write minimal implementation**

`src/pipeline.ts`（本任务部分）：`estimateTokens = ceil(length/4)`；`splitChangesIntoBatches(changes, maxTokens, promptOverheadTokens)`：阈值 `maxTokens * 0.85 - promptOverheadTokens`。贪心装箱：整文件塞不下时按 diff 行拆（保留文件头），单行仍超预算时按字符切。返回 `Change[][]`。TSDoc 写明「字符估算偏保守、批只会偏小」的依据。

**Step 4: Run test to verify it passes**

Run: `node --test test/pipeline.test.ts`
Expected: PASS（4 个用例）

自审：阈值 85% 与 `D-005` 一致；拆行/拆字符保留 `newPath` 上下文；无 token 日志。

**Step 5: Commit**

```bash
git add src/pipeline.ts test/pipeline.test.ts
git commit -m "feat: token-estimated diff batching for review pipeline"
```

- [x] **Task backend-006: 逐批评审与汇总编排**

**Files:**
- Modify: `src/pipeline.ts`
- Test: `test/pipeline.test.ts`

**Reasoning:**
- pipeline 主体：拉取 → 分批 → 逐批评审 → 汇总 → 回写。这是 `P-004`/`P-005` 的核心交付。测试用假 client 与假 reviewer，覆盖编排参数与顺序，不碰真实模型。

**Depends on:** `backend-004`、`backend-005`

**Interfaces:**
- Consumes: `GitlabClient`、`ReviewRules`、`Reviewer`、`estimateTokens`/`splitChangesIntoBatches`
- Produces: `ReviewPipeline`、`createReviewPipeline`、`MergeRequestTask`、`summarizeReviews`
- Contract checks: 拉取 changes 与 commits；逐批评审时 user_prompt 填充本批 diffsText；各批结果按序拼接交给汇总；汇总结果作为 note body 回写

**Step 1: Write the failing test**

```ts
// test/pipeline.test.ts（追加）
import { createReviewPipeline, type MergeRequestTask } from "../src/pipeline.ts";
import { createSilentLogger } from "../src/logger.ts";
import type { Reviewer } from "../src/reviewer.ts";
import type { GitlabClient } from "../src/gitlab-client.ts";
import type { ReviewRules } from "../src/rules.ts";

function fakeClient(overrides: Partial<GitlabClient> = {}): GitlabClient & { notes: string[] } {
  const notes: string[] = [];
  return {
    getMergeRequestChanges: async () => [{ newPath: "a.ts", oldPath: "a.ts", diff: "diff-a" }],
    getMergeRequestCommits: async () => [{ id: "c1", message: "feat: x" }],
    postMergeRequestNote: async (_p, _i, body) => { notes.push(body); },
    ...overrides,
    notes,
  };
}

const ruleSet = { systemPrompt: "SYS", userPrompt: "评：{diffs_text}" };
const rules = {
  resolve: () => ruleSet,
} as ReviewRules;

const task: MergeRequestTask = { projectId: 1, iid: 2, fullName: "team/app", sourceBranch: "dev", targetBranch: "main" };

test("pipeline 拉取、逐批评审、汇总并回写", async () => {
  const client = fakeClient();
  const prompts: string[] = [];
  const reviewer: Reviewer = {
    review: async ({ systemPrompt, code, context }) => {
      prompts.push(code);
      return { text: "批评论", model: "m" };
    },
  };
  const pipeline = createReviewPipeline({ client, rules, reviewer, logger: createSilentLogger(), batchMaxTokens: 6000 });
  await pipeline.run(task);
  // 1 批评审 + 1 次汇总 = 2 次 review 调用
  assert.equal(prompts.length, 2);
  assert.match(prompts[0], /diff-a/);
  assert.match(prompts[1], /批评论/); // 汇总输入含各批结果
  assert.equal(client.notes.length, 1);
  assert.match(client.notes[0], /批评论/);
});

test("拉取失败不抛异常、不回写", async () => {
  const client = fakeClient({ getMergeRequestChanges: async () => { throw new Error("boom"); } });
  const pipeline = createReviewPipeline({ client, rules, reviewer: { review: async () => ({ text: "x", model: "m" }) }, logger: createSilentLogger(), batchMaxTokens: 6000 });
  await assert.doesNotReject(() => pipeline.run(task));
  assert.equal(client.notes.length, 0);
});

test("单批评审失败不回写", async () => {
  const client = fakeClient();
  const pipeline = createReviewPipeline({ client, rules, reviewer: { review: async () => { throw new Error("boom"); } }, logger: createSilentLogger(), batchMaxTokens: 6000 });
  await assert.doesNotReject(() => pipeline.run(task));
  assert.equal(client.notes.length, 0);
});
```

**Step 2: Run test to verify it fails**

Run: `node --test test/pipeline.test.ts`
Expected: FAIL —— `createReviewPipeline` 等导出不存在

**Step 3: Write minimal implementation**

`src/pipeline.ts` 追加：`MergeRequestTask`；`createReviewPipeline({ client, rules, reviewer, logger, batchMaxTokens })` 返回 `{ run }`。`run` 流程：`getMergeRequestChanges` 与 `getMergeRequestCommits` → `rules.resolve(task.fullName)` → `splitChangesIntoBatches` → 逐批 `renderUserPrompt(userPrompt, { diffsText, commitsText })` + `reviewer.review({ systemPrompt, code: diffsText, context: 提交信息, signal })`（每批 `AbortSignal.timeout` 用配置的评审超时）→ `summarizeReviews`（各批文本按序拼接 + 汇总 prompt）→ `postMergeRequestNote(projectId, iid, 最终评论)`。每步失败 catch 记日志并 return（不抛出）。逐步日志：拉取完成、分批数量、每批耗时、汇总耗时、回写状态。TSDoc 写明失败语义与「汇总只基于批结果文本」。

**Step 4: Run test to verify it passes**

Run: `node --test test/pipeline.test.ts`
Expected: PASS（7 个用例）

自审：批序、汇总输入、回写 body 与 `P-004`/`P-005` 一致；日志不含正文与 token；失败不回写。

**Step 5: Commit**

```bash
git add src/pipeline.ts test/pipeline.test.ts
git commit -m "feat: batch review and summary pipeline with gitlab writeback"
```
