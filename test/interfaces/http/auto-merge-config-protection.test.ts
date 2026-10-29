import assert from "node:assert/strict";
import { test } from "node:test";
import express, { type Express } from "express";
import type { ConfigOverride, ConfigRepository } from "../../../src/domain/runtime-config.ts";
import { createConfigRouter } from "../../../src/interfaces/http/api/config.ts";

interface ConfigHarness {
  app: Express;
  values: Map<string, string>;
}

/** 用内存端口观察路由写入；权限判断仍通过真实 HTTP 与 Router 执行。 */
function buildHarness(): ConfigHarness {
  const values = new Map<string, string>();
  const config: ConfigRepository = {
    list: () => [...values].map(([key, value], index) => ({ key, value, updatedAt: index + 1 }) satisfies ConfigOverride),
    setAll: (items) => items.forEach((item) => values.set(item.key, item.value)),
    clear: (keys) => keys.forEach((key) => values.delete(key)),
  };
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    res.locals.isAdmin = req.headers["x-test-admin"] === "true";
    next();
  });
  app.use("/api/config", createConfigRouter({ config }));
  return { app, values };
}

async function withServer<T>(app: Express, run: (base: string) => Promise<T>): Promise<T> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function request(base: string, path: string, init: RequestInit = {}, admin = false): Promise<Response> {
  return fetch(`${base}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(admin ? { "X-Test-Admin": "true" } : {}),
      ...(init.headers ?? {}),
    },
  });
}

test("运行配置属于自动合并信任根，普通账号始终不能更新", async () => {
  const { app, values } = buildHarness();
  await withServer(app, async (base) => {
    const response = await request(base, "/api/config", {
      method: "PUT",
      body: JSON.stringify({ items: [{ key: "QUEUE_CONCURRENCY", value: "7" }] }),
    });

    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "修改运行配置需要管理员权限" });
    assert.equal(values.has("QUEUE_CONCURRENCY"), false, "拒绝后不能留下配置覆盖");
  });
});

test("管理员仍可更新配置并保留原有重启提示语义", async () => {
  const { app, values } = buildHarness();
  try {
    await withServer(app, async (base) => {
      const response = await request(base, "/api/config", {
        method: "PUT",
        body: JSON.stringify({ items: [{ key: "PORT", value: "6100" }] }),
      }, true);
      assert.equal(response.status, 200);
      assert.equal(values.get("PORT"), "6100");
      assert.deepEqual((await response.json() as { restartRequired: string[] }).restartRequired, ["PORT"]);
    });
  } finally {
    delete process.env.PORT;
  }
});

test("GET 对所有已登录账号保持可读且不会改变配置", async () => {
  const { app, values } = buildHarness();
  values.set("QUEUE_CONCURRENCY", "4");
  await withServer(app, async (base) => {
    const response = await request(base, "/api/config");
    assert.equal(response.status, 200);
    const body = await response.json() as { items: { key: string; value: string }[] };
    assert.equal(body.items.find((item) => item.key === "QUEUE_CONCURRENCY")?.value, "4");
    assert.equal(values.get("QUEUE_CONCURRENCY"), "4");
  });
});
