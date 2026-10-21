import { test } from "node:test";
import assert from "node:assert/strict";
import type { Express } from "express";
import { createApp } from "../../../src/interfaces/http/app.ts";
import { createAuthMiddleware } from "../../../src/interfaces/http/auth-middleware.ts";
import { createAuthRouter } from "../../../src/interfaces/http/api/auth.ts";
import { createWecomContactsRouter } from "../../../src/interfaces/http/api/wecom-contacts.ts";
import { openDatabase } from "../../../src/infrastructure/sqlite/database.ts";
import { createAdminRepository } from "../../../src/infrastructure/sqlite/admin-repo.ts";
import { createWecomContactRepository } from "../../../src/infrastructure/sqlite/wecom-contact-repo.ts";
import { createSilentLogger } from "../../../src/shared/logger.ts";
import { deriveToken } from "../../../src/shared/crypto.ts";

const AUTH_SALT = "test-auth-salt";
const ADMIN = "admin";
const ADMIN_PASSWORD = "admin-password";

/** 真实 SQLite 内存库 + 真实 Express 应用，避免 mock 掉需要证明的路由与持久化。 */
function buildHarness(): { app: Express; token: string } {
  const db = openDatabase(":memory:");
  const admins = createAdminRepository(db, AUTH_SALT, ADMIN);
  admins.ensureInitialAdmin(ADMIN, ADMIN_PASSWORD);
  const contacts = createWecomContactRepository(db);
  const authMiddleware = createAuthMiddleware({ admins, authSalt: AUTH_SALT });
  const app = createApp({
    logger: createSilentLogger(),
    enqueue: () => {},
    publicApiRoutes: { "/api/auth": createAuthRouter({ admins, authSalt: AUTH_SALT, authMiddleware }) },
    authMiddleware,
    apiRoutes: { "/api/wecom-contacts": createWecomContactsRouter({ contacts }) },
    staticAssets: [],
  });
  return { app, token: deriveToken(ADMIN, AUTH_SALT) };
}

/** 起一次临时监听并执行断言，结束后关闭。 */
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

/** 带令牌的请求。 */
function authed(token: string, base: string, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
}

test("映射接口未携带令牌时返回 401", async () => {
  const { app } = buildHarness();
  await withServer(app, async (base) => {
    assert.equal((await fetch(`${base}/api/wecom-contacts`)).status, 401);
  });
});

test("保存后可列出，重复保存同一账号是更新", async () => {
  const { app, token } = buildHarness();
  await withServer(app, async (base) => {
    const created = await authed(token, base, "/api/wecom-contacts", {
      method: "PUT",
      body: JSON.stringify({ gitlabUsername: "samxiao", wecomName: "王秦", wecomUserId: "wangqin" }),
    });
    assert.equal(created.status, 200);
    const saved = (await created.json()) as { gitlabUsername: string; wecomName: string };
    assert.equal(saved.gitlabUsername, "samxiao");

    const updated = await authed(token, base, "/api/wecom-contacts", {
      method: "PUT",
      body: JSON.stringify({ gitlabUsername: "SamXiao", wecomName: "王秦", wecomUserId: "" }),
    });
    assert.equal(updated.status, 200);

    const listed = await authed(token, base, "/api/wecom-contacts");
    const items = (await listed.json()) as { gitlabUsername: string; wecomName: string; wecomUserId: string }[];
    assert.equal(items.length, 1, "大小写不同的同一账号不能产生两条");
    assert.equal(items[0].wecomUserId, "", "后一次保存覆盖 userid");
  });
});

test("请求体非法时返回 400 且不落库", async () => {
  const { app, token } = buildHarness();
  await withServer(app, async (base) => {
    const cases: Record<string, unknown>[] = [
      {},
      { gitlabUsername: "" },
      { gitlabUsername: "张三", wecomName: "王秦" },
      { gitlabUsername: "ok-user", wecomName: "", wecomUserId: "" },
      { gitlabUsername: "ok-user", wecomName: "all" },
      { gitlabUsername: "ok-user", wecomName: "王秦", wecomUserId: "all" },
      { gitlabUsername: "ok-user", wecomName: "王秦", wecomUserId: "bad id" },
      { gitlabUsername: "ok-user", wecomName: "王秦\n<@all>" },
    ];
    for (const body of cases) {
      const res = await authed(token, base, "/api/wecom-contacts", { method: "PUT", body: JSON.stringify(body) });
      assert.equal(res.status, 400, `应拒绝：${JSON.stringify(body)}`);
    }
    const listed = await authed(token, base, "/api/wecom-contacts");
    assert.deepEqual(await listed.json(), [], "非法请求不能留下记录");
  });
});

test("删除映射成功返回 ok，不存在时返回 404", async () => {
  const { app, token } = buildHarness();
  await withServer(app, async (base) => {
    await authed(token, base, "/api/wecom-contacts", {
      method: "PUT",
      body: JSON.stringify({ gitlabUsername: "samxiao", wecomName: "王秦" }),
    });
    const removed = await authed(token, base, "/api/wecom-contacts/samxiao", { method: "DELETE" });
    assert.equal(removed.status, 200);
    const again = await authed(token, base, "/api/wecom-contacts/samxiao", { method: "DELETE" });
    assert.equal(again.status, 404);
  });
});
