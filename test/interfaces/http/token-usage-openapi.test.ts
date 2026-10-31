import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const openapi = JSON.parse(readFileSync(new URL("../../../docs/openapi.json", import.meta.url), "utf8")) as {
  components: { schemas: Record<string, {
    required?: string[];
    properties?: Record<string, {
      description?: string; nullable?: boolean; maximum?: number; minimum?: number; default?: unknown;
      required?: string[]; $ref?: string;
    }>;
    description?: string;
  }> };
  paths: Record<string, { get?: { description?: string } }>;
};
const generator = readFileSync(new URL("../../../scripts/build-openapi.ts", import.meta.url), "utf8");
const readme = readFileSync(new URL("../../../README.md", import.meta.url), "utf8");

test("OpenAPI 声明 token 用量结构与 null 语义", () => {
  const usage = openapi.components.schemas.TokenUsage;
  assert.ok(usage, "缺少 TokenUsage schema");
  assert.deepEqual(usage.required, ["input", "output", "cacheRead", "cacheWrite", "totalTokens"]);
  assert.match(usage.description ?? "", /子集/, "必须说明缓存是输入的子集，避免调用方相加");

  const record = openapi.components.schemas.ReviewRecord;
  assert.match(record.properties?.tokenUsage?.description ?? "", /没有可用 usage 数据/);
});

test("OpenAPI 的 ReviewStats 暴露按次与按维度 token 统计", () => {
  const stats = openapi.components.schemas.ReviewStats;
  assert.ok(stats.required?.includes("tokens"), "统计响应必须声明 tokens");
  assert.deepEqual(stats.properties?.tokens, { $ref: "#/components/schemas/TokenTotals" });

  const totals = openapi.components.schemas.TokenTotals;
  assert.deepEqual(totals.required, [
    "recordedReviews", "input", "output", "cacheRead", "cacheWrite", "total", "avgPerReview", "cacheHitRate",
  ]);
  assert.match(totals.description ?? "", /真实分母/, "必须说明平均值分母只算有 usage 的记录");

  const dimension = openapi.components.schemas.DimensionStat;
  assert.ok(dimension.required?.includes("totalTokens"));
  assert.match(dimension.properties?.totalTokens?.description ?? "", /不是 0/);
});

test("OpenAPI 采纳统计声明高分排除与排除条数", () => {
  const stats = openapi.components.schemas.AdoptionStats;
  assert.ok(stats.required?.includes("excluded"), "必须声明 excluded，避免调用方以为数据丢失");
  assert.deepEqual(stats.required, ["total", "untrackable", "excluded", "byProject", "byCommitter", "bySeverity"]);
  const excluded = openapi.components.schemas.AdoptionStats.properties?.excluded as { required?: string[] } | undefined;
  assert.equal(excluded?.required?.[0], "highScore");

  const description = openapi.paths["/api/reviews/adoption"]?.get?.description ?? "";
  assert.match(description, /95 分/, "口径必须写进端点描述");
  assert.match(description, /同时.*分子.*分母|分子也一并排除/);
  assert.match(description, /没有分数.*不按高分/);
});

test("README 记录 token 统计与高分排除口径", () => {
  assert.match(readme, /## Token 用量统计/);
  assert.match(readme, /缓存.*子集/);
  assert.match(readme, /整条记录记为 `null`|记为 `null`/);
  assert.match(readme, /≥ 95 分/);
  assert.match(readme, /不属于.*不可追踪/);
});

test("生成器自身承载 token 与排除语义，不能只手改产物", () => {
  assert.match(generator, /TokenUsage: \{/);
  assert.match(generator, /TokenTotals: \{/);
  assert.match(generator, /excluded: \{/);
  assert.match(generator, /高分排除/);
});
