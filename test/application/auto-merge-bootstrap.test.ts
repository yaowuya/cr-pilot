import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const bootstrap = readFileSync(new URL("../../src/bootstrap.ts", import.meta.url), "utf8");

test("组合根把完整项目的实时自动合并策略注入评审管线", () => {
  assert.match(
    bootstrap,
    /resolveAutoMergePolicy:\s*\(project\)\s*=>\s*prompts\.resolveProjectSetting\?\.\(project\)\?\.autoMergePolicy/,
    "自动合并必须读取项目设置的精确 resolver，不能复用会回落 default 或短名的 Prompt resolve",
  );
});

test("组合根注释锁定自动合并的完整路径与二次复核边界", () => {
  const pipelineStart = bootstrap.indexOf("const pipeline = createReviewPipeline");
  assert.ok(pipelineStart >= 0, "无法定位管线装配");
  const context = bootstrap.slice(Math.max(0, pipelineStart - 500), pipelineStart + 700);
  assert.match(context, /完整项目路径/);
  assert.match(context, /短名[\s\S]{0,100}不能授权|不能授权[\s\S]{0,100}短名/);
  assert.match(context, /任务开始.*PUT 前|PUT 前.*任务开始/);
});
