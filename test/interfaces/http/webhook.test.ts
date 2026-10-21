import { test } from "node:test";
import assert from "node:assert/strict";
import type { Express } from "express";
import { createApp } from "../../../src/interfaces/http/app.ts";
import { createSilentLogger } from "../../../src/shared/logger.ts";
import type { MergeRequestTask } from "../../../src/domain/review-task.ts";

/** 构造一个只含 webhook 路由的最小应用，记录两次分派各自的入参。 */
function buildApp(): { app: Express; review: MergeRequestTask[]; tracking: MergeRequestTask[] } {
  const review: MergeRequestTask[] = [];
  const tracking: MergeRequestTask[] = [];
  const app = createApp({
    logger: createSilentLogger(),
    enqueue: (task) => review.push(task),
    enqueueTracking: (task) => tracking.push(task),
  });
  return { app, review, tracking };
}

/** 起一次临时监听并执行断言。 */
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

/** 发送 merge_request webhook。 */
function send(base: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${base}/review/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Gitlab-Token": "t" },
    body: JSON.stringify(body),
  });
}

/** 最小 merge_request payload。 */
function payload(attributes: Record<string, unknown>): Record<string, unknown> {
  return {
    object_kind: "merge_request",
    project: { id: 1, path_with_namespace: "g/p" },
    object_attributes: { iid: 7, source_branch: "s", target_branch: "t", ...attributes },
  };
}

test("update 事件带 oldrev 时进入追踪而非评审队列", async () => {
  const { app, review, tracking } = buildApp();
  await withServer(app, async (base) => {
    const res = await send(base, payload({ action: "update", oldrev: "abc" }));
    assert.equal(res.status, 200);
    assert.match((await res.json() as { message: string }).message, /采纳追踪/);
    assert.equal(tracking.length, 1);
    assert.equal(review.length, 0, "有新提交不应重复跑完整评审");
    assert.equal(tracking[0].eventKind, "tracking");
  });
});

test("open 事件进入评审队列", async () => {
  const { app, review, tracking } = buildApp();
  await withServer(app, async (base) => {
    const res = await send(base, payload({ action: "open" }));
    assert.equal(res.status, 200);
    assert.equal(review.length, 1);
    assert.equal(tracking.length, 0);
  });
});

test("update 改动标题（无 oldrev）仍进入评审队列", async () => {
  const { app, review, tracking } = buildApp();
  await withServer(app, async (base) => {
    await send(base, payload({ action: "update" }));
    assert.equal(review.length, 1, "没有新提交不能跳过评审");
    assert.equal(tracking.length, 0);
  });
});

test("未装配追踪入口时 update 事件退化为原评审队列", async () => {
  const review: MergeRequestTask[] = [];
  const app = createApp({ logger: createSilentLogger(), enqueue: (task) => review.push(task) });
  await withServer(app, async (base) => {
    await send(base, payload({ action: "update", oldrev: "abc" }));
    assert.equal(review.length, 1, "不能静默丢弃事件");
  });
});
