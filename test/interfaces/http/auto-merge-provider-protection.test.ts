import { test } from "node:test";
import assert from "node:assert/strict";
import type { Express } from "express";
import { createApp } from "../../../src/interfaces/http/app.ts";
import { createAuthMiddleware } from "../../../src/interfaces/http/auth-middleware.ts";
import { createProvidersRouter } from "../../../src/interfaces/http/api/providers.ts";
import { createAdminRepository } from "../../../src/infrastructure/sqlite/admin-repo.ts";
import { openDatabase } from "../../../src/infrastructure/sqlite/database.ts";
import { createLlmProviderRepository } from "../../../src/infrastructure/sqlite/llm-provider-repo.ts";
import { deriveToken } from "../../../src/shared/crypto.ts";
import { createSilentLogger } from "../../../src/shared/logger.ts";

const AUTH_SALT = "auto-merge-provider-protection-salt";
const ADMIN = "admin";
const EDITOR = "editor";

const providerBody = {
  name: "gateway",
  label: "Gateway",
  kind: "custom",
  base_url: "https://gateway.example.test/v1",
  api_key: "secret-key",
  api: "openai-responses",
  models: ["model-a"],
  default_model: "model-a",
  is_default: false,
};

interface Harness {
  app: Express;
  adminToken: string;
  editorToken: string;
  close: () => void;
}

/** 使用真实鉴权和 SQLite 仓储，避免把角色或写副作用 mock 出测试边界。 */
function buildHarness(): Harness {
  const db = openDatabase(":memory:");
  const admins = createAdminRepository(db, AUTH_SALT, ADMIN);
  admins.ensureInitialAdmin(ADMIN, "admin-password");
  admins.create(EDITOR, "editor-password");
  const providers = createLlmProviderRepository(db);
  providers.create({
    name: "existing",
    label: "Existing",
    kind: "custom",
    baseUrl: "https://existing.example.test/v1",
    apiKey: "existing-secret",
    api: "openai-responses",
    models: ["model-a"],
    defaultModel: "model-a",
    isDefault: true,
  });
  const authMiddleware = createAuthMiddleware({ admins, authSalt: AUTH_SALT });
  const app = createApp({
    logger: createSilentLogger(),
    enqueue: () => {},
    authMiddleware,
    apiRoutes: { "/api/providers": createProvidersRouter({ providers }) },
  });
  return {
    app,
    adminToken: deriveToken(ADMIN, AUTH_SALT),
    editorToken: deriveToken(EDITOR, AUTH_SALT),
    close: () => db.close(),
  };
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

function authed(base: string, token: string, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
}

const writeRequests: ReadonlyArray<{ method: string; path: string; body?: unknown }> = [
  { method: "POST", path: "/api/providers", body: providerBody },
  { method: "PUT", path: "/api/providers/1", body: { ...providerBody, name: "existing", label: "Updated" } },
  { method: "DELETE", path: "/api/providers/1" },
  { method: "POST", path: "/api/providers/1/default" },
  { method: "PUT", path: "/api/providers/bindings/group%2Fproject", body: { provider_id: 1, model: "model-a" } },
  { method: "DELETE", path: "/api/providers/bindings/group%2Fproject" },
];

async function requestWrite(base: string, token: string, request: (typeof writeRequests)[number]): Promise<Response> {
  return authed(base, token, request.path, {
    method: request.method,
    ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
  });
}

test("普通账号不能预植或修改 evaluator，全部厂商写链始终返回 403", async () => {
  const harness = buildHarness();
  try {
    await withServer(harness.app, async (base) => {
      for (const request of writeRequests) {
        const response = await requestWrite(base, harness.editorToken, request);
        assert.equal(response.status, 403, `${request.method} ${request.path} 必须拒绝普通账号`);
        assert.deepEqual(await response.json(), { error: "修改 AI 厂商与项目模型绑定需要管理员权限" });
      }
    });
  } finally {
    harness.close();
  }
});

test("普通账号仍可读取厂商列表、模板和掩码详情", async () => {
  const harness = buildHarness();
  try {
    await withServer(harness.app, async (base) => {
      assert.equal((await authed(base, harness.editorToken, "/api/providers")).status, 200);
      assert.equal((await authed(base, harness.editorToken, "/api/providers/templates")).status, 200);
      const detail = await authed(base, harness.editorToken, "/api/providers/1");
      assert.equal(detail.status, 200);
      const body = await detail.json() as Record<string, unknown>;
      assert.equal(body.hasApiKey, true);
      assert.equal(typeof body.apiKeyMasked, "string");
      assert.equal("apiKey" in body, false, "读取权限不应放宽密钥回显语义");
    });
  } finally {
    harness.close();
  }
});

test("管理员可执行全部厂商写链，留空 API Key 仍保留原密钥", async () => {
  const harness = buildHarness();
  try {
    await withServer(harness.app, async (base) => {
      const orderedWrites = [
        writeRequests[0],
        { ...writeRequests[1], body: { ...(writeRequests[1].body as object), api_key: "" } },
        writeRequests[3],
        writeRequests[4],
        writeRequests[5],
      ];
      for (const request of orderedWrites) {
        const response = await requestWrite(base, harness.adminToken, request);
        assert.equal(response.status, 200, `${request.method} ${request.path} 应允许管理员`);
      }
      const detail = await authed(base, harness.adminToken, "/api/providers/1");
      assert.equal(detail.status, 200);
      const body = await detail.json() as { hasApiKey: boolean; apiKeyMasked?: string };
      assert.equal(body.hasApiKey, true);
      assert.equal(body.apiKeyMasked, "exis****cret");
      assert.equal((await requestWrite(base, harness.adminToken, writeRequests[2])).status, 200);
    });
  } finally {
    harness.close();
  }
});
