import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const types = readFileSync(new URL("../../../web/src/types.ts", import.meta.url), "utf8");
const statsView = readFileSync(new URL("../../../web/src/views/StatsView.vue", import.meta.url), "utf8");
const adoptionView = readFileSync(new URL("../../../web/src/views/AdoptionView.vue", import.meta.url), "utf8");
const reviewsView = readFileSync(new URL("../../../web/src/views/ReviewsView.vue", import.meta.url), "utf8");

function compact(source: string): string {
  return source.replace(/\s+/g, " ").trim();
}

test("前端类型与后端契约一致：token 五元组、统计汇总与排除条数", () => {
  const usage = types.match(/export interface TokenUsage \{[\s\S]*?\n\}/)?.[0];
  assert.ok(usage, "缺少 TokenUsage 类型");
  for (const field of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"]) {
    assert.match(usage, new RegExp(`\\b${field}\\s*:\\s*number`));
  }

  const totals = types.match(/export interface TokenTotals \{[\s\S]*?\n\}/)?.[0];
  assert.ok(totals, "缺少 TokenTotals 类型");
  for (const field of ["recordedReviews", "avgPerReview", "cacheHitRate"]) {
    assert.match(totals, new RegExp(`\\b${field}\\s*:`));
  }

  assert.match(types, /tokenUsage:\s*TokenUsage \| null/, "记录上的用量必须可为 null");
  assert.match(types, /tokens:\s*TokenTotals/, "统计响应必须带 tokens");
  assert.match(types, /totalTokens:\s*number \| null/, "维度行 token 必须可为 null");
  assert.match(types, /excluded:\s*\{ highScore: number \}/);
});

test("统计页展示 token 用量，并用「—」表达缺失而不是 0", () => {
  const source = compact(statsView);
  assert.match(source, /<h2>Token 使用<\/h2>/);
  for (const label of ["总 Token", "输入", "输出", "每次平均"]) {
    assert.match(source, new RegExp(`<span>${label}</span>`), `缺少 ${label} 指标`);
  }
  // 缺失必须是「—」，否则「没采到」会被读成「零消耗」。
  assert.match(source, /function formatTokens\(value: number \| null\): string \{ return value === null \? "—"/);
  assert.match(source, /缓存命中率/);
  assert.match(source, /都是输入的子集，不与输入相加/);
  assert.match(source, /recordedReviews/);
  // 维度表也展示 token。
  assert.match(source, /label="Token"[\s\S]{0,120}formatTokens\(row\.totalTokens\)/);
});

test("统计页默认值包含 tokens，避免首屏读取 undefined", () => {
  const source = compact(statsView);
  assert.match(source, /tokens: \{ recordedReviews: 0,[^}]*total: null/);
  assert.match(compact(reviewsView), /tokens: \{ recordedReviews: 0,[^}]*total: null/);
});

test("采纳页单独展示高分排除，并声明分子分母同时排除", () => {
  const source = compact(adoptionView);
  assert.match(source, /excludedHighScore/);
  assert.match(source, /已按口径排除 \{\{ excludedHighScore \}\} 条高分建议/);
  assert.match(source, /分子与分母同时排除/);
  assert.match(source, /不属于不可追踪/);
  assert.match(source, /评审总分 ≥ 95 分的建议/);
  // 排除项不能混进不可追踪总数。
  assert.match(source, /const excludedHighScore = computed\(\(\) => adoption\.value\?\.excluded\.highScore \?\? 0\);/);
});
