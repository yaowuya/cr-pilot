import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Express } from "express";
import { createApp } from "../../../src/interfaces/http/app.ts";
import { createAuthMiddleware, createRequireAdmin } from "../../../src/interfaces/http/auth-middleware.ts";
import { createAuthRouter } from "../../../src/interfaces/http/api/auth.ts";
import { createVerifyRouter } from "../../../src/interfaces/http/api/verify.ts";
import { openDatabase } from "../../../src/infrastructure/sqlite/database.ts";
import { createAdminRepository } from "../../../src/infrastructure/sqlite/admin-repo.ts";
import { createSilentLogger } from "../../../src/shared/logger.ts";
import { deriveToken } from "../../../src/shared/crypto.ts";
import { createFeatureVerifier, type FeatureVerifier, type VerifyOutcome, type VerifyWecomOptions } from "../../../src/application/feature-verifier.ts";
import type { OcrSelfTestOutcome } from "../../../src/application/ocr-self-test.ts";
import { createWecomContactRepository } from "../../../src/infrastructure/sqlite/wecom-contact-repo.ts";
import { loadConfig } from "../../../src/shared/config.ts";

const AUTH_SALT = "test-auth-salt";
const ADMIN = "admin";
const ADMIN_PASSWORD = "admin-password";
const MEMBER = "verify-member";

/** 可控制结果的验证器替身；记录调用参数便于断言。 */
function fakeVerifier(options: {
  ai?: VerifyOutcome | (() => Promise<VerifyOutcome>);
  wecom?: VerifyOutcome | (() => Promise<VerifyOutcome>);
  calls?: { wecom: VerifyWecomOptions[] };
  /** 机器人列表；缺省为空，模拟未配置任何机器人。 */
  bots?: { id: string; maskedKey: string; repositories: string[] }[];
}) {
  const calls = options.calls ?? { wecom: [] };
  const success = (message: string): VerifyOutcome => ({ success: true, message, detail: "detail", durationMs: 10 });
  const resolve = async (value: VerifyOutcome | (() => Promise<VerifyOutcome>) | undefined, fallback: string) => {
    if (typeof value === "function") return value();
    return value ?? success(fallback);
  };
  const verifier: FeatureVerifier = {
    listWecomBots: async () => options.bots ?? [],
    verifyAi: () => resolve(options.ai, "AI 通过"),
    verifyWecom: async (opts = {}) => {
      calls.wecom.push(opts);
      return resolve(options.wecom, "企微通过");
    },
  };
  return { verifier, calls };
}

/** 真实 SQLite 内存库 + 真实 Express 应用。 */
function buildHarness(verifier: FeatureVerifier, verifyOcr?: (project?: string) => Promise<OcrSelfTestOutcome>) {
  const db = openDatabase(":memory:");
  const admins = createAdminRepository(db, AUTH_SALT, ADMIN);
  admins.ensureInitialAdmin(ADMIN, ADMIN_PASSWORD);
  if (verifyOcr) admins.create(MEMBER, "member-password");
  const authMiddleware = createAuthMiddleware({ admins, authSalt: AUTH_SALT });
  const app = createApp({
    logger: createSilentLogger(),
    enqueue: () => {},
    publicApiRoutes: { "/api/auth": createAuthRouter({ admins, authSalt: AUTH_SALT, authMiddleware }) },
    authMiddleware,
    apiRoutes: { "/api/verify": createVerifyRouter({ verifier, ...(verifyOcr ? { ocr: { verify: verifyOcr, requireAdmin: createRequireAdmin() } } : {}) }) },
  });
  return { app, token: deriveToken(ADMIN, AUTH_SALT), memberToken: deriveToken(MEMBER, AUTH_SALT) };
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
async function waitTask(token: string, base: string, taskId: string): Promise<{ kind: string; status: string; message: string; detail: string; ocr?: OcrSelfTestOutcome["ocr"] }> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const res = await get(token, base, `/api/verify/tasks/${taskId}`);
    assert.equal(res.status, 200);
    const task = (await res.json()) as Awaited<ReturnType<typeof waitTask>>;
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

test("OCR 验证仅允许管理员提交和轮询，接受可选的完整项目路径", async () => {
  const { verifier } = fakeVerifier({});
  const calls: Array<string | undefined> = [];
  const payload: NonNullable<OcrSelfTestOutcome["ocr"]> = {
    project: "group/sub/repo", provider: "mock-provider", model: "mock-model", verdict: "detected",
    fixture: { path: "fixture.ts", line: 7, baseSha: "a".repeat(40), headSha: "b".repeat(40) },
    filesReviewed: 1, complete: true, score: 95,
    findings: [{ path: "fixture.ts", line: 7, severity: "high", message: "synthetic finding" }], rawCommentsFormat: "array",
  };
  const { app, token, memberToken } = buildHarness(verifier, async (project) => {
    calls.push(project);
    return { success: true, message: "OCR 通过", detail: "摘要", durationMs: 20, ocr: payload };
  });
  await withServer(app, async (base) => {
    const path = "/api/verify/ocr";
    assert.equal((await fetch(`${base}${path}`, { method: "POST" })).status, 401);
    assert.equal((await post(memberToken, base, path, { project: "group/sub/repo" })).status, 403);
    assert.deepEqual(calls, []);

    const submitted = await post(token, base, path, { project: " group/sub/repo " });
    assert.equal(submitted.status, 200);
    const { taskId } = (await submitted.json()) as { taskId: string };
    const taskPath = `/api/verify/tasks/${taskId}`;
    assert.equal((await get(memberToken, base, taskPath)).status, 403);
    const result = await waitTask(token, base, taskId);
    assert.equal(result.kind, "ocr");
    assert.equal(result.status, "success");
    assert.equal(result.message, "OCR 通过");
    assert.deepEqual(result.ocr, payload);

    const defaultRequest = await fetch(`${base}${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
    assert.equal(defaultRequest.status, 200);
    assert.deepEqual(calls, ["group/sub/repo", undefined]);
    const ai = await post(memberToken, base, "/api/verify/ai");
    assert.equal(ai.status, 200);
    const aiBody = (await ai.json()) as { taskId: string };
    assert.equal((await waitTask(memberToken, base, aiBody.taskId)).status, "success");
  });
});

test("OCR 验证拒绝自定义代码、URL 和非完整项目路径", async () => {
  const { verifier } = fakeVerifier({});
  let calls = 0;
  const { app, token } = buildHarness(verifier, async () => {
    calls++;
    return { success: true, message: "OCR 通过", detail: "", durationMs: 0 };
  });
  await withServer(app, async (base) => {
    for (const payload of [[], { code: "irrelevant" }, { url: "https://example.com" }, { project: null },
      { project: 12 }, { project: "" }, { project: "repo" }, { project: "group//repo" }, { project: "../repo" },
      { project: "group/repo", unknown: true }]) {
      assert.equal((await post(token, base, "/api/verify/ocr", payload)).status, 400, JSON.stringify(payload));
    }
    const nonJson = await fetch(`${base}/api/verify/ocr`, {
      method: "POST", headers: { "Content-Type": "text/plain", Authorization: `Bearer ${token}` }, body: "group/repo",
    });
    assert.equal(nonJson.status, 400);
    assert.equal(calls, 0);
  });
});

test("OCR 并发占用只在该任务结束后释放，不受同时运行的 AI 验证影响", async () => {
  let completeAi!: (result: VerifyOutcome) => void;
  const aiResult = new Promise<VerifyOutcome>((resolve) => { completeAi = resolve; });
  let completeOcr!: (result: OcrSelfTestOutcome) => void;
  const ocrResult = new Promise<OcrSelfTestOutcome>((resolve) => { completeOcr = resolve; });
  const { verifier } = fakeVerifier({ ai: () => aiResult });
  const { app, token } = buildHarness(verifier, () => ocrResult);
  await withServer(app, async (base) => {
    const ai = await post(token, base, "/api/verify/ai");
    const ocr = await post(token, base, "/api/verify/ocr");
    assert.equal(ai.status, 200);
    assert.equal(ocr.status, 200);
    const { taskId: aiTaskId } = (await ai.json()) as { taskId: string };
    const { taskId: ocrTaskId } = (await ocr.json()) as { taskId: string };
    assert.equal((await post(token, base, "/api/verify/ai")).status, 409);
    assert.equal((await post(token, base, "/api/verify/ocr")).status, 409);

    completeAi({ success: true, message: "AI 通过", detail: "", durationMs: 10 });
    await waitTask(token, base, aiTaskId);
    assert.equal((await post(token, base, "/api/verify/ocr")).status, 409);

    completeOcr({ success: false, message: "OCR 验证失败", detail: "", durationMs: 20 });
    assert.equal((await waitTask(token, base, ocrTaskId)).status, "failed");
    assert.equal((await post(token, base, "/api/verify/ocr")).status, 200);
  });
});

test("OCR 验证器意外抛错时返回脱敏的失败结果并释放占用", async () => {
  const { verifier } = fakeVerifier({});
  const { app, token } = buildHarness(verifier, async () => { throw new Error("sensitive upstream error detail"); });
  await withServer(app, async (base) => {
    const res = await post(token, base, "/api/verify/ocr");
    assert.equal(res.status, 200);
    const { taskId } = (await res.json()) as { taskId: string };
    const task = await waitTask(token, base, taskId);
    assert.equal(task.status, "failed");
    assert.doesNotMatch(JSON.stringify(task), /sensitive upstream error detail/);
    assert.equal((await post(token, base, "/api/verify/ocr")).status, 200);
  });
});

test("企微默认只预览，不真的发送", async () => {
  const calls: { wecom: VerifyWecomOptions[] } = { wecom: [] };
  const { verifier } = fakeVerifier({ calls });
  const { app, token } = buildHarness(verifier);
  await withServer(app, async (base) => {
    const { taskId } = (await (await post(token, base, "/api/verify/wecom", { gitlabUsername: " code-author ", webhookId: "aaaaaaaaaaaa" })).json()) as { taskId: string };
    await waitTask(token, base, taskId);
    assert.equal(calls.wecom.length, 1);
    assert.equal(calls.wecom[0].dryRun, true, "未确认时必须走预览");
    assert.equal(calls.wecom[0].gitlabUsername, "code-author", "所选提交人必须传到验证用例");
  });
});

test("企微 confirmSend=true 时才真实发送", async () => {
  const calls: { wecom: VerifyWecomOptions[] } = { wecom: [] };
  const { verifier } = fakeVerifier({ calls });
  const { app, token } = buildHarness(verifier);
  await withServer(app, async (base) => {
    const { taskId } = (await (await post(token, base, "/api/verify/wecom", { confirmSend: true, gitlabUsername: "code-author", webhookId: "aaaaaaaaaaaa" })).json()) as { taskId: string };
    await waitTask(token, base, taskId);
    assert.equal(calls.wecom[0].dryRun, false, "确认后必须真实发送");
    assert.equal(calls.wecom[0].gitlabUsername, "code-author", "发送与预览必须使用同一提交人字段");
  });
});

test("机器人 id 格式非法时拒绝，合法 id 放行", async () => {
  const { verifier } = fakeVerifier({});
  const { app, token } = buildHarness(verifier);
  await withServer(app, async (base) => {
    const bad = await post(token, base, "/api/verify/wecom", { confirmSend: true, webhookId: "not-a-url", gitlabUsername: "code-author" });
    assert.equal(bad.status, 400);
    const ok = await post(token, base, "/api/verify/wecom", { confirmSend: true, webhookId: "aaaaaaaaaaaa", gitlabUsername: "code-author" });
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

test("自检缺少或伪造提交人账号时返回 400，不启动验证任务", async () => {
  const { verifier, calls } = fakeVerifier({});
  const { app, token } = buildHarness(verifier);
  await withServer(app, async (base) => {
    for (const body of [{}, { gitlabUsername: 12 }, { gitlabUsername: "  " }, { gitlabUsername: "<@all>" }]) {
      const res = await post(token, base, "/api/verify/wecom", { ...body, confirmSend: true });
      assert.equal(res.status, 400);
      assert.match((await res.json() as { error: string }).error, /提交人/);
    }
    assert.equal(calls.wecom.length, 0);
  });
});

test("HTTP 自检通过真实用例与内存映射仓储，预览末行保留提交人提及", async (t) => {
  // 不只验证参数桩：锁定实际 HTTP → 用例 → 映射仓储 → 消息模板这一整段链路。
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const contacts = createWecomContactRepository(db);
  contacts.upsert({ gitlabUsername: "selected-author", wecomName: "测试提交人", wecomUserId: "selected_member" });
  // 测试自带隔离机器人规则，不能依赖开发机 prompts/rules 中恰好存在真实 webhook。
  const rulesDir = mkdtempSync(join(tmpdir(), "cr-pilot-verify-rules-"));
  t.after(() => rmSync(rulesDir, { recursive: true, force: true }));
  writeFileSync(join(rulesDir, "verify.yaml"), [
    "repository: group/verify",
    "wecom_webhook_url: https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=verify_test_key_123456",
    "wecom_score_threshold: 70",
    "code_review_prompt:",
    "  system_prompt: VERIFY",
    "  user_prompt: \"评：{diffs_text}\"",
  ].join("\n"));
  const verifier = createFeatureVerifier({
    config: loadConfig({ REVIEW_RULES_DIR: rulesDir }),
    logger: createSilentLogger(),
    wecomContacts: contacts,
  });
  const { app, token } = buildHarness(verifier);
  await withServer(app, async (base) => {
    // 用仓库里真实配置的机器人 id，避免测试依赖硬编码的合成 id。
    const bots = (await (await get(token, base, "/api/verify/wecom-bots")).json()) as {
      items: { id: string; maskedKey: string; repositories: string[] }[];
    };
    assert.ok(bots.items.length > 0, "仓库里应至少配置了一个企微机器人");
    const target = bots.items[0];
    // 预览路径不会发起任何网络请求（dryRun 只组装消息），因此无需替身 fetch。
    const res = await post(token, base, "/api/verify/wecom", {
      gitlabUsername: "selected-author",
      confirmSend: false,
      webhookId: target.id,
    });
    assert.equal(res.status, 200);
    const { taskId } = await res.json() as { taskId: string };
    const task = await waitTask(token, base, taskId);
    assert.equal(task.status, "success");
    assert.ok(task.detail.endsWith("\n\n<@se**er>"), "轮询结果只返回脱敏 userid");
    assert.equal(task.detail.includes("selected_member"), false);
    assert.match(task.detail, /机器人 \*\*\*\*/, "结果里应标明所选机器人（脱敏）");
  });
});

// ============ 企微机器人选择 ============

test("机器人列表接口返回脱敏信息，不下发 webhook 地址", async () => {
  const { verifier } = fakeVerifier({
    bots: [
      { id: "aaaaaaaaaaaa", maskedKey: "****bbbb", repositories: ["group/a", "group/b"] },
      { id: "cccccccccccc", maskedKey: "****dddd", repositories: ["group/c"] },
    ],
  });
  const { app, token } = buildHarness(verifier);
  await withServer(app, async (base) => {
    const res = await get(token, base, "/api/verify/wecom-bots");
    assert.equal(res.status, 200);
    const body = (await res.json()) as { items: { id: string; maskedKey: string; repositories: string[] }[] };
    assert.equal(body.items.length, 2);
    assert.equal(body.items[0].id, "aaaaaaaaaaaa");
    assert.equal(body.items[0].maskedKey, "****bbbb");
    assert.equal(JSON.stringify(body).includes("qyapi.weixin.qq.com"), false);
  });
});

test("未选择机器人时返回 400，不启动任务", async () => {
  const { verifier, calls } = fakeVerifier({});
  const { app, token } = buildHarness(verifier);
  await withServer(app, async (base) => {
    for (const body of [{}, { webhookId: "" }, { webhookId: "not-an-id" }, { webhookId: "<script>" }]) {
      const res = await post(token, base, "/api/verify/wecom", { gitlabUsername: "code-author", ...body });
      assert.equal(res.status, 400);
      assert.match((await res.json() as { error: string }).error, /机器人/);
    }
    assert.equal(calls.wecom.length, 0);
  });
});

test("选择机器人后按 id 传入验证用例，不接受任意 webhook 地址", async () => {
  const { verifier, calls } = fakeVerifier({});
  const { app, token } = buildHarness(verifier);
  await withServer(app, async (base) => {
    const res = await post(token, base, "/api/verify/wecom", {
      gitlabUsername: "code-author",
      webhookId: "aaaaaaaaaaaa",
      confirmSend: false,
      // 旧字段即使被传入也不能生效：地址只能由服务端按 id 解析。
      webhook: "https://evil.example.com/collect",
    });
    assert.equal(res.status, 200);
    const { taskId } = (await res.json()) as { taskId: string };
    await waitTask(token, base, taskId);
    assert.equal(calls.wecom[0].webhookId, "aaaaaaaaaaaa");
    assert.equal(calls.wecom[0].webhookOverride, undefined, "HTTP 侧不得把任意地址传给发送器");
  });
});
