import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Express } from "express";
import { createApp } from "../../../src/interfaces/http/app.ts";
import { createAuthMiddleware, createRequireAdmin } from "../../../src/interfaces/http/auth-middleware.ts";
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
import type { ProjectReviewSetting, PromptSummary, StoredPrompt } from "../../../src/domain/review-prompt.ts";

/** 当前 API 必须返回完整新字段；旧替身的可选类型不削弱运行时断言。 */
type ContextPrompt = StoredPrompt & { repositoryStandards: string; projectSettings: ProjectReviewSetting[] };
type ContextMeta = { projectSettings: ProjectReviewSetting[] };

const AUTH_SALT = "test-auth-salt";
const ADMIN = "admin";
const ADMIN_PASSWORD = "admin-password";

/** 一组测试装置：真实 SQLite 内存库 + 真实 Express 应用。 */
interface Harness {
  app: Express;
  token: string;
  dbDir: string;
  /** 管理员仓储，便于测试里追加普通账号。 */
  admins: ReturnType<typeof createAdminRepository>;
}

function buildHarness(options: { distDir?: string; rulesDir?: string } = {}): Harness {
  const db = openDatabase(":memory:");
  // 传入 ADMIN 作为管理员账号：角色由该配置计算（D-024），不存数据库。
  const admins = createAdminRepository(db, AUTH_SALT, ADMIN);
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
      "/api/admins": createAdminsRouter({ admins, requireAdmin: createRequireAdmin() }),
      "/api/reviews": createReviewsRouter({ records }),
      "/api/config": createConfigRouter({ config }),
      "/api/prompts": createPromptsRouter({ prompts, rulesDir: options.rulesDir ?? "prompts/rules" }),
    },
    staticAssets: options.distDir ? createStaticAssets({ distDir: options.distDir, logger: createSilentLogger() }) : [],
  });

  return { app, token: deriveToken(ADMIN, AUTH_SALT), dbDir: "", admins };
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
    // isAdmin 随 me 一起返回（D-024）：前端刷新页面时靠它恢复权限状态。
    assert.deepEqual(await me.json(), { username: ADMIN, isAdmin: true });
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
      // 两个键都需重启：PORT 是启动期绑定，QUEUE_CONCURRENCY 的队列在构造时
      // 就按并发数创建了槽位，写 process.env 不会改变已有队列的行为。
      assert.deepEqual([...updated.restartRequired].sort(), ["PORT", "QUEUE_CONCURRENCY"]);
      assert.equal(process.env.QUEUE_CONCURRENCY, "7", "覆盖值必须同步到进程环境变量");
      assert.equal(process.env.PORT, "6001");
    });
  } finally {
    if (originalKey === undefined) delete process.env.LLMGW_API_KEY;
    else process.env.LLMGW_API_KEY = originalKey;
    delete process.env.QUEUE_CONCURRENCY;
    delete process.env.PORT;
  }
});

test("配置更新拒绝越权键、只读键与非法取值", async () => {
  const { app, token } = buildHarness();
  await withServer(app, async (base) => {
    // 主机环境变量不属于本服务配置，不得写入覆盖表（否则下次启动会注入 process.env）
    const foreign = await authed(base, token, "/api/config", {
      method: "PUT",
      body: JSON.stringify({ items: [{ key: "PATH", value: "/tmp" }] }),
    });
    assert.equal(foreign.status, 400);
    assert.match((await foreign.json() as { error: string }).error, /不支持修改/);

    // DB_PATH 改动会让开库路径与启动横幅分叉
    const readOnly = await authed(base, token, "/api/config", {
      method: "PUT",
      body: JSON.stringify({ items: [{ key: "DB_PATH", value: "./other.db" }] }),
    });
    assert.equal(readOnly.status, 400);
    assert.match((await readOnly.json() as { error: string }).error, /只读/);

    // 非法取值（非正整数 / 非法枚举）必须在写入前拦下：否则下次启动直接退出
    const badPort = await authed(base, token, "/api/config", {
      method: "PUT",
      body: JSON.stringify({ items: [{ key: "PORT", value: "abc" }] }),
    });
    assert.equal(badPort.status, 400);
    const zeroConcurrency = await authed(base, token, "/api/config", {
      method: "PUT",
      body: JSON.stringify({ items: [{ key: "QUEUE_CONCURRENCY", value: "0" }] }),
    });
    assert.equal(zeroConcurrency.status, 400);
    const badLevel = await authed(base, token, "/api/config", {
      method: "PUT",
      body: JSON.stringify({ items: [{ key: "LOG_LEVEL", value: "verbose" }] }),
    });
    assert.equal(badLevel.status, 400);
  });
});

test("配置列表只包含服务自身配置项，不回显主机环境变量", async () => {
  const { app, token } = buildHarness();
  const originalConcurrency = process.env.QUEUE_CONCURRENCY;
  try {
    // 白名单内的键来自进程环境变量，因此这里临时设置一个以确保它出现在列表中。
    process.env.QUEUE_CONCURRENCY = "5";
    await withServer(app, async (base) => {
      const body = (await (await authed(base, token, "/api/config")).json()) as {
        items: { key: string; readOnly: boolean }[];
      };
      const keys = body.items.map((item) => item.key);
      for (const foreign of ["PATH", "HOME", "USERPROFILE", "TEMP"]) {
        assert.equal(keys.includes(foreign), false, `不得把主机环境变量 ${foreign} 当作配置项展示`);
      }
      assert.ok(keys.includes("QUEUE_CONCURRENCY"), "应包含本服务的配置项");
      assert.equal(body.items.find((item) => item.key === "DB_PATH")?.readOnly, true, "DB_PATH 应标记为只读");
    });
  } finally {
    if (originalConcurrency === undefined) delete process.env.QUEUE_CONCURRENCY;
    else process.env.QUEUE_CONCURRENCY = originalConcurrency;
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

test("仓库配置 API 支持独立开关、规范、meta 和旧客户端省略保值", async () => {
  const { app, token } = buildHarness();
  await withServer(app, async (base) => {
    const created = await authed(base, token, "/api/prompts", {
      method: "POST",
      body: JSON.stringify({ repository: "rules", projects: ["g/a", "g/b"], system_prompt: "s", user_prompt: "u", repository_standards: "规范", project_settings: [{ project: "g/a", repository_context_enabled: true }] }),
    });
    assert.equal(created.status, 200);
    const detail = await created.json() as ContextPrompt;
    assert.equal(detail.repositoryStandards, "规范");
    assert.deepEqual(detail.projectSettings, [{ project: "g/a", repositoryContextEnabled: true }, { project: "g/b", repositoryContextEnabled: false }]);
    const meta = await (await authed(base, token, "/api/prompts/meta")).json() as ContextMeta;
    assert.deepEqual(meta.projectSettings, detail.projectSettings);
    const list = await (await authed(base, token, "/api/prompts")).json() as PromptSummary[];
    assert.equal(list[0].hasRepositoryStandards, true);
    assert.equal("repositoryStandards" in list[0], false);
    const updated = await authed(base, token, `/api/prompts/${detail.id}`, { method: "PUT", body: JSON.stringify({ system_prompt: "s2", user_prompt: "u2" }) });
    assert.equal(updated.status, 200);
    const kept = await updated.json() as ContextPrompt;
    assert.deepEqual(kept.projects, ["g/a", "g/b"]);
    assert.deepEqual(kept.projectSettings, detail.projectSettings);
    assert.equal(kept.repositoryStandards, "规范");
    const cleared = await authed(base, token, `/api/prompts/${detail.id}`, { method: "PUT", body: JSON.stringify({ system_prompt: "s2", user_prompt: "u2", repository_standards: "", project_settings: [{project:"g/a",repository_context_enabled:false}] }) });
    assert.equal(cleared.status, 200);
    const off = await cleared.json() as ContextPrompt;
    assert.equal(off.repositoryStandards, "");
    assert.equal(off.projectSettings[0].repositoryContextEnabled, false);
  });
});

test("仓库配置 API 拒绝非法新字段且更新失败不改变配置", async () => {
  const { app, token } = buildHarness();
  await withServer(app, async (base) => {
    const initial = {repository:"r",projects:["g/a"],system_prompt:"s",user_prompt:"u"};
    const prompt = await (await authed(base, token, "/api/prompts", {method:"POST",body:JSON.stringify(initial)})).json() as ContextPrompt;
    for (const fields of [
      {repository_standards:null}, {repository_standards:1}, {repository_standards:"x".repeat(32001)},
      {project_settings:null}, {project_settings:{}}, {project_settings:[null]},
      {project_settings:[{project:"g/a",repository_context_enabled:"true"}]},
      {project_settings:[{project:"g/b",repository_context_enabled:true}]},
      {project_settings:[{project:"g/a",repository_context_enabled:true},{project:"G/A",repository_context_enabled:false}]},
      {projects:["g/../escape"],project_settings:[{project:"g/../escape",repository_context_enabled:true}]},
      {projects:["bad\\name"],project_settings:[{project:"bad\\name",repository_context_enabled:true}]},
      {projects:["https://git.example/g/a"],project_settings:[{project:"https://git.example/g/a",repository_context_enabled:true}]},
    ]) {
      const response = await authed(base, token, `/api/prompts/${prompt.id}`, {method:"PUT",body:JSON.stringify({...initial,system_prompt:"changed",...fields})});
      assert.equal(response.status, 400, JSON.stringify(fields));
      assert.equal(typeof (await response.json() as { error: string }).error, "string");
      const after = await (await authed(base, token, `/api/prompts/${prompt.id}`)).json() as ContextPrompt;
      assert.equal(after.systemPrompt, "s");
      assert.deepEqual(after.projects, ["g/a"]);
    }
    const invalidCreate = await authed(base, token, "/api/prompts", {method:"POST",body:JSON.stringify({...initial,repository:"default",project_settings:[{project:"g/a",repository_context_enabled:true}]})});
    assert.equal(invalidCreate.status, 400);
    assert.equal((await (await authed(base, token, "/api/prompts")).json() as PromptSummary[]).length, 1);
  });
});

test("既有短项目名可在页面和 API 正常开启仓库上下文", async () => {
  const { app, token } = buildHarness();
  await withServer(app, async (base) => {
    const body = {repository:"legacy-rules",projects:["auto-ops","cw-auto-ops"],system_prompt:"s",user_prompt:"u",project_settings:[{project:"auto-ops",repository_context_enabled:true}]};
    const created = await authed(base, token, "/api/prompts", {method:"POST",body:JSON.stringify(body)});
    assert.equal(created.status, 200);
    const prompt = await created.json() as ContextPrompt;
    assert.deepEqual(prompt.projectSettings,[{project:"auto-ops",repositoryContextEnabled:true},{project:"cw-auto-ops",repositoryContextEnabled:false}]);
    const meta = await (await authed(base, token, "/api/prompts/meta")).json() as ContextMeta;
    assert.deepEqual(meta.projectSettings,[{project:"auto-ops",repositoryContextEnabled:true},{project:"cw-auto-ops",repositoryContextEnabled:false}]);
  });
});

test("仓库配置写入继续允许普通登录账号，未认证写入全部拒绝", async () => {
  const { app, admins } = buildHarness();
  admins.create("editor", "editor-password");
  const token = deriveToken("editor", AUTH_SALT);
  await withServer(app, async (base) => {
    const body = JSON.stringify({repository:"editor-rules",projects:["g/a"],system_prompt:"s",user_prompt:"u",project_settings:[{project:"g/a",repository_context_enabled:true}]});
    const created = await authed(base, token, "/api/prompts", {method:"POST",body});
    assert.equal(created.status, 200);
    const prompt = await created.json() as ContextPrompt;
    assert.equal(prompt.projectSettings[0].repositoryContextEnabled, true);
    for (const [method, path] of [["POST","/api/prompts"],["PUT",`/api/prompts/${prompt.id}`],["DELETE",`/api/prompts/${prompt.id}`]]) {
      const response = await fetch(`${base}${path}`, {method,headers:{"Content-Type":"application/json"},...(method!=="DELETE"?{body}:{})});
      assert.equal(response.status, 401);
    }
    assert.equal((await authed(base, token, `/api/prompts/${prompt.id}`, {method:"DELETE"})).status, 200);
    assert.deepEqual((await (await authed(base, token, "/api/prompts/meta")).json() as ContextMeta).projectSettings, []);
  });
});

test("Prompt 名称可通过 API 修改，重名 409、default 不可改，旧客户端省略名称仍保值", async () => {
  const { app, token } = buildHarness();
  await withServer(app, async (base) => {
    const create = async (repository: string) => (await (await authed(base, token, "/api/prompts", {
      method:"POST", body:JSON.stringify({repository, projects:["g/a"], system_prompt:"s", user_prompt:"u", repository_standards:"规范"}),
    })).json()) as ContextPrompt;
    const target = await create("旧名称");
    await create("占用名称");

    const renamed = await authed(base, token, `/api/prompts/${target.id}`, {method:"PUT",
      body:JSON.stringify({repository:"  新名称  ", system_prompt:"s", user_prompt:"u"})});
    assert.equal(renamed.status, 200);
    const body = await renamed.json() as ContextPrompt;
    assert.equal(body.id, target.id);
    assert.equal(body.repository, "新名称");
    assert.deepEqual(body.projects, ["g/a"], "改名不得清空关联");
    assert.equal(body.repositoryStandards, "规范", "改名不得清空规范");

    const conflict = await authed(base, token, `/api/prompts/${target.id}`, {method:"PUT",
      body:JSON.stringify({repository:"占用名称", system_prompt:"changed", user_prompt:"u"})});
    assert.equal(conflict.status, 409);
    const afterConflict = await (await authed(base, token, `/api/prompts/${target.id}`)).json() as ContextPrompt;
    assert.equal(afterConflict.repository, "新名称", "重名失败不得改名");
    assert.equal(afterConflict.systemPrompt, "s", "重名失败不得改正文");

    const omitted = await authed(base, token, `/api/prompts/${target.id}`, {method:"PUT",
      body:JSON.stringify({system_prompt:"s2", user_prompt:"u2"})});
    assert.equal((await omitted.json() as ContextPrompt).repository, "新名称", "省略名称应保留原名");

    const fallback = await (await authed(base, token, "/api/prompts", {method:"POST",
      body:JSON.stringify({repository:"default", system_prompt:"s", user_prompt:"u"})})).json() as ContextPrompt;
    const protectedDefault = await authed(base, token, `/api/prompts/${fallback.id}`, {method:"PUT",
      body:JSON.stringify({repository:"default-renamed", system_prompt:"s", user_prompt:"u"})});
    assert.equal(protectedDefault.status, 400);
    assert.equal((await (await authed(base, token, `/api/prompts/${fallback.id}`)).json() as ContextPrompt).repository, "default");

    const toDefault = await authed(base, token, `/api/prompts/${target.id}`, {method:"PUT",
      body:JSON.stringify({repository:"default", system_prompt:"s", user_prompt:"u"})});
    assert.equal(toDefault.status, 400, "不允许改名为保留的 default");

    const empty = await authed(base, token, `/api/prompts/${target.id}`, {method:"PUT",
      body:JSON.stringify({repository:"   ", system_prompt:"s", user_prompt:"u"})});
    assert.equal(empty.status, 400);
  });
});

test("企微评分阈值以整数落库与回读，非法值 400", async () => {
  const { app, token } = buildHarness();
  await withServer(app, async (base) => {
    const created = await authed(base, token, "/api/prompts", {method:"POST",
      body:JSON.stringify({repository:"threshold-rules",system_prompt:"s",user_prompt:"u",wecom_score_threshold:"70"})});
    assert.equal(created.status, 200);
    const prompt = await created.json() as ContextPrompt & {wecomScoreThreshold?: number};
    assert.strictEqual(prompt.wecomScoreThreshold, 70, "字符串提交也必须存成整数");
    const detail = await (await authed(base, token, `/api/prompts/${prompt.id}`)).json() as {wecomScoreThreshold?: number};
    assert.strictEqual(detail.wecomScoreThreshold, 70);
    const list = await (await authed(base, token, "/api/prompts")).json() as {wecomScoreThreshold?: number}[];
    assert.strictEqual(list[0].wecomScoreThreshold, 70);
    for (const invalid of ["abc", -1, 70.5, {}, true]) {
      const response = await authed(base, token, `/api/prompts/${prompt.id}`, {method:"PUT",
        body:JSON.stringify({system_prompt:"s",user_prompt:"u",wecom_score_threshold:invalid})});
      assert.equal(response.status, 400, `阈值 ${JSON.stringify(invalid)} 应被拒绝`);
    }
    const cleared = await authed(base, token, `/api/prompts/${prompt.id}`, {method:"PUT",
      body:JSON.stringify({system_prompt:"s",user_prompt:"u",wecom_score_threshold:""})});
    assert.equal((await cleared.json() as {wecomScoreThreshold?: number}).wecomScoreThreshold, undefined);
  });
});

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

// ============ D-024：管理员权限 ============

test("登录与 me 返回 isAdmin：仅 ADMIN_USERNAME 指定账号为管理员", async () => {
  const { app, admins } = buildHarness();
  // 追加一个普通账号
  admins.create("normal-user", "normal-password");
  await withServer(app, async (base) => {
    const adminLogin = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: ADMIN, password: ADMIN_PASSWORD }),
    });
    const adminBody = (await adminLogin.json()) as { isAdmin: boolean };
    assert.equal(adminBody.isAdmin, true, "引导账号必须是管理员");

    const normalLogin = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "normal-user", password: "normal-password" }),
    });
    const normalBody = (await normalLogin.json()) as { isAdmin: boolean; token: string };
    assert.equal(normalBody.isAdmin, false, "非引导账号不是管理员");

    // me 也必须返回角色：前端刷新页面时靠它恢复权限状态
    const me = await authed(base, normalBody.token, "/api/auth/me");
    const meBody = (await me.json()) as { isAdmin: boolean; username: string };
    assert.equal(meBody.username, "normal-user");
    assert.equal(meBody.isAdmin, false);
  });
});

test("非管理员访问 /api/admins 返回 403", async () => {
  const { app, admins } = buildHarness();
  admins.create("normal-user", "normal-password");
  const normalToken = deriveToken("normal-user", AUTH_SALT);
  await withServer(app, async (base) => {
    // 列表
    const list = await authed(base, normalToken, "/api/admins");
    assert.equal(list.status, 403);
    assert.match(((await list.json()) as { error: string }).error, /管理员权限/);

    // 新增
    const created = await authed(base, normalToken, "/api/admins", {
      method: "POST",
      body: JSON.stringify({ username: "hacked", password: "hacked-password" }),
    });
    assert.equal(created.status, 403, "非管理员不得新增账号");

    // 删除
    const removed = await authed(base, normalToken, "/api/admins/1", { method: "DELETE" });
    assert.equal(removed.status, 403, "非管理员不得删除账号");

    // 确认没被写进去
    const after = await authed(base, deriveToken(ADMIN, AUTH_SALT), "/api/admins");
    const list2 = (await after.json()) as { username: string }[];
    assert.equal(list2.some((item) => item.username === "hacked"), false, "被拒的请求不得产生副作用");
  });
});

test("管理员可以正常访问 /api/admins，且列表标注 isAdmin", async () => {
  const { app, admins, token } = buildHarness();
  admins.create("normal-user", "normal-password");
  await withServer(app, async (base) => {
    const list = await authed(base, token, "/api/admins");
    assert.equal(list.status, 200);
    const items = (await list.json()) as { username: string; isAdmin: boolean }[];
    assert.equal(items.find((item) => item.username === ADMIN)?.isAdmin, true);
    assert.equal(items.find((item) => item.username === "normal-user")?.isAdmin, false);
  });
});

test("非管理员仍可访问其他管理页接口", async () => {
  const { app, admins } = buildHarness();
  admins.create("normal-user", "normal-password");
  const normalToken = deriveToken("normal-user", AUTH_SALT);
  await withServer(app, async (base) => {
    // 只有 /api/admins 被限制，其余页面普通账号照常可用（用户选择的范围）。
    for (const path of ["/api/reviews", "/api/reviews/stats", "/api/config", "/api/prompts"]) {
      const res = await authed(base, normalToken, path);
      assert.equal(res.status, 200, `${path} 不应限制普通账号`);
    }
  });
});

test("ADMIN_USERNAME 未配置时无人是管理员", async () => {
  const db = openDatabase(":memory:");
  // 不传 adminUsername：模拟漏配 .env
  const admins = createAdminRepository(db, AUTH_SALT);
  admins.ensureInitialAdmin(ADMIN, ADMIN_PASSWORD);
  assert.equal(admins.list()[0].isAdmin, false, "未配置管理员账号时不应有人获得权限");
  assert.equal(admins.adminUsername, "");
  db.close();
});

test("管理员判定忽略大小写与首尾空白", async () => {
  const db = openDatabase(":memory:");
  const admins = createAdminRepository(db, AUTH_SALT, "  Admin  ");
  admins.create("admin", "password-123");
  // 登录归一化后与配置一致，不应因大小写差异丢掉管理员权限
  assert.equal(admins.list()[0].isAdmin, true);
  db.close();
});
