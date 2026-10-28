import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const viewSource = readFileSync(new URL("../../../web/src/views/StatsView.vue", import.meta.url), "utf8");
const typeSource = readFileSync(new URL("../../../web/src/types.ts", import.meta.url), "utf8");

/** 把模板换行压平，令断言只关注契约而不绑定格式化结果。 */
function compact(source: string): string {
  return source.replace(/\s+/g, " ").trim();
}

test("前端 AdoptionStats 类型在 total 与维度行声明 pending", () => {
  const dimensionStart = typeSource.indexOf("export interface AdoptionDimensionRow");
  const statsStart = typeSource.indexOf("export interface AdoptionStats", dimensionStart);
  const nextType = typeSource.indexOf("export type VerifyTaskStatus", statsStart);
  assert.ok(dimensionStart >= 0 && statsStart > dimensionStart && nextType > statsStart, "无法定位 AdoptionStats 类型");

  const dimensionType = typeSource.slice(dimensionStart, statsStart);
  const statsType = typeSource.slice(statsStart, nextType);
  assert.match(dimensionType, /\bpending\s*:\s*number\s*;/);
  assert.match(statsType, /total\s*:\s*\{[^}]*\bpending\s*:\s*number\s*;/s);
});

test("StatsView 展示等待判定卡，并在项目与提交人共用表中展示 pending 列", () => {
  const source = compact(viewSource);

  assert.match(
    source,
    /label:\s*"等待判定",.{0,240}?value:\s*data\s*\?\s*String\(data\.total\.pending\)/,
    "等待判定卡必须直接展示 total.pending",
  );
  assert.match(source, /<el-table-column\s+prop="pending"\s+label="等待判定"/);
  assert.match(source, /rows:\s*data\?\.byProject\s*\?\?\s*\[\]/);
  assert.match(source, /rows:\s*data\?\.byCommitter\s*\?\?\s*\[\]/);
});

test("tracked=0 时说明同时给出 43 条等待判定与 8 条不可追踪，不再只归因于无行位置", () => {
  const alert = viewSource.match(/<el-alert[\s\S]*?<\/el-alert>/)?.[0];
  assert.ok(alert, "采纳统计需要保留零分母说明");

  assert.match(alert, /adoption\.total\.tracked\s*===\s*0/);
  assert.match(alert, /adoption\.total\.pending/);
  assert.match(alert, /adoption\.untrackable\.fallback\s*\+\s*adoption\.untrackable\.unknown/);
  assert.match(alert, /等待判定/);
  assert.match(alert, /\{\{\s*adoption\.total\.pending\s*\}\}/);
  assert.match(alert, /不可追踪/);
  assert.match(alert, /\{\{\s*adoption\.untrackable\.fallback\s*\+\s*adoption\.untrackable\.unknown\s*\}\}/);

  const example = compact(alert)
    .replace(/\{\{\s*adoption\.total\.pending\s*\}\}/g, "43")
    .replace(/\{\{\s*adoption\.untrackable\.fallback\s*\+\s*adoption\.untrackable\.unknown\s*\}\}/g, "8");
  assert.match(example, /(?:等待判定.{0,24}43|43.{0,24}等待判定)/);
  assert.match(example, /(?:不可追踪.{0,24}8|8.{0,24}不可追踪)/);
  assert.doesNotMatch(alert, /不可统计的建议没有代码行位置/, "不能再把零分母全部归因于没有行位置");
});
