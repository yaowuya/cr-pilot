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

// ============ 采纳率排除 ≥95 分评审 ============

/** 写入一条指定分数的评审记录，返回其 ID，供高分排除用例使用。 */
function seedScoredRecord(db: DatabaseSync, score: number | null, committer = "甲"): number {
  const result = db.prepare(
    `INSERT INTO review_records (
       project_id, project_name, mr_iid, committer_name, change_count, batch_count,
       score, duration_ms, result, error_message, comment_url, mr_url, started_at, finished_at
     ) VALUES (1, 'g/p', 7, ?, 1, 1, ?, 10, 'success', NULL, NULL, NULL, 1, 2)`,
  ).run(committer, score);
  return Number(result.lastInsertRowid);
}

test("95 分及以上评审的建议同时从分子与分母排除", () => {
  const db = openDatabase(":memory:");
  const low = seedScoredRecord(db, 60);
  const high = seedScoredRecord(db, 95);
  const repo = createReviewFindingRepository(db);
  // 低分评审：1 采纳 1 忽略 → 采纳率 50%
  repo.insert(makeFinding({ recordId: low, marker: "low-a", headSha: "h1", outcome: "adopted", trackedAt: 1 }));
  repo.insert(makeFinding({ recordId: low, marker: "low-b", headSha: "h2", outcome: "ignored", trackedAt: 1 }));
  // 高分评审：2 条采纳。若只排除分母不排除分子，采纳率会变成 3/2 > 100%。
  repo.insert(makeFinding({ recordId: high, marker: "high-a", headSha: "h3", outcome: "adopted", trackedAt: 1 }));
  repo.insert(makeFinding({ recordId: high, marker: "high-b", headSha: "h4", outcome: "adopted", trackedAt: 1 }));

  const stats = repo.getAdoptionStats({});
  assert.equal(stats.total.tracked, 2, "分母只保留低于 95 分的可统计建议");
  assert.equal(stats.total.adopted, 1, "高分建议的采纳数也必须排除，否则采纳率会超过 100%");
  assert.equal(stats.total.rate, 0.5);
  assert.equal(stats.excluded.highScore, 2, "排除条数必须单列，避免被误认为数据丢失");
  db.close();
});

test("95 分是边界：94 分计入，95 分排除", () => {
  const db = openDatabase(":memory:");
  const below = seedScoredRecord(db, 94);
  const at = seedScoredRecord(db, 95);
  const repo = createReviewFindingRepository(db);
  repo.insert(makeFinding({ recordId: below, marker: "m94", headSha: "h1", outcome: "adopted", trackedAt: 1 }));
  repo.insert(makeFinding({ recordId: at, marker: "m95", headSha: "h2", outcome: "ignored", trackedAt: 1 }));

  const stats = repo.getAdoptionStats({});
  assert.equal(stats.total.tracked, 1, "94 分仍参与采纳率");
  assert.equal(stats.total.adopted, 1);
  assert.equal(stats.excluded.highScore, 1);
  db.close();
});

test("没有分数的评审不被当作高分排除", () => {
  const db = openDatabase(":memory:");
  // 关键回归：SQL 里若直接写 `score < 95`，NULL 比较结果为 NULL，
  // 会把缺分记录一起排除；必须用 COALESCE 保留它们。
  const unscored = seedScoredRecord(db, null);
  const repo = createReviewFindingRepository(db);
  repo.insert(makeFinding({ recordId: unscored, marker: "m1", headSha: "h1", outcome: "adopted", trackedAt: 1 }));

  const stats = repo.getAdoptionStats({});
  assert.equal(stats.total.tracked, 1, "缺分记录必须保留在采纳率分母中");
  assert.equal(stats.excluded.highScore, 0);
  db.close();
});

test("分组维度与总计使用同一高分排除口径", () => {
  const db = openDatabase(":memory:");
  const low = seedScoredRecord(db, 70, "甲");
  const high = seedScoredRecord(db, 99, "乙");
  const repo = createReviewFindingRepository(db);
  repo.insert(makeFinding({ recordId: low, marker: "m1", headSha: "h1", severity: "p1", outcome: "adopted", trackedAt: 1 }));
  repo.insert(makeFinding({ recordId: high, marker: "m2", headSha: "h2", severity: "p1", outcome: "adopted", trackedAt: 1 }));

  const stats = repo.getAdoptionStats({});
  assert.deepEqual(stats.byCommitter.map((row) => row.name), ["甲"], "高分提交人整组消失，而不是留下 100% 的组");
  assert.deepEqual(stats.byProject.map((row) => row.tracked), [1]);
  assert.equal(stats.bySeverity.find((row) => row.name === "p1")?.tracked, 1);
  db.close();
});

test("等待判定的高分建议也计入排除数，避免用户等一个永不出现在分母的数", () => {
  const db = openDatabase(":memory:");
  const high = seedScoredRecord(db, 97);
  const repo = createReviewFindingRepository(db);
  repo.insert(makeFinding({ recordId: high, marker: "m1", headSha: "h1", outcome: "pending", trackedAt: null }));

  const stats = repo.getAdoptionStats({});
  assert.equal(stats.total.tracked, 0);
  assert.equal(stats.total.pending, 0, "高分 pending 不进等待判定：它永远不会被计入采纳率");
  assert.equal(stats.excluded.highScore, 1);
  db.close();
});

test("排除条数与总计使用同一时间/项目筛选口径", () => {
  const db = openDatabase(":memory:");
  const highEarly = seedScoredRecord(db, 96);
  // 把第一条挪到早期时间窗，验证筛选会作用到排除数上。
  db.prepare("UPDATE review_records SET started_at = 100 WHERE id = ?").run(highEarly);
  const highLate = seedScoredRecord(db, 98);
  db.prepare("UPDATE review_records SET started_at = 9000 WHERE id = ?").run(highLate);
  const repo = createReviewFindingRepository(db);
  repo.insert(makeFinding({ recordId: highEarly, marker: "m-early", headSha: "h1", outcome: "adopted", trackedAt: 1 }));
  repo.insert(makeFinding({ recordId: highLate, marker: "m-late", headSha: "h2", outcome: "adopted", trackedAt: 1 }));

  assert.equal(repo.getAdoptionStats({}).excluded.highScore, 2, "无筛选时两条都排除");
  // 注意：采纳统计 filter 用的是 findings.created_at，因此这里改用 createdAt 控制时间窗。
  db.prepare("UPDATE review_findings SET created_at = 100 WHERE marker = 'm-early'").run();
  db.prepare("UPDATE review_findings SET created_at = 9000 WHERE marker = 'm-late'").run();
  assert.equal(repo.getAdoptionStats({ from: 5000 }).excluded.highScore, 1, "时间筛选必须同时作用于排除数");
  assert.equal(repo.getAdoptionStats({ projectId: 999 }).excluded.highScore, 0, "项目筛选必须同时作用于排除数");
  db.close();
});
