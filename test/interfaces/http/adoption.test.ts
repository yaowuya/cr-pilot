import { test } from "node:test";
import assert from "node:assert/strict";
import type { Express } from "express";
import { createApp } from "../../../src/interfaces/http/app.ts";
import { createAuthMiddleware } from "../../../src/interfaces/http/auth-middleware.ts";
import { createAuthRouter } from "../../../src/interfaces/http/api/auth.ts";
import { createReviewsRouter } from "../../../src/interfaces/http/api/reviews.ts";
import { openDatabase } from "../../../src/infrastructure/sqlite/database.ts";
import { createAdminRepository } from "../../../src/infrastructure/sqlite/admin-repo.ts";
import { createReviewRecordRepository } from "../../../src/infrastructure/sqlite/review-record-repo.ts";
import { createReviewFindingRepository } from "../../../src/infrastructure/sqlite/review-finding-repo.ts";
import { createSilentLogger } from "../../../src/shared/logger.ts";
import { deriveToken } from "../../../src/shared/crypto.ts";

const AUTH_SALT = "test-auth-salt";
const ADMIN = "admin";
const ADMIN_PASSWORD = "admin-password";

/** 真实 SQLite 内存库 + 真实 Express 应用。 */
function buildHarness(options: { withFindings?: boolean } = {}) {
  const db = openDatabase(":memory:");
  const admins = createAdminRepository(db, AUTH_SALT, ADMIN);
  admins.ensureInitialAdmin(ADMIN, ADMIN_PASSWORD);
  const records = createReviewRecordRepository(db);
  const findings = createReviewFindingRepository(db);
  const authMiddleware = createAuthMiddleware({ admins, authSalt: AUTH_SALT });
  const app = createApp({
    logger: createSilentLogger(),
    enqueue: () => {},
    publicApiRoutes: { "/api/auth": createAuthRouter({ admins, authSalt: AUTH_SALT, authMiddleware }) },
    authMiddleware,
    apiRoutes: {
      "/api/reviews": createReviewsRouter({
        records,
        findings: options.withFindings === false ? undefined : findings,
      }),
    },
  });
  return { app, token: deriveToken(ADMIN, AUTH_SALT), db, records, findings };
}

async function withServer<T>(app: Express, run: (base: string) => Promise<T>): Promise<T> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function authed(token: string, base: string, path: string): Promise<Response> {
  return fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` } });
}

test("采纳接口未携带令牌时返回 401", async () => {
  const { app } = buildHarness();
  await withServer(app, async (base) => {
    assert.equal((await fetch(`${base}/api/reviews/adoption`)).status, 401);
  });
});

test("无数据时采纳率为 null 而不是 0", async () => {
  const { app, token } = buildHarness();
  await withServer(app, async (base) => {
    const res = await authed(token, base, "/api/reviews/adoption");
    assert.equal(res.status, 200);
    const body = (await res.json()) as { total: { tracked: number; rate: number | null }; untrackable: { fallback: number; unknown: number } };
    assert.equal(body.total.tracked, 0);
    assert.equal(body.total.rate, null);
    assert.deepEqual(body.untrackable, { fallback: 0, unknown: 0 });
  });
});

test("非法查询参数返回 400", async () => {
  const { app, token } = buildHarness();
  await withServer(app, async (base) => {
    assert.equal((await authed(token, base, "/api/reviews/adoption?from=abc")).status, 400);
    assert.equal((await authed(token, base, "/api/reviews/adoption?projectId=-1")).status, 400);
    assert.equal((await authed(token, base, "/api/reviews/adoption?to=0")).status, 400);
  });
});

test("有数据时返回采纳率与不可统计计数", async () => {
  const { app, token, db } = buildHarness();
  db.prepare(
    `INSERT INTO review_records (project_id, project_name, mr_iid, committer_name, change_count, batch_count, score, duration_ms, result, error_message, comment_url, mr_url, started_at, finished_at)
     VALUES (1, 'g/p', 7, '王秦', 1, 1, 60, 100, 'success', NULL, NULL, NULL, 1, 2)`,
  ).run();
  const findings = createReviewFindingRepository(db);
  const row = {
    recordId: 1,
    projectId: 1,
    mrIid: 7,
    findingId: "f1",
    severity: "p1",
    path: "a.ts",
    line: 1,
    lineKey: "new_line" as const,
    baseSha: "b",
    headSha: "h",
    discussionId: null,
    noteId: null,
    trackedAt: 1,
    createdAt: 1,
    gitlabUrl: "https://gitlab.example.com",
    gitlabTokenSealed: "",
  };
  findings.insert({ ...row, marker: "m1", codeFingerprint: "f1", outcome: "adopted" });
  findings.insert({ ...row, marker: "m2", codeFingerprint: "f2", outcome: "ignored" });
  findings.insert({ ...row, marker: "m3", codeFingerprint: "", outcome: "pending", trackedAt: null });

  await withServer(app, async (base) => {
    const body = (await (await authed(token, base, "/api/reviews/adoption")).json()) as {
      total: { tracked: number; adopted: number; rate: number | null };
      untrackable: { fallback: number };
      byProject: unknown[];
      byCommitter: { name: string; tracked: number; adopted: number; rate: number | null }[];
      bySeverity: unknown[];
    };
    assert.equal(body.total.tracked, 2);
    assert.equal(body.total.adopted, 1);
    assert.equal(body.total.rate, 0.5);
    assert.equal(body.untrackable.fallback, 1);
    assert.equal(body.byProject.length, 1);
    assert.equal(body.byCommitter[0].name, "王秦");
    assert.equal(body.byCommitter[0].tracked, 2);
    assert.equal(body.bySeverity.length, 1);
  });
});

test("未装配建议仓储时返回空统计而不是报错", async () => {
  const { app, token } = buildHarness({ withFindings: false });
  await withServer(app, async (base) => {
    const res = await authed(token, base, "/api/reviews/adoption");
    assert.equal(res.status, 200);
    const body = (await res.json()) as { total: { rate: null } };
    assert.equal(body.total.rate, null);
  });
});
