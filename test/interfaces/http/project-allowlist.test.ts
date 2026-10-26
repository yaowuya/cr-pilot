import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { Express } from "express";
import { createApp, type AppDeps } from "../../../src/interfaces/http/app.ts";
import { startServer, type ServerDeps } from "../../../src/interfaces/http/server.ts";
import { openDatabase } from "../../../src/infrastructure/sqlite/database.ts";
import { createPromptRepository } from "../../../src/infrastructure/sqlite/prompt-repo.ts";
import { createLogger } from "../../../src/shared/logger.ts";
import { createTaskQueue } from "../../../src/shared/queue.ts";
import { loadConfig } from "../../../src/shared/config.ts";
import type { MergeRequestTask } from "../../../src/domain/review-task.ts";

// undici 会在发请求前拒绝 Fetch 标准禁用的端口；随机分配后也必须复核。
const FETCH_BAD_PORTS = new Set([
  1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000,
  6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);
const WEBHOOK_TOKEN = "allowlist-http-test-token";
const DENIED_MESSAGE = "项目未在 Prompt 管理中配置，拒绝评审";

/** 关闭监听及遗留连接，断言失败时也不让临时 HTTP 服务存活。 */
async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}

/** 只绑定回环随机端口，并避开 Fetch 不允许访问的端口。 */
async function withApp(app: Express, run: (base: string) => Promise<void>): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const server = createServer(app);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.once("listening", resolve);
        server.listen(0, "127.0.0.1");
      });
      const address = server.address();
      assert.ok(address && typeof address === "object");
      if (FETCH_BAD_PORTS.has(address.port)) continue;
      await run(`http://127.0.0.1:${address.port}`);
      return;
    } finally {
      await closeServer(server);
    }
  }
  throw new Error("连续 20 次未分配到 Fetch 可用的回环端口");
}

/** 合法 MR 事件；带 oldrev 的 update 由真实 parser 识别为采纳追踪。 */
function payload(fullName = "team/app", attributes: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    object_kind: "merge_request",
    project: { id: 42, path_with_namespace: fullName },
    object_attributes: {
      iid: 7,
      action: "open",
      source_branch: "feature",
      target_branch: "main",
      ...attributes,
    },
  };
}

/** 只向当前测试启动的服务发送请求；token=null 用于验证原有令牌校验。 */
function post(base: string, body: unknown, token: string | null = WEBHOOK_TOKEN): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json", connection: "close" };
  if (token !== null) headers["x-gitlab-token"] = token;
  return fetch(`${base}/review/webhook`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(3_000),
  });
}

/** 在公开入队边界收集副作用，日志使用真实格式化器但不落盘。 */
function makeDeps(isProjectAllowed?: (fullName: string) => boolean) {
  const enqueued: MergeRequestTask[] = [];
  const lines: string[] = [];
  const deps: AppDeps = {
    logger: createLogger("debug", (line) => lines.push(line)),
    enqueue: (task) => { enqueued.push(task); },
    isProjectAllowed,
  };
  return { deps, enqueued, lines };
}

/** 经过真正 startServer 装配启动；配置只来自显式空环境，不读取 .env。 */
async function withStartedServer(deps: ServerDeps, run: (base: string) => Promise<void>): Promise<void> {
  const config = { ...loadConfig({}), host: "127.0.0.1", port: 0, uiPort: 0, dbPath: ":memory:" };
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const servers = await startServer(config, deps, deps.logger);
    try {
      const address = servers.primary.address();
      assert.ok(address && typeof address === "object");
      if (FETCH_BAD_PORTS.has(address.port)) continue;
      await run(`http://127.0.0.1:${address.port}`);
      return;
    } finally {
      await closeServer(servers.primary);
      if (servers.secondary) await closeServer(servers.secondary);
    }
  }
  throw new Error("startServer 连续 20 次未分配到 Fetch 可用的回环端口");
}

/** 保留真实队列，只在评审执行边界记录任务，绝不触发 GitLab 或模型。 */
function makeServerDeps(isProjectAllowed: (fullName: string) => boolean) {
  const { deps: appDeps } = makeDeps(isProjectAllowed);
  const runs: MergeRequestTask[] = [];
  const deps: ServerDeps = {
    logger: appDeps.logger,
    queue: createTaskQueue(1, appDeps.logger),
    pipeline: { run: async (task) => { runs.push(task); } },
    enqueueTracking: () => {},
    isProjectAllowed,
  };
  return { deps, runs };
}

test("未关联 Prompt 的项目在 HTTP 边界返回固定 403 且不入队", async () => {
  const checked: string[] = [];
  const { deps, enqueued, lines } = makeDeps((fullName) => {
    checked.push(fullName);
    return false;
  });
  await withApp(createApp(deps), async (base) => {
    const response = await post(base, payload("team/unconfigured"));
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: DENIED_MESSAGE });
    assert.deepEqual(checked, ["team/unconfigured"]);
    assert.equal(enqueued.length, 0);
    assert.ok(lines.length > 0, "拒绝时应留下可定位项目/MR 的日志");
    assert.match(lines.join("\n"), /team\/unconfigured/);
    assert.doesNotMatch(lines.join("\n"), /allowlist-http-test-token/);
  });
});

test("缺少项目检查 callback 时 HTTP 返回 503 且不入队", async () => {
  const { deps, enqueued, lines } = makeDeps();
  // 必须真正省略属性，而不仅是 callback 返回 false。
  delete deps.isProjectAllowed;
  await withApp(createApp(deps), async (base) => {
    const response = await post(base, payload("team/unconfigured"));
    assert.equal(response.status, 503);
    const body: unknown = await response.json();
    assert.ok(body && typeof body === "object" && "error" in body && typeof body.error === "string");
    assert.equal(enqueued.length, 0);
    assert.doesNotMatch(JSON.stringify(body) + lines.join("\n"), /allowlist-http-test-token/);
  });
});

test("项目检查抛含 secret 的 Error 时返回 503，响应与日志均不回显凭据或原异常", async () => {
  const checked: string[] = [];
  const { deps, enqueued, lines } = makeDeps((fullName) => {
    checked.push(fullName);
    throw new Error("raw-database-failure allowlist-callback-secret");
  });
  await withApp(createApp(deps), async (base) => {
    const response = await post(base, {
      ...payload("team/app"),
      private_payload_marker: "allowlist-raw-payload-secret",
    });
    const text = await response.text();
    const logs = lines.join("\n");
    // 先检验敏感信息，避免状态码断言掩盖一次潜在的日志泄露。
    for (const secret of [WEBHOOK_TOKEN, "allowlist-callback-secret", "raw-database-failure", "allowlist-raw-payload-secret"]) {
      assert.equal(text.includes(secret), false, "HTTP 响应不能回显敏感信息");
      assert.equal(logs.includes(secret), false, "日志不能包含 token、payload 或原异常");
    }
    assert.equal(response.status, 503);
    assert.deepEqual(checked, ["team/app"]);
    assert.equal(enqueued.length, 0);
    assert.ok(lines.length > 0, "配置检查失败必须留日志供排查");
    assert.match(logs, /team\/app/);
  });
});

test("已关联 Prompt 的项目检查通过后保持原有 200 与任务级 token 入队行为", async () => {
  const checked: string[] = [];
  const { deps, enqueued } = makeDeps((fullName) => {
    checked.push(fullName);
    return true;
  });
  await withApp(createApp(deps), async (base) => {
    const response = await post(base, payload("team/configured"));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { message: "merge_request !7 已进入评审队列" });
    assert.deepEqual(checked, ["team/configured"]);
    assert.equal(enqueued.length, 1);
    assert.equal(enqueued[0].projectId, 42);
    assert.equal(enqueued[0].iid, 7);
    assert.equal(enqueued[0].fullName, "team/configured");
    assert.equal(enqueued[0].sourceBranch, "feature");
    assert.equal(enqueued[0].targetBranch, "main");
    assert.equal(enqueued[0].gitlabToken, WEBHOOK_TOKEN);
    assert.equal(enqueued[0].eventKind, "review");
  });
});

test("未知项目有新提交时仍登记历史采纳追踪，不调用项目名单检查", async () => {
  const checked: string[] = [];
  const tracking: MergeRequestTask[] = [];
  const { deps, enqueued } = makeDeps((fullName) => {
    checked.push(fullName);
    return false;
  });
  deps.enqueueTracking = (task) => { tracking.push(task); };
  await withApp(createApp(deps), async (base) => {
    const response = await post(base, payload("team/unknown", { action: "update", oldrev: "old-head-sha" }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { message: "merge_request !7 已进入采纳追踪" });
    assert.equal(enqueued.length, 0);
    assert.deepEqual(checked, []);
    assert.equal(tracking.length, 1);
    assert.equal(tracking[0].fullName, "team/unknown");
    assert.equal(tracking[0].eventKind, "tracking");
  });
});

test("缺少名单 callback 也不阻断已装配的历史采纳追踪", async () => {
  const tracking: MergeRequestTask[] = [];
  const { deps, enqueued } = makeDeps();
  delete deps.isProjectAllowed;
  deps.enqueueTracking = (task) => { tracking.push(task); };
  await withApp(createApp(deps), async (base) => {
    const response = await post(base, payload("team/unknown", { action: "update", oldrev: "old-head-sha" }));
    assert.equal(response.status, 200);
    await response.text();
    assert.equal(tracking.length, 1);
    assert.equal(enqueued.length, 0);
  });
});

test("未装配 tracking handler 的新提交退回完整评审时仍被名单拒绝", async () => {
  const checked: string[] = [];
  const { deps, enqueued } = makeDeps((fullName) => {
    checked.push(fullName);
    return false;
  });
  await withApp(createApp(deps), async (base) => {
    const response = await post(base, payload("team/unknown", { action: "update", oldrev: "old-head-sha" }));
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: DENIED_MESSAGE });
    assert.deepEqual(checked, ["team/unknown"]);
    assert.equal(enqueued.length, 0);
  });
});

test("没有 oldrev 的普通 update 走完整评审，不能借 tracking handler 绕过名单", async () => {
  const tracking: MergeRequestTask[] = [];
  const { deps, enqueued } = makeDeps(() => false);
  deps.enqueueTracking = (task) => { tracking.push(task); };
  await withApp(createApp(deps), async (base) => {
    const response = await post(base, payload("team/unknown", { action: "update" }));
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: DENIED_MESSAGE });
    assert.equal(tracking.length, 0);
    assert.equal(enqueued.length, 0);
  });
});

test("原有 payload 与 token 校验先于名单检查，非法请求仍返回 400", async () => {
  const checked: string[] = [];
  const { deps, enqueued } = makeDeps((fullName) => {
    checked.push(fullName);
    return false;
  });
  await withApp(createApp(deps), async (base) => {
    for (const body of [null, { object_kind: "push" }, { object_kind: "merge_request", project: { id: 42 } }]) {
      const response = await post(base, body);
      assert.equal(response.status, 400);
      await response.text();
    }
    const missingToken = await post(base, payload(), null);
    assert.equal(missingToken.status, 400);
    await missingToken.text();
    assert.deepEqual(checked, []);
    assert.equal(enqueued.length, 0);
  });
});

test("真实内存 PromptRepository 只有 default 时未知项目仍在 HTTP 边界被拒绝", async () => {
  const db = openDatabase(":memory:");
  try {
    const prompts = createPromptRepository(db);
    prompts.create({ repository: "default", systemPrompt: "default system", userPrompt: "{diffs_text}" });
    const { deps, enqueued } = makeDeps((fullName) => prompts.isProjectConfigured!(fullName));
    await withApp(createApp(deps), async (base) => {
      const response = await post(base, payload("team/unconfigured"));
      assert.equal(response.status, 403);
      assert.deepEqual(await response.json(), { error: DENIED_MESSAGE });
      assert.equal(enqueued.length, 0);
    });
  } finally {
    db.close();
  }
});

test("真实内存 PromptRepository 的显式项目关联通过 HTTP 放行，不依赖仓库上下文开关", async () => {
  const db = openDatabase(":memory:");
  try {
    const prompts = createPromptRepository(db);
    prompts.create({ repository: "default", systemPrompt: "default system", userPrompt: "{diffs_text}" });
    prompts.create({ repository: "team rules", projects: ["team/configured"], systemPrompt: "project system", userPrompt: "{diffs_text}" });
    const checked: string[] = [];
    const { deps, enqueued } = makeDeps((fullName) => {
      checked.push(fullName);
      return prompts.isProjectConfigured!(fullName);
    });
    await withApp(createApp(deps), async (base) => {
      const response = await post(base, payload("team/configured"));
      assert.equal(response.status, 200);
      await response.text();
      assert.deepEqual(checked, ["team/configured"]);
      assert.equal(enqueued.length, 1);
      assert.equal(enqueued[0].fullName, "team/configured");
    });
  } finally {
    db.close();
  }
});

test("真实内存 PromptRepository 解绑后同一 HTTP app 的下一请求立即拒绝，即使 default 仍存在", async () => {
  const db = openDatabase(":memory:");
  try {
    const prompts = createPromptRepository(db);
    prompts.create({ repository: "default", systemPrompt: "default system", userPrompt: "{diffs_text}" });
    const projectPrompt = prompts.create({ repository: "team rules", projects: ["team/configured"], systemPrompt: "project system", userPrompt: "{diffs_text}" });
    const { deps, enqueued } = makeDeps((fullName) => prompts.isProjectConfigured!(fullName));
    await withApp(createApp(deps), async (base) => {
      const allowed = await post(base, payload("team/configured"));
      assert.equal(allowed.status, 200);
      await allowed.text();
      assert.equal(enqueued.length, 1);
      prompts.update(projectPrompt.id, { projects: [], systemPrompt: "project system", userPrompt: "{diffs_text}" });
      const denied = await post(base, payload("team/configured"));
      assert.equal(denied.status, 403);
      assert.deepEqual(await denied.json(), { error: DENIED_MESSAGE });
      assert.equal(enqueued.length, 1, "解绑后的请求不应产生第二次入队");
    });
  } finally {
    db.close();
  }
});

test("startServer 必须透传项目 callback：未知项目 403 且 fake pipeline 从未运行", async () => {
  const checked: string[] = [];
  const { deps, runs } = makeServerDeps((fullName) => {
    checked.push(fullName);
    return fullName === "team/configured";
  });
  await withStartedServer(deps, async (base) => {
    const response = await post(base, payload("team/unknown"));
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: DENIED_MESSAGE });
    assert.deepEqual(checked, ["team/unknown"]);
    assert.equal(runs.length, 0);
    assert.equal(deps.queue.pending, 0);
  });
});

test("startServer 必须透传项目 callback：已知项目 200 且 fake pipeline 恰好运行一次", async () => {
  const checked: string[] = [];
  const { deps, runs } = makeServerDeps((fullName) => {
    checked.push(fullName);
    return fullName === "team/configured";
  });
  await withStartedServer(deps, async (base) => {
    const response = await post(base, payload("team/configured"));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { message: "merge_request !7 已进入评审队列" });
    assert.deepEqual(checked, ["team/configured"]);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].fullName, "team/configured");
    assert.equal(runs[0].gitlabToken, WEBHOOK_TOKEN);
    assert.equal(runs[0].eventKind, "review");
  });
});
