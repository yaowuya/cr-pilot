import { test } from "node:test";
import assert from "node:assert/strict";
import type { Express } from "express";
import { createApp } from "../../../src/interfaces/http/app.ts";
import { createAuthMiddleware } from "../../../src/interfaces/http/auth-middleware.ts";
import { createReviewsRouter } from "../../../src/interfaces/http/api/reviews.ts";
import { openDatabase } from "../../../src/infrastructure/sqlite/database.ts";
import { createAdminRepository } from "../../../src/infrastructure/sqlite/admin-repo.ts";
import { createReviewRecordRepository } from "../../../src/infrastructure/sqlite/review-record-repo.ts";
import { createReviewFindingRepository } from "../../../src/infrastructure/sqlite/review-finding-repo.ts";
import { createSilentLogger } from "../../../src/shared/logger.ts";
import { deriveToken } from "../../../src/shared/crypto.ts";

const AUTH_SALT = "token-usage-api-salt";
const ADMIN = "admin";

function buildHarness() {
  const db = openDatabase(":memory:");
  const admins = createAdminRepository(db, AUTH_SALT, ADMIN);
  admins.ensureInitialAdmin(ADMIN, "password");
  const records = createReviewRecordRepository(db);
  const findings = createReviewFindingRepository(db);
  const app = createApp({
    logger: createSilentLogger(),
    enqueue: () => {},
    authMiddleware: createAuthMiddleware({ admins, authSalt: AUTH_SALT }),
    apiRoutes: {
      "/api/reviews": createReviewsRouter({ records, findings }),
    },
  });
  return { app, token: deriveToken(ADMIN, AUTH_SALT), records, findings, db };
}

async function withServer<T>(app: Express, run: (base: string) => Promise<T>): Promise<T> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("服务未监听");
  try {
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function authed(token: string, base: string, path: string): Promise<Response> {
  return fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` } });
}

test("统计接口返回 token 汇总与按维度用量", async () => {
  const { app, token, records } = buildHarness();
  records.insert({
    projectId: 1, projectName: "group/a", mrIid: 1, committerName: "甲", changeCount: 1, batchCount: 1,
    score: 80, durationMs: 10, result: "success", errorMessage: null, commentUrl: null, mrUrl: null,
    startedAt: 1, finishedAt: 2,
    tokenUsage: { input: 1000, output: 200, cacheRead: 400, cacheWrite: 0, totalTokens: 1600 },
  });
  records.insert({
    projectId: 1, projectName: "group/a", mrIid: 2, committerName: "甲", changeCount: 1, batchCount: 1,
    score: 70, durationMs: 10, result: "success", errorMessage: null, commentUrl: null, mrUrl: null,
    startedAt: 3, finishedAt: 4,
    tokenUsage: null,
  });
  await withServer(app, async (base) => {
    const res = await authed(token, base, "/api/reviews/stats");
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      tokens: { recordedReviews: number; total: number | null; avgPerReview: number | null; cacheHitRate: number | null };
      byProject: Array<{ totalTokens: number | null }>;
    };
    assert.equal(body.tokens.recordedReviews, 1, "只有 1 次评审有 usage");
    assert.equal(body.tokens.total, 1600);
    assert.equal(body.tokens.avgPerReview, 1600, "平均值分母只算有 usage 的记录");
    assert.equal(body.tokens.cacheHitRate, 0.4);
    assert.equal(body.byProject[0].totalTokens, 1600, "同组缺失记录不得拉低总量");
  });
});

test("采纳接口返回高分排除条数，且从分母中真正移除", async () => {
  const { app, token, records, findings } = buildHarness();
  const low = records.insert({
    projectId: 1, projectName: "group/a", mrIid: 1, committerName: "甲", changeCount: 1, batchCount: 1,
    score: 60, durationMs: 10, result: "success", errorMessage: null, commentUrl: null, mrUrl: null,
    startedAt: 1, finishedAt: 2, tokenUsage: null,
  });
  const high = records.insert({
    projectId: 1, projectName: "group/a", mrIid: 2, committerName: "甲", changeCount: 1, batchCount: 1,
    score: 96, durationMs: 10, result: "success", errorMessage: null, commentUrl: null, mrUrl: null,
    startedAt: 3, finishedAt: 4, tokenUsage: null,
  });
  if (typeof low !== "number" || typeof high !== "number") assert.fail("真实仓储必须返回记录 ID");
  const base = {
    projectId: 1, mrIid: 1, findingId: "f", severity: "p1", path: "a.ts", line: 1, lineKey: "new_line" as const,
    baseSha: "b", headSha: "h", codeFingerprint: "fp", discussionId: "d", noteId: 1, outcome: "adopted" as const,
    trackedAt: 1, createdAt: 1, gitlabUrl: "https://gitlab.example.com", gitlabTokenSealed: "",
  };
  findings.insert({ ...base, recordId: low, marker: "m-low" });
  findings.insert({ ...base, recordId: high, marker: "m-high" });

  await withServer(app, async (endpoint) => {
    const res = await authed(token, endpoint, "/api/reviews/adoption");
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      total: { tracked: number; adopted: number; rate: number | null };
      excluded: { highScore: number };
    };
    assert.equal(body.total.tracked, 1);
    assert.equal(body.total.adopted, 1);
    assert.equal(body.total.rate, 1, "排除高分后采纳率只反映低分评审");
    assert.equal(body.excluded.highScore, 1);
  });
});

test("未装配建议仓储时采纳响应仍包含 excluded 字段", async () => {
  const db = openDatabase(":memory:");
  const admins = createAdminRepository(db, AUTH_SALT, ADMIN);
  admins.ensureInitialAdmin(ADMIN, "password");
  const app = createApp({
    logger: createSilentLogger(),
    enqueue: () => {},
    authMiddleware: createAuthMiddleware({ admins, authSalt: AUTH_SALT }),
    apiRoutes: { "/api/reviews": createReviewsRouter({ records: createReviewRecordRepository(db) }) },
  });
  const token = deriveToken(ADMIN, AUTH_SALT);
  await withServer(app, async (base) => {
    const body = (await (await authed(token, base, "/api/reviews/adoption")).json()) as { excluded?: unknown };
    assert.deepEqual(body.excluded, { highScore: 0 }, "空结构必须与真实响应同形，前端无需分支判断");
  });
  db.close();
});
