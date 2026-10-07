import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Express } from "express";
import { createApp } from "../../../src/interfaces/http/app.ts";
import { createAuthMiddleware } from "../../../src/interfaces/http/auth-middleware.ts";
import { createAuthRouter } from "../../../src/interfaces/http/api/auth.ts";
import { createAdminsRouter } from "../../../src/interfaces/http/api/admins.ts";
import { createConfigRouter } from "../../../src/interfaces/http/api/config.ts";
import { createPromptsRouter } from "../../../src/interfaces/http/api/prompts.ts";
import { createReviewsRouter } from "../../../src/interfaces/http/api/reviews.ts";
import { createStaticAssets } from "../../../src/interfaces/http/static-assets.ts";
import { openDatabase } from "../../../src/infrastructure/sqlite/database.ts";
import { createAdminRepository } from "../../../src/infrastructure/sqlite/admin-repo.ts";
import { createConfigRepository } from "../../../src/infrastructure/sqlite/config-repo.ts";
import { createPromptRepository } from "../../../src/infrastructure/sqlite/prompt-repo.ts";
import { createReviewRecordRepository } from "../../../src/infrastructure/sqlite/review-record-repo.ts";
import { createSilentLogger } from "../../../src/shared/logger.ts";
import { deriveToken } from "../../../src/shared/crypto.ts";

const AUTH_SALT = "test-auth-salt";
const ADMIN = "admin";
const ADMIN_PASSWORD = "admin-password";

/** 一组测试装置：真实 SQLite 内存库 + 真实 Express 应用。 */
interface Harness {
  app: Express;
  token: string;
  dbDir: string;
}

function buildHarness(options: { distDir?: string; rulesDir?: string } = {}): Harness {
  const db = openDatabase(":memory:");
  const admins = createAdminRepository(db, AUTH_SALT);
  admins.ensureInitialAdmin(ADMIN, ADMIN_PASSWORD);
  const config = createConfigRepository(db);
  const prompts = createPromptRepository(db);
  const records = createReviewRecordRepository(db);

  const authMiddleware = createAuthMiddleware({ admins, authSalt: AUTH_SALT });
  const app = createApp({
    logger: createSilentLogger(),
    enqueue: () => {},
    publicApiRoutes: { "/api/auth": createAuthRouter({ admins, authSalt: AUTH_SALT, authMiddleware }) },
    authMiddleware,
    apiRoutes: {
      "/api/admins": createAdminsRouter({ admins }),
      "/api/reviews": createReviewsRouter({ records }),
      "/api/config": createConfigRouter({ config }),
      "/api/prompts": createPromptsRouter({ prompts, rulesDir: options.rulesDir ?? "prompts/rules" }),
    },
    staticAssets: options.distDir ? createStaticAssets({ distDir: options.distDir, logger: createSilentLogger() }) : [],
  });

  return { app, token: deriveToken(ADMIN, AUTH_SALT), dbDir: "" };
}

/** 用 fetch 直接打 Express 应用（监听 0 端口取随机端口）。 */
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

/** 带令牌的请求辅助。 */
function authed(base: string, token: string, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
}

// ============ backend-017：认证路由 ============

test("登录成功返回令牌，失败返回 401 且不区分原因", async () => {
  const { app, token } = buildHarness();
  await withServer(app, async (base) => {
    const ok = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: ADMIN, password: ADMIN_PASSWORD }),
    });
    assert.equal(ok.status, 200);
    const body = (await ok.json()) as { token: string; username: string };
    assert.equal(body.token, token);
    assert.equal(body.username, ADMIN);

    const bad = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: ADMIN, password: "wrong" }),
    });
    assert.equal(bad.status, 401);
    const missing = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "nobody", password: ADMIN_PASSWORD }),
    });
    assert.equal(missing.status, 401);
    assert.deepEqual(await bad.json(), await missing.json(), "两种失败必须返回相同响应体，避免账号枚举");

    const empty = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(empty.status, 400);
  });
});

test("me 返回当前用户名，logout 返回 ok", async () => {
  const { app, token } = buildHarness();
  await withServer(app, async (base) => {
    const me = await authed(base, token, "/api/auth/me");
    assert.equal(me.status, 200);
    assert.deepEqual(await me.json(), { username: ADMIN });
    const out = await authed(base, token, "/api/auth/logout", { method: "POST" });
    assert.equal(out.status, 200);
  });
});

test("me 未携带令牌时返回 401", async () => {
  const { app } = buildHarness();
  await withServer(app, async (base) => {
    assert.equal((await fetch(`${base}/api/auth/me`)).status, 401, "前端据此判定本地令牌失效");
  });
});

// ============ backend-014：鉴权 ============

test("无令牌与错误令牌访问管理接口均返回 401", async () => {
  const { app } = buildHarness();
  await withServer(app, async (base) => {
    assert.equal((await fetch(`${base}/api/reviews`)).status, 401);
    assert.equal((await fetch(`${base}/api/reviews`, { headers: { Authorization: "Bearer deadbeef" } })).status, 401);
    assert.equal((await fetch(`${base}/api/reviews`, { headers: { Authorization: "Basic abc" } })).status, 401);
  });
});

test("有效令牌可访问管理接口，health 与 webhook 不需要令牌", async () => {
  const { app, token } = buildHarness();
  await withServer(app, async (base) => {
    assert.equal((await authed(base, token, "/api/reviews")).status, 200);
    assert.equal((await fetch(`${base}/health`)).status, 200);
    const hook = await fetch(`${base}/review/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ object_kind: "push" }),
    });
    assert.equal(hook.status, 400, "webhook 保持原有语义");
  });
});

// ============ backend-018：管理员账号 ============

test("管理员列表不含密码哈希，新增后返回账号", async () => {
  const { app, token } = buildHarness();
  await withServer(app, async (base) => {
    const list = (await (await authed(base, token, "/api/admins")).json()) as Record<string, unknown>[];
    assert.equal(list.length, 1);
    assert.equal("passwordHash" in list[0], false, "列表不得返回密码哈希");

    const created = await authed(base, token, "/api/admins", {
      method: "POST",
      body: JSON.stringify({ username: "second", password: "long-enough-pw" }),
    });
    assert.equal(created.status, 200);
    const body = (await created.json()) as { id: number; username: string };
    assert.equal(body.username, "second");
    assert.equal("passwordHash" in body, false);
  });
});

test("重复用户名返回 409，密码过短返回 400", async () => {
  const { app, token } = buildHarness();
  await withServer(app, async (base) => {
    const dup = await authed(base, token, "/api/admins", {
      method: "POST",
      body: JSON.stringify({ username: ADMIN, password: "long-enough-pw" }),
    });
    assert.equal(dup.status, 409);
    const short = await authed(base, token, "/api/admins", {
      method: "POST",
      body: JSON.stringify({ username: "third", password: "short" }),
    });
    assert.equal(short.status, 400);
    assert.equal((await short.json() as { error: string }).error.includes("8"), true);
  });
});

test("删除自己被拒，删除他人成功，删除最后一个被拒", async () => {
  const { app, token } = buildHarness();
  await withServer(app, async (base) => {
    const list = (await (await authed(base, token, "/api/admins")).json()) as { id: number; username: string }[];
    const self = list[0];
    const selfDelete = await authed(base, token, `/api/admins/${self.id}`, { method: "DELETE" });
    assert.equal(selfDelete.status, 400);
    assert.match((await selfDelete.json() as { error: string }).error, /不能删除当前登录/);

    const created = (await (
      await authed(base, token, "/api/admins", {
        method: "POST",
        body: JSON.stringify({ username: "temp", password: "long-enough-pw" }),
      })
    ).json()) as { id: number };
    assert.equal((await authed(base, token, `/api/admins/${created.id}`, { method: "DELETE" })).status, 200);

    // 只剩自己一个：自删约束先于「最后一个」判定。
    const again = await authed(base, token, `/api/admins/${self.id}`, { method: "DELETE" });
    assert.equal(again.status, 400);

    assert.equal((await authed(base, token, "/api/admins/9999", { method: "DELETE" })).status, 404);
    assert.equal((await authed(base, token, "/api/admins/abc", { method: "DELETE" })).status, 400);
  });
});

// ============ backend-019：评审记录 ============

test("评审记录返回分页结构，非法 pageSize 与倒置时间范围返回 400", async () => {
  const { app, token } = buildHarness();
  await withServer(app, async (base) => {
    const ok = await authed(base, token, "/api/reviews?page=1&pageSize=10");
    assert.equal(ok.status, 200);
    const body = (await ok.json()) as { items: unknown[]; total: number; page: number; pageSize: number };
    assert.deepEqual(body.items, []);
    assert.equal(body.total, 0);
    assert.equal(body.pageSize, 10);
    assert.equal((await authed(base, token, "/api/reviews?pageSize=99999")).status, 400);
    assert.equal((await authed(base, token, "/api/reviews?page=0")).status, 400);
    assert.equal((await authed(base, token, "/api/reviews?from=200&to=100")).status, 400);
  });
});

test("评审统计返回全部字段", async () => {
  const { app, token } = buildHarness();
  await withServer(app, async (base) => {
    const res = await authed(base, token, "/api/reviews/stats");
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    for (const key of ["total", "projectCount", "committerCount", "avgScore", "daily"]) {
      assert.ok(key in body, `缺少字段 ${key}`);
    }
    assert.equal(body.total, 0);
    assert.equal(body.avgScore, null, "没有分数时不得返回 0");
  });
});

// ============ backend-020：环境变量管理 ============

test("密钥字段掩码返回，更新同步 process.env 并标注需重启项", async () => {
  const { app, token } = buildHarness();
  const originalKey = process.env.LLMGW_API_KEY;
  try {
    process.env.LLMGW_API_KEY = "sk-abcdefghijklmnop";
    await withServer(app, async (base) => {
      const res = await authed(base, token, "/api/config");
      const body = (await res.json()) as { items: { key: string; value: string; masked: boolean; restartRequired: boolean }[] };
      const keyItem = body.items.find((item) => item.key === "LLMGW_API_KEY");
      assert.ok(keyItem, "应包含密钥项");
      assert.equal(keyItem.masked, true);
      assert.match(keyItem.value, /\*\*\*\*/);
      assert.doesNotMatch(keyItem.value, /efghij/, "掩码不得泄露中间内容");
      assert.equal(keyItem.restartRequired, true, "pi 读取的密钥需重启才生效");

      const put = await authed(base, token, "/api/config", {
        method: "PUT",
        body: JSON.stringify({ items: [{ key: "QUEUE_CONCURRENCY", value: "7" }, { key: "PORT", value: "6001" }] }),
      });
      assert.equal(put.status, 200);
      const updated = (await put.json()) as { restartRequired: string[] };
      assert.deepEqual(updated.restartRequired, ["PORT"], "只有启动期绑定项需重启");
      assert.equal(process.env.QUEUE_CONCURRENCY, "7", "可热更新项必须同步到进程环境变量");
      assert.equal(process.env.PORT, "6001");
    });
  } finally {
    if (originalKey === undefined) delete process.env.LLMGW_API_KEY;
    else process.env.LLMGW_API_KEY = originalKey;
    delete process.env.QUEUE_CONCURRENCY;
    delete process.env.PORT;
  }
});

test("配置更新拒绝非数组与缺 key 的请求体", async () => {
  const { app, token } = buildHarness();
  await withServer(app, async (base) => {
    assert.equal((await authed(base, token, "/api/config", { method: "PUT", body: JSON.stringify({}) })).status, 400);
    assert.equal(
      (await authed(base, token, "/api/config", { method: "PUT", body: JSON.stringify({ items: [{ value: "x" }] }) })).status,
      400,
    );
  });
});

// ============ backend-021：prompt 管理 ============

test("prompt 增删改查与回落 default", async () => {
  const { app, token } = buildHarness();
  await withServer(app, async (base) => {
    const created = await authed(base, token, "/api/prompts", {
      method: "POST",
      body: JSON.stringify({ repository: "group/proj", system_prompt: "SYS", user_prompt: "u {diffs_text}" }),
    });
    assert.equal(created.status, 200);
    const prompt = (await created.json()) as { id: number };

    // 列表不含正文
    const list = (await (await authed(base, token, "/api/prompts")).json()) as Record<string, unknown>[];
    assert.equal("systemPrompt" in list[0], false, "列表不得返回完整正文");

    // 详情含正文
    const detail = (await (await authed(base, token, `/api/prompts/${prompt.id}`)).json()) as { systemPrompt: string };
    assert.equal(detail.systemPrompt, "SYS");

    // 重复 repository → 409
    const dup = await authed(base, token, "/api/prompts", {
      method: "POST",
      body: JSON.stringify({ repository: "group/proj", system_prompt: "S2", user_prompt: "u" }),
    });
    assert.equal(dup.status, 409);

    // 更新
    const updated = await authed(base, token, `/api/prompts/${prompt.id}`, {
      method: "PUT",
      body: JSON.stringify({ system_prompt: "SYS2", user_prompt: "u2 {diffs_text}" }),
    });
    assert.equal(updated.status, 200);
    assert.equal(((await updated.json()) as { systemPrompt: string }).systemPrompt, "SYS2");

    // 空正文 → 400
    assert.equal(
      (await authed(base, token, `/api/prompts/${prompt.id}`, { method: "PUT", body: JSON.stringify({ system_prompt: "", user_prompt: "u" }) })).status,
      400,
    );

    // 删除
    assert.equal((await authed(base, token, `/api/prompts/${prompt.id}`, { method: "DELETE" })).status, 200);
    assert.equal((await authed(base, token, `/api/prompts/${prompt.id}`)).status, 404);
    assert.equal((await authed(base, token, "/api/prompts/abc")).status, 400);
  });
});

test("prompt 导入接口返回导入与跳过计数", async () => {
  const dir = mkdtempSync(join(tmpdir(), "crp-rules-"));
  try {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      join(dir, "proj.yaml"),
      ["repository: group/imported", "code_review_prompt:", "  system_prompt: SYS", "  user_prompt: u {diffs_text}"].join("\n"),
    );
    const { app, token } = buildHarness({ rulesDir: dir });
    await withServer(app, async (base) => {
      const res = await authed(base, token, "/api/prompts/import", { method: "POST" });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { imported: 1, skipped: 0 });
      // 重复导入全部跳过
      const again = await authed(base, token, "/api/prompts/import", { method: "POST" });
      assert.deepEqual(await again.json(), { imported: 0, skipped: 1 });
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============ backend-022：静态资源与 SPA fallback ============

test("SPA fallback 排除 /api 与 /review 前缀", async () => {
  const distDir = mkdtempSync(join(tmpdir(), "crp-dist-"));
  try {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(distDir, "index.html"), '<!doctype html><html><body><div id="app"></div></body></html>');
    const { app, token } = buildHarness({ distDir });
    await withServer(app, async (base) => {
      const apiMiss = await fetch(`${base}/api/not-exist`, { headers: { Authorization: `Bearer ${token}` } });
      assert.equal(apiMiss.status, 404);
      assert.match(apiMiss.headers.get("content-type") ?? "", /application\/json/, "未匹配 API 必须返回 JSON");

      for (const path of ["/", "/reviews", "/prompts"]) {
        const page = await fetch(`${base}${path}`);
        assert.equal(page.status, 200, `${path} 应回落到 index.html`);
        assert.match(await page.text(), /<div id="app">/);
      }

      // 既有路由不受静态托管影响
      assert.equal((await fetch(`${base}/health`)).status, 200);
    });
  } finally {
    rmSync(distDir, { recursive: true, force: true });
  }
});

test("未构建前端时跳过静态托管，API 仍可用", async () => {
  const missing = join(tmpdir(), "definitely-not-built-crp");
  const { app, token } = buildHarness({ distDir: missing });
  await withServer(app, async (base) => {
    assert.equal((await authed(base, token, "/api/reviews")).status, 200);
    assert.equal((await fetch(`${base}/reviews`)).status, 404, "没有产物时不提供 SPA fallback");
  });
});

test("相对产物路径也能托管（sendFile 需要绝对路径）", async () => {
  // 回归：曾用相对路径调 res.sendFile 导致 500「path must be absolute」。
  // 生产配置 WEB_DIST_DIR 就是相对路径，必须确保它可用。
  const relativeDir = join("web", "dist");
  if (!existsSync(join(process.cwd(), relativeDir, "index.html"))) {
    // 未构建前端时跳过（CI 或纯后端开发环境）。
    return;
  }
  const { app, token } = buildHarness({ distDir: relativeDir });
  await withServer(app, async (base) => {
    const page = await fetch(`${base}/reviews`);
    assert.equal(page.status, 200, "相对路径必须能正常返回 index.html");
    assert.match(await page.text(), /<div id="app">/);
    // 静态资源与 API 隔离同时成立
    assert.equal((await authed(base, token, "/api/reviews")).status, 200);
    assert.match((await fetch(`${base}/api/not-exist`)).headers.get("content-type") ?? "", /application\/json/);
  });
});
