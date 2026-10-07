import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMarker, buildPosition, parseDiffLines, parseReviewJson } from "../../src/domain/inline-comment.ts";

test("parseDiffLines 区分新增行与删除行", () => {
  const diff = [
    "--- a/app.ts",
    "+++ b/app.ts",
    "@@ -1,3 +1,4 @@",
    " const a = 1;",
    "-const b = 2;",
    "+const b = 3;",
    "+const c = 4;",
    " const d = 5;",
  ].join("\n");
  const sets = parseDiffLines(diff);
  assert.deepEqual([...sets.added].sort((a, b) => a - b), [2, 3]);
  assert.deepEqual([...sets.removed].sort((a, b) => a - b), [2]);
  assert.deepEqual([...sets.visibleNew].sort((a, b) => a - b), [1, 2, 3, 4]);
  // old 侧只有 3 行（1 上下文、2 删除、3 上下文）：删除行占用 old 行号但不占 new。
  assert.deepEqual([...sets.visibleOld].sort((a, b) => a - b), [1, 2, 3]);
});

test("parseDiffLines 多 hunk 行号连续递增", () => {
  const diff = ["@@ -1,1 +1,1 @@", "+a", "@@ -10,1 +20,1 @@", "+b"].join("\n");
  const sets = parseDiffLines(diff);
  assert.deepEqual([...sets.added].sort((a, b) => a - b), [1, 20]);
});

test("parseDiffLines 无 hunk 头时返回空集合", () => {
  const sets = parseDiffLines("--- a/x\n+++ b/x\n+only header");
  assert.equal(sets.added.size, 0);
});

test("parseDiffLines 纯新增文件（@@ -0,0 +1,N @@）", () => {
  const sets = parseDiffLines(["@@ -0,0 +1,2 @@", "+one", "+two"].join("\n"));
  assert.deepEqual([...sets.added].sort((a, b) => a - b), [1, 2]);
  assert.equal(sets.removed.size, 0);
});

test("parseReviewJson 解析 findings 并强制 new_line/old_line 互斥", () => {
  const ok = parseReviewJson(
    JSON.stringify({
      reviewed_head_sha: "a".repeat(40),
      summary: { body: "总分：85 分" },
      findings: [{ id: "f1", severity: "high", path: "app.ts", new_line: 2, body: "空指针" }],
    }),
  );
  assert.equal(ok?.findings[0].lineKey, "new_line");
  assert.equal(ok?.findings[0].line, 2);
  assert.equal(
    parseReviewJson(
      JSON.stringify({
        reviewed_head_sha: "a".repeat(40),
        summary: { body: "x" },
        findings: [{ id: "f1", severity: "low", path: "a.ts", new_line: 1, old_line: 1, body: "b" }],
      }),
    ),
    null,
    "同时给出 new_line 与 old_line 必须判为非法",
  );
});

test("parseReviewJson 缺 summary 或 sha 非法时返回 null", () => {
  assert.equal(parseReviewJson("not json"), null);
  assert.equal(parseReviewJson(JSON.stringify({ reviewed_head_sha: "short", summary: { body: "x" }, findings: [] })), null);
  assert.equal(parseReviewJson(JSON.stringify({ reviewed_head_sha: "a".repeat(40), findings: [] })), null);
});

test("parseReviewJson 拒绝重复 id 与非法 severity", () => {
  const base = { reviewed_head_sha: "a".repeat(40), summary: { body: "x" } };
  assert.equal(
    parseReviewJson(JSON.stringify({ ...base, findings: [
      { id: "f1", severity: "low", path: "a.ts", new_line: 1, body: "b" },
      { id: "f1", severity: "low", path: "b.ts", new_line: 1, body: "c" },
    ] })),
    null,
    "重复 id 会让 marker 幂等判断失效",
  );
  assert.equal(
    parseReviewJson(JSON.stringify({ ...base, findings: [{ id: "f1", severity: "urgent", path: "a.ts", new_line: 1, body: "b" }] })),
    null,
  );
});

test("parseReviewJson 允许 old_line 锚点并保留 severity 小写", () => {
  const ok = parseReviewJson(
    JSON.stringify({
      reviewed_head_sha: "b".repeat(40),
      summary: { body: "总分：70 分" },
      findings: [{ id: "f2", severity: "HIGH", path: "a.ts", old_line: 5, body: "删除行问题" }],
    }),
  );
  assert.equal(ok?.findings[0].lineKey, "old_line");
  assert.equal(ok?.findings[0].severity, "high");
});

test("buildMarker 与 buildPosition 产出 marker 注释与完整 position", () => {
  assert.equal(buildMarker("abc", "f1"), "<!-- marker:abc:f1 -->");
  const position = buildPosition({
    refs: { baseSha: "b", startSha: "s", headSha: "h" },
    oldPath: "a.ts",
    newPath: "b.ts",
    lineKey: "new_line",
    line: 12,
  });
  assert.deepEqual(position, {
    position_type: "text",
    base_sha: "b",
    start_sha: "s",
    head_sha: "h",
    old_path: "a.ts",
    new_path: "b.ts",
    new_line: 12,
  });
});

test("buildPosition 在 old_line 锚点时不带 new_line", () => {
  const position = buildPosition({
    refs: { baseSha: "b", startSha: "s", headSha: "h" },
    oldPath: "a.ts",
    newPath: "a.ts",
    lineKey: "old_line",
    line: 3,
  });
  assert.equal("new_line" in position, false);
  assert.equal("old_line" in position ? position.old_line : undefined, 3);
});
