import { test } from "node:test";
import assert from "node:assert/strict";
import type { Express } from "express";
import { createApp } from "../../../src/interfaces/http/app.ts";
import { createAuthMiddleware } from "../../../src/interfaces/http/auth-middleware.ts";
import { createPromptsRouter } from "../../../src/interfaces/http/api/prompts.ts";
import { createAdminRepository } from "../../../src/infrastructure/sqlite/admin-repo.ts";
import { openDatabase } from "../../../src/infrastructure/sqlite/database.ts";
import { createPromptRepository } from "../../../src/infrastructure/sqlite/prompt-repo.ts";
import { deriveToken } from "../../../src/shared/crypto.ts";
import { createSilentLogger } from "../../../src/shared/logger.ts";

const AUTH_SALT = "auto-merge-policy-http-salt";
const ADMIN = "admin";
const ADMIN_PASSWORD = "admin-password";
const EDITOR = "editor";
const EDITOR_PASSWORD = "editor-password";

const requestPolicy = {
  enabled: true,
  minimum_score: 95,
  target_branches: ["main"],
  method: "squash",
  remove_source_branch: true,
};

function promptBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    repository: "rules",
    projects: ["group/app"],
    system_prompt: "system",
    user_prompt: "review {diffs_text}",
    ...extra,
  };
}

function buildHarness(): { app: Express; adminToken: string; editorToken: string; close: () => void } {
  const db = openDatabase(":memory:");
  const admins = createAdminRepository(db, AUTH_SALT, ADMIN);
  admins.ensureInitialAdmin(ADMIN, ADMIN_PASSWORD);
  admins.create(EDITOR, EDITOR_PASSWORD);
  const prompts = createPromptRepository(db);
  const authMiddleware = createAuthMiddleware({ admins, authSalt: AUTH_SALT });
  const app = createApp({
    logger: createSilentLogger(),
    enqueue: () => {},
    authMiddleware,
    apiRoutes: { "/api/prompts": createPromptsRouter({ prompts, rulesDir: "prompts/rules" }) },
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
  try { return await run(`http://127.0.0.1:${port}`); }
  finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}

function authed(base: string, token: string, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
}

test("管理员以 snake_case 保存自动合并，详情、列表和 meta 返回 camelCase 完整策略", async () => {
  const harness = buildHarness();
  try {
    await withServer(harness.app, async (base) => {
      const created = await authed(base, harness.adminToken, "/api/prompts", {
        method: "POST",
        body: JSON.stringify(promptBody({ project_settings: [{ project: "group/app", auto_merge_policy: requestPolicy }] })),
      });
      assert.equal(created.status, 200);
      const detail = await created.json() as { id: number; projectSettings: unknown[] };
      assert.deepEqual(detail.projectSettings, [{
        project: "group/app",
        repositoryContextEnabled: false,
        autoMergePolicy: {
          enabled: true,
          minimumScore: 95,
          targetBranches: ["main"],
          method: "squash",
          removeSourceBranch: true,
        },
      }]);
      const list = await (await authed(base, harness.adminToken, "/api/prompts")).json() as Array<{ projectSettings: unknown[] }>;
      const meta = await (await authed(base, harness.adminToken, "/api/prompts/meta")).json() as { projectSettings: unknown[] };
      assert.deepEqual(list[0]?.projectSettings, detail.projectSettings);
      assert.deepEqual(meta.projectSettings, detail.projectSettings);
    });
  } finally { harness.close(); }
});

test("HTTP 启用自动合并拒绝缺失 diffs_text，显式关闭同请求可移除占位符", async () => {
  const harness = buildHarness();
  try {
    await withServer(harness.app, async (base) => {
      const invalidCreate = await authed(base, harness.adminToken, "/api/prompts", {
        method: "POST",
        body: JSON.stringify(promptBody({
          repository: "invalid-rules",
          projects: ["group/invalid"],
          user_prompt: "只看提交说明",
          project_settings: [{ project: "group/invalid", auto_merge_policy: requestPolicy }],
        })),
      });
      assert.equal(invalidCreate.status, 400);
      assert.match(String((await invalidCreate.json() as { error?: unknown }).error), /diffs_text/);

      const created = await authed(base, harness.adminToken, "/api/prompts", {
        method: "POST",
        body: JSON.stringify(promptBody({
          repository: "protected-rules",
          projects: ["group/protected"],
          project_settings: [{ project: "group/protected", auto_merge_policy: requestPolicy }],
        })),
      });
      assert.equal(created.status, 200);
      const prompt = await created.json() as { id: number };

      const invalidUpdate = await authed(base, harness.adminToken, `/api/prompts/${prompt.id}`, {
        method: "PUT",
        body: JSON.stringify(promptBody({
          repository: "protected-rules",
          projects: ["group/protected"],
          user_prompt: "占位符已删除",
        })),
      });
      assert.equal(invalidUpdate.status, 400);
      assert.match(String((await invalidUpdate.json() as { error?: unknown }).error), /diffs_text/);

      const disabled = await authed(base, harness.adminToken, `/api/prompts/${prompt.id}`, {
        method: "PUT",
        body: JSON.stringify(promptBody({
          repository: "protected-rules",
          projects: ["group/protected"],
          user_prompt: "普通评审模板",
          project_settings: [{
            project: "group/protected",
            auto_merge_policy: { ...requestPolicy, enabled: false },
          }],
        })),
      });
      assert.equal(disabled.status, 200);
      const detail = await disabled.json() as {
        userPrompt: string;
        projectSettings: Array<{ autoMergePolicy: { enabled: boolean } }>;
      };
      assert.equal(detail.userPrompt, "普通评审模板");
      assert.equal(detail.projectSettings[0]?.autoMergePolicy.enabled, false);
    });
  } finally { harness.close(); }
});

test("普通账号不能显式创建或修改 auto_merge_policy，受保护 Prompt 的其他写入也拒绝", async () => {
  const harness = buildHarness();
  try {
    await withServer(harness.app, async (base) => {
      const forbiddenCreate = await authed(base, harness.editorToken, "/api/prompts", {
        method: "POST",
        body: JSON.stringify(promptBody({ project_settings: [{ project: "group/app", auto_merge_policy: requestPolicy }] })),
      });
      assert.equal(forbiddenCreate.status, 403);

      const created = await authed(base, harness.adminToken, "/api/prompts", {
        method: "POST",
        body: JSON.stringify(promptBody({ project_settings: [{ project: "group/app", auto_merge_policy: requestPolicy }] })),
      });
      const prompt = await created.json() as { id: number };
      const forbiddenUpdate = await authed(base, harness.editorToken, `/api/prompts/${prompt.id}`, {
        method: "PUT",
        body: JSON.stringify(promptBody({ system_prompt: "blocked", project_settings: [{ project: "group/app", auto_merge_policy: { ...requestPolicy, enabled: false } }] })),
      });
      assert.equal(forbiddenUpdate.status, 403);

      const protectedUpdate = await authed(base, harness.editorToken, `/api/prompts/${prompt.id}`, {
        method: "PUT",
        body: JSON.stringify(promptBody({ system_prompt: "editor-change", project_settings: [{ project: "group/app", repository_context_enabled: true }] })),
      });
      assert.equal(protectedUpdate.status, 403, "保护覆盖整个 Prompt 写链，不能通过正文影响评分后触发合并");
    });
  } finally { harness.close(); }
});

test("已启用自动合并的项目保护 Prompt 全写链，普通账号不能改正文、关联、删除或导入竞争项", async () => {
  const harness = buildHarness();
  try {
    await withServer(harness.app, async (base) => {
      const protectedCreate = await authed(base, harness.adminToken, "/api/prompts", {
        method: "POST",
        body: JSON.stringify(promptBody({
          repository: "protected-rules",
          projects: ["group/protected"],
          project_settings: [{ project: "group/protected", auto_merge_policy: requestPolicy }],
        })),
      });
      assert.equal(protectedCreate.status, 200);
      const protectedPrompt = await protectedCreate.json() as { id: number };

      const competingCreate = await authed(base, harness.editorToken, "/api/prompts", {
        method: "POST",
        body: JSON.stringify(promptBody({ repository: "competing-rules", projects: ["group/protected"] })),
      });
      assert.equal(competingCreate.status, 403, "关联已启用项目也属于受保护写入");
      const invalidAdminCompeting = await authed(base, harness.adminToken, "/api/prompts", {
        method: "POST",
        body: JSON.stringify(promptBody({ repository: "admin-competing", projects: ["GROUP/PROTECTED"] })),
      });
      assert.equal(invalidAdminCompeting.status, 400, "管理员也不能制造第二条不确定关联");

      for (const body of [
        { system_prompt: "tampered", user_prompt: "user" },
        promptBody({ repository: "protected-rules", projects: [], system_prompt: "unlink" }),
      ]) {
        const response = await authed(base, harness.editorToken, `/api/prompts/${protectedPrompt.id}`, {
          method: "PUT", body: JSON.stringify(body),
        });
        assert.equal(response.status, 403, "旧项目或最终项目受保护时都必须拒绝");
      }
      assert.equal((await authed(base, harness.editorToken, `/api/prompts/${protectedPrompt.id}`, { method: "DELETE" })).status, 403);
      assert.equal((await authed(base, harness.editorToken, "/api/prompts/import", { method: "POST" })).status, 403);
      assert.equal((await authed(base, harness.adminToken, "/api/prompts/import", { method: "POST" })).status, 200);

      const safeCreate = await authed(base, harness.editorToken, "/api/prompts", {
        method: "POST",
        body: JSON.stringify(promptBody({ repository: "safe-rules", projects: ["group/safe"] })),
      });
      assert.equal(safeCreate.status, 200, "未受保护项目保持原权限");
      const safePrompt = await safeCreate.json() as { id: number };
      const attachProtected = await authed(base, harness.editorToken, `/api/prompts/${safePrompt.id}`, {
        method: "PUT",
        body: JSON.stringify(promptBody({ repository: "safe-rules", projects: ["group/protected"] })),
      });
      assert.equal(attachProtected.status, 403, "最终关联已启用项目时必须拒绝");
      const adminAttachProtected = await authed(base, harness.adminToken, `/api/prompts/${safePrompt.id}`, {
        method: "PUT",
        body: JSON.stringify(promptBody({ repository: "safe-rules", projects: ["Group/Protected"] })),
      });
      assert.equal(adminAttachProtected.status, 400, "唯一关联约束不因管理员身份放宽");
      assert.equal((await authed(base, harness.editorToken, `/api/prompts/${safePrompt.id}`, {
        method: "PUT", body: JSON.stringify(promptBody({ repository: "safe-rules", projects: ["group/safe"], system_prompt: "safe-change" })),
      })).status, 200);
      assert.equal((await authed(base, harness.editorToken, `/api/prompts/${safePrompt.id}`, { method: "DELETE" })).status, 200);

      const adminUpdate = await authed(base, harness.adminToken, `/api/prompts/${protectedPrompt.id}`, {
        method: "PUT",
        body: JSON.stringify(promptBody({ repository: "protected-rules", projects: ["group/protected"], system_prompt: "admin-change" })),
      });
      assert.equal(adminUpdate.status, 200, "管理员仍可维护受保护 Prompt");
    });
  } finally { harness.close(); }
});

test("管理员请求拒绝非法自动合并结构且不改变已保存策略", async () => {
  const harness = buildHarness();
  try {
    await withServer(harness.app, async (base) => {
      const created = await authed(base, harness.adminToken, "/api/prompts", {
        method: "POST",
        body: JSON.stringify(promptBody()),
      });
      const prompt = await created.json() as { id: number };
      const invalidPolicies = [
        null,
        { ...requestPolicy, minimum_score: 0 },
        { ...requestPolicy, target_branches: [] },
        { ...requestPolicy, target_branches: ["main", " main "] },
        { ...requestPolicy, method: "rebase" },
      ];
      for (const auto_merge_policy of invalidPolicies) {
        const response = await authed(base, harness.adminToken, `/api/prompts/${prompt.id}`, {
          method: "PUT",
          body: JSON.stringify(promptBody({ project_settings: [{ project: "group/app", auto_merge_policy }] })),
        });
        assert.equal(response.status, 400, JSON.stringify(auto_merge_policy));
      }
      const detail = await (await authed(base, harness.adminToken, `/api/prompts/${prompt.id}`)).json() as {
        projectSettings: Array<{ autoMergePolicy: { enabled: boolean; minimumScore: number } }>;
      };
      assert.deepEqual(detail.projectSettings[0]?.autoMergePolicy, {
        enabled: false,
        minimumScore: 100,
        targetBranches: [],
        method: "merge",
        removeSourceBranch: false,
      });
    });
  } finally { harness.close(); }
});
