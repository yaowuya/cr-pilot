import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildMarker,
  buildPosition,
  parseDiffLines,
  parseFindingsFromMarkdown,
  parseReviewJson,
} from "../../src/domain/inline-comment.ts";

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

test("parseReviewJson 支持 Markdown 正文末尾 fenced JSON，并解析覆盖无锚点问题的 merge_gate", () => {
  const head = "c".repeat(40);
  const parsed = parseReviewJson(`## 评审报告\n\n### P1：无法定位但必须阻断\n\n\`\`\`json\n${JSON.stringify({
    reviewed_head_sha: head,
    summary: { body: "总分：95 分" },
    findings: [],
    merge_gate: { max_severity: "high", blocking_findings: 1 },
  })}\n\`\`\``);
  assert.deepEqual(parsed?.mergeGate, { maxSeverity: "high", blockingFindings: 1 });
  assert.equal(parsed?.reviewedHeadSha, head);
  assert.deepEqual(parsed?.findings, []);
});

test("parseReviewJson 对既有无 merge_gate JSON 保持兼容，但拒绝畸形 gate", () => {
  const base = { reviewed_head_sha: "d".repeat(40), summary: { body: "x" }, findings: [] };
  assert.equal(parseReviewJson(JSON.stringify(base))?.mergeGate, undefined);
  assert.equal(parseReviewJson(JSON.stringify({ ...base, merge_gate: { max_severity: "urgent", blocking_findings: 0 } })), null);
  assert.equal(parseReviewJson(JSON.stringify({ ...base, merge_gate: { max_severity: "low", blocking_findings: -1 } })), null);
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

// ============ Markdown 反推行内评论位置 ============

/** 模拟「prompt 缺结构化块」时模型的真实输出：纯 Markdown，含位置行。 */
const MARKDOWN_REVIEW = `代码审查报告

审查范围：本次变更涉及后端权限与通知组。

---

P0：部分拓扑权限被错误扩大为整个业务权限
- 位置： \`apps/task_mgmt/service/dynamic_topo_service.py:429-434\`
- 问题：权限判断缺失，导致越权读取。
- 建议：使用实际授权节点集合查询。

---

P1：通知组搜索存在 N+1 查询
- 位置： \`apps/system_mgmt/filters/notice_group_filter.py:22\`
- 问题：循环内查询关联关系。
`;

test("从 Markdown 正文反推出 findings", () => {
  const parsed = parseFindingsFromMarkdown(MARKDOWN_REVIEW, { headSha: "a".repeat(40) });
  assert.ok(parsed, "应能识别出可定位的问题");
  assert.equal(parsed.findings.length, 2);
  assert.equal(parsed.reviewedHeadSha, "a".repeat(40), "head_sha 由调用方注入");

  const first = parsed.findings[0];
  assert.equal(first.path, "apps/task_mgmt/service/dynamic_topo_service.py");
  assert.equal(first.line, 429, "区间取起始行作为锚点");
  assert.equal(first.lineKey, "new_line");
  assert.equal(first.severity, "critical", "P0 映射为 critical");
  assert.match(first.body, /拓扑权限/, "body 应包含问题说明");
});

test("P 级映射到 schema 的 severity 枚举", () => {
  const text = [
    "P0：甲",
    "- 位置： a/b.py:1",
    "P1：乙",
    "- 位置： a/c.py:2",
    "P2：丙",
    "- 位置： a/d.py:3",
    "P3：丁",
    "- 位置： a/e.py:4",
  ].join("\n");
  const parsed = parseFindingsFromMarkdown(text);
  assert.ok(parsed);
  assert.deepEqual(
    parsed.findings.map((f) => f.severity),
    ["critical", "high", "medium", "low"],
  );
});

test("同一位置的重复条目只取一次", () => {
  // 正文里常在摘要和详情各写一次位置，重复发布没有意义
  const text = ["P1：摘要里提一次", "- 位置： a/b.py:10", "", "P1：详情再说", "- 位置： a/b.py:10"].join("\n");
  const parsed = parseFindingsFromMarkdown(text);
  assert.ok(parsed);
  assert.equal(parsed.findings.length, 1);
});

test("id 稳定：同一位置每次生成相同 id，保证 marker 幂等", () => {
  const a = parseFindingsFromMarkdown(MARKDOWN_REVIEW);
  const b = parseFindingsFromMarkdown(MARKDOWN_REVIEW);
  assert.ok(a && b);
  assert.deepEqual(
    a.findings.map((f) => f.id),
    b.findings.map((f) => f.id),
    "同输入必须得到相同 id，否则重跑会重复发行内评论",
  );
});

test("非路径位置（函数名）不产生 finding", () => {
  // prompt 允许「函数/类名」这种写法，但无法用于 position，必须跳过
  const text = ["P1：某问题", "- 位置： `get_all_scope_host_ids` 函数"].join("\n");
  assert.equal(parseFindingsFromMarkdown(text), null);
});

test("没有任何位置时返回 null，交由调用方降级", () => {
  assert.equal(parseFindingsFromMarkdown("代码看起来没问题，没有发现可定位的问题。"), null);
});

test("混合路径风格都能识别", () => {
  const text = [
    "P2：甲",
    "- 位置: app.py:10",
    "P2：乙",
    "**位置**： `lib/util.ts:20`",
  ].join("\n");
  const parsed = parseFindingsFromMarkdown(text);
  assert.ok(parsed);
  assert.equal(parsed.findings.length, 2);
  assert.equal(parsed.findings[0].path, "app.py");
  assert.equal(parsed.findings[1].path, "lib/util.ts");
});
