import { test } from "node:test";
import assert from "node:assert/strict";
import type { Express } from "express";
import { createApp } from "../../../src/interfaces/http/app.ts";
import { createAuthMiddleware } from "../../../src/interfaces/http/auth-middleware.ts";
import { createAuthRouter } from "../../../src/interfaces/http/api/auth.ts";
import { createVerifyRouter } from "../../../src/interfaces/http/api/verify.ts";
import { openDatabase } from "../../../src/infrastructure/sqlite/database.ts";
import { createAdminRepository } from "../../../src/infrastructure/sqlite/admin-repo.ts";
import { createSilentLogger } from "../../../src/shared/logger.ts";
import { deriveToken } from "../../../src/shared/crypto.ts";
import type { FeatureVerifier, VerifyOutcome } from "../../../src/application/feature-verifier.ts";

const AUTH_SALT = "test-auth-salt";
const ADMIN = "admin";
const ADMIN_PASSWORD = "admin-password";

/** 可控制结果的验证器替身；记录调用参数便于断言。 */
function fakeVerifier(options: {
  ai?: VerifyOutcome | (() => Promise<VerifyOutcome>);
  wecom?: VerifyOutcome | (() => Promise<VerifyOutcome>);
  calls?: { wecom: { webhookOverride?: string; dryRun?: boolean }[] };
}) {
  const calls = options.calls ?? { wecom: [] };
  const success = (message: string): VerifyOutcome => ({ success: true, message, detail: "detail", durationMs: 10 });
  const resolve = async (value: VerifyOutcome | (() => Promise<VerifyOutcome>) | undefined, fallback: string) => {
    if (typeof value === "function") return value();
    return value ?? success(fallback);
  };
  const verifier: FeatureVerifier = {
    verifyAi: () => resolve(options.ai, "AI 通过"),
    verifyWecom: async (opts = {}) => {
      calls.wecom.push(opts);
      return resolve(options.wecom, "企微通过");
    },
  };
  return { verifier, calls };
}

/** 真实 SQLite 内存库 + 真实 Express 应用。 */
function buildHarness(verifier: FeatureVerifier) {
  const db = openDatabase(":memory:");
  const admins = createAdminRepository(db, AUTH_SALT, ADMIN);
  admins.ensureInitialAdmin(ADMIN, ADMIN_PASSWORD);
  const authMiddleware = createAuthMiddleware({ admins, authSalt: AUTH_SALT });
  const app = createApp({
    logger: createSilentLogger(),
    enqueue: () => {},
    publicApiRoutes: { "/api/auth": createAuthRouter({ admins, authSalt: AUTH_SALT, authMiddleware }) },
    authMiddleware,
    apiRoutes: { "/api/verify": createVerifyRouter({ verifier }) },
  });
  return { app, token: deriveToken(ADMIN, AUTH_SALT) };
}

async function withServer<T>(app: Express, run: (base: string) => Promise<T>): Promise<T> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function post(token: string, base: string, path: string, body: unknown = {}): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

function get(token: string, base: string, path: string): Promise<Response> {
  return fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` } });
}

/** 轮询任务直到结束（测试里验证器是即时的，通常一两次即可）。 */
async function waitTask(token: string, base: string, taskId: string): Promise<{ status: string; message: string }> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const res = await get(token, base, `/api/verify/tasks/${taskId}`);
    assert.equal(res.status, 200);
    const task = (await res.json()) as { status: string; message: string };
    if (task.status !== "running") return task;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("任务超时未结束");
}

test("自检接口未携带令牌时返回 401", async () => {
  const { verifier } = fakeVerifier({});
  const { app } = buildHarness(verifier);
  await withServer(app, async (base) => {
    assert.equal((await fetch(`${base}/api/verify/ai`, { method: "POST" })).status, 401);
    assert.equal((await fetch(`${base}/api/verify/tasks/x`)).status, 401);
  });
});

test("提交 AI 验证返回任务 ID，轮询后得到成功结果", async () => {
  const { verifier } = fakeVerifier({ ai: { success: true, message: "AI 评审通过，解析出 17 分", detail: "摘要", durationMs: 72000 } });
  const { app, token } = buildHarness(verifier);
  await withServer(app, async (base) => {
    const res = await post(token, base, "/api/verify/ai");
    assert.equal(res.status, 200);
    const { taskId } = (await res.json()) as { taskId: string };
    assert.ok(taskId, "必须返回任务 ID");
    const task = await waitTask(token, base, taskId);
    assert.equal(task.status, "success");
    assert.match(task.message, /17 分/);
  });
});

test("AI 验证失败时任务状态为 failed，不是 500", async () => {
  const { verifier } = fakeVerifier({ ai: { success: false, message: "AI 评审返回空文本", detail: "", durationMs: 5 } });
  const { app, token } = buildHarness(verifier);
  await withServer(app, async (base) => {
    const { taskId } = (await (await post(token, base, "/api/verify/ai")).json()) as { taskId: string };
    const task = await waitTask(token, base, taskId);
    assert.equal(task.status, "failed");
    assert.match(task.message, /空文本/);
  });
});

test("企微默认只预览，不真的发送", async () => {
  const calls: { wecom: { webhookOverride?: string; dryRun?: boolean }[] } = { wecom: [] };
  const { verifier } = fakeVerifier({ calls });
  const { app, token } = buildHarness(verifier);
  await withServer(app, async (base) => {
    const { taskId } = (await (await post(token, base, "/api/verify/wecom", {})).json()) as { taskId: string };
    await waitTask(token, base, taskId);
    assert.equal(calls.wecom.length, 1);
    assert.equal(calls.wecom[0].dryRun, true, "未确认时必须走预览");
  });
});

test("企微 confirmSend=true 时才真实发送", async () => {
  const calls: { wecom: { webhookOverride?: string; dryRun?: boolean }[] } = { wecom: [] };
  const { verifier } = fakeVerifier({ calls });
  const { app, token } = buildHarness(verifier);
  await withServer(app, async (base) => {
    const { taskId } = (await (await post(token, base, "/api/verify/wecom", { confirmSend: true })).json()) as { taskId: string };
    await waitTask(token, base, taskId);
    assert.equal(calls.wecom[0].dryRun, false, "确认后必须真实发送");
  });
});

test("企微 webhook 覆盖参数必须合法", async () => {
  const { verifier } = fakeVerifier({});
  const { app, token } = buildHarness(verifier);
  await withServer(app, async (base) => {
    const bad = await post(token, base, "/api/verify/wecom", { confirmSend: true, webhook: "not-a-url" });
    assert.equal(bad.status, 400);
    const ok = await post(token, base, "/api/verify/wecom", { confirmSend: true, webhook: "https://example.com/hook" });
    assert.equal(ok.status, 200);
  });
});

test("同一时间只允许一个同类验证任务", async () => {
  // AI 验证会消耗模型额度，并发触发既浪费也会让结果互相干扰。
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { verifier } = fakeVerifier({
    ai: async () => {
      await gate;
      return { success: true, message: "done", detail: "", durationMs: 1 };
    },
  });
  const { app, token } = buildHarness(verifier);
  await withServer(app, async (base) => {
    const first = await post(token, base, "/api/verify/ai");
    assert.equal(first.status, 200);
    const second = await post(token, base, "/api/verify/ai");
    assert.equal(second.status, 409, "重复提交应被拒绝");
    release?.();
    const { taskId } = (await first.json()) as { taskId: string };
    await waitTask(token, base, taskId);
  });
});

test("查询不存在的任务返回 404", async () => {
  const { verifier } = fakeVerifier({});
  const { app, token } = buildHarness(verifier);
  await withServer(app, async (base) => {
    assert.equal((await get(token, base, "/api/verify/tasks/not-exist")).status, 404);
  });
});
