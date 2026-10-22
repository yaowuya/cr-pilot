import { test } from "node:test";
import assert from "node:assert/strict";
import { createAdoptionTracker, decideOutcome } from "../../src/application/adoption-tracker.ts";
import { fingerprintLine, type ReviewFinding, type ReviewFindingRepository } from "../../src/domain/review-finding.ts";
import { createSilentLogger } from "../../src/shared/logger.ts";
import { sealSecret } from "../../src/shared/secret-box.ts";

/** 测试用部署盐；追踪器用它解密建议里的令牌。 */
const TRACKING_SALT = "test-tracking-salt";

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
    gitlabUrl: "https://gitlab.example.com",
    gitlabTokenSealed: sealSecret("glpat-token", TRACKING_SALT),
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
    // 与仓储一致：排除无指纹项，但保留已判定项以便新提交后重评。
    listPendingTracking: () => rows.filter((row) => row.codeFingerprint !== ""),
    countUntrackable: () => {
      const fallback = rows.filter((row) => row.codeFingerprint === "").length;
      const unknown = rows.filter((row) => row.outcome === "unknown").length;
      return { total: fallback + unknown, fallback, unknown };
    },
    updateOutcome(id, outcome, trackedAt, evaluatedHeadSha) {
      const row = rows.find((item) => item.id === id);
      if (row) {
        row.outcome = outcome;
        row.trackedAt = trackedAt;
        row.headSha = evaluatedHeadSha;
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
  const tracker = createAdoptionTracker({ findings: repo, client: clientStub({}), logger: createSilentLogger(), secretKey: TRACKING_SALT });
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
    secretKey: TRACKING_SALT,
  });
  await tracker.runOnce();
  assert.equal(repo.rows[0].outcome, "adopted");
});

test("已解决但代码未变记 resolved-without-change", async () => {
  const repo = repoWith([makeFinding()]);
  const tracker = createAdoptionTracker({ findings: repo, client: clientStub({ resolved: true }), logger: createSilentLogger(), secretKey: TRACKING_SALT });
  await tracker.runOnce();
  assert.equal(repo.rows[0].outcome, "resolved-without-change");
});

test("文件读取失败记 unknown，不猜测", async () => {
  const repo = repoWith([makeFinding()]);
  const tracker = createAdoptionTracker({
    findings: repo,
    client: clientStub({ file: async () => { throw new Error("404"); } }),
    logger: createSilentLogger(),
    secretKey: TRACKING_SALT,
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
    secretKey: TRACKING_SALT,
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
    secretKey: TRACKING_SALT,
  });
  await tracker.runOnce();
  assert.equal(repo.rows[0].outcome, "unknown", "整体重写时无法归因到单行，不能猜");
});

test("head 未变时跳过，不改状态", async () => {
  const repo = repoWith([makeFinding()]);
  const tracker = createAdoptionTracker({ findings: repo, client: clientStub({ latestHead: "old" }), logger: createSilentLogger(), secretKey: TRACKING_SALT });
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
    secretKey: TRACKING_SALT,
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
    secretKey: TRACKING_SALT,
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

test("没有可追踪项（全是无指纹降级项）时不请求 GitLab", async () => {
  const repo = repoWith([makeFinding({ outcome: "adopted", codeFingerprint: "" })]);
  let called = 0;
  const tracker = createAdoptionTracker({
    findings: repo,
    client: { getLatestHeadSha: async () => { called += 1; return "new"; }, getFileRaw: async () => "", getDiscussions: async () => [] },
    logger: createSilentLogger(),
    secretKey: TRACKING_SALT,
  });
  await tracker.runOnce();
  assert.equal(called, 0);
});

test("追踪调用必须携带任务级实例与解密后的令牌", async () => {
  // 关键回归：漏传 token 会以未鉴权身份请求 GitLab 并返回 401，
  // 所有建议被记为 unknown，采纳率永远为空。
  const repo = repoWith([makeFinding({ gitlabUrl: "https://gitlab.task-level", gitlabTokenSealed: sealSecret("glpat-real", TRACKING_SALT) })]);
  const calls: { raw: unknown[]; latest: unknown[]; discussions: unknown[] } = { raw: [], latest: [], discussions: [] };
  const tracker = createAdoptionTracker({
    findings: repo,
    client: {
      getLatestHeadSha: async (...args: unknown[]) => { calls.latest.push(args); return "new"; },
      getFileRaw: async (...args: unknown[]) => { calls.raw.push(args); return "line1\nline2\nconst target = 1;\n"; },
      getDiscussions: async (...args: unknown[]) => { calls.discussions.push(args); return []; },
    },
    logger: createSilentLogger(),
    secretKey: TRACKING_SALT,
  });
  await tracker.runOnce();

  assert.deepEqual(calls.latest[0], [1, 7, "https://gitlab.task-level", "glpat-real"]);
  assert.deepEqual(calls.raw[0], [1, 7, "src/a.ts", "new", "https://gitlab.task-level", "glpat-real"]);
  assert.deepEqual(calls.discussions[0], [1, 7, "https://gitlab.task-level", "glpat-real"]);
});

test("无凭据的建议被跳过，不发起未鉴权请求", async () => {
  const repo = repoWith([makeFinding({ gitlabTokenSealed: "" })]);
  let called = 0;
  const tracker = createAdoptionTracker({
    findings: repo,
    client: {
      getLatestHeadSha: async () => { called += 1; return "new"; },
      getFileRaw: async () => { called += 1; return ""; },
      getDiscussions: async () => { called += 1; return []; },
    },
    logger: createSilentLogger(),
    secretKey: TRACKING_SALT,
  });
  await tracker.runOnce();
  assert.equal(called, 0, "没有凭据就不能打 GitLab");
  assert.equal(repo.rows[0].outcome, "pending", "保持待追踪，等凭据恢复");
});

test("令牌解密失败时按无凭据处理，不抛错", async () => {
  const repo = repoWith([makeFinding({ gitlabTokenSealed: sealSecret("glpat-real", "别的盐") })]);
  let called = 0;
  const tracker = createAdoptionTracker({
    findings: repo,
    client: {
      getLatestHeadSha: async () => { called += 1; return "new"; },
      getFileRaw: async () => { called += 1; return ""; },
      getDiscussions: async () => { called += 1; return []; },
    },
    logger: createSilentLogger(),
    secretKey: TRACKING_SALT,
  });
  await tracker.runOnce();
  assert.equal(called, 0);
  assert.equal(repo.rows[0].outcome, "pending");
});

test("已判定的建议在新提交后重新评估（先忽略、后改进）", async () => {
  // 关键回归：只扫 pending 会让「先无视、后改代码」永久停留 ignored，
  // 采纳率系统性偏低，也与设计的「终态可被覆盖」状态机不一致。
  const repo = repoWith([makeFinding({ outcome: "ignored", trackedAt: 100, headSha: "old" })]);
  const tracker = createAdoptionTracker({
    findings: repo,
    client: {
      getLatestHeadSha: async () => "new",
      getFileRaw: async () => "line1\nline2\nconst target = 999;\n",
      getDiscussions: async () => [],
    },
    logger: createSilentLogger(),
    secretKey: TRACKING_SALT,
  });
  await tracker.runOnce();
  assert.equal(repo.rows[0].outcome, "adopted", "新提交改了代码必须重判为 adopted");
  assert.equal(repo.rows[0].headSha, "new", "记录本次评估的 head");
});

test("已按最新 head 判定过的建议不再重复请求 GitLab", async () => {
  const repo = repoWith([makeFinding({ outcome: "ignored", trackedAt: 100, headSha: "new" })]);
  let rawCalls = 0;
  const tracker = createAdoptionTracker({
    findings: repo,
    client: {
      getLatestHeadSha: async () => "new",
      getFileRaw: async () => { rawCalls += 1; return ""; },
      getDiscussions: async () => [],
    },
    logger: createSilentLogger(),
    secretKey: TRACKING_SALT,
  });
  await tracker.runOnce();
  assert.equal(rawCalls, 0, "同一版本不重复判定");
  assert.equal(repo.rows[0].outcome, "ignored", "状态保持不变");
});
