import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const viewSource = readFileSync(new URL("../../../web/src/views/AdoptionView.vue", import.meta.url), "utf8");
const statsSource = readFileSync(new URL("../../../web/src/views/StatsView.vue", import.meta.url), "utf8");
const typeSource = readFileSync(new URL("../../../web/src/types.ts", import.meta.url), "utf8");

function compact(source: string): string { return source.replace(/\s+/g, " ").trim(); }

test("前端 AdoptionStats 类型在 total 与维度行声明 pending", () => {
  const dimensionStart = typeSource.indexOf("export interface AdoptionDimensionRow");
  const statsStart = typeSource.indexOf("export interface AdoptionStats", dimensionStart);
  const nextType = typeSource.indexOf("export type VerifyTaskStatus", statsStart);
  assert.ok(dimensionStart >= 0 && statsStart > dimensionStart && nextType > statsStart, "无法定位 AdoptionStats 类型");
  assert.match(typeSource.slice(dimensionStart, statsStart), /\bpending\s*:\s*number\s*;/);
  assert.match(typeSource.slice(statsStart, nextType), /total\s*:\s*\{[^}]*\bpending\s*:\s*number\s*;/s);
});

test("AdoptionView 展示等待判定，并在项目与提交人共用表中展示 pending 列", () => {
  const source = compact(viewSource);
  assert.match(source, /label:\s*"等待判定".{0,180}?adoption\.value\?\.total\.pending/);
  assert.match(source, /<el-table-column\s+prop="pending"\s+label="等待判定"/);
  assert.match(source, /const projectRows\s*=\s*computed/);
  assert.match(source, /const committerRows\s*=\s*computed/);
  assert.match(source, /\/api\/reviews\/adoption/);
  assert.doesNotMatch(statsSource, /\/api\/reviews\/adoption/, "评分统计页不应继续加载采纳接口");
});

test("tracked=0 时同时说明等待判定与不可追踪，不把零分母归因于无行位置", () => {
  const source = compact(viewSource);
  assert.match(source, /adoption\s*&&\s*adoption\.total\.tracked\s*===\s*0/);
  assert.match(source, /adoption\.total\.pending\s*>\s*0\s*\|\|\s*untrackableTotal\s*>\s*0/);
  assert.match(source, /等待判定\s*\{\{\s*adoption\.total\.pending\s*\}\}/);
  assert.match(source, /不可追踪\s*\{\{\s*untrackableTotal\s*\}\}/);
  assert.match(source, /两类建议都不会被当作未采纳加入分母/);
});
