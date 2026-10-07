import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { Express } from "express";
import { createApp, type AppDeps, type WebhookEnqueue } from "../../../src/interfaces/http/app.ts";
import { createSilentLogger } from "../../../src/shared/logger.ts";
import type { MergeRequestTask } from "../../../src/domain/review-task.ts";

/**
 * Fetch 规范定义了一组禁用端口，undici 会直接拒绝连接并报 `bad port`。
 * `listen(0)` 偶尔会分配到这些端口，使测试随机失败，因此绑定后必须校验。
 * 只列出大于 1024 的条目：动态端口不会落在更低的范围。
 */
const FETCH_BAD_PORTS = new Set([
  1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000,
  6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);

/** 启动一个 fetch 可访问的临时服务器，跳过规范禁用的端口。 */
async function listenOnFetchablePort(app: Express): Promise<{ server: Server; port: number }> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const server = createServer(app);
    await new Promise<void>((resolve, reject) => {
      // 先挂事件再 listen：Express 的 listen 回调不对应 listening 事件。
      server.once("error", reject);
      server.once("listening", () => resolve());
      server.listen(0, "127.0.0.1");
    });
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    if (port > 0 && !FETCH_BAD_PORTS.has(port)) return { server, port };
    await new Promise((resolve) => server.close(resolve));
  }
  throw new Error("连续 20 次都分配到 fetch 不可用的端口");
}

/** 构造一个合法的 GitLab merge_request payload。 */
function mergeRequestPayload(overrides: Record<string, unknown> = {}): unknown {
  return {
    object_kind: "merge_request",
    project_id: 42,
    project: { id: 42, path_with_namespace: "team/app" },
    object_attributes: {
      iid: 7,
      action: "open",
      source_branch: "dev",
      target_branch: "main",
    },
    ...overrides,
  };
}

/** 捕获入队动作的依赖集合。 */
function makeDeps(): { deps: AppDeps; enqueued: MergeRequestTask[] } {
  const enqueued: MergeRequestTask[] = [];
  const enqueue: WebhookEnqueue = (task) => {
    enqueued.push(task);
  };
  return {
    deps: { logger: createSilentLogger(), enqueue },
    enqueued,
  };
}

async function withApp(run: (base: string) => Promise<void>, deps: AppDeps): Promise<void> {
  const { server, port } = await listenOnFetchablePort(createApp(deps));
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function post(base: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}/review/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

test("缺少 X-Gitlab-Token 请求头返回 400 不入队", async () => {
  const { deps, enqueued } = makeDeps();
  await withApp(async (base) => {
    // 访问令牌随 webhook 请求头携带（对齐参考项目），缺失时无法拉取/回写，直接拒绝。
    assert.equal((await post(base, mergeRequestPayload())).status, 400);
  }, deps);
  assert.equal(enqueued.length, 0);
});

test("merge_request 事件携带 token 入队并返回 200", async () => {
  const { deps, enqueued } = makeDeps();
  await withApp(async (base) => {
    const response = await post(base, mergeRequestPayload(), { "x-gitlab-token": "event-token" });
    assert.equal(response.status, 200);
  }, deps);
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].projectId, 42);
  assert.equal(enqueued[0].iid, 7);
  assert.equal(enqueued[0].fullName, "team/app");
  assert.equal(enqueued[0].sourceBranch, "dev");
  assert.equal(enqueued[0].targetBranch, "main");
  assert.equal(enqueued[0].gitlabToken, "event-token");
});

test("gitlabUrl 从 X-Gitlab-Instance 请求头派生", async () => {
  const { deps, enqueued } = makeDeps();
  await withApp(async (base) => {
    const response = await post(base, mergeRequestPayload(), { "x-gitlab-token": "t", "x-gitlab-instance": "https://code.cwoa.net" });
    assert.equal(response.status, 200);
  }, deps);
  assert.equal(enqueued[0].gitlabUrl, "https://code.cwoa.net");
});

test("无 X-Gitlab-Instance 时从 repository.homepage 派生 gitlabUrl", async () => {
  const { deps, enqueued } = makeDeps();
  const payload = mergeRequestPayload({
    repository: { homepage: "https://code.cwoa.net/team/app" },
  });
  await withApp(async (base) => {
    const response = await post(base, payload, { "x-gitlab-token": "t" });
    assert.equal(response.status, 200);
  }, deps);
  assert.equal(enqueued[0].gitlabUrl, "https://code.cwoa.net");
});

test("非 merge_request 事件返回 400，不入队", async () => {
  const { deps, enqueued } = makeDeps();
  await withApp(async (base) => {
    assert.equal((await post(base, { object_kind: "push" })).status, 400);
  }, deps);
  assert.equal(enqueued.length, 0);
});

test("project_id 缺失时回退 project.id", async () => {
  const { deps, enqueued } = makeDeps();
  const payload = mergeRequestPayload({ project_id: undefined, project: { id: 99, path_with_namespace: "team/app" } });
  await withApp(async (base) => {
    assert.equal((await post(base, payload, { "x-gitlab-token": "t" })).status, 200);
  }, deps);
  assert.equal(enqueued[0].projectId, 99);
});

test("旧纯代码请求不再支持", async () => {
  const { deps, enqueued } = makeDeps();
  await withApp(async (base) => {
    const response = await post(base, { code: "const a = 1;" });
    // 没有 object_kind 的 JSON 对象 → 400（不是评审，也不是入队）
    assert.equal(response.status, 400);
  }, deps);
  assert.equal(enqueued.length, 0);
});

test("未知路径返回 JSON 404", async () => {
  const { deps } = makeDeps();
  await withApp(async (base) => {
    const response = await fetch(`${base}/nope`);
    assert.equal(response.status, 404);
    const body = (await response.json()) as { error?: unknown };
    assert.equal(typeof body.error, "string");
  }, deps);
});
