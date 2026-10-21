import { test } from "node:test";
import assert from "node:assert/strict";
import { createAdoptionTracker, decideOutcome } from "../../src/application/adoption-tracker.ts";
import { fingerprintLine, type ReviewFinding, type ReviewFindingRepository } from "../../src/domain/review-finding.ts";
import { createSilentLogger } from "../../src/shared/logger.ts";

/** 构造一条待追踪建议。 */
function makeFinding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  const line = "const target = 1;";
  return {
    id: 1,
    recordId: 1,
    projectId: 1,
    mrIid: 7,
    marker: "<!-- marker:old:1 -->",
    findingId: "f1",
    severity: "p1",
    path: "src/a.ts",
    line: 3,
    lineKey: "new_line",
    baseSha: "old",
    headSha: "old",
    codeFingerprint: fingerprintLine(line),
    discussionId: "d1",
    noteId: 1,
    outcome: "pending",
    trackedAt: null,
    createdAt: 1,
    ...overrides,
  };
}

/** 内存仓储替身：只实现追踪用例用到的方法。 */
function repoWith(items: ReviewFinding[]): ReviewFindingRepository & { rows: ReviewFinding[] } {
  const rows = [...items];
  return {
    rows,
    insert() {},
    listByRecord: () => rows,
    listByMr: () => rows,
    listPendingTracking: () => rows.filter((row) => row.outcome === "pending" && row.codeFingerprint !== ""),
    updateOutcome(id, outcome, trackedAt) {
      const row = rows.find((item) => item.id === id);
      if (row) {
        row.outcome = outcome;
        row.trackedAt = trackedAt;
      }
    },
    getAdoptionStats: () => ({
      total: { tracked: 0, adopted: 0, rate: null },
      untrackable: { fallback: 0, unknown: 0 },
      byProject: [],
      byCommitter: [],
      bySeverity: [],
    }),
  };
}

/** 构造 GitLab 替身。 */
function clientStub(options: {
  latestHead?: string;
  file?: string | (() => Promise<string>);
  resolved?: boolean;
  discussions?: { id: string; notes: { id: number; body: string; resolvable?: boolean; resolved?: boolean }[] }[];
}) {
  return {
    getLatestHeadSha: async () => options.latestHead ?? "new",
    getFileRaw: async () => {
      if (typeof options.file === "function") return options.file();
      if (options.file === undefined) return ["line1", "line2", ["const target = 1;"]].flat().join("\n");
      return options.file;
    },
    getDiscussions: async () =>
      options.discussions ?? [
        { id: "d1", notes: [{ id: 1, body: "x <!-- marker:old:1 -->", resolvable: true, resolved: options.resolved ?? false }] },
      ],
  };
}

test("目标行未变且未解决记 ignored", async () => {
  const repo = repoWith([makeFinding()]);
  const tracker = createAdoptionTracker({ findings: repo, client: clientStub({}), logger: createSilentLogger() });
  await tracker.runOnce();
  assert.equal(repo.rows[0].outcome, "ignored");
  assert.ok(repo.rows[0].trackedAt);
});

test("目标行改变记 adopted", async () => {
  const repo = repoWith([makeFinding()]);
  const tracker = createAdoptionTracker({
    findings: repo,
    client: clientStub({ file: "line1\nline2\nconst target = 2;\n" }),
    logger: createSilentLogger(),
  });
  await tracker.runOnce();
  assert.equal(repo.rows[0].outcome, "adopted");
});

test("已解决但代码未变记 resolved-without-change", async () => {
  const repo = repoWith([makeFinding()]);
  const tracker = createAdoptionTracker({ findings: repo, client: clientStub({ resolved: true }), logger: createSilentLogger() });
  await tracker.runOnce();
  assert.equal(repo.rows[0].outcome, "resolved-without-change");
});

test("文件读取失败记 unknown，不猜测", async () => {
  const repo = repoWith([makeFinding()]);
  const tracker = createAdoptionTracker({
    findings: repo,
    client: clientStub({ file: async () => { throw new Error("404"); } }),
    logger: createSilentLogger(),
  });
  await tracker.runOnce();
  assert.equal(repo.rows[0].outcome, "unknown");
});

test("文件保留但指纹消失，说明该行已被改写，记 adopted", async () => {
  const repo = repoWith([makeFinding()]);
  const tracker = createAdoptionTracker({
    findings: repo,
    // 文件仍在、行数够，但原行内容已被改写
    client: clientStub({ file: "line1\nline2\nconst target = 999;\n" }),
    logger: createSilentLogger(),
  });
  await tracker.runOnce();
  assert.equal(repo.rows[0].outcome, "adopted");
});

test("文件被大幅截断、原行号远超现有行数时记 unknown", async () => {
  const repo = repoWith([makeFinding({ line: 100 })]);
  const tracker = createAdoptionTracker({
    findings: repo,
    client: clientStub({ file: "only-one-line" }),
    logger: createSilentLogger(),
  });
  await tracker.runOnce();
  assert.equal(repo.rows[0].outcome, "unknown", "整体重写时无法归因到单行，不能猜");
});

test("head 未变时跳过，不改状态", async () => {
  const repo = repoWith([makeFinding()]);
  const tracker = createAdoptionTracker({ findings: repo, client: clientStub({ latestHead: "old" }), logger: createSilentLogger() });
  await tracker.runOnce();
  assert.equal(repo.rows[0].outcome, "pending", "没有新提交不应判定");
});

test("行号漂移后仍按指纹定位并判定", async () => {
  const repo = repoWith([makeFinding({ line: 3 })]);
  // 前面多插入两行，目标行从第 3 行移到第 5 行
  const tracker = createAdoptionTracker({
    findings: repo,
    client: clientStub({ file: "n1\nn2\nline1\nline2\nconst target = 1;\n" }),
    logger: createSilentLogger(),
  });
  await tracker.runOnce();
  assert.equal(repo.rows[0].outcome, "ignored", "位移不算改动");
});

test("单条 MR 失败不影响其他 MR", async () => {
  const rows = [
    makeFinding({ id: 1, mrIid: 7, headSha: "old" }),
    makeFinding({ id: 2, mrIid: 8, headSha: "old", marker: "<!-- marker:old:2 -->" }),
  ];
  const repo = repoWith(rows);
  let calls = 0;
  const base = clientStub({});
  const tracker = createAdoptionTracker({
    findings: repo,
    client: {
      ...base,
      getLatestHeadSha: async (projectId, iid) => {
        calls += 1;
        if (iid === 7) throw new Error("限流");
        return "new";
      },
    },
    logger: createSilentLogger(),
  });
  await tracker.runOnce();
  assert.equal(calls, 2);
  assert.equal(rows[0].outcome, "pending", "失败的 MR 保持原状态，等下一轮");
  assert.notEqual(rows[1].outcome, "pending", "另一个 MR 不受影响");
});

test("decideOutcome 四态组合正确", () => {
  assert.equal(decideOutcome(true, false), "adopted");
  assert.equal(decideOutcome(true, true), "adopted", "改动即采纳，解决状态不影响结论");
  assert.equal(decideOutcome(false, true), "resolved-without-change");
  assert.equal(decideOutcome(false, false), "ignored");
});

test("没有待追踪项时不请求 GitLab", async () => {
  const repo = repoWith([makeFinding({ outcome: "adopted" })]);
  let called = 0;
  const tracker = createAdoptionTracker({
    findings: repo,
    client: { getLatestHeadSha: async () => { called += 1; return "new"; }, getFileRaw: async () => "", getDiscussions: async () => [] },
    logger: createSilentLogger(),
  });
  await tracker.runOnce();
  assert.equal(called, 0);
});
