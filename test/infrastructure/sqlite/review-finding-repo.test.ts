import { test } from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../../../src/infrastructure/sqlite/database.ts";
import { createReviewFindingRepository } from "../../../src/infrastructure/sqlite/review-finding-repo.ts";

/** 插入一条评审记录，满足建议表的外键。 */
function seedRecord(db: DatabaseSync, committer = "王秦"): number {
  db.prepare(
    `INSERT INTO review_records (
       project_id, project_name, mr_iid, committer_name, change_count, batch_count,
       score, duration_ms, result, error_message, comment_url, mr_url, started_at, finished_at
     ) VALUES (1, 'g/p', 7, ?, 3, 1, 55, 1000, 'success', NULL, NULL, NULL, 1, 2)`,
  ).run(committer);
  return 1;
}

/** 构造一条待写入的建议。 */
function makeFinding(overrides: Partial<Parameters<ReturnType<typeof createReviewFindingRepository>["insert"]>[0]> = {}) {
  return {
    recordId: 1,
    projectId: 1,
    mrIid: 7,
    marker: "<!-- marker:a:1 -->",
    findingId: "1",
    severity: "p1",
    path: "src/a.ts",
    line: 10,
    lineKey: "new_line" as const,
    baseSha: "base",
    headSha: "head",
    codeFingerprint: "0123456789abcdef",
    discussionId: "d1",
    noteId: 11,
    outcome: "pending" as const,
    trackedAt: null,
    createdAt: 100,
    gitlabUrl: "https://gitlab.example.com",
    gitlabTokenSealed: "",
    ...overrides,
  };
}

test("同一版本同一 marker 只落一行", () => {
  const db = openDatabase(":memory:");
  seedRecord(db);
  const repo = createReviewFindingRepository(db);
  repo.insert(makeFinding());
  repo.insert(makeFinding());
  assert.equal(repo.listByRecord(1).length, 1, "重跑评审不能重复计数");
});

test("不同 head_sha 的同名 marker 视为两条不同建议", () => {
  const db = openDatabase(":memory:");
  seedRecord(db);
  const repo = createReviewFindingRepository(db);
  repo.insert(makeFinding());
  repo.insert(makeFinding({ headSha: "head2" }));
  assert.equal(repo.listByRecord(1).length, 2);
});

test("listPendingTracking 排除无指纹项，但保留已判定项以便新提交后重评", () => {
  const db = openDatabase(":memory:");
  seedRecord(db);
  const repo = createReviewFindingRepository(db);
  repo.insert(makeFinding({ marker: "m1" }));
  // 降级并入汇总：无指纹，永远无法追踪
  repo.insert(makeFinding({ marker: "m2", codeFingerprint: "" }));
  const pending = repo.listPendingTracking(10);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].marker, "m1");

  repo.updateOutcome(pending[0].id, "adopted", 200, "head-new");
  const updated = repo.listByRecord(1).find((item) => item.marker === "m1");
  assert.equal(updated?.trackedAt, 200);
  assert.equal(updated?.headSha, "head-new", "必须记录本次评估的 head");

  // 已判定项仍会被扫描：追踪器再按 headSha 比较决定是否需要重判，
  // 否则「先忽略、后改进」永远统计不到。
  const rescan = repo.listPendingTracking(10);
  assert.equal(rescan.length, 1);
  assert.equal(rescan[0].headSha, "head-new");
});

test("listPendingTracking 超过批量上限时轮转候选，后排 pending 不会被旧终态永久饿死", () => {
  const db = openDatabase(":memory:");
  seedRecord(db);
  const repo = createReviewFindingRepository(db);
  for (let index = 1; index <= 200; index += 1) {
    repo.insert(makeFinding({
      marker: `old-${index}`,
      headSha: `old-head-${index}`,
      outcome: "ignored",
      trackedAt: index,
      createdAt: index,
    }));
  }
  repo.insert(makeFinding({ marker: "new-pending", headSha: "new-pending-head", createdAt: 201 }));

  const first = repo.listPendingTracking(200);
  const second = repo.listPendingTracking(200);
  assert.equal(first.length, 200);
  assert.ok(second.some((finding) => finding.marker === "new-pending"), "后排候选必须在下一轮进入批次");
});

test("聚合采纳率排除 unknown 与不可追踪项", () => {
  const db = openDatabase(":memory:");
  seedRecord(db);
  const repo = createReviewFindingRepository(db);
  repo.insert(makeFinding({ marker: "m1", outcome: "adopted", trackedAt: 1, codeFingerprint: "f1" }));
  repo.insert(makeFinding({ marker: "m2", outcome: "ignored", trackedAt: 1, codeFingerprint: "f2" }));
  repo.insert(makeFinding({ marker: "m3", outcome: "resolved-without-change", trackedAt: 1, codeFingerprint: "f3" }));
  repo.insert(makeFinding({ marker: "m4", outcome: "unknown", trackedAt: 1, codeFingerprint: "f4" }));
  repo.insert(makeFinding({ marker: "m5", outcome: "pending", trackedAt: null, codeFingerprint: "" }));

  const stats = repo.getAdoptionStats({});
  assert.equal(stats.total.tracked, 3, "adopted + ignored + resolved-without-change");
  assert.equal(stats.total.adopted, 1);
  assert.ok(Math.abs((stats.total.rate ?? 0) - 1 / 3) < 1e-9);
  assert.equal(stats.untrackable.fallback, 1, "空指纹计入不可追踪");
  assert.equal(stats.untrackable.unknown, 1);
});

test("无数据时采纳率为 null 而不是 0", () => {
  const db = openDatabase(":memory:");
  seedRecord(db);
  const stats = createReviewFindingRepository(db).getAdoptionStats({});
  assert.equal(stats.total.tracked, 0);
  assert.equal(stats.total.rate, null);
});

test("按项目、提交人、严重级分组", () => {
  const db = openDatabase(":memory:");
  seedRecord(db, "王秦");
  const repo = createReviewFindingRepository(db);
  repo.insert(makeFinding({ marker: "m1", severity: "p0", outcome: "adopted", trackedAt: 1 }));
  repo.insert(makeFinding({ marker: "m2", severity: "p1", outcome: "ignored", trackedAt: 1 }));

  const stats = repo.getAdoptionStats({});
  assert.equal(stats.bySeverity.length, 2);
  assert.deepEqual(stats.byCommitter.map((row) => row.name), ["王秦"]);
  assert.equal(stats.byCommitter[0].tracked, 2);
  assert.equal(stats.byProject[0].tracked, 2);
});

test("按时间与项目过滤", () => {
  const db = openDatabase(":memory:");
  seedRecord(db);
  const repo = createReviewFindingRepository(db);
  repo.insert(makeFinding({ marker: "m1", createdAt: 100, outcome: "adopted", trackedAt: 1 }));
  repo.insert(makeFinding({ marker: "m2", createdAt: 900, outcome: "ignored", trackedAt: 1 }));

  assert.equal(repo.getAdoptionStats({ from: 500 }).total.tracked, 1);
  assert.equal(repo.getAdoptionStats({ to: 500 }).total.tracked, 1);
  assert.equal(repo.getAdoptionStats({ projectId: 999 }).total.tracked, 0);
});
