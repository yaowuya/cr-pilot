import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Express } from "express";
import { createApp } from "../../../src/interfaces/http/app.ts";
import { createAuthMiddleware } from "../../../src/interfaces/http/auth-middleware.ts";
import { createReviewsRouter } from "../../../src/interfaces/http/api/reviews.ts";
import { createAdminRepository } from "../../../src/infrastructure/sqlite/admin-repo.ts";
import { openDatabase } from "../../../src/infrastructure/sqlite/database.ts";
import { createReviewFindingRepository } from "../../../src/infrastructure/sqlite/review-finding-repo.ts";
import { createReviewRecordRepository } from "../../../src/infrastructure/sqlite/review-record-repo.ts";
import { deriveToken } from "../../../src/shared/crypto.ts";
import { createSilentLogger } from "../../../src/shared/logger.ts";

const AUTH_SALT = "adoption-pending-contract-salt";
const USERNAME = "contract-admin";

type FindingRepository = ReturnType<typeof createReviewFindingRepository>;
type NewFinding = Parameters<FindingRepository["insert"]>[0];

interface AdoptionRowResponse {
  name: string;
  tracked: number;
  adopted: number;
  pending: number;
  rate: number | null;
}

interface AdoptionResponse {
  total: { tracked: number; adopted: number; pending: number; rate: number | null };
  untrackable: { fallback: number; unknown: number };
  byProject: AdoptionRowResponse[];
  byCommitter: AdoptionRowResponse[];
  bySeverity: AdoptionRowResponse[];
}

/** 用真实内存仓储装配受鉴权保护的采纳统计接口。 */
function buildHarness(withFindings = true) {
  const db = openDatabase(":memory:");
  const admins = createAdminRepository(db, AUTH_SALT, USERNAME);
  admins.ensureInitialAdmin(USERNAME, "contract-password");
  const records = createReviewRecordRepository(db);
  const findings = createReviewFindingRepository(db);
  const authMiddleware = createAuthMiddleware({ admins, authSalt: AUTH_SALT });
  const app = createApp({
    logger: createSilentLogger(),
    enqueue: () => {},
    authMiddleware,
    apiRoutes: {
      "/api/reviews": createReviewsRouter({ records, findings: withFindings ? findings : undefined }),
    },
  });
  return { app, db, records, findings, token: deriveToken(USERNAME, AUTH_SALT) };
}

/** 在随机本地端口执行请求，测试结束后关闭监听。 */
async function withServer<T>(app: Express, run: (base: string) => Promise<T>): Promise<T> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** 构造同一条评审记录下的建议，覆盖 HTTP 序列化所需的最小字段。 */
function finding(recordId: number, marker: string, overrides: Partial<NewFinding> = {}): NewFinding {
  return {
    recordId,
    projectId: 41,
    mrIid: 12,
    marker,
    findingId: marker,
    severity: "p1",
    path: "src/http-contract.ts",
    line: 1,
    lineKey: "new_line",
    baseSha: "base",
    headSha: "head",
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

function rowNamed(rows: readonly AdoptionRowResponse[], name: string): AdoptionRowResponse {
  const row = rows.find((item) => item.name === name);
  assert.ok(row, `响应缺少维度行 ${name}`);
  return row;
}

test("GET /api/reviews/adoption 在总计与全部维度返回 pending", async () => {
  const harness = buildHarness();
  try {
    const recordId = harness.records.insert({
      projectId: 41,
      projectName: "group/http-contract",
      mrIid: 12,
      committerName: "契约提交人",
      changeCount: 1,
      batchCount: 1,
      score: 90,
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
    harness.findings.insert(finding(recordId, "adopted", { outcome: "adopted", trackedAt: 200 }));
    harness.findings.insert(finding(recordId, "pending"));
    harness.findings.insert(finding(recordId, "fallback", { codeFingerprint: "", discussionId: null, noteId: null }));
    harness.findings.insert(finding(recordId, "unknown", { outcome: "unknown", trackedAt: 200 }));

    await withServer(harness.app, async (base) => {
      const response = await fetch(`${base}/api/reviews/adoption`, {
        headers: { Authorization: `Bearer ${harness.token}` },
      });
      assert.equal(response.status, 200);
      const body = (await response.json()) as AdoptionResponse;

      assert.deepEqual(body.total, { tracked: 1, adopted: 1, pending: 1, rate: 1 });
      assert.deepEqual(body.untrackable, { fallback: 1, unknown: 1 });
      assert.deepEqual(rowNamed(body.byProject, "group/http-contract"), { name: "group/http-contract", projectId: 41, tracked: 1, adopted: 1, pending: 1, rate: 1 });
      assert.deepEqual(rowNamed(body.byCommitter, "契约提交人"), {
        name: "契约提交人",
        tracked: 1,
        adopted: 1,
        pending: 1,
        rate: 1,
      });
      assert.deepEqual(rowNamed(body.bySeverity, "p1"), { name: "p1", tracked: 1, adopted: 1, pending: 1, rate: 1 });
    });
  } finally {
    harness.db.close();
  }
});

test("未装配建议仓储时空响应也保留 pending 字段", async () => {
  const harness = buildHarness(false);
  try {
    await withServer(harness.app, async (base) => {
      const response = await fetch(`${base}/api/reviews/adoption`, {
        headers: { Authorization: `Bearer ${harness.token}` },
      });
      assert.equal(response.status, 200);
      const body = (await response.json()) as AdoptionResponse;
      assert.deepEqual(body.total, { tracked: 0, adopted: 0, pending: 0, rate: null });
      assert.deepEqual(body.byProject, []);
      assert.deepEqual(body.byCommitter, []);
      assert.deepEqual(body.bySeverity, []);
    });
  } finally {
    harness.db.close();
  }
});

test("生成后的 OpenAPI schema 要求 total 与维度行都包含 pending", () => {
  const spec = JSON.parse(readFileSync(new URL("../../../docs/openapi.json", import.meta.url), "utf8")) as {
    components: {
      schemas: {
        AdoptionDimensionRow: { required: string[]; properties: Record<string, { type?: string }> };
        AdoptionStats: {
          properties: {
            total: { required: string[]; properties: Record<string, { type?: string }> };
          };
        };
      };
    };
  };

  const dimension = spec.components.schemas.AdoptionDimensionRow;
  assert.ok(dimension.required.includes("pending"), "AdoptionDimensionRow.required 缺少 pending");
  assert.equal(dimension.properties.pending?.type, "integer");

  const total = spec.components.schemas.AdoptionStats.properties.total;
  assert.ok(total.required.includes("pending"), "AdoptionStats.total.required 缺少 pending");
  assert.equal(total.properties.pending?.type, "integer");
});

test("OpenAPI 生成器本身声明 pending，不能只手改生成产物", () => {
  const source = readFileSync(new URL("../../../scripts/build-openapi.ts", import.meta.url), "utf8");
  const dimensionStart = source.indexOf("AdoptionDimensionRow:");
  const statsStart = source.indexOf("AdoptionStats:", dimensionStart);
  const nextSchema = source.indexOf("WecomBot:", statsStart);
  assert.ok(dimensionStart >= 0 && statsStart > dimensionStart && nextSchema > statsStart, "无法定位采纳统计 schema");

  const dimensionSchema = source.slice(dimensionStart, statsStart);
  const statsSchema = source.slice(statsStart, nextSchema);
  const totalSchema = statsSchema.slice(statsSchema.indexOf("total:"), statsSchema.indexOf("untrackable:"));

  assert.match(dimensionSchema, /required:\s*\[[^\]]*"pending"[^\]]*\]/s);
  assert.match(dimensionSchema, /\bpending:\s*\{\s*type:\s*"integer"/s);
  assert.match(totalSchema, /required:\s*\[[^\]]*"pending"[^\]]*\]/s);
  assert.match(totalSchema, /\bpending:\s*\{\s*type:\s*"integer"/s);
});
