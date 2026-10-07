# Domain Foundation Tasks

> **For agentic workers:** REQUIRED FLOW: Use `fp-execute` to implement this plan task-by-task. Only task markers use checkbox (`- [ ] **Task backend-NNN: ...**`) syntax for tracking; substeps are plain ordered instructions.

- [ ] **Task backend-001: diff 行号解析纯函数**

**Files:**
- Create: `src/domain/inline-comment.ts`
- Test: `test/domain/inline-comment.test.ts`

**Reasoning:**
- `D-004` 要求校验 finding 行号是否落在 diff 变更行上，这是发布行内评论的前置条件；参考实现 `gitlab_mr_review.py:93-125` 已验证算法。
- 独立边界：纯函数、零 IO，可完全单测，不需要数据库或 HTTP。

**Depends on**: None

**Interfaces:**
- Consumes: 无
- Produces: `parseDiffLines(diff: string): DiffLineSets`，`DiffLineSets = {added: Set<number>, removed: Set<number>, visibleNew: Set<number>, visibleOld: Set<number>}`
- Contract checks: 多 hunk 时行号不重置；`+++`/`---` 头不计入任何集合

**Step 1: Write the failing test**

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDiffLines } from "../../src/domain/inline-comment.ts";

test("parseDiffLines 区分新增行与删除行", () => {
  const diff = [
    "--- a/app.ts",
    "+++ b/app.ts",
    "@@ -1,3 +1,4 @@",
    " const a = 1;",
    "-const b = 2;",
    "+const b = 3;",
    "+const c = 4;",
    " const d = 5;",
  ].join("\n");
  const sets = parseDiffLines(diff);
  assert.deepEqual([...sets.added].sort((a, b) => a - b), [2, 3]);
  assert.deepEqual([...sets.removed].sort((a, b) => a - b), [2]);
  assert.deepEqual([...sets.visibleNew].sort((a, b) => a - b), [1, 2, 3, 4]);
  assert.deepEqual([...sets.visibleOld].sort((a, b) => a - b), [1, 3, 4]);
});

test("parseDiffLines 多 hunk 行号连续递增", () => {
  const diff = ["@@ -1,1 +1,1 @@", "+a", "@@ -10,1 +20,1 @@", "+b"].join("\n");
  const sets = parseDiffLines(diff);
  assert.deepEqual([...sets.added].sort((a, b) => a - b), [1, 20]);
});

test("parseDiffLines 无 hunk 头时返回空集合", () => {
  const sets = parseDiffLines("--- a/x\n+++ b/x\n+only header");
  assert.equal(sets.added.size, 0);
});
```

**Step 2: Run test to verify it fails**

Run: `node --test test/domain/inline-comment.test.ts`
Expected: FAIL with `Cannot find module '../../src/domain/inline-comment.ts'`

**Step 3: Write minimal implementation**

```typescript
/** 单个变更文件的合法锚点行号集合。added/removed 用于校验 finding，visible* 用于诊断。 */
export interface DiffLineSets {
  added: Set<number>;
  removed: Set<number>;
  visibleNew: Set<number>;
  visibleOld: Set<number>;
}

/**
 * 解析 unified diff，算出各 hunk 的合法锚点行号（零 IO 纯函数）。
 *
 * 只有落在 added 或 removed 的行才能作为 GitLab 行内评论的锚点：GitLab 会拒绝
 * 指向未变更行的 position。逐行跟踪 `@@` 的 old/new 起始计数，遇到 `+`/`-` 归入
 * 对应集合并递增该侧计数，context 行同时计入 visible 两侧。
 * `+++`/`---` 文件头必须排除，否则会被误判为变更行。
 */
export function parseDiffLines(diff: string): DiffLineSets {
  const added = new Set<number>();
  const removed = new Set<number>();
  const visibleNew = new Set<number>();
  const visibleOld = new Set<number>();
  let oldLine: number | undefined;
  let newLine: number | undefined;
  for (const raw of diff.split("\n")) {
    const hunk = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      continue;
    }
    if (oldLine === undefined || newLine === undefined) continue;
    if (raw.startsWith("+++") || raw.startsWith("---")) continue;
    if (raw.startsWith("+")) {
      added.add(newLine);
      visibleNew.add(newLine);
      newLine += 1;
    } else if (raw.startsWith("-")) {
      removed.add(oldLine);
      visibleOld.add(oldLine);
      oldLine += 1;
    } else {
      visibleOld.add(oldLine);
      visibleNew.add(newLine);
      oldLine += 1;
      newLine += 1;
    }
  }
  return { added, removed, visibleNew, visibleOld };
}
```

**Step 4: Run test to verify it passes**

Run: `node --test test/domain/inline-comment.test.ts`
Expected: PASS（3 tests）

自审：docstring 解释了「为什么只有 added/removed 可作锚点」这一非显然约束；`+++`/`---` 排除逻辑需在代码注释中说明原因（文件头以 `+`/`-` 开头，会被误判为变更行）。

**Step 5: Commit**

```bash
git add src/domain/inline-comment.ts test/domain/inline-comment.test.ts
git commit -m "feat: 新增 diff 行号解析纯函数，支撑行内评论锚点校验"
```

- [ ] **Task backend-002: AI 输出 JSON 解析、marker 与 position 构造**

**Files:**
- Modify: `src/domain/inline-comment.ts`
- Test: `test/domain/inline-comment.test.ts`

**Reasoning:**
- `D-006` 要求按参考 schema 解析 AI 输出的 JSON；`D-005` 要求 marker 幂等；`D-004` 要求 position 构造。三者都是纯函数且互不依赖外部调用，可在一个任务内完成并单测。

**Depends on:** backend-001

**Interfaces:**
- Consumes: 无
- Produces: `parseReviewJson(text): ParsedReview | null`、`buildMarker(headSha, itemId): string`、`buildPosition(input): DiscussionPosition`，以及类型 `ParsedFinding`、`ParsedReview`、`DiscussionPosition`
- Contract checks: `new_line` 与 `old_line` 必须互斥；`reviewedHeadSha` 必须是 40 位 hex

**Step 1: Write the failing test**

```typescript
import { buildMarker, buildPosition, parseReviewJson } from "../../src/domain/inline-comment.ts";

test("parseReviewJson 解析 findings 并强制 new_line/old_line 互斥", () => {
  const ok = parseReviewJson(JSON.stringify({
    reviewed_head_sha: "a".repeat(40),
    summary: { body: "总分：85 分" },
    findings: [{ id: "f1", severity: "high", path: "app.ts", new_line: 2, body: "空指针" }],
  }));
  assert.equal(ok?.findings[0].lineKey, "new_line");
  assert.equal(ok?.findings[0].line, 2);
  assert.equal(
    parseReviewJson(JSON.stringify({
      reviewed_head_sha: "a".repeat(40),
      summary: { body: "x" },
      findings: [{ id: "f1", severity: "low", path: "a.ts", new_line: 1, old_line: 1, body: "b" }],
    })),
    null,
    "同时给出 new_line 与 old_line 必须判为非法",
  );
});

test("parseReviewJson 缺 summary 或 sha 非法时返回 null", () => {
  assert.equal(parseReviewJson("not json"), null);
  assert.equal(parseReviewJson(JSON.stringify({ reviewed_head_sha: "short", summary: { body: "x" }, findings: [] })), null);
});

test("buildMarker 与 buildPosition 产出 marker 注释与完整 position", () => {
  assert.equal(buildMarker("abc", "f1"), "<!-- marker:abc:f1 -->");
  const position = buildPosition({
    refs: { baseSha: "b", startSha: "s", headSha: "h" },
    oldPath: "a.ts",
    newPath: "b.ts",
    lineKey: "new_line",
    line: 12,
  });
  assert.deepEqual(position, {
    position_type: "text",
    base_sha: "b",
    start_sha: "s",
    head_sha: "h",
    old_path: "a.ts",
    new_path: "b.ts",
    new_line: 12,
  });
});
```

**Step 2: Run test to verify it fails**

Run: `node --test test/domain/inline-comment.test.ts`
Expected: FAIL with `does not provide an export named 'parseReviewJson'`

**Step 3: Write minimal implementation**

```typescript
/** 单条 finding 的定位信息。lineKey 决定发 new_line 还是 old_line。 */
export interface ParsedFinding {
  id: string;
  severity: string;
  path: string;
  body: string;
  lineKey: "new_line" | "old_line";
  line: number;
}

/** AI 输出的结构化评审结果。 */
export interface ParsedReview {
  reviewedHeadSha: string;
  summaryBody: string;
  findings: ParsedFinding[];
}

/** GitLab Discussions API 的 position 对象：new_line 与 old_line 互斥。 */
export type DiscussionPosition = {
  position_type: "text";
  base_sha: string;
  start_sha: string;
  head_sha: string;
  old_path: string;
  new_path: string;
} & ({ new_line: number } | { old_line: number });

/**
 * 解析 AI 输出的 JSON 评审结果（零 IO 纯函数）。
 *
 * schema 对齐参考实现 `references/review.schema.json`：reviewed_head_sha 必须是
 * 40 位 hex；findings 中 new_line 与 old_line 必须恰好出现一个——GitLab 的
 * position 只接受其中一个，同时给出说明模型无法确定锚点在哪一侧，此时判为非法
 * 而非猜一个。任一校验失败返回 null，由调用方把该批次整体降级进汇总评论，
 * 而不是丢弃内容。
 */
export function parseReviewJson(text: string): ParsedReview | null {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return null;
  }
  // 逐项校验：reviewed_head_sha 正则、summary.body 非空、findings 数组。
  // 每个 finding 要求 id/severity/path/body 非空，且 new_line/old_line 恰好一个。
  // 校验逻辑按上述规则逐条返回，失败一律 return null（不抛错，便于调用方降级）。
  /* 完整实现见执行 */
}

/**
 * 生成幂等 marker：以 head_sha 为前缀。
 *
 * MR 产生新提交后 head 变化，marker 随之变化，历史评论不会被误判为已发布，
 * 与参考实现 `gitlab_mr_review.py:269-270` 语义一致。
 */
export function buildMarker(headSha: string, itemId: string): string {
  return `<!-- marker:${headSha}:${itemId} -->`;
}

/** 构造 GitLab 行内评论的 position 对象；lineKey 决定用 new_line 还是 old_line。 */
export function buildPosition(input: {
  refs: { baseSha: string; startSha: string; headSha: string };
  oldPath: string;
  newPath: string;
  lineKey: "new_line" | "old_line";
  line: number;
}): DiscussionPosition {
  const base = {
    position_type: "text" as const,
    base_sha: input.refs.baseSha,
    start_sha: input.refs.startSha,
    head_sha: input.refs.headSha,
    old_path: input.oldPath,
    new_path: input.newPath,
  };
  return input.lineKey === "new_line" ? { ...base, new_line: input.line } : { ...base, old_line: input.line };
}
```

**Step 4: Run test to verify it passes**

Run: `node --test test/domain/inline-comment.test.ts`
Expected: PASS（6 tests）

自审：`parseReviewJson` 的每个校验分支必须有注释说明拒绝原因（如「同时给两个行号说明模型无法确定锚点侧」），否则后续维护者无法判断该分支能否放宽。

**Step 5: Commit**

```bash
git add src/domain/inline-comment.ts test/domain/inline-comment.test.ts
git commit -m "feat: 新增评审 JSON 解析、幂等 marker 与行内评论 position 构造"
```
