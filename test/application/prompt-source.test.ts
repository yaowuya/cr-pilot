import { test } from "node:test";
import assert from "node:assert/strict";
import { describePromptSource, type PromptSource } from "../../src/application/review-pipeline.ts";

test("数据库项目规则来源显示规则名与 id", () => {
  const source: PromptSource = {
    kind: "db-project",
    name: "通用评审",
    id: 7,
    projects: ["auto-ops", "cw-auto-ops"],
  };
  const text = describePromptSource(source);
  assert.match(text, /数据库项目规则/);
  assert.match(text, /通用评审/);
  assert.match(text, /id=7/);
});

test("数据库全局默认来源标明是 default", () => {
  const text = describePromptSource({ kind: "db-default", name: "default", id: 1 });
  assert.match(text, /数据库全局默认/);
  assert.match(text, /default/);
  assert.match(text, /id=1/);
});

test("兜底来源明确说明数据库无可用记录", () => {
  const text = describePromptSource({ kind: "fallback", name: "group/proj" });
  assert.match(text, /yaml兜底/);
  assert.match(text, /数据库无可用记录/);
});

test("三种来源的描述互不相同，日志里可区分", () => {
  // 排障时靠这句描述判断「命中了哪套规则」，三者必须一眼可分
  const descriptions = new Set([
    describePromptSource({ kind: "db-project", name: "p", id: 1, projects: ["a"] }),
    describePromptSource({ kind: "db-default", name: "default", id: 2 }),
    describePromptSource({ kind: "fallback", name: "x" }),
  ]);
  assert.equal(descriptions.size, 3, "三种来源的描述不能重复");
});
