# AI 评审建议采纳追踪 Backend Implementation Plan

> **For agentic workers:** REQUIRED FLOW: Use `fp-execute` to implement this plan task-by-task. Only task markers use checkbox (`- [ ] **Task backend-NNN: ...**`) syntax for tracking; substeps are plain ordered instructions.

**Goal:** 持久化每条评审建议并在其后的 MR 提交中追踪代码是否发生变化，按项目、提交人、严重级输出采纳率统计，同时单列不可统计部分。

**Architecture:** 建议明细独立落表（`review_findings`），通过 `record_id` 关联现有 `review_records`。评审管线发布行内评论成功后写入建议与被评论行的单行指纹；MR 产生新提交时由 webhook 识别并登记追踪；独立定时器扫描待追踪项，用指纹在新版本文件中重新定位目标行并读取讨论解决状态，写入四态判定；统计接口聚合后返回。

**Tech Stack:** Node >= 22.19、TypeScript ESM、Express 5、`node:sqlite` `DatabaseSync`（无 ORM）、Node 内置 test runner（`node --test`）。

## Global Constraints

- 运行环境 Node `>=22.19.0`，TypeScript strict，ESM 导入必须带 `.ts` 后缀（`src/**` 现有写法）。
- 分层依赖固定为 `interfaces → application → domain`，`infrastructure` 实现 `domain` 端口并由 `src/bootstrap.ts` 注入；`domain` 零 IO（`README.md:5-32`）。
- 数据库统一使用 `node:sqlite` 的 `DatabaseSync` 同步 API 与单连接模式；建表只用 `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`，启动幂等，不引入 ORM 或迁移框架（`src/infrastructure/sqlite/database.ts:10`）。
- 时间字段统一存 Unix 毫秒 `INTEGER`；`node:sqlite` 不接受 `undefined`，缺失值必须显式传 `null`（`src/infrastructure/sqlite/review-record-repo.ts:73`）。
- 错误响应体固定为 `{ error: string }` 并配对应 HTTP 状态码；`/api` 路由统一走 Bearer 鉴权，不新增权限分支（`src/interfaces/http/api/reviews.ts:83`）。
- 新增配置只沿用 `src/shared/config.ts:85` 的环境变量读取模式，不引入配置框架；新增键必须同步登记到 `MANAGEABLE_KEYS` 与 `RESTART_REQUIRED_KEYS`，否则页面无法管理与重启提示失真（`src/interfaces/http/api/config.ts:18`、`src/infrastructure/sqlite/config-repo.ts:30`）。
- 采纳判定只使用四态枚举 `pending | adopted | resolved-without-change | ignored | unknown`；`unknown` 不计入采纳率分母（`design/backend.md#决策 7`）。
- 追踪不得修改评审主流程的并发或超时，不得发送评论，不得阻塞 `startServer`（`design/backend.md#决策 12`）。
- 不新增第三方 npm 依赖。
- Engineering quality: `C:\Users\Lenovo\.dsh\skills\_shared\engineering-quality.md`；本项目 docstring 使用中文 JSDoc 风格解释职责与非显然约束（`src/application/review-pipeline.ts:470`、`src/infrastructure/sqlite/database.ts:107`）；最小可行方案为「单行指纹 + 独立表 + 进程内定时器」，延后项为无。

## File Structure

| Path | Action | Responsibility |
| --- | --- | --- |
| `src/domain/review-finding.ts` | create | 建议实体、四态枚举、指纹纯函数、仓储与聚合端口 |
| `src/infrastructure/sqlite/database.ts` | modify | 新增 `review_findings` 表与索引 |
| `src/infrastructure/sqlite/review-finding-repo.ts` | create | 建议读写与聚合的 SQLite 实现 |
| `src/domain/review-task.ts` | modify | `GitlabClient` 增加 `getFileRaw`、`getLatestRef`；`Discussion` 补解决状态 |
| `src/infrastructure/gitlab/gitlab-client.ts` | modify | 实现 `getFileRaw`、补齐 discussions 字段 |
| `src/application/review-pipeline.ts` | modify | 行内评论成功后写入建议记录与指纹 |
| `src/application/adoption-tracker.ts` | create | 追踪用例：重定位、判定、落库、聚合 |
| `src/interfaces/http/webhook-parser.ts` | modify | 解析 `action` 与 `oldrev`，识别有新提交的 update 事件 |
| `src/interfaces/http/app.ts` | modify | update 事件入追踪登记而非评审 |
| `src/interfaces/http/api/reviews.ts` | modify | 新增 `GET /adoption` |
| `src/shared/config.ts` | modify | 新增追踪开关与同步间隔配置 |
| `src/bootstrap.ts` | modify | 装配仓储、追踪器与定时器 |
| `scripts/build-openapi.ts` | modify | 补采纳统计接口到 OpenAPI |
| `docs/openapi.json` | modify | 重新生成为生成产物 |

## Backend Interface Ledger

| Interface | Owner Task | Contract | Consumers | Verification |
| --- | --- | --- | --- | --- |
| `fingerprintLine(line: string): string` | `backend-001` | 输入一行源码文本，输出去首尾空白、内部连续空白压缩为单空格后的 SHA-256 前 16 位十六进制；空串返回空串 | 评审管线、追踪用例 | `test/domain/review-finding.test.ts::指纹忽略空白差异` |
| `ReviewFinding` | `backend-001` | 建议实体，字段见 `design/backend.md#接近实现的模型代码` | 仓储、追踪用例、统计接口 | `test/domain/review-finding.test.ts` |
| `FindingOutcome` | `backend-001` | `"pending" \| "adopted" \| "resolved-without-change" \| "ignored" \| "unknown"` | 仓储、追踪用例、聚合 | `test/domain/review-finding.test.ts::四态枚举可穷举` |
| `ReviewFindingRepository` | `backend-002` | `insert(finding)`、`listByRecord(recordId)`、`listPendingTracking(limit)`、`listByMr(projectId, mrIid)`、`updateOutcome(id, outcome, trackedAt)`、`getAdoptionStats(query)` | 管线、追踪器、统计路由 | `test/infrastructure/sqlite/review-finding-repo.test.ts` |
| `createReviewFindingRepository(db)` | `backend-002` | 返回 `ReviewFindingRepository` | `src/bootstrap.ts` | 同上 |
| `GitlabClient.getFileRaw(projectId, iid, path, headSha, gitlabUrl?, gitlabToken?)` | `backend-003` | 返回指定 MR 在给定 head 下某文件的原始文本；文件不存在时抛错 | 追踪器 | `test/infrastructure/gitlab/gitlab-client-file.test.ts` |
| `GitlabClient.getLatestHeadSha(projectId, iid, gitlabUrl?, gitlabToken?)` | `backend-003` | 复用 versions 接口返回 `head_sha` | 追踪器 | 同上 |
| `Discussion.notes[].resolvable / resolved` | `backend-003` | 布尔，缺失时按 `false` 处理 | 追踪器 | `test/infrastructure/gitlab/gitlab-client-discussions.test.ts` |
| `PipelineDeps.findingWriter` | `backend-004` | 可选端口 `{ insert(finding): void }`；缺省时不写建议，保持既有调用方行为 | 组合根 | `test/application/review-pipeline.test.ts` |
| `MergeRequestTask.eventKind` | `backend-005` | `"review" \| "tracking"`，缺省 `"review"` | webhook 路由、队列 | `test/interfaces/http/webhook-parser.test.ts` |
| `AdoptionTracker.runOnce(): Promise<void>` | `backend-006` | 执行一轮追踪并落库；异常内部消化 | `src/bootstrap.ts` | `test/application/adoption-tracker.test.ts` |
| `createAdoptionTracker(deps)` | `backend-006` | 返回 `{ runOnce }` | `src/bootstrap.ts` | 同上 |
| `GET /api/reviews/adoption` | `backend-007` | 查询参数 `from?`/`to?`/`projectId?`；返回 `AdoptionStats` | 前端统计页 | `test/interfaces/http/adoption.test.ts` |
| `AppConfig.adoptionTrackingEnabled` | `backend-008` | 布尔，默认 `true`，读 `ADOPTION_TRACKING_ENABLED` | 组合根 | `test/shared/config.test.ts` |
| `AppConfig.adoptionSyncIntervalMs` | `backend-008` | 正整数，默认 `600000`，读 `ADOPTION_SYNC_INTERVAL_MS` | 组合根 | 同上 |

---

- [ ] **Task backend-001: 建议实体与单行指纹纯函数**

**Files:**
- Create: `src/domain/review-finding.ts`
- Test: `test/domain/review-finding.test.ts`

**Reasoning:**
- 指纹是整个追踪链路的地基，必须先独立可测，避免后续任务在不可靠的基础上搭建判定逻辑。
- 纯函数放在 `domain` 层符合项目零 IO 约束（`README.md:5-32`）。

**Depends on:** None

**Interfaces:**
- Consumes: 无
- Produces: `ReviewFinding`、`FindingOutcome`、`fingerprintLine`、`ReviewFindingRepository`、`AdoptionStats`
- Contract checks: 指纹对空白差异不敏感、对内容变化敏感；空串返回空串

**Step 1: Write the failing test**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { fingerprintLine } from "../../src/domain/review-finding.ts";

test("指纹忽略空白差异", () => {
  assert.equal(fingerprintLine("  const a = 1;  "), fingerprintLine("const   a = 1;"));
});

test("指纹对内容变化敏感", () => {
  assert.notEqual(fingerprintLine("const a = 1;"), fingerprintLine("const a = 2;"));
});

test("空行返回空串，不产生伪指纹", () => {
  assert.equal(fingerprintLine(""), "");
  assert.equal(fingerprintLine("   "), "");
});

test("指纹定长为 16 位十六进制", () => {
  assert.match(fingerprintLine("const a = 1;"), /^[0-9a-f]{16}$/);
});
```

**Step 2: Run test to verify it fails**

Run: `node --test test/domain/review-finding.test.ts`
Expected: FAIL，报错 `Cannot find module '../../src/domain/review-finding.ts'`

**Step 3: Write minimal implementation**

按 Global Constraints 同步编写中文 JSDoc，说明指纹为何取单行与规范化规则；不引入抽象基类。

```ts
import { createHash } from "node:crypto";

/** 采纳判定的四态；`unknown` 不计入采纳率分母。 */
export type FindingOutcome = "pending" | "adopted" | "resolved-without-change" | "ignored" | "unknown";

/**
 * 计算单行代码指纹。
 *
 * 归一化去首尾空白并把内部连续空白压成单空格：缩进调整和多余空格不是
 * 语义变化，不应被判定为「代码已改」。空行返回空串，调用方据此跳过追踪。
 */
export function fingerprintLine(line: string): string {
  const normalized = line.trim().replace(/\s+/g, " ");
  if (!normalized) return "";
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}
```

同时在同文件补齐 `ReviewFinding`、`ReviewFindingRepository`、`AdoptionStats` 类型（字段与契约按 `design/backend.md#接近实现的模型代码` 与 `#接口权限与兼容边界`）。

**Step 4: Run test to verify it passes**

Run: `node --test test/domain/review-finding.test.ts`
Expected: PASS（4 项）

自审：`fingerprintLine` 的 JSDoc 说明了规范化规则与空串语义，没有复述签名。

**Step 5: Commit**

```bash
git add src/domain/review-finding.ts test/domain/review-finding.test.ts
git commit -m "feat: 新增评审建议实体与单行指纹"
```

---

- [ ] **Task backend-002: review_findings 表与仓储实现**

**Files:**
- Modify: `src/infrastructure/sqlite/database.ts`
- Create: `src/infrastructure/sqlite/review-finding-repo.ts`
- Test: `test/infrastructure/sqlite/review-finding-repo.test.ts`

**Reasoning:**
- 表与仓储必须在业务逻辑之前就位，否则追踪器与统计接口没有数据来源。
- 唯一约束 `(head_sha, marker)` 保证重跑评审不重复计数，这是统计可信的前提。

**Depends on:** `backend-001`

**Interfaces:**
- Consumes: `ReviewFinding`、`ReviewFindingRepository`、`AdoptionStats`
- Produces: `createReviewFindingRepository(db: DatabaseSync): ReviewFindingRepository`
- Contract checks: 重复 marker 不产生两行；`listPendingTracking` 只返回未判定项；聚合分母排除 `unknown`

**Step 1: Write the failing test**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../../../src/infrastructure/sqlite/database.ts";
import { createReviewFindingRepository } from "../../../src/infrastructure/sqlite/review-finding-repo.ts";

function seed(db: ReturnType<typeof openDatabase>) {
  db.prepare(`INSERT INTO review_records (project_id, project_name, mr_iid, committer_name, change_count, batch_count, score, duration_ms, result, error_message, comment_url, mr_url, started_at, finished_at) VALUES (1,'g/p',7,'王秦',3,1,55,1000,'success',NULL,NULL,NULL,1,2)`).run();
}

test("同一版本同一 marker 只落一行", () => {
  const db = openDatabase(":memory:");
  seed(db);
  const repo = createReviewFindingRepository(db);
  const base = { recordId: 1, projectId: 1, mrIid: 7, marker: "<!-- marker:a:1 -->", findingId: "1", severity: "p1", path: "a.ts", line: 10, lineKey: "new_line" as const, baseSha: "b", headSha: "a", codeFingerprint: "f", discussionId: null, noteId: null, outcome: "pending" as const, trackedAt: null, createdAt: 1 };
  repo.insert(base);
  repo.insert({ ...base, findingId: "1" });
  assert.equal(repo.listByRecord(1).length, 1);
});

test("listPendingTracking 只返回待判定项", () => {
  const db = openDatabase(":memory:");
  seed(db);
  const repo = createReviewFindingRepository(db);
  repo.insert({ recordId: 1, projectId: 1, mrIid: 7, marker: "m1", findingId: "1", severity: "p1", path: "a.ts", line: 1, lineKey: "new_line", baseSha: "b", headSha: "a", codeFingerprint: "f", discussionId: null, noteId: null, outcome: "pending", trackedAt: null, createdAt: 1 });
  assert.equal(repo.listPendingTracking(10).length, 1);
  repo.updateOutcome(1, "adopted", 100);
  assert.equal(repo.listPendingTracking(10).length, 0);
});

test("聚合采纳率排除 unknown 与不可追踪项", () => {
  const db = openDatabase(":memory:");
  seed(db);
  const repo = createReviewFindingRepository(db);
  const row = { recordId: 1, projectId: 1, mrIid: 7, marker: "m", findingId: "1", severity: "p1", path: "a.ts", line: 1, lineKey: "new_line" as const, baseSha: "b", headSha: "a", codeFingerprint: "f", discussionId: null, noteId: null, createdAt: 1 };
  repo.insert({ ...row, marker: "m1", outcome: "adopted", trackedAt: 1, codeFingerprint: "f1" });
  repo.insert({ ...row, marker: "m2", outcome: "ignored", trackedAt: 1, codeFingerprint: "f2" });
  repo.insert({ ...row, marker: "m3", outcome: "unknown", trackedAt: 1, codeFingerprint: "f3" });
  repo.insert({ ...row, marker: "m4", outcome: "pending", trackedAt: null, codeFingerprint: "" });
  const stats = repo.getAdoptionStats({});
  assert.equal(stats.total.tracked, 2);
  assert.equal(stats.total.adopted, 1);
  assert.equal(stats.untrackable.fallback, 1);
  assert.equal(stats.untrackable.unknown, 1);
});
```

**Step 2: Run test to verify it fails**

Run: `node --test test/infrastructure/sqlite/review-finding-repo.test.ts`
Expected: FAIL，报错 `Cannot find module ...review-finding-repo.ts`

**Step 3: Write minimal implementation**

在 `database.ts` 的 `SCHEMA` 末尾追加表与索引；在仓储中实现六个方法。表结构按 `design/backend.md#索引约束与软删除`，聚合按 `#查询模式与索引映射`。

```ts
CREATE TABLE IF NOT EXISTS review_findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  record_id INTEGER NOT NULL,
  project_id INTEGER NOT NULL,
  mr_iid INTEGER NOT NULL,
  marker TEXT NOT NULL,
  finding_id TEXT NOT NULL,
  severity TEXT NOT NULL,
  path TEXT NOT NULL,
  line INTEGER NOT NULL,
  line_key TEXT NOT NULL,
  base_sha TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  code_fingerprint TEXT NOT NULL DEFAULT '',
  discussion_id TEXT,
  note_id INTEGER,
  outcome TEXT NOT NULL DEFAULT 'pending',
  tracked_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (head_sha, marker),
  FOREIGN KEY (record_id) REFERENCES review_records (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_findings_tracking ON review_findings (outcome, tracked_at);
CREATE INDEX IF NOT EXISTS idx_findings_record ON review_findings (record_id);
CREATE INDEX IF NOT EXISTS idx_findings_project ON review_findings (project_id, created_at DESC);
```

`getAdoptionStats` 的 `total.tracked` 只统计 `outcome IN ('adopted','ignored','resolved-without-change')`；`untrackable.fallback` 统计 `code_fingerprint = ''`，`untrackable.unknown` 统计 `outcome = 'unknown'`。分母为 0 时 `rate` 返回 `null`（不是 0）。

**Step 4: Run test to verify it passes**

Run: `node --test test/infrastructure/sqlite/review-finding-repo.test.ts`
Expected: PASS（3 项）

自审：仓储方法 JSDoc 说明互斥边界与取值约束；`node:sqlite` 的 `null` 处理已核对。

**Step 5: Commit**

```bash
git add src/infrastructure/sqlite/database.ts src/infrastructure/sqlite/review-finding-repo.ts test/infrastructure/sqlite/review-finding-repo.test.ts
git commit -m "feat: 新增 review_findings 表与仓储"
```

---

- [ ] **Task backend-003: GitLab 客户端补文件读取与讨论解决状态**

**Files:**
- Modify: `src/domain/review-task.ts`
- Modify: `src/infrastructure/gitlab/gitlab-client.ts`
- Test: `test/infrastructure/gitlab/gitlab-client-adoption.test.ts`

**Reasoning:**
- 追踪必须拿到目标文件在最新 head 下的原始内容，现有客户端只有 diff 与 discussions，无此能力。
- `resolved` 字段是 GitLab 已返回却被丢弃的数据（`gitlab-client.ts:209`），补齐成本极低。

**Depends on:** None

**Interfaces:**
- Consumes: 现有 `request` 辅助函数
- Produces: `GitlabClient.getFileRaw`、`GitlabClient.getLatestHeadSha`、`Discussion.notes[].resolvable`/`resolved`
- Contract checks: 文件不存在时抛错而非返回空串；讨论字段缺失时按 `false`

**Step 1: Write the failing test**

```ts
test("getFileRaw 用 ref 与路径请求 raw 文件", async () => {
  const calls: string[] = [];
  const client = createGitlabClient({ url: "https://g", timeoutMs: 1000, insecureTls: false, logger: createSilentLogger(), fetchImpl: async (url) => { calls.push(String(url)); return new Response("const a = 1;\n"); } });
  const text = await client.getFileRaw(1, 7, "src/a.ts", "abc123");
  assert.equal(text, "const a = 1;\n");
  assert.match(calls[0], /repository\/files\/src%2Fa\.ts\/raw\?ref=abc123/);
});

test("讨论映射保留解决状态，缺失按 false", async () => {
  const client = createGitlabClient({ url: "https://g", timeoutMs: 1000, insecureTls: false, logger: createSilentLogger(), fetchImpl: async () => new Response(JSON.stringify([{ id: "d1", notes: [{ id: 1, body: "x", resolvable: true, resolved: true }, { id: 2, body: "y" }] }])) });
  const discussions = await client.getDiscussions(1, 7);
  assert.equal(discussions[0].notes[0].resolved, true);
  assert.equal(discussions[0].notes[1].resolved, false);
});
```

**Step 2: Run test to verify it fails**

Run: `node --test test/infrastructure/gitlab/gitlab-client-adoption.test.ts`
Expected: FAIL，`getFileRaw is not a function`

**Step 3: Write minimal implementation**

在 `GitlabClient` 接口与实现中新增两个方法；`Discussion.notes` 补两个布尔字段。URL 需对路径做 `encodeURIComponent`，Query 用 `?ref=`。

```ts
/**
 * 读取指定 MR 在给定 head 下的某文件原始内容。
 *
 * 追踪判定需要「评审后这一行现在长什么样」，diff 无法还原完整上下文，
 * 因此必须取 raw 文件。文件在该版本不存在时抛出异常，由调用方记为 unknown。
 */
async getFileRaw(projectId, iid, path, headSha, gitlabUrl = "", gitlabToken = "") {
  return request<string>(gitlabUrl, gitlabToken, `/api/v4/projects/${projectId}/repository/files/${encodeURIComponent(path)}/raw?ref=${headSha}`, { raw: true });
}
```

**Step 4: Run test to verify it passes**

Run: `node --test test/infrastructure/gitlab/gitlab-client-adoption.test.ts`
Expected: PASS（2 项）

自审：新方法 JSDoc 说明为何需要 raw 而非 diff、失败语义。

**Step 5: Commit**

```bash
git add src/domain/review-task.ts src/infrastructure/gitlab/gitlab-client.ts test/infrastructure/gitlab/gitlab-client-adoption.test.ts
git commit -m "feat: GitLab 客户端支持 raw 文件与讨论解决状态"
```

---

- [ ] **Task backend-004: 评审管线写入建议与指纹**

**Files:**
- Modify: `src/application/review-pipeline.ts:690-735`
- Test: `test/application/review-pipeline.test.ts`

**Reasoning:**
- 建议记录必须在发布行内评论成功后写入，此时才拿到 discussion 与 note ID。
- 降级并入汇总的建议也要写一条（指纹为空），否则不可统计部分无法统计。

**Depends on:** `backend-001`、`backend-002`

**Interfaces:**
- Consumes: `ReviewFindingRepository.insert`、`fingerprintLine`
- Produces: `PipelineDeps.findingWriter?: { insert(finding: ReviewFinding): void }`
- Contract checks: 成功发布写一条带指纹；降级写一条指纹为空；未注入时不写且行为不变

**Step 1: Write the failing test**

```ts
test("行内评论发布成功后写入建议与指纹", async () => {
  const inserted: ReviewFinding[] = [];
  const pipeline = createReviewPipeline({ ...deps, findingWriter: { insert: (f) => inserted.push(f) } });
  await pipeline.run({ ...task, headShaAdvanced: true });
  assert.equal(inserted.length, 1);
  assert.match(inserted[0].codeFingerprint, /^[0-9a-f]{16}$/);
  assert.ok(inserted[0].discussionId);
});

test("降级进汇总的建议写入空指纹", async () => {
  const inserted: ReviewFinding[] = [];
  const pipeline = createReviewPipeline({ ...deps, findingWriter: { insert: (f) => inserted.push(f) } });
  await pipeline.run({ ...task, lineNotInDiff: true });
  assert.equal(inserted[0].codeFingerprint, "");
});
```

**Step 2: Run test to verify it fails**

Run: `node --test test/application/review-pipeline.test.ts`
Expected: FAIL，`inserted.length` 为 0

**Step 3: Write minimal implementation**

在 `postDiscussion` 成功后，用对应 `change` 的新文件内容取第 `finding.line` 行调用 `fingerprintLine`；写入 `ReviewFinding`。降级分支写 `codeFingerprint: ""`。`findingWriter` 未注入时整段跳过。

**Step 4: Run test to verify it passes**

Run: `node --test test/application/review-pipeline.test.ts`
Expected: PASS

自审：新增分支未改变既有发布与降级行为；注释说明为何降级项也要记录。

**Step 5: Commit**

```bash
git add src/application/review-pipeline.ts test/application/review-pipeline.test.ts
git commit -m "feat: 评审管线写入建议明细与代码指纹"
```

---

- [ ] **Task backend-005: webhook 识别新提交事件**

**Files:**
- Modify: `src/interfaces/http/webhook-parser.ts`
- Modify: `src/interfaces/http/app.ts:55-98`
- Test: `test/interfaces/http/webhook-parser.test.ts`

**Reasoning:**
- 追踪的触发点是 MR 新提交，现有实现只校验 `object_kind`，不区分 `action`。
- 必须与评审触发分离，否则每次推送都会重跑一次完整评审，浪费算力。

**Depends on:** None

**Interfaces:**
- Consumes: `payload.object_attributes.action`、`payload.object_attributes.oldrev`
- Produces: `MergeRequestTask.eventKind: "review" | "tracking"`
- Contract checks: `update` + 非空 `oldrev` 判为 tracking；其余维持 review

**Step 1: Write the failing test**

```ts
test("update 事件且 oldrev 非空时标记为追踪", () => {
  const task = parseMergeRequestTask({ object_kind: "merge_request", project_id: 1, project: { path_with_namespace: "g/p" }, object_attributes: { iid: 7, action: "update", oldrev: "abc", source_branch: "s", target_branch: "t" } });
  assert.equal(task?.eventKind, "tracking");
});

test("open 事件维持评审", () => {
  const task = parseMergeRequestTask({ object_kind: "merge_request", project_id: 1, project: { path_with_namespace: "g/p" }, object_attributes: { iid: 7, action: "open", source_branch: "s", target_branch: "t" } });
  assert.equal(task?.eventKind, "review");
});
```

**Step 2: Run test to verify it fails**

Run: `node --test test/interfaces/http/webhook-parser.test.ts`
Expected: FAIL，`eventKind` 为 `undefined`

**Step 3: Write minimal implementation**

解析器读 `action` 与 `oldrev`，`action === "update" && oldrev` 时 `eventKind = "tracking"`。`app.ts` 中按 `eventKind` 分流：tracking 走新的 `enqueueTracking` 依赖，review 走原 `enqueue`；`enqueueTracking` 缺省时退化为入评审队列。

**Step 4: Run test to verify it passes**

Run: `node --test test/interfaces/http/webhook-parser.test.ts`
Expected: PASS

自审：分流逻辑注释说明为何 update 不再触发完整评审。

**Step 5: Commit**

```bash
git add src/interfaces/http/webhook-parser.ts src/interfaces/http/app.ts test/interfaces/http/webhook-parser.test.ts
git commit -m "feat: webhook 区分新提交事件用于采纳追踪"
```

---

- [ ] **Task backend-006: 采纳追踪用例**

**Files:**
- Create: `src/application/adoption-tracker.ts`
- Test: `test/application/adoption-tracker.test.ts`

**Reasoning:**
- 追踪判定是本次功能的核心算法，必须独立成可测用例。
- 四态判定与失败降级都在这里收束，便于集中验证。

**Depends on:** `backend-001`、`backend-002`、`backend-003`

**Interfaces:**
- Consumes: `ReviewFindingRepository`、`GitlabClient.getFileRaw`/`getLatestHeadSha`/`getDiscussions`
- Produces: `createAdoptionTracker(deps): { runOnce(): Promise<void> }`
- Contract checks: 四态各自成立；异常保留原状态；`head_sha` 未变则跳过

**Step 1: Write the failing test**

```ts
test("目标行未变记 ignored", async () => {
  const tracker = createAdoptionTracker({ findings: repoWith({ line: 3, codeFingerprint: fingerprintLine("const a = 1;") }), client: { getFileRaw: async () => "x\nx\nconst a = 1;\n" } });
  await tracker.runOnce();
  assert.equal(repo.rows[0].outcome, "ignored");
});

test("目标行改变记 adopted", async () => { /* 文件返回 `const a = 2;` → adopted */ });
test("已 resolved 但代码未变记 resolved-without-change", async () => { /* discussions 返回 resolved:true → resolved-without-change */ });
test("文件缺失记 unknown", async () => { /* getFileRaw 抛错 → unknown */ });
```

**Step 2: Run test to verify it fails**

Run: `node --test test/application/adoption-tracker.test.ts`
Expected: FAIL，模块不存在

**Step 3: Write minimal implementation**

实现 `runOnce()`：取 `listPendingTracking` → 按 MR 分组 → `getLatestHeadSha` 比较 → `getDiscussions` 建 marker 映射 → 逐条 `getFileRaw`（同一 MR 同一文件只取一次）→ 在 `[line-3, line+3]` 找指纹 → 判定并 `updateOutcome`。整体包 try/catch，失败记 `warn` 并保留原状态。

**Step 4: Run test to verify it passes**

Run: `node --test test/application/adoption-tracker.test.ts`
Expected: PASS（4 项）

自审：判定函数 JSDoc 说明四态含义与窗口选择理由；失败路径不吞掉可观察信息。

**Step 5: Commit**

```bash
git add src/application/adoption-tracker.ts test/application/adoption-tracker.test.ts
git commit -m "feat: 新增评审建议采纳追踪用例"
```

---

- [ ] **Task backend-007: 采纳统计接口**

**Files:**
- Modify: `src/interfaces/http/api/reviews.ts:83`
- Test: `test/interfaces/http/adoption.test.ts`

**Reasoning:**
- 统计结果的唯一对外通道，前端依赖其结构。
- 复用现有路由组与鉴权，不新增权限分支。

**Depends on:** `backend-002`

**Interfaces:**
- Consumes: `ReviewFindingRepository.getAdoptionStats`
- Produces: `GET /api/reviews/adoption`
- Contract checks: 无数据时 `rate` 为 `null`；参数非法返回 400

**Step 1: Write the failing test**

```ts
test("无数据时采纳率为 null 而非 0", async () => {
  const res = await authed(token, base, "/api/reviews/adoption");
  const body = await res.json();
  assert.equal(body.total.rate, null);
  assert.equal(body.total.tracked, 0);
});

test("非法 from 参数返回 400", async () => {
  const res = await authed(token, base, "/api/reviews/adoption?from=abc");
  assert.equal(res.status, 400);
});
```

**Step 2: Run test to verify it fails**

Run: `node --test test/interfaces/http/adoption.test.ts`
Expected: FAIL，404

**Step 3: Write minimal implementation**

在 `createReviewsRouter` 中新增 `router.get("/adoption", ...)`，注意注册顺序必须在 `/:id` 之前（若存在）。解析 `from`/`to`/`projectId` 为可选整数，非法返回 400。

**Step 4: Run test to verify it passes**

Run: `node --test test/interfaces/http/adoption.test.ts`
Expected: PASS

自审：路由注释说明为何与 `/stats` 同级而非独立路由组。

**Step 5: Commit**

```bash
git add src/interfaces/http/api/reviews.ts test/interfaces/http/adoption.test.ts
git commit -m "feat: 新增采纳率统计接口"
```

---

- [ ] **Task backend-008: 配置项与组合根装配**

**Files:**
- Modify: `src/shared/config.ts`
- Modify: `src/interfaces/http/api/config.ts:18`
- Modify: `src/infrastructure/sqlite/config-repo.ts:30`
- Modify: `src/bootstrap.ts`
- Test: `test/shared/config.test.ts`

**Reasoning:**
- 追踪会产生额外 GitLab 调用，部署方需要能关闭。
- 装配必须在最后完成，依赖前面所有组件。

**Depends on:** `backend-002`、`backend-005`、`backend-006`、`backend-007`

**Interfaces:**
- Consumes: 全部前述组件
- Produces: `AppConfig.adoptionTrackingEnabled`、`AppConfig.adoptionSyncIntervalMs`；启动后定时器运行
- Contract checks: 默认开启、默认 600000；关闭时不启动定时器

**Step 1: Write the failing test**

```ts
test("追踪配置默认开启且间隔 10 分钟", () => {
  const config = loadConfig({} as NodeJS.ProcessEnv);
  assert.equal(config.adoptionTrackingEnabled, true);
  assert.equal(config.adoptionSyncIntervalMs, 600000);
});

test("显式关闭追踪", () => {
  assert.equal(loadConfig({ ADOPTION_TRACKING_ENABLED: "false" } as NodeJS.ProcessEnv).adoptionTrackingEnabled, false);
});
```

**Step 2: Run test to verify it fails**

Run: `node --test test/shared/config.test.ts`
Expected: FAIL，字段为 `undefined`

**Step 3: Write minimal implementation**

`config.ts` 新增两个字段与读取逻辑（复用 `readBooleanFlag` 与 `readPositiveInt`）；`config.ts` 的 `MANAGEABLE_KEYS` 与 `RESTART_REQUIRED_KEYS` 同步登记两个键；`bootstrap.ts` 创建仓储、追踪器，`adoptionTrackingEnabled` 为真时 `setInterval(...).unref()`。

**Step 4: Run test to verify it passes**

Run: `node --test test/shared/config.test.ts`
Expected: PASS

自审：定时器 `unref()` 保证不阻止进程退出；配置键登记完整，页面与重启提示一致。

**Step 5: Commit**

```bash
git add src/shared/config.ts src/interfaces/http/api/config.ts src/infrastructure/sqlite/config-repo.ts src/bootstrap.ts test/shared/config.test.ts
git commit -m "feat: 装配采纳追踪定时任务与配置"
```

---

- [ ] **Task backend-009: OpenAPI 与全量回归**

**Files:**
- Modify: `scripts/build-openapi.ts`
- Modify: `docs/openapi.json`
- Test: `test/interfaces/http/config-docs.test.ts`

**Reasoning:**
- 项目要求接口文档由脚本从代码生成并在库中维护，遗漏会让文档漂移。
- 最后统一跑全量回归，确认无破坏。

**Depends on:** `backend-007`

**Interfaces:**
- Consumes: `GET /api/reviews/adoption` 契约
- Produces: 更新后的 `docs/openapi.json`
- Contract checks: 新增 1 个 path、1 个 operation、1 个 schema

**Step 1: Write the failing test**

```ts
test("OpenAPI 包含采纳统计接口", () => {
  const spec = JSON.parse(readFileSync("docs/openapi.json", "utf8"));
  assert.ok(spec.paths["/api/reviews/adoption"]?.get);
});
```

**Step 2: Run test to verify it fails**

Run: `node --test test/interfaces/http/config-docs.test.ts`
Expected: FAIL，path 不存在

**Step 3: Write minimal implementation**

在 `build-openapi.ts` 的评审记录分区新增 `paths["/api/reviews/adoption"]`，补 `AdoptionStats` schema 与 tag 描述；运行 `npm run build:openapi` 重新生成产物。

**Step 4: Run test to verify it passes**

Run: `node --test test/interfaces/http/config-docs.test.ts && npm test && npm run typecheck`
Expected: 全部 PASS

自审：OpenAPI 描述与实现契约一致；生成产物已入库。

**Step 5: Commit**

```bash
git add scripts/build-openapi.ts docs/openapi.json test/interfaces/http/config-docs.test.ts
git commit -m "docs: 补充采纳统计接口 OpenAPI"
```

## Coverage Matrix

| Source | Requirement / Boundary | Tasks | Verification |
| --- | --- | --- | --- |
| proposal.md | 评审时持久化每条建议与代码指纹 | `backend-001`, `backend-002`, `backend-004` | `node --test test/application/review-pipeline.test.ts` |
| proposal.md | 补齐讨论解决状态 | `backend-003` | `node --test test/infrastructure/gitlab/gitlab-client-adoption.test.ts` |
| proposal.md | 评审后追踪代码是否变化 | `backend-006` | `node --test test/application/adoption-tracker.test.ts` |
| proposal.md | 采纳率统计与不可统计单列 | `backend-002`, `backend-007` | `node --test test/interfaces/http/adoption.test.ts` |
| design/backend.md | 行内容指纹判定（D-001、D-003） | `backend-001`, `backend-006` | `node --test test/domain/review-finding.test.ts` |
| design/backend.md | 独立建议表与索引（D-002） | `backend-002` | `node --test test/infrastructure/sqlite/review-finding-repo.test.ts` |
| design/backend.md | webhook 分流（D-004） | `backend-005` | `node --test test/interfaces/http/webhook-parser.test.ts` |
| design/backend.md | 定时调度复用进程内能力（D-005、D-012） | `backend-008` | `npm test` |
| design/backend.md | GitLab 能力补齐（D-006） | `backend-003` | `node --test test/infrastructure/gitlab/gitlab-client-adoption.test.ts` |
| design/backend.md | 四态与分母口径（D-007） | `backend-006`, `backend-002` | `node --test test/application/adoption-tracker.test.ts` |
| design/backend.md | 统计接口（D-008） | `backend-007` | `node --test test/interfaces/http/adoption.test.ts` |
| design/backend.md | 配置项（D-011） | `backend-008` | `node --test test/shared/config.test.ts` |
| Backend boundary | 数据模型与迁移 | `backend-002` | `node --test test/infrastructure/sqlite/database.test.ts` |
| Backend boundary | 外部服务调用与失败降级 | `backend-003`, `backend-006` | `node --test test/application/adoption-tracker.test.ts` |
| Backend boundary | 定时任务 | `backend-008` | `npm test` |
| Backend boundary | 接口文档同步 | `backend-009` | `npm run build:openapi` |
