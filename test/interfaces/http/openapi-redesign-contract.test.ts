import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const openapi = JSON.parse(readFileSync(new URL("../../../docs/openapi.json", import.meta.url), "utf8")) as {
  paths: Record<string, { get?: { parameters?: Array<{ name: string }> } }>;
  components: { schemas: Record<string, { properties?: Record<string, unknown> }> };
};

test("OpenAPI 同步评审概览筛选与采纳项目工作台字段", () => {
  const statsParams = openapi.paths["/api/reviews/stats"]?.get?.parameters?.map((item) => item.name) ?? [];
  assert.ok(statsParams.includes("project_id"));
  assert.ok(statsParams.includes("committer"));
  assert.ok(openapi.components.schemas.AdoptionDimensionRow?.properties?.projectId);
  const adoptionParams = openapi.paths["/api/reviews/adoption"]?.get?.parameters?.map((item) => item.name) ?? [];
  assert.ok(adoptionParams.includes("projectId"));
});
