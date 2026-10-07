import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../../../src/infrastructure/sqlite/database.ts";
import { createReviewRecordRepository } from "../../../src/infrastructure/sqlite/review-record-repo.ts";
import type { ReviewRecord } from "../../../src/domain/review-record.ts";

/** 构造一条记录，未指定的字段用可辨识的默认值。 */
function record(overrides: Partial<ReviewRecord> = {}): ReviewRecord {
  return {
    projectId: 1,
    projectName: "a/b",
    mrIid: 7,
    committerName: "alice",
    changeCount: 3,
    batchCount: 1,
    score: 90,
    durationMs: 1000,
    result: "success",
    errorMessage: null,
    commentUrl: null,
    startedAt: 1000,
    finishedAt: 2000,
    ...overrides,
  };
}

test("insert 后 getList 可按项目筛选，getStats 忽略 null 分数", () => {
  const db = openDatabase(":memory:");
  const repo = createReviewRecordRepository(db);
  repo.insert(record());
  repo.insert(record({ projectId: 2, projectName: "c/d", committerName: "bob", score: null, result: "failed", errorMessage: "boom", startedAt: 3000, finishedAt: 3500 }));

  const list = repo.getList({ projectId: 1, page: 1, pageSize: 10 });
  assert.equal(list.total, 1);
  assert.equal(list.items[0].committerName, "alice");

  const stats = repo.getStats({});
  assert.equal(stats.total, 2);
  assert.equal(stats.projectCount, 2);
  assert.equal(stats.committerCount, 2);
  assert.equal(stats.avgScore, 90, "null 分数不得计入平均值");
  db.close();
});

test("getList 支持按提交人与时间范围筛选并按时间倒序", () => {
  const db = openDatabase(":memory:");
  const repo = createReviewRecordRepository(db);
  ["alice", "bob", "alice"].forEach((name, index) => {
    repo.insert(record({ committerName: name, mrIid: index, startedAt: 1000 + index, finishedAt: 1100 + index }));
  });

  assert.equal(repo.getList({ committer: "alice", page: 1, pageSize: 10 }).total, 2);
  assert.equal(repo.getList({ from: 1001, page: 1, pageSize: 10 }).total, 2);
  assert.equal(repo.getList({ to: 1000, page: 1, pageSize: 10 }).total, 1);

  const all = repo.getList({ page: 1, pageSize: 10 });
  assert.ok(all.items[0].startedAt >= all.items[1].startedAt, "默认按 startedAt 倒序");
  db.close();
});

test("getList 分页返回正确页与总数", () => {
  const db = openDatabase(":memory:");
  const repo = createReviewRecordRepository(db);
  for (let index = 0; index < 5; index += 1) {
    repo.insert(record({ mrIid: index, startedAt: 1000 + index, finishedAt: 1100 + index }));
  }
  const first = repo.getList({ page: 1, pageSize: 2 });
  const second = repo.getList({ page: 2, pageSize: 2 });
  assert.equal(first.total, 5);
  assert.equal(first.items.length, 2);
  assert.equal(second.items.length, 2);
  assert.notEqual(first.items[0].mrIid, second.items[0].mrIid);
  db.close();
});

test("getStats 保留 null 语义：无任何分数时 avgScore 为 null", () => {
  const db = openDatabase(":memory:");
  const repo = createReviewRecordRepository(db);
  repo.insert(record({ score: null, result: "failed", errorMessage: "x" }));
  assert.equal(repo.getStats({}).avgScore, null, "没有分数时不得返回 0");
  db.close();
});

test("getStats 按日聚合且 daily 有序", () => {
  const db = openDatabase(":memory:");
  const repo = createReviewRecordRepository(db);
  const day = 86_400_000;
  repo.insert(record({ startedAt: day, score: 80 }));
  repo.insert(record({ startedAt: day + 1, score: 100 }));
  repo.insert(record({ startedAt: day * 2, score: null }));
  const stats = repo.getStats({});
  assert.equal(stats.daily.length, 2);
  assert.equal(stats.daily[0].count, 2);
  assert.equal(stats.daily[0].avgScore, 90);
  assert.equal(stats.daily[1].count, 1);
  assert.equal(stats.daily[1].avgScore, null);
  db.close();
});

test("insert 保留失败原因与评论链接", () => {
  const db = openDatabase(":memory:");
  const repo = createReviewRecordRepository(db);
  repo.insert(record({ result: "failed", errorMessage: "拉取失败", score: null }));
  const item = repo.getList({ page: 1, pageSize: 1 }).items[0];
  assert.equal(item.result, "failed");
  assert.equal(item.errorMessage, "拉取失败");
  assert.equal(item.commentUrl, null);
  db.close();
});
