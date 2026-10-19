- [x] **Task backend-007: webhook 路由改造**

**Files:**
- Modify: `src/app.ts`
- Test: `test/app.test.ts`

**Reasoning:**
- `P-005`/`P-006` 的核心交付：webhook 只做来源校验与事件分派，评审逻辑移出路由；旧「纯代码」形态移除。
- 原 `test/app.test.ts` 的 9 个「同步评审」用例全部替换为 webhook 契约用例。

**Depends on:** `backend-004`、`backend-006`

**Interfaces:**
- Consumes: `TaskQueue`、`MergeRequestTask` 的构造参数
- Produces: 新 `AppDeps { queue, webhookSecret, logger, onMergeRequest }`；`POST /review/webhook` 的 401/400/200
- Contract checks: 缺 `X-Gitlab-Token` 或 secret 不匹配 401；`object_kind` 非 merge_request 400；merge_request 入队并 200；队列被调用一次且携带正确 project_id/iid/fullName

**Step 1: Write the failing test**

```ts
// test/app.test.ts（重写）
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { Express } from "express";
import { createApp, type AppDeps } from "../src/app.ts";
import { createLogger, createSilentLogger, type Logger } from "../src/logger.ts";
import { createTaskQueue, type TaskQueue } from "../src/queue.ts";

const SECRET = "webhook-secret";

function mergeRequestPayload(): unknown {
  return {
    object_kind: "merge_request",
    project_id: 42,
    project: { path_with_namespace: "team/app" },
    object_attributes: { iid: 7, action: "open", source_branch: "dev", target_branch: "main" },
  };
}

function makeDeps(overrides: Partial<AppDeps> = {}): AppDeps & { enqueued: unknown[] } {
  const enqueued: unknown[] = [];
  const queue = {
    push: (task: () => Promise<void>) => { enqueued.push(task); },
    pending: 0,
  } as unknown as TaskQueue;
  return { queue, webhookSecret: SECRET, logger: createSilentLogger(), ...overrides, enqueued };
}

async function withApp(run: (base: string) => Promise<void>, deps: AppDeps): Promise<void> {
  const server = createServer(createApp(deps));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.once("listening", () => resolve());
    server.listen(0, "127.0.0.1");
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("secret 缺失或不匹配返回 401", async () => {
  const deps = makeDeps();
  await withApp(async (base) => {
    const without = await fetch(`${base}/review/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(mergeRequestPayload()),
    });
    assert.equal(without.status, 401);
    const wrong = await fetch(`${base}/review/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-gitlab-token": "wrong" },
      body: JSON.stringify(mergeRequestPayload()),
    });
    assert.equal(wrong.status, 401);
  }, deps);
  assert.equal(deps.enqueued.length, 0);
});

test("非 merge_request 事件返回 400", async () => {
  const deps = makeDeps();
  await withApp(async (base) => {
    const response = await fetch(`${base}/review/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-gitlab-token": SECRET },
      body: JSON.stringify({ object_kind: "push" }),
    });
    assert.equal(response.status, 400);
  }, deps);
  assert.equal(deps.enqueued.length, 0);
});

test("merge_request 事件入队并返回 200", async () => {
  const deps = makeDeps();
  let ran = false;
  deps.queue = { push: () => { ran = true; }, pending: 0 } as unknown as TaskQueue;
  await withApp(async (base) => {
    const response = await fetch(`${base}/review/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-gitlab-token": SECRET },
      body: JSON.stringify(mergeRequestPayload()),
    });
    assert.equal(response.status, 200);
  }, deps);
  assert.equal(ran, true);
});

test("旧纯代码请求不再支持（401）", async () => {
  const deps = makeDeps();
  await withApp(async (base) => {
    const response = await fetch(`${base}/review/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-gitlab-token": SECRET },
      body: JSON.stringify({ code: "const a = 1;" }),
    });
    assert.equal(response.status, 400);
  }, deps);
});
```

注：实现时入队构造 `MergeRequestTask`，测试可用假 `queue.push` 校验。若需要校验任务参数，改为在 `makeDeps` 里捕获并检查。最终形态以「队列被调用且携带正确参数」为准，可用 `enqueued` 数组 + 运行时调用断言。

**Step 2: Run test to verify it fails**

Run: `node --test test/app.test.ts`
Expected: FAIL —— 旧用例仍按「同步评审」形态断言，新用例不通过

**Step 3: Write minimal implementation**

`src/app.ts` 重写：`AppDeps { queue: TaskQueue; webhookSecret: string; logger: Logger }`。`POST /review/webhook`：先比对 `X-Gitlab-Token` 与 `webhookSecret`（缺或错 → 401）；解析 payload，`object_kind !== "merge_request"` → 400；提取 `project_id`（优先顶层，缺失回退 `project.id`）、`object_attributes.iid/action/source_branch/target_branch`、`project.path_with_namespace` 构造 `MergeRequestTask`，`queue.push(() => pipelineTask)`，立即 200。删除旧的 code 评审逻辑与 `loadReviewPrompt` 引用。逐步日志沿用（收到请求、来源校验、入队）。移除 `express.json` 中不必要的变化；保留 404 与错误中间件。

注：`AppDeps` 需要 pipeline 执行入口——设计上由 `server.ts` 装配 `queue` 与 `onTask` 回调（或 `pipeline.run`），本任务以 `AppDeps { queue, webhookSecret, logger, createTask }` 形态落地，`createTask(payload) => () => Promise<void>` 由 server 注入，保持路由不依赖 pipeline 细节。实现时若此形态与 backend-008 装配冲突，以「路由不 import pipeline」为准则调整，并在 backend-008 一并验证。

**Step 4: Run test to verify it passes**

Run: `node --test test/app.test.ts`
Expected: PASS（4 个用例）

自审：401 先于事件分派；立即返回 200；旧形态移除与 `P-005` 一致；日志不打 payload 正文（只打 object_kind 与 iid）。

**Step 5: Commit**

```bash
git add src/app.ts test/app.test.ts
git commit -m "feat: gitlab webhook route with secret check and queue dispatch"
```

- [x] **Task backend-008: 装配、文档与端到端启动**

**Files:**
- Modify: `src/server.ts`
- Modify: `README.md`
- Test: `test/server.test.ts`

**Reasoning:**
- 把队列、客户端、规则、管线装配进进程入口，并更新 README 的 GitLab 对接说明。真实 MR 端到端验证由用户环境完成（需要真实 GitLab 配置）。

**Depends on:** `backend-007`

**Interfaces:**
- Consumes: 全部模块
- Produces: `startServer(config, deps, logger)` 新签名
- Contract checks: 装配后监听、启动失败日志、配置缺失快速失败

**Step 1: Write the failing test**

```ts
// test/server.test.ts（重写）
import { test } from "node:test";
import assert from "node:assert/strict";
import { createLogger } from "../src/logger.ts";
import { createTaskQueue } from "../src/queue.ts";
import { startServer } from "../src/server.ts";
import type { GitlabClient } from "../src/gitlab-client.ts";
import type { ReviewRules } from "../src/rules.ts";
import { createReviewPipeline } from "../src/pipeline.ts";
import { createSilentLogger } from "../src/logger.ts";

const config = {
  port: 0, host: "127.0.0.1",
  promptPath: "prompts/review.md", timeoutMs: 1000,
  logLevel: "info" as const,
  gitlabUrl: "https://gitlab.example.com", gitlabToken: "t", gitlabWebhookSecret: "s",
  gitlabInsecureTls: false, gitlabApiTimeoutMs: 1000, batchMaxTokens: 6000, rulesDir: "prompts/rules",
};

test("startServer 装配管线后监听并可关闭", async () => {
  const lines: string[] = [];
  const logger = createLogger("info", (line) => lines.push(line));
  const client = {} as GitlabClient;
  const rules = { resolve: () => ({ systemPrompt: "s", userPrompt: "u" }) } as unknown as ReviewRules;
  const pipeline = createReviewPipeline({ client, rules, reviewer: { review: async () => ({ text: "x", model: "m" }) }, logger: createSilentLogger(), batchMaxTokens: 6000 });
  const server = await startServer(config, { queue: createTaskQueue(), webhookSecret: "s", pipeline, logger }, logger);
  const address = server.address();
  assert.equal(typeof address === "object" && address !== null && address.port > 0, true);
  await new Promise((resolve) => server.close(resolve));
  assert.match(lines.join("\n"), /监听/);
});
```

**Step 2: Run test to verify it fails**

Run: `node --test test/server.test.ts`
Expected: FAIL —— `startServer` 签名与装配不符

**Step 3: Write minimal implementation**

`src/server.ts`：`startServer(config, deps, logger)`；直接执行入口构造 `logger`、`queue`、`createGitlabClient`、`loadReviewRules`、`createReviewPipeline`、`createPiReviewer`，并注入 `createTask`（把 payload 解析成 `MergeRequestTask` 包装为 `() => pipeline.run(task)`）。启动横幅打印生效配置（GitLab URL 打印但 token 不打印）。`README.md` 重写：GitLab 对接前置（`GITLAB_URL`/`GITLAB_TOKEN`/`GITLAB_WEBHOOK_SECRET`）、webhook 配置步骤（GitLab 侧 Secret Token 设置）、仓库规则目录用法、分批参数说明、旧接口停止支持的迁移说明。

**Step 4: Run test to verify it passes**

Run: `node --test test/server.test.ts`
Expected: PASS（1 个用例）；随后 `npm test` 全量 + `npm run typecheck`

自审：装配顺序与设计一致；token 不进入任何日志；README 与 `loadConfig` 字段一一对应。

**Step 5: Commit**

```bash
git add src/server.ts README.md test/server.test.ts
git commit -m "feat: wire pipeline into server entry and document gitlab setup"
```

