import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { openDatabase } from "../../../src/infrastructure/sqlite/database.ts";
import { createConfigRepository } from "../../../src/infrastructure/sqlite/config-repo.ts";
import { createConfigRouter } from "../../../src/interfaces/http/api/config.ts";
import { createApp } from "../../../src/interfaces/http/app.ts";
import { createSilentLogger } from "../../../src/shared/logger.ts";
import type { Express } from "express";

/** 环境变量项的形状（与接口返回一致）。 */
interface ConfigItemResponse {
  key: string;
  value: string;
  masked: boolean;
  restartRequired: boolean;
  overridden: boolean;
  readOnly: boolean;
  label: string;
  description: string;
  defaultValue: string;
  hint: string;
}

/** 起一个只挂配置路由的最小应用。 */
function buildApp(): Express {
  const db = openDatabase(":memory:");
  const config = createConfigRepository(db);
  return createApp({
    logger: createSilentLogger(),
    enqueue: () => {},
    // 本文件只验证配置说明元数据，鉴权不是关注点：用放行中间件代替真实鉴权。
    authMiddleware: (_req, _res, next) => next(),
    apiRoutes: { "/api/config": createConfigRouter({ config }) },
  });
}

/** 用 fetch 打随机端口，返回配置项列表。 */
async function fetchItems(app: Express): Promise<ConfigItemResponse[]> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/config`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { items: ConfigItemResponse[] };
    return body.items;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("每个可管理配置项都有中文名与用途说明", async () => {
  // 页面只显示英文键名时运维看不出用途，因此每项都必须带说明。
  // 新增配置键却忘记登记说明时，这条用例会失败。
  const items = await fetchItems(buildApp());
  const missing = items.filter((item) => !item.label || !item.description);
  assert.deepEqual(
    missing.map((item) => item.key),
    [],
    "以下配置项缺少中文名或用途说明，请在 CONFIG_DOCS 中登记",
  );
});

test("说明字段随接口下发，且不影响原有字段", async () => {
  const items = await fetchItems(buildApp());
  const port = items.find((item) => item.key === "PORT");
  assert.ok(port, "PORT 必须始终列出");
  assert.equal(port.label, "监听端口");
  assert.match(port.description, /监听端口/);
  assert.equal(port.defaultValue, "5001", "默认值应与 shared/config.ts 一致");
  // 原有字段语义不变
  assert.equal(port.masked, false);
  assert.equal(port.readOnly, false);
  assert.equal(port.restartRequired, true);
});

test("只读项与密钥项的说明同样齐全", async () => {
  const items = await fetchItems(buildApp());
  for (const key of ["DB_PATH", "ADMIN_USERNAME", "ADMIN_PASSWORD"]) {
    const item = items.find((row) => row.key === key);
    assert.ok(item, `${key} 必须列出`);
    assert.equal(item.readOnly, true, `${key} 应为只读`);
    assert.ok(item.label && item.description, `${key} 缺少说明`);
  }
  // AUTH_SALT 可改（写库覆盖），但改完必须重启才生效——不在 READ_ONLY_KEYS 里。
  const authSalt = items.find((row) => row.key === "AUTH_SALT");
  assert.ok(authSalt);
  assert.equal(authSalt.masked, true, "AUTH_SALT 应被掩码");
  assert.equal(authSalt.readOnly, false, "AUTH_SALT 允许页面修改");
  assert.equal(authSalt.restartRequired, true, "改 AUTH_SALT 必须重启才生效");
  assert.match(authSalt.description, /令牌|盐/, "说明应解释它是什么");
});

test("正整数项的说明里给出单位或格式", async () => {
  const items = await fetchItems(buildApp());
  for (const key of ["REVIEW_TIMEOUT_MS", "GITLAB_API_TIMEOUT", "REVIEW_BATCH_MAX_TOKENS"]) {
    const item = items.find((row) => row.key === key);
    assert.ok(item);
    assert.ok(item.hint, `${key} 应给出取值提示`);
  }
});

test("历史遗留覆盖项即使没有说明也不报错", async () => {
  // 旧版本可能写入任意键；这些键没有登记说明，页面退化为只显示键名。
  const db = openDatabase(":memory:");
  const config = createConfigRepository(db);
  config.setAll([{ key: "LEGACY_CUSTOM_KEY", value: "x" }]);
  const app = createApp({
    logger: createSilentLogger(),
    enqueue: () => {},
    authMiddleware: (_req, _res, next) => next(),
    apiRoutes: { "/api/config": createConfigRouter({ config }) },
  });
  const items = await fetchItems(app);
  const legacy = items.find((item) => item.key === "LEGACY_CUSTOM_KEY");
  assert.ok(legacy, "历史覆盖项仍要展示，便于运维清理");
  assert.equal(legacy.label, "", "未登记说明的键 label 为空串而非报错");
  assert.equal(legacy.description, "");
  db.close();
});

test("OpenAPI 包含采纳统计接口与其数据模型", () => {
  const spec = JSON.parse(readFileSync("docs/openapi.json", "utf8")) as {
    paths: Record<string, unknown>;
    components: { schemas: Record<string, unknown> };
  };
  assert.ok(spec.paths["/api/reviews/adoption"], "必须暴露采纳统计接口");
  assert.ok(spec.components.schemas.AdoptionStats, "必须定义采纳统计模型");
  assert.ok(spec.components.schemas.AdoptionDimensionRow, "必须定义维度聚合模型");
});

test("OpenAPI 包含功能自检接口与任务模型", () => {
  const spec = JSON.parse(readFileSync("docs/openapi.json", "utf8")) as {
    paths: Record<string, unknown>;
    components: { schemas: Record<string, unknown> };
  };
  assert.ok(spec.paths["/api/verify/ai"], "必须暴露 AI 验证接口");
  assert.ok(spec.paths["/api/verify/wecom"], "必须暴露企微验证接口");
  assert.ok(spec.paths["/api/verify/tasks/{id}"], "必须暴露任务查询接口");
  assert.ok(spec.components.schemas.VerifyTask, "必须定义任务模型");
});

test("企微自检的 OpenAPI 契约要求明确选择测试提交人", () => {
  const spec = JSON.parse(readFileSync("docs/openapi.json", "utf8")) as {
    paths: Record<string, { post: { requestBody: { required: boolean; content: Record<string, { schema: { required: string[]; properties: Record<string, unknown> } }> } } }>;
  };
  const body = spec.paths["/api/verify/wecom"].post.requestBody;
  assert.equal(body.required, true);
  const schema = body.content["application/json"].schema;
  assert.ok(schema.required.includes("gitlabUsername"));
  assert.ok(schema.properties.gitlabUsername);
});
