import { test } from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../../../src/infrastructure/sqlite/database.ts";
import { createReviewFindingRepository } from "../../../src/infrastructure/sqlite/review-finding-repo.ts";
import { createReviewRecordRepository } from "../../../src/infrastructure/sqlite/review-record-repo.ts";

type NewFinding = Parameters<ReturnType<typeof createReviewFindingRepository>["insert"]>[0];

interface FindingOwner {
  recordId: number;
  projectId: number;
  mrIid: number;
}

/** 写入一条真实评审记录，作为建议明细的外键与提交人来源。 */
function seedRecord(
  db: DatabaseSync,
  input: { projectId: number; projectName: string; mrIid: number; committerName: string },
): FindingOwner {
  const recordId = createReviewRecordRepository(db).insert({
    ...input,
    changeCount: 1,
    batchCount: 1,
    score: 80,
    durationMs: 10,
    result: "success",
    errorMessage: null,
    commentUrl: null,
    mrUrl: null,
    startedAt: 1,
    finishedAt: 2,
    tokenUsage: null,
  });
  if (typeof recordId !== "number") assert.fail("真实 SQLite 仓储必须返回自增记录 ID");
  return { recordId, projectId: input.projectId, mrIid: input.mrIid };
}

/** 构造建议；默认是有行指纹、尚未判定的可追踪建议。 */
function finding(owner: FindingOwner, marker: string, overrides: Partial<NewFinding> = {}): NewFinding {
  return {
    ...owner,
    marker,
    findingId: marker,
    severity: "p1",
    path: "src/example.ts",
    line: 10,
    lineKey: "new_line",
    baseSha: `base-${owner.projectId}`,
    headSha: `head-${owner.projectId}`,
    codeFingerprint: `fingerprint-${marker}`,
    discussionId: `discussion-${marker}`,
    noteId: 1,
    outcome: "pending",
    trackedAt: null,
    createdAt: 100,
    gitlabUrl: "https://gitlab.example.com",
    gitlabTokenSealed: "sealed-test-token",
    ...overrides,
  };
}

/** 从聚合结果中取指定维度行，缺行时给出可读失败。 */
function rowNamed<T extends { name: string }>(rows: readonly T[], name: string): T {
  const row = rows.find((item) => item.name === name);
  assert.ok(row, `缺少维度行 ${name}`);
  return row;
}

test("pending 只统计有指纹的待判定建议，并出现在总计及每个聚合维度", () => {
  const db = openDatabase(":memory:");
  try {
    const projectA = seedRecord(db, { projectId: 101, projectName: "group/a", mrIid: 7, committerName: "甲" });
    const projectB = seedRecord(db, { projectId: 202, projectName: "group/b", mrIid: 8, committerName: "乙" });
    const repo = createReviewFindingRepository(db);

    repo.insert(finding(projectA, "a-adopted", { outcome: "adopted", trackedAt: 200 }));
    repo.insert(finding(projectA, "a-ignored", { outcome: "ignored", trackedAt: 200 }));
    repo.insert(finding(projectA, "a-pending"));
    // 降级项即使仍是 pending，也只能进入 fallback，不能冒充等待判定。
    repo.insert(finding(projectA, "a-fallback", { codeFingerprint: "", discussionId: null, noteId: null }));
    // unknown 有指纹但已无法定位，属于不可追踪终态，不是等待判定。
    repo.insert(finding(projectA, "a-unknown", { outcome: "unknown", trackedAt: 200 }));
    repo.insert(finding(projectB, "b-resolved", { severity: "p2", outcome: "resolved-without-change", trackedAt: 200 }));
    repo.insert(finding(projectB, "b-pending", { severity: "p2" }));

    const stats = repo.getAdoptionStats({});

    assert.deepEqual(stats.total, { tracked: 3, adopted: 1, pending: 2, rate: 1 / 3 });
    assert.deepEqual(stats.untrackable, { fallback: 1, unknown: 1 });
    assert.deepEqual(rowNamed(stats.byProject, "group/a"), { name: "group/a", projectId: 101, tracked: 2, adopted: 1, pending: 1, rate: 0.5 });
    assert.deepEqual(rowNamed(stats.byProject, "group/b"), { name: "group/b", projectId: 202, tracked: 1, adopted: 0, pending: 1, rate: 0 });
    assert.deepEqual(rowNamed(stats.byCommitter, "甲"), { name: "甲", tracked: 2, adopted: 1, pending: 1, rate: 0.5 });
    assert.deepEqual(rowNamed(stats.byCommitter, "乙"), { name: "乙", tracked: 1, adopted: 0, pending: 1, rate: 0 });
    assert.deepEqual(rowNamed(stats.bySeverity, "p1"), { name: "p1", tracked: 2, adopted: 1, pending: 1, rate: 0.5 });
    assert.deepEqual(rowNamed(stats.bySeverity, "p2"), { name: "p2", tracked: 1, adopted: 0, pending: 1, rate: 0 });
  } finally {
    db.close();
  }
});

test("tracked 为零时仍报告 43 条等待判定和 8 条 fallback，rate 保持 null", () => {
  const db = openDatabase(":memory:");
  try {
    const owner = seedRecord(db, { projectId: 303, projectName: "group/pending", mrIid: 9, committerName: "等待者" });
    const repo = createReviewFindingRepository(db);

    for (let index = 1; index <= 43; index += 1) {
      repo.insert(finding(owner, `pending-${index}`, { severity: "p0" }));
    }
    for (let index = 1; index <= 8; index += 1) {
      repo.insert(
        finding(owner, `fallback-${index}`, {
          severity: "p0",
          codeFingerprint: "",
          discussionId: null,
          noteId: null,
        }),
      );
    }

    const stats = repo.getAdoptionStats({});

    assert.deepEqual(stats.total, { tracked: 0, adopted: 0, pending: 43, rate: null });
    assert.deepEqual(stats.untrackable, { fallback: 8, unknown: 0 });
    assert.deepEqual(rowNamed(stats.byProject, "group/pending"), { name: "group/pending", projectId: 303, tracked: 0, adopted: 0, pending: 43, rate: null });
    assert.deepEqual(rowNamed(stats.byCommitter, "等待者"), {
      name: "等待者",
      tracked: 0,
      adopted: 0,
      pending: 43,
      rate: null,
    });
    assert.deepEqual(rowNamed(stats.bySeverity, "p0"), { name: "p0", tracked: 0, adopted: 0, pending: 43, rate: null });
  } finally {
    db.close();
  }
});
