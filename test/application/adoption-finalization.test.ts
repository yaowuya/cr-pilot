import assert from "node:assert/strict";
import { test } from "node:test";
import * as adoptionTracking from "../../src/application/adoption-tracker.ts";
import type { GitlabClient } from "../../src/domain/review-task.ts";
import {
  fingerprintLine,
  type FindingOutcome,
  type ReviewFinding,
  type ReviewFindingRepository,
} from "../../src/domain/review-finding.ts";
import type { Logger } from "../../src/shared/logger.ts";
import { createSilentLogger } from "../../src/shared/logger.ts";
import { sealSecret } from "../../src/shared/secret-box.ts";

const TRACKING_SALT = "adoption-finalization-test-salt";
const REVIEWED_HEAD = "reviewed-head";
const UNCHANGED_FILE = "line 1\nline 2\nconst target = 1;\nline 4";

type MergeRequestTrackingState = {
  headSha: string;
  state: "opened" | "closed" | "merged";
};

type TrackingClient = Pick<GitlabClient, "getLatestHeadSha" | "getFileRaw" | "getDiscussions"> & {
  getMergeRequestTrackingState?: (
    projectId: number,
    iid: number,
    gitlabUrl?: string,
    gitlabToken?: string,
  ) => Promise<MergeRequestTrackingState>;
};

type TrackingTriggerFactory = (
  tracker: adoptionTracking.AdoptionTracker,
  logger: Logger,
) => () => Promise<void>;

/** 构造一条有真实行锚点、可离线追踪的建议。 */
function makeFinding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    id: 1,
    recordId: 10,
    projectId: 101,
    mrIid: 7,
    marker: "<!-- marker:reviewed-head:1 -->",
    findingId: "finding-1",
    severity: "p1",
    path: "src/example.ts",
    line: 3,
    lineKey: "new_line",
    baseSha: "base-head",
    headSha: REVIEWED_HEAD,
    codeFingerprint: fingerprintLine("const target = 1;"),
    discussionId: "discussion-1",
    noteId: 11,
    gitlabUrl: "https://gitlab.example.test",
    gitlabTokenSealed: sealSecret("glpat-synthetic", TRACKING_SALT),
    outcome: "pending",
    trackedAt: null,
    createdAt: 1,
    ...overrides,
  };
}

/** 内存仓储只通过公开端口暴露判定结果，不读取数据库或历史产物。 */
function createFindingRepository(items: ReviewFinding[]): ReviewFindingRepository & { rows: ReviewFinding[] } {
  const rows = items.map((item) => ({ ...item }));
  return {
    rows,
    insert() {},
    listByRecord: () => rows,
    listByMr: () => rows,
    listPendingTracking: (limit) => rows.filter((row) => row.codeFingerprint !== "").slice(0, limit),
    countUntrackable: () => {
      const fallback = rows.filter((row) => row.codeFingerprint === "").length;
      const unknown = rows.filter((row) => row.outcome === "unknown").length;
      return { total: fallback + unknown, fallback, unknown };
    },
    refreshTrackingCredentials: () => 0,
    updateOutcome(id, outcome, trackedAt, evaluatedHeadSha) {
      const row = rows.find((candidate) => candidate.id === id);
      if (!row) return;
      row.outcome = outcome;
      row.trackedAt = trackedAt;
      row.headSha = evaluatedHeadSha;
    },
    getAdoptionStats: () => ({
      total: { tracked: 0, adopted: 0, pending: 0, rate: null },
      untrackable: { fallback: 0, unknown: 0 },
        excluded: { highScore: 0 },
      byProject: [],
      byCommitter: [],
      bySeverity: [],
    }),
  };
}

function createTracker(rows: ReviewFinding[], client: TrackingClient) {
  const findings = createFindingRepository(rows);
  const tracker = adoptionTracking.createAdoptionTracker({
    findings,
    client,
    logger: createSilentLogger(),
    secretKey: TRACKING_SALT,
  });
  return { findings, tracker };
}

/** 读取新增的公开触发接口；缺少导出时给出清晰的红测原因。 */
function requireTrackingTriggerFactory(): TrackingTriggerFactory {
  const candidate: unknown = Reflect.get(adoptionTracking, "createAdoptionTrackingTrigger");
  if (typeof candidate !== "function") {
    assert.fail("adoption-tracker.ts 尚未导出 createAdoptionTrackingTrigger");
  }
  return candidate as TrackingTriggerFactory;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** 用有限事件循环轮次等待异步状态，避免行为缺失时测试永久挂起。 */
async function eventually(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}

test("opened MR 的 head 未变化时继续保持 pending", async () => {
  const calls = { state: 0, legacyHead: 0, file: 0, discussions: 0 };
  const client: TrackingClient = {
    getMergeRequestTrackingState: async (...args) => {
      calls.state += 1;
      assert.deepEqual(args, [101, 7, "https://gitlab.example.test", "glpat-synthetic"]);
      return { headSha: REVIEWED_HEAD, state: "opened" };
    },
    getLatestHeadSha: async () => {
      calls.legacyHead += 1;
      return REVIEWED_HEAD;
    },
    getFileRaw: async () => {
      calls.file += 1;
      return UNCHANGED_FILE;
    },
    getDiscussions: async () => {
      calls.discussions += 1;
      return [];
    },
  };
  const { findings, tracker } = createTracker([makeFinding()], client);

  await tracker.runOnce();

  assert.equal(findings.rows[0].outcome, "pending");
  assert.equal(findings.rows[0].trackedAt, null);
  assert.deepEqual(calls, { state: 1, legacyHead: 0, file: 0, discussions: 0 });
});

const finalizationScenarios: {
  name: string;
  state: "closed" | "merged";
  file: string;
  resolved: boolean;
  expected: FindingOutcome;
}[] = [
  {
    name: "closed MR 中目标行改变后收口为 adopted",
    state: "closed",
    file: "line 1\nline 2\nconst target = 2;\nline 4",
    resolved: false,
    expected: "adopted",
  },
  {
    name: "merged MR 中目标行删除后收口为 adopted",
    state: "merged",
    file: "line 1\nline 2\nline 4\nline 5",
    resolved: false,
    expected: "adopted",
  },
  {
    name: "closed MR 中代码未变但讨论已解决时收口为 resolved-without-change",
    state: "closed",
    file: UNCHANGED_FILE,
    resolved: true,
    expected: "resolved-without-change",
  },
  {
    name: "merged MR 中代码未变且讨论未解决时收口为 ignored",
    state: "merged",
    file: UNCHANGED_FILE,
    resolved: false,
    expected: "ignored",
  },
];

for (const scenario of finalizationScenarios) {
  test(`${scenario.name}（即使 head 未变化）`, async () => {
    let legacyHeadCalls = 0;
    const client: TrackingClient = {
      getMergeRequestTrackingState: async () => ({ headSha: REVIEWED_HEAD, state: scenario.state }),
      getLatestHeadSha: async () => {
        legacyHeadCalls += 1;
        return REVIEWED_HEAD;
      },
      getFileRaw: async () => scenario.file,
      getDiscussions: async () => [
        {
          id: "discussion-1",
          notes: [
            {
              id: 11,
              body: `建议 ${makeFinding().marker}`,
              resolvable: true,
              resolved: scenario.resolved,
            },
          ],
        },
      ],
    };
    const { findings, tracker } = createTracker([makeFinding()], client);

    await tracker.runOnce();

    assert.equal(findings.rows[0].outcome, scenario.expected);
    assert.equal(findings.rows[0].headSha, REVIEWED_HEAD);
    assert.notEqual(findings.rows[0].trackedAt, null, "终态 MR 必须完成 pending 建议的最终判定");
    assert.equal(legacyHeadCalls, 0, "新 tracking-state 能力存在时不应回退旧接口");
  });
}

test("同一 head 已判定为非 pending 的建议不因 MR 收口而重复读取", async () => {
  const calls = { state: 0, legacyHead: 0, file: 0, discussions: 0 };
  const client: TrackingClient = {
    getMergeRequestTrackingState: async () => {
      calls.state += 1;
      return { headSha: REVIEWED_HEAD, state: "merged" };
    },
    getLatestHeadSha: async () => {
      calls.legacyHead += 1;
      return REVIEWED_HEAD;
    },
    getFileRaw: async () => {
      calls.file += 1;
      return UNCHANGED_FILE;
    },
    getDiscussions: async () => {
      calls.discussions += 1;
      return [];
    },
  };
  const existing = makeFinding({ outcome: "ignored", trackedAt: 123 });
  const { findings, tracker } = createTracker([existing], client);

  await tracker.runOnce();

  assert.equal(findings.rows[0].outcome, "ignored");
  assert.equal(findings.rows[0].trackedAt, 123);
  assert.deepEqual(calls, { state: 1, legacyHead: 0, file: 0, discussions: 0 });
});

test("head 变化时仍沿原逻辑重新判定已判定建议", async () => {
  const client: TrackingClient = {
    getMergeRequestTrackingState: async () => ({ headSha: "new-head", state: "opened" }),
    getLatestHeadSha: async () => REVIEWED_HEAD,
    getFileRaw: async () => "line 1\nline 2\nconst target = 999;\nline 4",
    getDiscussions: async () => [],
  };
  const existing = makeFinding({ outcome: "ignored", trackedAt: 123 });
  const { findings, tracker } = createTracker([existing], client);

  await tracker.runOnce();

  assert.equal(findings.rows[0].outcome, "adopted");
  assert.equal(findings.rows[0].headSha, "new-head");
  assert.notEqual(findings.rows[0].trackedAt, 123);
});

test("MR 级状态优先使用最新 pending 凭据，不被旧已判定行的吊销 token 阻塞", async () => {
  const old = makeFinding({ id: 1, outcome: "ignored", trackedAt: 10, gitlabTokenSealed: sealSecret("revoked-token", TRACKING_SALT), createdAt: 1 });
  const fresh = makeFinding({ id: 2, marker: "<!-- marker:reviewed-head:2 -->", gitlabTokenSealed: sealSecret("fresh-token", TRACKING_SALT), createdAt: 2 });
  const stateTokens: string[] = [];
  const client: TrackingClient = {
    getMergeRequestTrackingState: async (_project, _iid, _url, token) => {
      stateTokens.push(token ?? "");
      if (token === "revoked-token") throw Object.assign(new Error("unauthorized"), { status: 401 });
      return { headSha: REVIEWED_HEAD, state: "opened" };
    },
    getLatestHeadSha: async () => REVIEWED_HEAD,
    getFileRaw: async () => UNCHANGED_FILE,
    getDiscussions: async () => [],
  };
  const { tracker } = createTracker([old, fresh], client);
  await tracker.runOnce();
  assert.deepEqual(stateTokens, ["fresh-token"]);
});

test("首选凭据认证失败时尝试同实例同 MR 的下一份可解凭据", async () => {
  const fallback = makeFinding({ id: 1, outcome: "ignored", trackedAt: 10, gitlabTokenSealed: sealSecret("fallback-token", TRACKING_SALT), createdAt: 1 });
  const pending = makeFinding({ id: 2, marker: "<!-- marker:reviewed-head:2 -->", gitlabTokenSealed: sealSecret("revoked-pending", TRACKING_SALT), createdAt: 2 });
  const stateTokens: string[] = [];
  const client: TrackingClient = {
    getMergeRequestTrackingState: async (_project, _iid, _url, token) => {
      stateTokens.push(token ?? "");
      if (token === "revoked-pending") throw Object.assign(new Error("unauthorized"), { status: 401 });
      return { headSha: REVIEWED_HEAD, state: "opened" };
    },
    getLatestHeadSha: async () => REVIEWED_HEAD,
    getFileRaw: async () => UNCHANGED_FILE,
    getDiscussions: async () => [],
  };
  const { tracker } = createTracker([fallback, pending], client);
  await tracker.runOnce();
  assert.deepEqual(stateTokens, ["revoked-pending", "fallback-token"]);
});

test("不同 GitLab 实例的同数字 project/MR 必须分组隔离", async () => {
  const first = makeFinding({ id: 1, gitlabUrl: "https://gitlab-a.example.test", gitlabTokenSealed: sealSecret("token-a", TRACKING_SALT) });
  const second = makeFinding({ id: 2, marker: "<!-- marker:reviewed-head:2 -->", gitlabUrl: "https://gitlab-b.example.test", gitlabTokenSealed: sealSecret("token-b", TRACKING_SALT) });
  const calls: unknown[][] = [];
  const client: TrackingClient = {
    getMergeRequestTrackingState: async (...args) => { calls.push(args); return { headSha: REVIEWED_HEAD, state: "opened" }; },
    getLatestHeadSha: async () => REVIEWED_HEAD,
    getFileRaw: async () => UNCHANGED_FILE,
    getDiscussions: async () => [],
  };
  const { tracker } = createTracker([first, second], client);
  await tracker.runOnce();
  assert.deepEqual(calls.sort((a, b) => String(a[2]).localeCompare(String(b[2]))), [
    [101, 7, "https://gitlab-a.example.test", "token-a"],
    [101, 7, "https://gitlab-b.example.test", "token-b"],
  ]);
});

test("同一 MR 首行缺凭据时使用后续有效行的实例与令牌读取状态", async () => {
  const first = makeFinding({ id: 1, gitlabUrl: "", gitlabTokenSealed: "" });
  const second = makeFinding({ id: 2, marker: "<!-- marker:reviewed-head:2 -->" });
  const stateCalls: unknown[][] = [];
  const discussionCalls: unknown[][] = [];
  const client: TrackingClient = {
    getMergeRequestTrackingState: async (...args) => {
      stateCalls.push(args);
      return { headSha: REVIEWED_HEAD, state: "merged" };
    },
    getLatestHeadSha: async () => REVIEWED_HEAD,
    getFileRaw: async () => UNCHANGED_FILE,
    getDiscussions: async (...args) => { discussionCalls.push(args); return []; },
  };
  const { tracker } = createTracker([first, second], client);
  await tracker.runOnce();
  const expected = [101, 7, "https://gitlab.example.test", "glpat-synthetic"];
  assert.deepEqual(stateCalls, [expected]);
  assert.deepEqual(discussionCalls, [expected]);
});

test("GitlabClient 缺少 tracking-state 方法时兼容 getLatestHeadSha 并视为 opened", async () => {
  const calls = { legacyHead: 0, file: 0, discussions: 0 };
  const client: TrackingClient = {
    getLatestHeadSha: async () => {
      calls.legacyHead += 1;
      return REVIEWED_HEAD;
    },
    getFileRaw: async () => {
      calls.file += 1;
      return UNCHANGED_FILE;
    },
    getDiscussions: async () => {
      calls.discussions += 1;
      return [];
    },
  };
  const { findings, tracker } = createTracker([makeFinding()], client);

  await tracker.runOnce();

  assert.equal(findings.rows[0].outcome, "pending", "兼容路径不能把 opened MR 提前收口");
  assert.deepEqual(calls, { legacyHead: 1, file: 0, discussions: 0 });
});

test("single-flight 在运行中合并多次触发：最大并发 1 且最多补跑一次", async () => {
  const createTrigger = requireTrackingTriggerFactory();
  const gates = [deferred(), deferred()];
  const pendingCalls: Promise<void>[] = [];
  let runs = 0;
  let active = 0;
  let maxActive = 0;
  const tracker: adoptionTracking.AdoptionTracker = {
    async runOnce() {
      const index = runs;
      runs += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        await (gates[index]?.promise ?? Promise.resolve());
      } finally {
        active -= 1;
      }
    },
  };
  const trigger = createTrigger(tracker, createSilentLogger());

  try {
    pendingCalls.push(trigger());
    await eventually(() => runs === 1, "首次触发未启动追踪轮次");

    pendingCalls.push(trigger(), trigger(), trigger());
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(runs, 1, "运行中触发不能并发启动新轮次");

    gates[0].resolve();
    await eventually(() => runs >= 2, "运行中多次触发没有合并成一次补跑");
    assert.equal(runs, 2, "同一繁忙周期只能补跑一次");
    assert.equal(maxActive, 1, "追踪轮次不得重叠执行");

    pendingCalls.push(trigger(), trigger());
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(runs, 2, "补跑期间的触发也不能形成第三轮");

    gates[1].resolve();
    await Promise.all(pendingCalls);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(runs, 2);
    assert.equal(maxActive, 1);
    assert.equal(active, 0);
  } finally {
    for (const gate of gates) gate.resolve();
    await Promise.allSettled(pendingCalls);
  }
});

test("single-flight 空闲后的新触发会启动新一轮", async () => {
  const createTrigger = requireTrackingTriggerFactory();
  let runs = 0;
  const trigger = createTrigger(
    {
      async runOnce() {
        runs += 1;
      },
    },
    createSilentLogger(),
  );

  await trigger();
  await trigger();

  assert.equal(runs, 2);
});

test("single-flight 消化轮次异常、写日志且不会阻塞后续触发", async () => {
  const createTrigger = requireTrackingTriggerFactory();
  const logs: { level: string; message: string; fields?: Record<string, unknown> }[] = [];
  const logger: Logger = {
    debug: (message, fields) => logs.push({ level: "debug", message, fields }),
    info: (message, fields) => logs.push({ level: "info", message, fields }),
    warn: (message, fields) => logs.push({ level: "warn", message, fields }),
    error: (message, fields) => logs.push({ level: "error", message, fields }),
  };
  let runs = 0;
  const trigger = createTrigger(
    {
      async runOnce() {
        runs += 1;
        if (runs === 1) throw new Error("synthetic tracking failure");
      },
    },
    logger,
  );

  await assert.doesNotReject(() => trigger());
  await assert.doesNotReject(() => trigger());

  assert.equal(runs, 2, "失败轮次结束后必须恢复为空闲状态");
  assert.ok(
    logs.some((entry) => entry.level === "warn" || entry.level === "error"),
    "轮次异常必须由注入的 logger 留痕",
  );
});
