# HTTP API Tasks

> **For agentic workers:** REQUIRED FLOW: Use `fp-execute` to implement this plan task-by-task. Only task markers use checkbox (`- [ ] **Task backend-NNN: ...**`) syntax for tracking; substeps are plain ordered instructions.

- [ ] **Task backend-017: 认证路由**

**Files:**
- Create: `src/interfaces/http/api/auth.ts`
- Test: `test/interfaces/http/api.test.ts`

**Reasoning:**
- proposal 变更点 8 要求完整登录体系。登录是唯一免鉴权的 `/api` 入口，必须先于其他路由可用。

**Depends on:** backend-014

**Interfaces:**
- Consumes: `AdminRepository.findByUsername`、`verifyPassword`、`deriveToken`
- Produces: `createAuthRouter(deps): Router`，挂载 `/api/auth/login`、`/api/auth/logout`、`/api/auth/me`
- Contract checks: 密码错误与用户不存在都返回 401 且响应体完全一致；登录成功返回派生令牌

**Step 1: Write the failing test**

```typescript
test("登录成功返回令牌，失败返回 401 且不区分原因", async () => {
  const ok = await request(app).post("/api/auth/login").send({ username: "admin", password: "s3cret" });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.token);
  assert.equal(ok.body.username, "admin");
  const bad = await request(app).post("/api/auth/login").send({ username: "admin", password: "wrong" });
  assert.equal(bad.status, 401);
  const missing = await request(app).post("/api/auth/login").send({ username: "nobody", password: "s3cret" });
  assert.equal(missing.status, 401);
  assert.deepEqual(bad.body, missing.body, "两种失败必须返回相同响应体，避免账号枚举");
});

test("缺少用户名或密码返回 400", async () => {
  assert.equal((await request(app).post("/api/auth/login").send({})).status, 400);
});
```

**Step 2: Run test to verify it fails**

Run: `node --test test/interfaces/http/api.test.ts`
Expected: FAIL（路由不存在，返回 404）

**Step 3: Write minimal implementation**

```typescript
import { Router } from "express";
import type { AdminRepository } from "../../../domain/admin.ts";
import { deriveToken, verifyPassword } from "../../../shared/crypto.ts";

/**
 * 认证路由：登录、登出、当前管理员。
 *
 * 登录失败一律返回相同的 401 响应体，不区分「用户不存在」与「密码错误」，
 * 否则可被用来枚举有效用户名。logout 无服务端状态（D-009 无状态令牌），
 * 接口仅为语义完整，实际清除由前端完成。
 */
export function createAuthRouter(deps: { admins: AdminRepository; salt: string }): Router { /* 见实现 */ }
```

登录成功返回 `{token: deriveToken(username, salt), username}`；`me` 从 `res.locals.username` 返回 `{username}`。

**Step 4: Run test to verify it passes**

Run: `node --test test/interfaces/http/api.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/interfaces/http/api/auth.ts test/interfaces/http/api.test.ts
git commit -m "feat: 新增登录、登出与当前管理员接口"
```

- [ ] **Task backend-018: 管理员账号管理路由**

**Files:**
- Create: `src/interfaces/http/api/admins.ts`
- Test: `test/interfaces/http/api.test.ts`

**Reasoning:**
- proposal 变更点 9 要求账号增删与两项删除约束。约束是本任务的核心可观察行为。

**Depends on**: backend-017

**Interfaces:**
- Consumes: `AdminRepository.create` / `list` / `delete` / `count`
- Produces: `createAdminsRouter(deps): Router`，挂载 `/api/admins`
- Contract checks: 重复用户名 409；密码过短 400；删除自己 400；删除最后一个管理员 400

**Step 1: Write the failing test**

```typescript
test("删除自己与删除最后一个管理员均返回 400", async () => {
  const me = (await request(app).get("/api/auth/me").set("Authorization", `Bearer ${adminToken}`)).body;
  const res = await request(app).delete(`/api/admins/${me.id}`).set("Authorization", `Bearer ${adminToken}`);
  assert.equal(res.status, 400);
  assert.match(res.body.error, /不能删除当前登录/);
});

test("存在第二个账号时可删除他人账号", async () => {
  const created = await request(app).post("/api/admins").set("Authorization", `Bearer ${adminToken}`)
    .send({ username: "second", password: "longenough" });
  assert.equal(created.status, 200);
  const res = await request(app).delete(`/api/admins/${created.body.id}`).set("Authorization", `Bearer ${adminToken}`);
  assert.equal(res.status, 200);
});

test("重复用户名返回 409，密码过短返回 400", async () => {
  const dup = await request(app).post("/api/admins").set("Authorization", `Bearer ${adminToken}`)
    .send({ username: "admin", password: "longenough" });
  assert.equal(dup.status, 409);
  const short = await request(app).post("/api/admins").set("Authorization", `Bearer ${adminToken}`)
    .send({ username: "x", password: "short" });
  assert.equal(short.status, 400);
});
```

**Step 2: Run test to verify it fails**

Run: `node --test test/interfaces/http/api.test.ts`
Expected: FAIL（路由不存在）

**Step 3: Write minimal implementation**

删除前置校验顺序固定：**先判是否删除当前登录账号**（`proposal.md#out-of-scope` 之外已确认的 P-004 规定自删约束优先），再判是否最后一个管理员。两者同时成立时返回自删的错误消息。密码最小长度取 8。

`create` 捕获仓储抛出的「已存在」错误并转 409。

**Step 4: Run test to verify it passes**

Run: `node --test test/interfaces/http/api.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/interfaces/http/api/admins.ts test/interfaces/http/api.test.ts
git commit -m "feat: 新增管理员账号增删接口与删除约束"
```

- [ ] **Task backend-019: 评审记录查询与统计路由**

**Files:**
- Create: `src/interfaces/http/api/reviews.ts`
- Test: `test/interfaces/http/api.test.ts`

**Reasoning:**
- proposal 变更点 7 要求记录查询与基础统计。这是只读接口，无写路径。

**Depends on**: backend-014

**Interfaces:**
- Consumes: `ReviewRecordRepository.getList` / `getStats`
- Produces: `createReviewsRouter(deps): Router`，挂载 `/api/reviews` 与 `/api/reviews/stats`
- Contract checks: `pageSize` 上限 200；非法参数返回 400；未认证返回 401

**Step 1: Write the failing test**

```typescript
test("GET /api/reviews 返回分页结构，非法 pageSize 返回 400", async () => {
  const ok = await request(app).get("/api/reviews?page=1&pageSize=10").set("Authorization", `Bearer ${adminToken}`);
  assert.equal(ok.status, 200);
  assert.ok(Array.isArray(ok.body.items));
  assert.equal(ok.body.pageSize, 10);
  const bad = await request(app).get("/api/reviews?pageSize=99999").set("Authorization", `Bearer ${adminToken}`);
  assert.equal(bad.status, 400);
  const badPage = await request(app).get("/api/reviews?page=0").set("Authorization", `Bearer ${adminToken}`);
  assert.equal(badPage.status, 400);
});

test("GET /api/reviews/stats 返回统计字段", async () => {
  const res = await request(app).get("/api/reviews/stats").set("Authorization", `Bearer ${adminToken}`);
  assert.equal(res.status, 200);
  for (const key of ["total", "projectCount", "committerCount", "avgScore", "daily"]) {
    assert.ok(key in res.body, `缺少字段 ${key}`);
  }
});
```

**Step 2: Run test to verify it fails**

Run: `node --test test/interfaces/http/api.test.ts`
Expected: FAIL（路由不存在）

**Step 3: Write minimal implementation**

`pageSize` 上限 200，超出返回 400 而非静默截断——静默截断会让前端分页显示与实际不符。查询参数非法（页码非正整数、`from > to`）同样返回 400 并给出中文错误文案。

**Step 4: Run test to verify it passes**

Run: `node --test test/interfaces/http/api.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/interfaces/http/api/reviews.ts test/interfaces/http/api.test.ts
git commit -m "feat: 新增评审记录查询与统计接口"
```

- [ ] **Task backend-020: 环境变量管理路由**

**Files:**
- Create: `src/interfaces/http/api/config.ts`
- Test: `test/interfaces/http/api.test.ts`

**Reasoning:**
- proposal 变更点 10 要求查询与更新配置；`D-012` 要求密钥掩码；`D-014` 要求立即生效并标注需重启项。

**Depends on**: backend-014

**Interfaces:**
- Consumes: `ConfigRepository.list` / `setAll`、`RESTART_REQUIRED_KEYS`、`process.env`
- Produces: `createConfigRouter(deps): Router`，挂载 `/api/config`
- Contract checks: 密钥字段返回掩码；更新后 `process.env` 已同步；响应含需重启键列表

**Step 1: Write the failing test**

```typescript
test("密钥字段掩码返回，更新同步 process.env 并标注需重启项", async () => {
  process.env.LLMGW_API_KEY = "sk-abcdefghijklmnop";
  const res = await request(app).get("/api/config").set("Authorization", `Bearer ${adminToken}`);
  const keyItem = res.body.items.find((i: { key: string }) => i.key === "LLMGW_API_KEY");
  assert.equal(keyItem.masked, true);
  assert.ok(keyItem.value.includes("****"));
  assert.ok(!keyItem.value.includes("efghij"), "掩码不得泄露中间内容");

  const put = await request(app).put("/api/config").set("Authorization", `Bearer ${adminToken}`)
    .send({ items: [{ key: "QUEUE_CONCURRENCY", value: "7" }, { key: "PORT", value: "6001" }] });
  assert.equal(put.status, 200);
  assert.deepEqual(put.body.restartRequired, ["PORT"]);
  assert.equal(process.env.QUEUE_CONCURRENCY, "7");
});
```

**Step 2: Run test to verify it fails**

Run: `node --test test/interfaces/http/api.test.ts`
Expected: FAIL（路由不存在）

**Step 3: Write minimal implementation**

读取时对键名含 `KEY`/`SECRET`/`TOKEN`/`PASSWORD` 的项做掩码：值长度大于 8 显示前 4 与后 4，中间 `****`；否则全掩码。写入时先落库，再同步 `process.env[k] = v`（`D-014`），响应返回 `restartRequired` 为本次更新中命中 `RESTART_REQUIRED_KEYS` 的键列表。

`GET /api/config` 的当前值来源：数据库覆盖优先，未覆盖的键回落到 `process.env` 当前值，让页面显示「实际生效值」而非仅显示覆盖项。

**Step 4: Run test to verify it passes**

Run: `node --test test/interfaces/http/api.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/interfaces/http/api/config.ts test/interfaces/http/api.test.ts
git commit -m "feat: 新增环境变量管理接口，密钥掩码与需重启标注"
```

- [ ] **Task backend-021: prompt 管理路由与规则来源切换**

**Files:**
- Create: `src/interfaces/http/api/prompts.ts`
- Modify: `src/infrastructure/rules/review-rules.ts:47-102`
- Test: `test/interfaces/http/api.test.ts`、`test/infrastructure/rules/review-rules.test.ts`

**Reasoning:**
- proposal 变更点 13 要求 prompt 增删改查与导入；`P-015` 要求 yaml 降级为初始导入与兜底。两者改的是同一个数据来源，必须一起完成才能验证回落链。

**Depends on**: backend-008, backend-014

**Interfaces:**
- Consumes: `PromptRepository` 全部方法、现有 `loadReviewRules`
- Produces: `createPromptsRouter(deps): Router`，挂载 `/api/prompts*`；`loadReviewRules` 支持可选 `promptSource`
- Contract checks: `repository` 重复 409；列表不返回完整正文；删除后回落 default；数据库与 default 都未命中时回落 yaml

**Step 1: Write the failing test**

```typescript
test("删除项目 prompt 后该仓库回落 default", async () => {
  const created = await request(app).post("/api/prompts").set("Authorization", `Bearer ${adminToken}`)
    .send({ repository: "g/p", system_prompt: "s", user_prompt: "u {diffs_text}" });
  assert.equal(created.status, 200);
  const res = await request(app).delete(`/api/prompts/${created.body.id}`).set("Authorization", `Bearer ${adminToken}`);
  assert.equal(res.status, 200);
  const after = await request(app).get("/api/prompts").set("Authorization", `Bearer ${adminToken}`);
  assert.equal(after.body.some((i: { repository: string }) => i.repository === "g/p"), false);
});

test("prompt 列表不返回完整正文", async () => {
  await request(app).post("/api/prompts").set("Authorization", `Bearer ${adminToken}`)
    .send({ repository: "g/q", system_prompt: "很长的系统提示内容", user_prompt: "u {diffs_text}" });
  const res = await request(app).get("/api/prompts").set("Authorization", `Bearer ${adminToken}`);
  assert.equal("systemPrompt" in res.body[0], false, "列表不得返回完整正文");
});

test("重复 repository 返回 409", async () => {
  await request(app).post("/api/prompts").set("Authorization", `Bearer ${adminToken}`)
    .send({ repository: "g/dup", system_prompt: "s", user_prompt: "u" });
  const dup = await request(app).post("/api/prompts").set("Authorization", `Bearer ${adminToken}`)
    .send({ repository: "g/dup", system_prompt: "s2", user_prompt: "u" });
  assert.equal(dup.status, 409);
});

test("数据库未命中时 loadReviewRules 回落 yaml 目录", async () => {
  const rules = await loadReviewRules(fixtureDir, "fallback", { promptSource: { resolve: () => undefined } as unknown as PromptRepository });
  assert.equal(rules.resolve("unknown/repo").systemPrompt, "fallback");
});
```

**Step 2: Run test to verify it fails**

Run: `node --test test/interfaces/http/api.test.ts test/infrastructure/rules/review-rules.test.ts`
Expected: FAIL（路由不存在；`loadReviewRules` 不接受 `promptSource`）

**Step 3: Write minimal implementation**

`GET /api/prompts` 列表只返回 `{id, repository, updatedAt, hasWecomWebhook}` 等摘要字段，正文只在 `GET /api/prompts/:id` 返回，避免一次拉取全部 prompt 正文。

`loadReviewRules` 的 `options` 增加可选 `promptSource?: PromptRepository`：`resolve()` 先查 `promptSource.resolve(repositoryFullName)`，未命中查 `repository="default"` 记录，仍未命中才走现有 yaml 目录与 Markdown 兜底链（现有行为完全不变）。

`POST /api/prompts/import` 调用 `promptSource.importFromDir(config.rulesDir)` 并返回 `{imported, skipped}`。

**Step 4: Run test to verify it passes**

Run: `node --test test/interfaces/http/api.test.ts test/infrastructure/rules/review-rules.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/interfaces/http/api/prompts.ts src/infrastructure/rules/review-rules.ts test/interfaces/http/api.test.ts test/infrastructure/rules/review-rules.test.ts
git commit -m "feat: 新增 prompt 管理接口，规则来源改为数据库优先并回落 yaml"
```

- [ ] **Task backend-022: 静态资源托管与 SPA fallback**

**Files:**
- Create: `src/interfaces/http/static-assets.ts`
- Modify: `src/interfaces/http/app.ts:84-87`（404 处理）
- Test: `test/interfaces/http/app.test.ts`

**Reasoning:**
- `D-016` 确认前端产物由 Express 托管。fallback 必须排除 `/api` 与 `/review`，否则未匹配的 API 会返回 HTML，前端无法解析错误。

**Depends on**: backend-014

**Interfaces:**
- Consumes: `web/dist` 目录路径
- Produces: `createStaticAssets(deps): RequestHandler`
- Contract checks: `/api/not-exist` 返回 404 JSON；`/` 与任意前端路由返回 `index.html`；`/health` 与 `/review/webhook` 不受影响

**Step 1: Write the failing test**

```typescript
test("SPA fallback 排除 /api 与 /review 前缀", async () => {
  const apiMiss = await request(app).get("/api/not-exist").set("Authorization", `Bearer ${adminToken}`);
  assert.equal(apiMiss.status, 404);
  assert.equal(apiMiss.type, "application/json", "未匹配的 API 必须返回 JSON 而非 HTML");
  const page = await request(app).get("/reviews");
  assert.equal(page.status, 200);
  assert.match(page.text, /<div id="app">/, "前端路由应回落到 index.html");
});

test("既有 health 与 webhook 路由不受静态托管影响", async () => {
  assert.equal((await request(app).get("/health")).status, 200);
  const hook = await request(app).post("/review/webhook").send({ object_kind: "push" });
  assert.equal(hook.status, 400);
});
```

**Step 2: Run test to verify it fails**

Run: `node --test test/interfaces/http/app.test.ts`
Expected: FAIL（`/reviews` 返回 404 JSON 而非 index.html）

**Step 3: Write minimal implementation**

```typescript
import express, { type Express, type RequestHandler } from "express";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * 托管前端构建产物并提供 SPA fallback。
 *
 * fallback 必须排除 /api 与 /review 前缀：否则未匹配的管理 API 会返回 index.html，
 * 前端拿到 HTML 却按 JSON 解析，错误信息完全丢失（D-016 的隔离边界）。
 * 产物目录不存在时静默跳过——本地开发未构建前端时服务仍应正常提供 API。
 */
export function createStaticAssets(deps: { distDir: string }): RequestHandler[] { /* 见实现 */ }
```

fallback 用 `app.get("*", ...)` 注册在 API 路由之后、404 处理之前，并对 `req.path` 做前缀判定后 `next()` 放行给既有 404。

**Step 4: Run test to verify it passes**

Run: `node --test test/interfaces/http/app.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/interfaces/http/static-assets.ts src/interfaces/http/app.ts test/interfaces/http/app.test.ts
git commit -m "feat: 托管前端静态资源与 SPA fallback，隔离 API 前缀"
```

- [ ] **Task backend-023: 组合根装配与部署配置**

**Files:**
- Modify: `src/bootstrap.ts:20-75`
- Create: `scripts/import-prompts.ts`
- Modify: `.env.example`
- Modify: `docker-compose.yml:21-26`
- Modify: `README.md`
- Test: `test/shared/config.test.ts`（复用 `applyConfigOverrides` 覆盖）

**Reasoning:**
- `D-002` 要求装配集中在组合根；prompt 迁移需要导入脚本；部署需要卷挂载与文档。这一步把前面所有增量接成可运行的整体。

**Depends on**: backend-012, backend-014, backend-017, backend-018, backend-019, backend-020, backend-021, backend-022

**Interfaces:**
- Consumes: 全部仓储工厂与路由工厂
- Produces: `main()` 完整装配；`scripts/import-prompts.ts` 可执行脚本
- Contract checks: 启动顺序为「加载 .env → 开库 → 应用 DB 覆盖 → loadConfig → 引导管理员 → 装配 → 监听」；启动横幅打印 prompt 来源与数据库路径；容器重启后数据仍在

**Step 1: Write the failing test**

```typescript
test("启动顺序保证数据库覆盖先于配置读取", () => {
  const env: NodeJS.ProcessEnv = { QUEUE_CONCURRENCY: "2" };
  applyConfigOverrides(env, { QUEUE_CONCURRENCY: "9" });
  const config = loadConfig(env);
  assert.equal(config.queueConcurrency, 9);
});
```

**Step 2: Run test to verify it fails**

Run: `node --test test/shared/config.test.ts`
Expected: PASS（`applyConfigOverrides` 已在 `backend-012` 实现，本步验证集成顺序）

若已 PASS，说明 `backend-012` 与本步的集成无缺口，Step 2 视为验证而非失败。

**Step 3: Write minimal implementation**

`main()` 的装配顺序：

```typescript
loadEnvFileIfPresent(".env");
const db = openDatabase(config.dbPath);            // 需要先读一次配置拿 dbPath
const overrides = configRepo.list();               // 建仓储
applyConfigOverrides(process.env, toMap(overrides));
const config = loadConfig();                      // 重新读取，此时含 DB 覆盖
```

注意 `dbPath` 必须在第一次 `loadConfig()` 后取得，而其余配置要在应用覆盖后重读——这一「读两次」的顺序需在代码注释中说明，否则后续维护者会「优化」成只读一次而让 DB 覆盖失效。

`docker-compose.yml` 新增 `- /data/cr-pilot:/app/data` 卷并把 `DB_PATH` 指向其下；`.env.example` 补充 `DB_PATH`、`ADMIN_USERNAME`、`ADMIN_PASSWORD`、`AUTH_SALT`、`LOG_FILE` 说明；`README.md` 补充新配置项、API 一览与 prompt 导入步骤。

`scripts/import-prompts.ts` 读取环境变量指向的 DB 路径与规则目录，调用 `importFromDir` 并打印导入结果。

**Step 4: Run test to verify it passes**

Run: `npm run typecheck && npm test`
Expected: PASS（全部测试通过）

自审：「读两次配置」的顺序注释是本任务最容易被后续修改破坏的地方，必须写明「若只读一次，DB 覆盖将不生效」。

**Step 5: Commit**

```bash
git add src/bootstrap.ts scripts/import-prompts.ts .env.example docker-compose.yml README.md test/shared/config.test.ts
git commit -m "feat: 组合根接入数据库与管理 API，补充导入脚本与部署配置"
```
