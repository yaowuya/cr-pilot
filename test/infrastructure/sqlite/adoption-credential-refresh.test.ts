import { test } from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../../../src/infrastructure/sqlite/database.ts";
import { createReviewFindingRepository } from "../../../src/infrastructure/sqlite/review-finding-repo.ts";

const ORIGINAL_URL = "https://old-gitlab.example.invalid";
const ORIGINAL_SEALED_TOKEN = "sealed-fixture-original";
// webhook 只能刷新同一实例的任务凭据；实例地址同时作为跨 GitLab 隔离键。
const REFRESHED_URL = ORIGINAL_URL;
const REFRESHED_SEALED_TOKEN = "sealed-fixture-refreshed";

/** 建立建议表外键所需的最小评审记录。 */
function seedRecord(db: DatabaseSync): number {
  const result = db.prepare(
    `INSERT INTO review_records (
       project_id, project_name, mr_iid, committer_name, change_count, batch_count,
       score, duration_ms, result, error_message, comment_url, mr_url, started_at, finished_at
     ) VALUES (11, 'fixture/project', 7, 'fixture-author', 1, 1, 80, 1, 'success', NULL, NULL, NULL, 1, 2)`,
  ).run();
  return Number(result.lastInsertRowid);
}

/** 构造凭据刷新测试所需的建议行；token 仅使用不可用的合成密文。 */
function makeFinding(
  recordId: number,
  overrides: Partial<Parameters<ReturnType<typeof createReviewFindingRepository>["insert"]>[0]> = {},
): Parameters<ReturnType<typeof createReviewFindingRepository>["insert"]>[0] {
  return {
    recordId,
    projectId: 11,
    mrIid: 7,
    marker: "pending-trackable",
    findingId: "pending-trackable",
    severity: "high",
    path: "src/example.ts",
    line: 2,
    lineKey: "new_line",
    baseSha: "base",
    headSha: "head-pending-trackable",
    codeFingerprint: "fixture-fingerprint",
    discussionId: "discussion-1",
    noteId: 1,
    outcome: "pending",
    trackedAt: null,
    createdAt: 1,
    gitlabUrl: ORIGINAL_URL,
    gitlabTokenSealed: ORIGINAL_SEALED_TOKEN,
    ...overrides,
  };
}

test("refreshTrackingCredentials 只更新指定 GitLab 实例/project/MR 的可追踪 pending 行", () => {
  const db = openDatabase(":memory:");
  try {
    const recordId = seedRecord(db);
    const repository = createReviewFindingRepository(db);
    repository.insert(makeFinding(recordId));
    repository.insert(makeFinding(recordId, {
      marker: "pending-fallback",
      findingId: "pending-fallback",
      headSha: "head-pending-fallback",
      codeFingerprint: "",
    }));
    repository.insert(makeFinding(recordId, {
      marker: "already-adopted",
      findingId: "already-adopted",
      headSha: "head-already-adopted",
      outcome: "adopted",
      trackedAt: 20,
    }));
    repository.insert(makeFinding(recordId, {
      marker: "other-instance",
      findingId: "other-instance",
      headSha: "head-other-instance",
      gitlabUrl: "https://other-gitlab.example.invalid",
    }));
    repository.insert(makeFinding(recordId, {
      marker: "other-mr",
      findingId: "other-mr",
      headSha: "head-other-mr",
      mrIid: 8,
    }));
    repository.insert(makeFinding(recordId, {
      marker: "other-project",
      findingId: "other-project",
      headSha: "head-other-project",
      projectId: 12,
    }));

    const updated = repository.refreshTrackingCredentials(11, 7, REFRESHED_URL, REFRESHED_SEALED_TOKEN);

    assert.equal(updated, 1, "只有带行锚点、会实际追踪的 pending 行需要刷新凭据");
    const targetRows = repository.listByMr(11, 7);
    const trackablePending = targetRows.find((finding) => finding.findingId === "pending-trackable");
    assert.ok(trackablePending);
    assert.equal(trackablePending.gitlabUrl, REFRESHED_URL);
    assert.equal(trackablePending.gitlabTokenSealed, REFRESHED_SEALED_TOKEN);
    const fallbackPending = targetRows.find((finding) => finding.findingId === "pending-fallback");
    assert.ok(fallbackPending);
    assert.equal(fallbackPending.gitlabUrl, ORIGINAL_URL, "永远不可追踪的降级项不应扩大凭据存储范围");
    assert.equal(fallbackPending.gitlabTokenSealed, ORIGINAL_SEALED_TOKEN);

    const adopted = targetRows.find((finding) => finding.findingId === "already-adopted");
    assert.ok(adopted);
    assert.equal(adopted.gitlabUrl, ORIGINAL_URL, "已判定行不得被新 webhook 凭据改写");
    assert.equal(adopted.gitlabTokenSealed, ORIGINAL_SEALED_TOKEN);

    const otherInstance = targetRows.find((finding) => finding.findingId === "other-instance");
    assert.ok(otherInstance);
    assert.equal(otherInstance.gitlabUrl, "https://other-gitlab.example.invalid");
    assert.equal(otherInstance.gitlabTokenSealed, ORIGINAL_SEALED_TOKEN);

    const otherMr = repository.listByMr(11, 8)[0];
    assert.equal(otherMr.gitlabUrl, ORIGINAL_URL);
    assert.equal(otherMr.gitlabTokenSealed, ORIGINAL_SEALED_TOKEN);
    const otherProject = repository.listByMr(12, 7)[0];
    assert.equal(otherProject.gitlabUrl, ORIGINAL_URL);
    assert.equal(otherProject.gitlabTokenSealed, ORIGINAL_SEALED_TOKEN);

    assert.equal(
      repository.refreshTrackingCredentials(999, 999, REFRESHED_URL, REFRESHED_SEALED_TOKEN),
      0,
      "没有匹配行时返回零",
    );
  } finally {
    db.close();
  }
});

test("refreshTrackingCredentials 不吞掉 SQLite 更新错误", () => {
  const db = openDatabase(":memory:");
  try {
    const recordId = seedRecord(db);
    const repository = createReviewFindingRepository(db);
    repository.insert(makeFinding(recordId));
    db.exec(`
      CREATE TRIGGER reject_tracking_credential_refresh
      BEFORE UPDATE OF gitlab_url, gitlab_token_sealed ON review_findings
      BEGIN
        SELECT RAISE(ABORT, 'synthetic credential refresh failure');
      END;
    `);

    assert.throws(
      () => repository.refreshTrackingCredentials(11, 7, REFRESHED_URL, REFRESHED_SEALED_TOKEN),
      /synthetic credential refresh failure/,
    );
    const unchanged = repository.listByMr(11, 7)[0];
    assert.equal(unchanged.gitlabUrl, ORIGINAL_URL);
    assert.equal(unchanged.gitlabTokenSealed, ORIGINAL_SEALED_TOKEN);
  } finally {
    db.close();
  }
});
