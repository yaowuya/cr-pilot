import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../../../src/infrastructure/sqlite/database.ts";
import { createReviewRecordRepository } from "../../../src/infrastructure/sqlite/review-record-repo.ts";
import { createReviewFindingRepository } from "../../../src/infrastructure/sqlite/review-finding-repo.ts";
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
    mrUrl: null,
    startedAt: 1000,
    finishedAt: 2000,
    tokenUsage: null,
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

// ============ 按项目 / 按提交人 两维度聚合 ============

test("byProject 聚合次数与分数（min/avg/max），null 分数不计入", () => {
  const db = openDatabase(":memory:");
  const repo = createReviewRecordRepository(db);
  repo.insert(record({ projectId: 1, projectName: "group/a", score: 60 }));
  repo.insert(record({ projectId: 1, projectName: "group/a", score: 80 }));
  // 这条没有分数：应计入次数，但不能参与 avg/min/max
  repo.insert(record({ projectId: 1, projectName: "group/a", score: null }));
  repo.insert(record({ projectId: 2, projectName: "group/b", score: 90 }));

  const stats = repo.getStats({});
  const projectA = stats.byProject.find((item) => item.name === "group/a");
  assert.ok(projectA);
  assert.equal(projectA.count, 3, "无分数的记录也要计入次数");
  assert.equal(projectA.avgScore, 70, "只对有分数的记录求均值");
  assert.equal(projectA.minScore, 60, "null 不得被当成 0 分最低值");
  assert.equal(projectA.maxScore, 80);

  const projectB = stats.byProject.find((item) => item.name === "group/b");
  assert.ok(projectB);
  assert.equal(projectB.count, 1);
  assert.equal(projectB.avgScore, 90);
  db.close();
});

test("byCommitter 聚合与 byProject 相互独立", () => {
  const db = openDatabase(":memory:");
  const repo = createReviewRecordRepository(db);
  // 同一人提交多个项目
  repo.insert(record({ projectId: 1, projectName: "group/a", committerName: "张三", score: 70 }));
  repo.insert(record({ projectId: 2, projectName: "group/b", committerName: "张三", score: 90 }));
  // 同一项目多人提交
  repo.insert(record({ projectId: 1, projectName: "group/a", committerName: "李四", score: 50 }));

  const stats = repo.getStats({});
  const zhangsan = stats.byCommitter.find((item) => item.name === "张三");
  assert.ok(zhangsan);
  assert.equal(zhangsan.count, 2);
  assert.equal(zhangsan.avgScore, 80);
  assert.equal(zhangsan.minScore, 70);
  assert.equal(zhangsan.maxScore, 90);

  const projectA = stats.byProject.find((item) => item.name === "group/a");
  assert.ok(projectA);
  assert.equal(projectA.count, 2, "group/a 有两条记录（张三 + 李四）");
  assert.equal(projectA.avgScore, 60);
  db.close();
});

test("两维度都按次数降序、名称升序稳定排序", () => {
  const db = openDatabase(":memory:");
  const repo = createReviewRecordRepository(db);
  // b 项目 1 次，a 项目 2 次，c 项目 1 次 → 期望 a(2) 在前，b/c(各1) 按名称升序
  repo.insert(record({ projectId: 1, projectName: "group/b", committerName: "乙" }));
  repo.insert(record({ projectId: 2, projectName: "group/a", committerName: "甲" }));
  repo.insert(record({ projectId: 2, projectName: "group/a", committerName: "甲" }));
  repo.insert(record({ projectId: 3, projectName: "group/c", committerName: "丙" }));

  const stats = repo.getStats({});
  assert.deepEqual(
    stats.byProject.map((item) => item.name),
    ["group/a", "group/b", "group/c"],
    "次数降序，同次数按名称升序",
  );
  db.close();
});

test("空表时两维度返回空数组而不是 undefined", () => {
  const db = openDatabase(":memory:");
  const repo = createReviewRecordRepository(db);
  const stats = repo.getStats({});
  assert.deepEqual(stats.byProject, []);
  assert.deepEqual(stats.byCommitter, []);
  db.close();
});

test("时间筛选同时作用于两维度聚合", () => {
  const db = openDatabase(":memory:");
  const repo = createReviewRecordRepository(db);
  repo.insert(record({ projectName: "group/a", startedAt: 1000, score: 50 }));
  repo.insert(record({ projectName: "group/a", startedAt: 9000, score: 90 }));

  // 只统计 5000 之后的记录
  const stats = repo.getStats({ from: 5000 });
  const projectA = stats.byProject.find((item) => item.name === "group/a");
  assert.ok(projectA);
  assert.equal(projectA.count, 1, "筛选条件必须应用到分组聚合");
  assert.equal(projectA.avgScore, 90);
  db.close();
});

test("insert 返回自增 ID，且该 ID 可作为建议明细的外键", () => {
  // 关键回归：不返回 ID 时管线拿不到 recordId，建议明细永远不会落库，
  // 采纳统计会一直为空（测试全绿也发现不了）。
  const db = openDatabase(":memory:");
  const records = createReviewRecordRepository(db);
  const first = records.insert(record({ mrIid: 1 }));
  const second = records.insert(record({ mrIid: 2 }));
  assert.equal(typeof first, "number", "必须返回数字 ID");
  assert.ok(Number(first) > 0);
  assert.notEqual(first, second, "两条记录应得到不同 ID");

  const findings = createReviewFindingRepository(db);
  findings.insert({
    recordId: Number(first),
    projectId: 1,
    mrIid: 1,
    marker: "<!-- marker:h:1 -->",
    findingId: "f1",
    severity: "p1",
    path: "a.ts",
    line: 1,
    lineKey: "new_line",
    baseSha: "b",
    headSha: "h",
    codeFingerprint: "0123456789abcdef",
    discussionId: "d1",
    noteId: 1,
    outcome: "pending",
    trackedAt: null,
    createdAt: 1,
    gitlabUrl: "https://gitlab.example.com",
    gitlabTokenSealed: "",
  });
  assert.equal(findings.listByRecord(Number(first)).length, 1, "外键可用");
});

// ============ token 用量统计 ============

/** 一条可辨识的用量，便于断言各项分别累加。 */
const USAGE = { input: 1000, output: 200, cacheRead: 400, cacheWrite: 50, totalTokens: 1650 };

test("token 用量往返：写入后读取与统计均保留五列", () => {
  const db = openDatabase(":memory:");
  const repo = createReviewRecordRepository(db);
  repo.insert(record({ tokenUsage: USAGE }));

  const item = repo.getList({ page: 1, pageSize: 1 }).items[0];
  assert.deepEqual(item.tokenUsage, USAGE, "五列必须原样往返");
  db.close();
});

test("token 用量为 null 表示无数据，与全零用量必须区分", () => {
  const db = openDatabase(":memory:");
  const repo = createReviewRecordRepository(db);
  repo.insert(record({ tokenUsage: null }));
  repo.insert(record({ tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 } }));

  const items = repo.getList({ page: 1, pageSize: 10 }).items;
  const nullUsage = items.filter((item) => item.tokenUsage === null);
  assert.equal(nullUsage.length, 1, "没采到 usage 的记录必须保持 null");
  const zeroUsage = items.filter((item) => item.tokenUsage !== null);
  assert.equal(zeroUsage.length, 1, "真实的零消耗是有效数据，不能与缺失混同");
  db.close();
});

test("getStats 汇总 token：只对有用量的记录求和，缺失不当作 0 拉低平均", () => {
  const db = openDatabase(":memory:");
  const repo = createReviewRecordRepository(db);
  repo.insert(record({ tokenUsage: USAGE }));
  repo.insert(record({ tokenUsage: USAGE }));
  repo.insert(record({ tokenUsage: null }));

  const tokens = repo.getStats({}).tokens;
  assert.equal(tokens.recordedReviews, 2, "平均值分母只算有用量的记录");
  assert.equal(tokens.input, 2000);
  assert.equal(tokens.output, 400);
  assert.equal(tokens.cacheRead, 800);
  assert.equal(tokens.total, 3300);
  assert.equal(tokens.avgPerReview, 1650, "3 次评审里只有 2 次有用量，平均应按 2 算");
  // 命中率分母是全部输入侧 token：input 1000×2 + cacheRead 400×2 + cacheWrite 50×2 = 2900，
  // 命中 800 → 800/2900。若误用 input（2000）作分母会得到 0.4 并掩盖 >1 的可能。
  assert.ok(Math.abs((tokens.cacheHitRate ?? 0) - 800 / 2900) < 1e-9, "命中率 = cacheRead ÷ (input + cacheRead + cacheWrite)");
  assert.ok((tokens.cacheHitRate ?? 0) <= 1, "命中率必须落在 0..1");
  db.close();
});

test("getStats 无任何 usage 时 token 各项为 null 而不是 0", () => {
  const db = openDatabase(":memory:");
  const repo = createReviewRecordRepository(db);
  repo.insert(record({ tokenUsage: null }));

  const tokens = repo.getStats({}).tokens;
  assert.equal(tokens.recordedReviews, 0);
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "total", "avgPerReview", "cacheHitRate"] as const) {
    assert.equal(tokens[key], null, `${key} 必须是 null，避免把「没数据」显示成 0`);
  }
  db.close();
});

test("byProject / byCommitter 同时给出该组 token 总量，缺失组保持 null", () => {
  const db = openDatabase(":memory:");
  const repo = createReviewRecordRepository(db);
  repo.insert(record({ projectName: "group/a", committerName: "甲", tokenUsage: USAGE }));
  repo.insert(record({ projectName: "group/a", committerName: "甲", tokenUsage: { ...USAGE, totalTokens: 350 } }));
  repo.insert(record({ projectName: "group/b", committerName: "乙", tokenUsage: null }));

  const stats = repo.getStats({});
  const projectA = stats.byProject.find((item) => item.name === "group/a");
  assert.equal(projectA?.totalTokens, 2000, "同组多次评审累加");
  const projectB = stats.byProject.find((item) => item.name === "group/b");
  assert.equal(projectB?.totalTokens, null, "该组全无用量时为 null");

  const committerA = stats.byCommitter.find((item) => item.name === "甲");
  assert.equal(committerA?.totalTokens, 2000);
  db.close();
});

test("token 统计与分数、时间筛选口径一致", () => {
  const db = openDatabase(":memory:");
  const repo = createReviewRecordRepository(db);
  repo.insert(record({ startedAt: 1000, score: 50, tokenUsage: USAGE }));
  repo.insert(record({ startedAt: 9000, score: 90, tokenUsage: USAGE }));

  const filtered = repo.getStats({ from: 5000 }).tokens;
  assert.equal(filtered.recordedReviews, 1, "时间筛选必须同时作用于 token 聚合");
  assert.equal(filtered.total, USAGE.totalTokens);
  db.close();
});

test("token 五列不齐的记录不进统计，与单行读取守卫一致", () => {
  const db = openDatabase(":memory:");
  const repo = createReviewRecordRepository(db);
  repo.insert(record({ tokenUsage: USAGE }));
  // 模拟迁移中途/人工写入只补了部分列。
  db.prepare("UPDATE review_records SET cache_write_tokens = NULL WHERE id = 1").run();

  const tokens = repo.getStats({}).tokens;
  assert.equal(tokens.recordedReviews, 0, "半份数据不能计入平均值分母");
  assert.equal(tokens.total, null, "半份数据不得被当成完整用量");
  db.close();
});
