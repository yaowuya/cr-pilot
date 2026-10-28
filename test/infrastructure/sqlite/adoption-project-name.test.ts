import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../../../src/infrastructure/sqlite/database.ts";
import { createReviewRecordRepository } from "../../../src/infrastructure/sqlite/review-record-repo.ts";
import { createReviewFindingRepository } from "../../../src/infrastructure/sqlite/review-finding-repo.ts";

/** 采纳统计按评审发生时保存的项目全名分组，而不是展示数字 project_id。 */
test("采纳率按历史项目名称聚合，项目改名/同数字ID不会显示为数字", () => {
  const db = openDatabase(":memory:");
  try {
    const records = createReviewRecordRepository(db);
    const findings = createReviewFindingRepository(db);
    const recordId = records.insert({
      projectId: 3982, projectName: "rd-fy23-canway-kingark/cw-bcms-backend", mrIid: 2229,
      committerName: "张浩东", changeCount: 2, batchCount: 1, score: 90, durationMs: 10,
      result: "success", errorMessage: null, commentUrl: null, mrUrl: null, startedAt: 1, finishedAt: 2,
    });
    if (typeof recordId !== "number") assert.fail("SQLite 仓储必须返回记录 ID");
    findings.insert({
      recordId, projectId: 3982, mrIid: 2229, marker: "project-name", findingId: "project-name",
      severity: "p1", path: "src/a.ts", line: 1, lineKey: "new_line", baseSha: "base", headSha: "head",
      codeFingerprint: "fingerprint", discussionId: "d1", noteId: 1, outcome: "adopted", trackedAt: 3,
      createdAt: 2, gitlabUrl: "https://gitlab.example.invalid", gitlabTokenSealed: "sealed",
    });

    const stats = findings.getAdoptionStats({});
    assert.deepEqual(stats.byProject, [{
      name: "rd-fy23-canway-kingark/cw-bcms-backend", projectId: 3982, tracked: 1, adopted: 1, pending: 0, rate: 1,
    }]);
  } finally {
    db.close();
  }
});
