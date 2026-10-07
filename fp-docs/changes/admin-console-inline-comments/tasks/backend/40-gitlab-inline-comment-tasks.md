# GitLab Inline Comment Tasks

> **For agentic workers:** REQUIRED FLOW: Use `fp-execute` to implement this plan task-by-task. Only task markers use checkbox (`- [ ] **Task backend-NNN: ...**`) syntax for tracking; substeps are plain ordered instructions.

- [ ] **Task backend-013: prompt 仓储与记录仓储的端口边界复核**

**Files:**
- Modify: `src/domain/review-record.ts`（补 `ReviewRecordWriter` 别名）
- Test: 无新增测试，复用既有仓储与管线测试

**Reasoning:**
- 管线只依赖「写入一条记录」这一窄能力，而仓储对外暴露 `insert`。两者方法名一致时不需要别名；仅当管线需要在测试中注入更窄接口时才补 `ReviewRecordWriter`。
- 本任务是一次边界确认，不是新功能：若 `backend-009` 已用结构化类型直接注入 `ReviewRecordRepository`，则本任务为空操作，应在执行时确认后跳过而非硬造类型。

**Depends on**: backend-009

**Interfaces:**
- Consumes: `ReviewRecordRepository`
- Produces: 无（确认既有边界足够）
- Contract checks: 管线的依赖类型宽度不超过它实际使用的方法集合

**Step 1: Write the failing test**

不适用——本任务不引入行为。执行时改为静态核对：读取 `src/application/review-pipeline.ts` 中 `recordWriter` 的声明类型，确认其只含 `insert`。

**Step 2: Run test to verify it fails**

不适用。改为运行 `node --test test/application/review-pipeline.test.ts`，确认注入 fake writer 的测试通过。

**Step 3: Write minimal implementation**

若 `backend-009` 已把 `recordWriter` 声明为 `{ insert(record: ReviewRecord): void }` 的内联结构类型，则本任务不改代码，只在执行记录中注明「边界已足够」。

若声明为完整 `ReviewRecordRepository`，改为内联结构类型（只含 `insert`），理由：管线不需要读与统计，依赖越宽越难测试替身。

**Step 4: Run test to verify it passes**

Run: `node --test test/application/review-pipeline.test.ts`
Expected: PASS

**Step 5: Commit**

若无需改动则跳过提交；若有改动：

```bash
git add src/application/review-pipeline.ts
git commit -m "refactor: 收窄管线记录写入依赖到 insert 方法"
```

- [ ] **Task backend-014: Bearer 鉴权中间件**

**Files:**
- Create: `src/interfaces/http/auth-middleware.ts`
- Test: `test/interfaces/http/api.test.ts`

**Reasoning:**
- `D-008` 要求 Bearer 令牌；这是所有管理路由的前置门禁，必须先于各路由实现。

**Depends on**: backend-006, backend-007

**Interfaces:**
- Consumes: `AdminRepository.findByUsername`、`deriveToken(username, salt)`、请求头 `authorization`
- Produces: `createAuthMiddleware(deps): RequestHandler`
- Contract checks: 无令牌、错误令牌返回 401；有效令牌把 `username` 挂到 `req.auth`

**Step 1: Write the failing test**

```typescript
test("无令牌与错误令牌访问管理接口均返回 401", async () => {
  const none = await request(app).get("/api/reviews");
  assert.equal(none.status, 401);
  const bad = await request(app).get("/api/reviews").set("Authorization", "Bearer deadbeef");
  assert.equal(bad.status, 401);
});

test("有效令牌可访问管理接口", async () => {
  const res = await request(app).get("/api/reviews").set("Authorization", `Bearer ${validToken}`);
  assert.equal(res.status, 200);
});
```

**Step 2: Run test to verify it fails**

Run: `node --test test/interfaces/http/api.test.ts`
Expected: FAIL（路由不存在，返回 404）

**Step 3: Write minimal implementation**

```typescript
import type { RequestHandler } from "express";
import { timingSafeEqual } from "node:crypto";
import type { AdminRepository } from "../../domain/admin.ts";
import { deriveToken } from "../../shared/crypto.ts";

/**
 * Bearer 令牌鉴权中间件。
 *
 * 无状态令牌（D-009）：逐个比对库中账号的派生令牌，不查会话表。账号数量为个位数
 * 到几十，线性比对开销可忽略；换来的是不引入会话表与吊销逻辑。
 * 比较用 timingSafeEqual 避免时序侧信道。
 */
export function createAuthMiddleware(deps: { admins: AdminRepository; salt: string }): RequestHandler {
  return (req, res, next) => {
    const header = req.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token) {
      res.status(401).json({ error: "缺少访问令牌" });
      return;
    }
    const matched = deps.admins.list().find((admin) => {
      const expected = Buffer.from(deriveToken(admin.username, deps.salt));
      const actual = Buffer.from(token);
      return expected.length === actual.length && timingSafeEqual(expected, actual);
    });
    if (!matched) {
      res.status(401).json({ error: "访问令牌无效" });
      return;
    }
    res.locals.username = matched.username;
    next();
  };
}
```

账号存放在 `res.locals` 而非扩展 `req` 类型，避免污染全局 Express 类型声明。

**Step 4: Run test to verify it passes**

Run: `node --test test/interfaces/http/api.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/interfaces/http/auth-middleware.ts test/interfaces/http/api.test.ts
git commit -m "feat: 新增 Bearer 令牌鉴权中间件"
```

- [x] **Task backend-015: GitLab 版本与行内评论客户端**

**Files:**
- Modify: `src/domain/review-task.ts:60-71`（GitlabClient 端口）
- Modify: `src/infrastructure/gitlab/gitlab-client.ts:82-124`
- Test: `test/infrastructure/gitlab/gitlab-client.test.ts`

**Reasoning:**
- `D-004` 需要三个 SHA，`D-005` 需要发布与回读 discussions。这是 `D-017` 确认的端口扩展。

**Depends on**: backend-002

**Interfaces:**
- Consumes: 现有 `request` 封装与 `GitlabApiError` 语义
- Produces: `getMergeRequestVersions`、`postDiscussion`、`getDiscussions`；类型 `DiffRefs`、`Discussion`
- Contract checks: URL 拼接与 `PRIVATE-TOKEN` 头；`postDiscussion` 请求体含 `body` 与 `position`

**Step 1: Write the failing test**

```typescript
test("getMergeRequestVersions 取最新 diff version 的三个 SHA", async () => {
  const { calls, fetchFn } = trackFetch(() => jsonResponse(200, [
    { base_commit_sha: "b", start_commit_sha: "s", head_commit_sha: "h" },
    { base_commit_sha: "old-b", start_commit_sha: "old-s", head_commit_sha: "old-h" },
  ]));
  const client = makeClient(fetchFn);
  const refs = await client.getMergeRequestVersions(42, 7, "https://gitlab.example.com", "TASK-TOKEN");
  assert.deepEqual(refs, { baseSha: "b", startSha: "s", headSha: "h" });
  assert.ok(calls[0].url.endsWith("/api/v4/projects/42/merge_requests/7/versions"));
  assert.equal((calls[0].init.headers as Record<string, string>)["PRIVATE-TOKEN"], "TASK-TOKEN");
});

test("versions 为空数组时抛出可读错误", async () => {
  const { fetchFn } = trackFetch(() => jsonResponse(200, []));
  const client = makeClient(fetchFn);
  await assert.rejects(() => client.getMergeRequestVersions(1, 1), /没有 diff 版本/);
});

test("postDiscussion 发送 body 与 position", async () => {
  const { calls, fetchFn } = trackFetch(() => jsonResponse(201, { id: "d1", notes: [{ id: 1 }] }));
  const client = makeClient(fetchFn);
  await client.postDiscussion(
    42, 7, "body",
    { position_type: "text", base_sha: "b", start_sha: "s", head_sha: "h", old_path: "a.ts", new_path: "a.ts", new_line: 3 },
    "https://gitlab.example.com", "T",
  );
  const sent = JSON.parse(String(calls[0].init.body));
  assert.equal(sent.position.new_line, 3);
  assert.equal(sent.body, "body");
  assert.ok(calls[0].url.endsWith("/api/v4/projects/42/merge_requests/7/discussions"));
});

test("getDiscussions 处理分页", async () => {
  let page = 0;
  const fetchFn: FetchFn = async () => {
    page += 1;
    if (page === 1) {
      const res = jsonResponse(200, [{ id: "d1", notes: [] }]);
      Object.defineProperty(res, "headers", { value: new Map([["x-next-page", "2"]]) });
      return res;
    }
    const res = jsonResponse(200, [{ id: "d2", notes: [] }]);
    Object.defineProperty(res, "headers", { value: new Map() });
    return res;
  };
  const client = makeClient(fetchFn);
  const all = await client.getDiscussions(1, 1);
  assert.equal(all.length, 2);
});
```

**Step 2: Run test to verify it fails**

Run: `node --test test/infrastructure/gitlab/gitlab-client.test.ts`
Expected: FAIL with `client.getMergeRequestVersions is not a function`

**Step 3: Write minimal implementation**

在 `review-task.ts` 增加类型与端口方法：

```typescript
/** MR 最新 diff version 的三个 SHA。GitLab position 必需，缺任一项评论无法定位。 */
export interface DiffRefs {
  baseSha: string;
  startSha: string;
  headSha: string;
}

/** Discussions API 的行内讨论；notes[].position 用于发布后回读校验。 */
export interface Discussion {
  id: string;
  notes: { id: number; body: string; position?: Record<string, unknown> }[];
}
```

端口追加三个方法（保持与既有方法相同的任务级 `gitlabUrl`/`gitlabToken` 尾参约定）：

```typescript
  getMergeRequestVersions(projectId: number, iid: number, gitlabUrl?: string, gitlabToken?: string): Promise<DiffRefs>;
  postDiscussion(projectId: number, iid: number, body: string, position: DiscussionPosition, gitlabUrl?: string, gitlabToken?: string): Promise<Discussion>;
  getDiscussions(projectId: number, iid: number, gitlabUrl?: string, gitlabToken?: string): Promise<Discussion[]>;
```

实现要点：`versions` 为空数组时抛 `GitlabApiError`（消息含「没有 diff 版本」），因为没有 SHA 就无法发布任何行内评论，早失败好过逐条降级；`getDiscussions` 需按 `x-next-page` 头翻页合并，因为同一 MR 的讨论可能跨页。

**Step 4: Run test to verify it passes**

Run: `node --test test/infrastructure/gitlab/gitlab-client.test.ts`
Expected: PASS（既有测试 + 4 个新测试）

**Step 5: Commit**

```bash
git add src/domain/review-task.ts src/infrastructure/gitlab/gitlab-client.ts test/infrastructure/gitlab/gitlab-client.test.ts
git commit -m "feat: GitLab 客户端新增版本查询与行内评论发布回读"
```

- [ ] **Task backend-016: 行内评论发布的失败降级与发布后校验**

**Files:**
- Modify: `src/application/review-pipeline.ts`
- Test: `test/application/review-pipeline.test.ts`

**Reasoning:**
- `backend-011` 已实现主路径与行号校验。本任务专门覆盖两类边界：单条发布失败（GitLab 返回 4xx/5xx）与发布后校验不通过（GitLab 接受但锚点偏移）。这两类必须单独验证，因为它们决定了「不丢内容」这一 `design` 硬约束是否真的成立。

**Depends on:** backend-011, backend-015

**Interfaces:**
- Consumes: `GitlabClient.postDiscussion`、`GitlabClient.getDiscussions`、`buildMarker`
- Produces: 管线内单条失败降级与发布后校验逻辑
- Contract checks: 单条失败时该 finding 并入汇总且其余继续发布；校验不通过记 warn 且不重复发布

**Step 1: Write the failing test**

```typescript
test("单条行内评论发布失败时并入汇总且不影响其他 finding", async () => {
  const posted: string[] = [];
  let summaryBody = "";
  let call = 0;
  const client = {
    getMergeRequestChanges: async () => [{ newPath: "a.ts", oldPath: "a.ts", diff: "@@ -1,0 +1,2 @@\n+one\n+two\n" }],
    getMergeRequestCommits: async () => [],
    getMergeRequestVersions: async () => ({ baseSha: "b", startSha: "s", headSha: "h" }),
    getDiscussions: async () => [],
    postDiscussion: async (_p: number, _i: number, body: string) => {
      call += 1;
      if (call === 1) throw new Error("GitLab API 400");
      posted.push(body);
      return { id: "d", notes: [{ id: 1, body, position: { new_line: 1 } }] };
    },
    postMergeRequestNote: async (_p: number, _i: number, body: string) => { summaryBody = body; },
  };
  const pipeline = buildPipelineWithReviewer({
    client,
    reviewJson: {
      reviewed_head_sha: "h",
      summary: { body: "总分：90 分" },
      findings: [
        { id: "f1", severity: "high", path: "a.ts", new_line: 1, body: "第一条" },
        { id: "f2", severity: "low", path: "a.ts", new_line: 2, body: "第二条" },
      ],
    },
  });
  await pipeline.run(taskFixture());
  assert.equal(posted.length, 1, "第二条仍应成功发布");
  assert.ok(summaryBody.includes("第一条"), "失败的那条必须并入汇总");
});

test("head_sha 不一致时全部并入汇总不发行内评论", async () => {
  const posted: string[] = [];
  const client = {
    getMergeRequestChanges: async () => [{ newPath: "a.ts", oldPath: "a.ts", diff: "@@ -1,0 +1,1 @@\n+one\n" }],
    getMergeRequestCommits: async () => [],
    getMergeRequestVersions: async () => ({ baseSha: "b", startSha: "s", headSha: "h" }),
    getDiscussions: async () => [],
    postDiscussion: async (_p: number, _i: number, body: string) => { posted.push(body); return { id: "d", notes: [] }; },
    postMergeRequestNote: async () => {},
  };
  const pipeline = buildPipelineWithReviewer({
    client,
    reviewJson: {
      reviewed_head_sha: "stale".padEnd(40, "0"),
      summary: { body: "总分：90 分" },
      findings: [{ id: "f1", severity: "low", path: "a.ts", new_line: 1, body: "过期评审" }],
    },
  });
  await pipeline.run(taskFixture());
  assert.equal(posted.length, 0, "head 不一致时不得发行内评论");
});
```

**Step 2: Run test to verify it fails**

Run: `node --test test/application/review-pipeline.test.ts`
Expected: FAIL（首条失败会中断整个发布循环，第二条未发布）

**Step 3: Write minimal implementation**

把 `backend-011` 的发布循环改为逐条 try/catch：单条 `postDiscussion` 抛错时把该 finding 文本并入「无法定位/发布失败」的汇总段落并继续下一条。发布后回读校验失败（position 行号或路径不匹配）时记 warn，不把该 finding 重复并入汇总（它已成功发布，只是锚点可能偏移），也不重复发布。

**Step 4: Run test to verify it passes**

Run: `node --test test/application/review-pipeline.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/application/review-pipeline.ts test/application/review-pipeline.test.ts
git commit -m "fix: 行内评论单条失败降级并入汇总，不中断其他 finding"
```
