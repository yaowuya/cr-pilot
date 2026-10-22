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
function buildHarness(): { app: Express; contacts: ReturnType<typeof createWecomContactRepository>; token: string } {
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
  return { app, contacts, token: deriveToken(ADMIN, AUTH_SALT) };
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
      // 明确清除：编辑姓名时如果 userid 为空，不应意外删除原有映射。
      body: JSON.stringify({ gitlabUsername: "SamXiao", wecomName: "王秦", clearWecomUserId: true }),
    });
    assert.equal(updated.status, 200);

    const listed = await authed(token, base, "/api/wecom-contacts");
    const items = (await listed.json()) as { gitlabUsername: string; wecomName: string; hasWecomUserId: boolean; wecomUserIdMasked: string }[];
    assert.equal(items.length, 1, "大小写不同的同一账号不能产生两条");
    assert.equal(items[0].hasWecomUserId, false, "显式清除后不再有 userid");
    assert.equal(items[0].wecomUserIdMasked, "");
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

test("GET 与 PUT 仅返回中间掩码，编辑姓名时保留原 userid，清除须显式确认", async () => {
  const { app, token, contacts } = buildHarness();
  const syntheticId = "synthetic_98765";
  await withServer(app, async (base) => {
    const created = await authed(token, base, "/api/wecom-contacts", {
      method: "PUT", body: JSON.stringify({ gitlabUsername: "author", wecomName: "示例人", wecomUserId: syntheticId }),
    });
    assert.equal(created.status, 200);
    const createdBody = await created.text();
    assert.equal(createdBody.includes(syntheticId), false, "PUT 响应不应回显完整 userid");
    const saved = JSON.parse(createdBody) as { hasWecomUserId: boolean; wecomUserIdMasked: string; wecomUserId?: string };
    assert.equal(saved.hasWecomUserId, true);
    assert.match(saved.wecomUserIdMasked, /^.{2}\*\*.{2}$/);
    assert.equal(saved.wecomUserId, undefined);

    const listedBody = await (await authed(token, base, "/api/wecom-contacts")).text();
    assert.equal(listedBody.includes(syntheticId), false, "GET 响应不应泄露完整 userid");
    assert.equal(JSON.parse(listedBody)[0].wecomUserIdMasked, saved.wecomUserIdMasked);

    const edited = await authed(token, base, "/api/wecom-contacts", {
      method: "PUT", body: JSON.stringify({ gitlabUsername: "AUTHOR", wecomName: "已改姓名", wecomUserId: "" }),
    });
    assert.equal(edited.status, 200);
    assert.equal(contacts.findByGitlabUsername("author")?.wecomUserId, syntheticId, "空输入应保留原 userid");
    assert.equal((await edited.json() as { hasWecomUserId: boolean }).hasWecomUserId, true);

    const cleared = await authed(token, base, "/api/wecom-contacts", {
      method: "PUT", body: JSON.stringify({ gitlabUsername: "author", wecomName: "已改姓名", clearWecomUserId: true }),
    });
    assert.equal(cleared.status, 200);
    assert.equal(contacts.findByGitlabUsername("author")?.wecomUserId, "");
    assert.equal((await cleared.json() as { hasWecomUserId: boolean }).hasWecomUserId, false);
  });
});

test("短 userid 不得露出全部字符；清除与替换不能同时提交", async () => {
  const { app, token, contacts } = buildHarness();
  await withServer(app, async (base) => {
    for (const userId of ["a", "ab", "abcd"]) {
      const response = await authed(token, base, "/api/wecom-contacts", {
        method: "PUT", body: JSON.stringify({ gitlabUsername: `short${userId.length}`, wecomName: "短号", wecomUserId: userId }),
      });
      const body = await response.text();
      assert.equal(body.includes(`\"${userId}\"`), false, "短 userid 不得完整出现于响应中");
      assert.equal((JSON.parse(body) as { wecomUserIdMasked: string }).wecomUserIdMasked, "**");
    }
    const conflict = await authed(token, base, "/api/wecom-contacts", {
      method: "PUT", body: JSON.stringify({ gitlabUsername: "short2", wecomName: "短号", wecomUserId: "new", clearWecomUserId: true }),
    });
    assert.equal(conflict.status, 400);
    assert.equal(contacts.findByGitlabUsername("short2")?.wecomUserId, "ab");
  });
});

test("只有 userid 的映射可留空编辑；不能清除后留下空映射", async () => {
  const { app, token, contacts } = buildHarness();
  await withServer(app, async (base) => {
    const created = await authed(token, base, "/api/wecom-contacts", {
      method: "PUT", body: JSON.stringify({ gitlabUsername: "id-only", wecomUserId: "sample_member" }),
    });
    assert.equal(created.status, 200);
    const retained = await authed(token, base, "/api/wecom-contacts", {
      method: "PUT", body: JSON.stringify({ gitlabUsername: "id-only", wecomName: "", wecomUserId: "" }),
    });
    assert.equal(retained.status, 200);
    assert.equal(contacts.findByGitlabUsername("id-only")?.wecomUserId, "sample_member");
    const invalidClear = await authed(token, base, "/api/wecom-contacts", {
      method: "PUT", body: JSON.stringify({ gitlabUsername: "id-only", wecomName: "", clearWecomUserId: true }),
    });
    assert.equal(invalidClear.status, 400);
    assert.equal(contacts.findByGitlabUsername("id-only")?.wecomUserId, "sample_member");
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
