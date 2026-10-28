import { test } from "node:test";
import assert from "node:assert/strict";
import { createAdoptionTracker } from "../../src/application/adoption-tracker.ts";
import { fingerprintLine, type ReviewFinding, type ReviewFindingRepository } from "../../src/domain/review-finding.ts";
import type { Logger } from "../../src/shared/logger.ts";
import { sealSecret } from "../../src/shared/secret-box.ts";

const salt = "synthetic-observability-salt";

function finding(id: number, mrIid: number, overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    id, recordId: id, projectId: 1, mrIid, marker: `<!-- marker:${id} -->`, findingId: String(id), severity: "p1",
    path: "a.ts", line: 1, lineKey: "new_line", baseSha: "base", headSha: "same",
    codeFingerprint: fingerprintLine("const a = 1;"), discussionId: `d${id}`, noteId: id,
    outcome: "pending", trackedAt: null, createdAt: id, gitlabUrl: "https://gitlab.invalid",
    gitlabTokenSealed: sealSecret(`synthetic-token-${id}`, salt), ...overrides,
  };
}

function repository(rows: ReviewFinding[]): ReviewFindingRepository {
  return {
    insert() {}, listByRecord: () => rows, listByMr: () => rows,
    listPendingTracking: () => rows,
    countUntrackable: () => ({ total: 0, fallback: 0, unknown: 0 }),
    updateOutcome(id, outcome, trackedAt, headSha) {
      const row = rows.find((item) => item.id === id);
      if (row) Object.assign(row, { outcome, trackedAt, headSha });
    },
    refreshTrackingCredentials: () => 0,
    getAdoptionStats: () => ({ total: { tracked: 0, adopted: 0, pending: rows.length, rate: null }, untrackable: { fallback: 0, unknown: 0 }, byProject: [], byCommitter: [], bySeverity: [] }),
  };
}

function collectingLogger(entries: Array<{ level: string; message: string; fields?: Record<string, unknown> }>): Logger {
  return {
    debug: (message, fields) => entries.push({ level: "debug", message, fields }),
    info: (message, fields) => entries.push({ level: "info", message, fields }),
    warn: (message, fields) => entries.push({ level: "warn", message, fields }),
    error: (message, fields) => entries.push({ level: "error", message, fields }),
  };
}

test("轮次 INFO 区分等待、已是最新、缺凭据和版本不可用，不再混成待处理", async () => {
  const rows = [
    finding(1, 1),
    finding(2, 2, { outcome: "ignored", trackedAt: 10 }),
    finding(3, 3, { gitlabTokenSealed: "" }),
    finding(4, 4),
  ];
  const entries: Array<{ level: string; message: string; fields?: Record<string, unknown> }> = [];
  const tracker = createAdoptionTracker({
    findings: repository(rows), secretKey: salt, logger: collectingLogger(entries),
    client: {
      getLatestHeadSha: async () => "same",
      getMergeRequestTrackingState: async (_project, iid) => ({ headSha: iid === 4 ? "" : "same", state: "opened" }),
      getDiscussions: async () => [], getFileRaw: async () => "const a = 1;",
    },
  });
  await tracker.runOnce();
  const summary = entries.find((entry) => entry.level === "info" && entry.message === "采纳追踪完成一轮");
  assert.ok(summary);
  assert.deepEqual(summary.fields, {
    扫描候选建议数: 4, 已判定建议数: 0, 其中终态收口: 0, 等待新提交建议数: 1,
    已是最新判定建议数: 1, 缺少凭据建议数: 1, 最新版本不可用建议数: 1,
    失败MR数: 0, 失败建议数: 0, 不可追踪建议数: 0, 其中降级并入汇总: 0, 其中有行锚点但无法定位: 0,
  });
  assert.equal("待处理建议数" in summary.fields, false);
  assert.doesNotMatch(JSON.stringify(entries), /synthetic-token/);
});

test("讨论读取失败只把真正需要判定的建议计为失败", async () => {
  const rows = [finding(1, 1, { headSha: "old" }), finding(2, 1, { headSha: "new", outcome: "ignored", trackedAt: 10 })];
  const entries: Array<{ level: string; message: string; fields?: Record<string, unknown> }> = [];
  const tracker = createAdoptionTracker({ findings: repository(rows), secretKey: salt, logger: collectingLogger(entries), client: {
    getLatestHeadSha: async () => "new",
    getMergeRequestTrackingState: async () => ({ headSha: "new", state: "opened" }),
    getDiscussions: async () => { throw new Error("synthetic discussion failure"); },
    getFileRaw: async () => "const a = 1;",
  } });
  await tracker.runOnce();
  const summary = entries.find((entry) => entry.message === "采纳追踪完成一轮");
  assert.equal(summary?.fields?.已是最新判定建议数, 1);
  assert.equal(summary?.fields?.失败MR数, 1);
  assert.equal(summary?.fields?.失败建议数, 1);
});

test("终态 pending 即使 head 已变化也在汇总日志计入收口", async () => {
  const rows = [finding(1, 1, { headSha: "old" })];
  const entries: Array<{ level: string; message: string; fields?: Record<string, unknown> }> = [];
  const tracker = createAdoptionTracker({ findings: repository(rows), secretKey: salt, logger: collectingLogger(entries), client: {
    getLatestHeadSha: async () => "new",
    getMergeRequestTrackingState: async () => ({ headSha: "new", state: "closed" }),
    getDiscussions: async () => [], getFileRaw: async () => "const a = 2;",
  } });
  await tracker.runOnce();
  const summary = entries.find((entry) => entry.message === "采纳追踪完成一轮");
  assert.equal(summary?.fields?.其中终态收口, 1);
  assert.equal(rows[0].outcome, "adopted");
});

test("终态同 head 收口在汇总日志单独计数", async () => {
  const rows = [finding(1, 1)];
  const entries: Array<{ level: string; message: string; fields?: Record<string, unknown> }> = [];
  const tracker = createAdoptionTracker({ findings: repository(rows), secretKey: salt, logger: collectingLogger(entries), client: {
    getLatestHeadSha: async () => "same",
    getMergeRequestTrackingState: async () => ({ headSha: "same", state: "merged" }),
    getDiscussions: async () => [], getFileRaw: async () => "const a = 1;",
  } });
  await tracker.runOnce();
  const summary = entries.find((entry) => entry.message === "采纳追踪完成一轮");
  assert.equal(summary?.fields?.已判定建议数, 1);
  assert.equal(summary?.fields?.其中终态收口, 1);
  assert.equal(rows[0].outcome, "ignored");
});
