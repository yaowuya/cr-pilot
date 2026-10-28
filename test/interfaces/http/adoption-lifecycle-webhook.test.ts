import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMergeRequestTask } from "../../../src/interfaces/http/webhook-parser.ts";
import { createApp } from "../../../src/interfaces/http/app.ts";
import type { MergeRequestTask } from "../../../src/domain/review-task.ts";
import { createSilentLogger } from "../../../src/shared/logger.ts";

/** 仅构造 parser/HTTP 路由所需字段，不访问外部系统。 */
function mergeRequestPayload(action: string, oldrev?: string): Record<string, unknown> {
  return {
    object_kind: "merge_request",
    project: { id: 101, path_with_namespace: "group/synthetic-project" },
    object_attributes: {
      iid: 7,
      action,
      ...(oldrev === undefined ? {} : { oldrev }),
      source_branch: "feature/synthetic",
      target_branch: "main",
    },
    repository: { homepage: "https://gitlab.example.test/group/synthetic-project" },
  };
}

const trackingCases = [
  { action: "update", oldrev: "previous-head", reason: "有新提交的 update" },
  { action: "merge", oldrev: undefined, reason: "MR merge" },
  { action: "close", oldrev: undefined, reason: "MR close" },
] as const;

for (const scenario of trackingCases) {
  test(`${scenario.reason} webhook 映射为 tracking`, () => {
    const task = parseMergeRequestTask(mergeRequestPayload(scenario.action, scenario.oldrev));
    assert.ok(task);
    assert.equal(task.eventKind, "tracking");
  });
}

const reviewCases = [
  { action: "update", reason: "没有 oldrev 的普通 update" },
  { action: "open", reason: "MR open" },
] as const;

for (const scenario of reviewCases) {
  test(`${scenario.reason} webhook 仍映射为 review`, () => {
    const task = parseMergeRequestTask(mergeRequestPayload(scenario.action));
    assert.ok(task);
    assert.equal(task.eventKind, "review");
  });
}

for (const action of ["merge", "close"] as const) {
  test(`${action} HTTP 事件进入追踪入口，不跑完整评审或项目白名单`, async () => {
    const tracked: MergeRequestTask[] = [];
    let reviewed = 0;
    let allowlistChecks = 0;
    const app = createApp({
      logger: createSilentLogger(),
      enqueue: () => { reviewed += 1; },
      enqueueTracking: (task) => { tracked.push(task); },
      isProjectAllowed: () => { allowlistChecks += 1; return false; },
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    try {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const response = await fetch(`http://127.0.0.1:${address.port}/review/webhook`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-gitlab-token": "synthetic-token", connection: "close" },
        body: JSON.stringify(mergeRequestPayload(action)),
      });
      assert.equal(response.status, 200);
      assert.equal(reviewed, 0);
      assert.equal(allowlistChecks, 0);
      assert.equal(tracked.length, 1);
      assert.equal(tracked[0].eventKind, "tracking");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
    }
  });
}
