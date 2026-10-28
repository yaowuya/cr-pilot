import { test } from "node:test";
import assert from "node:assert/strict";
import * as adoptionTracking from "../../src/application/adoption-tracker.ts";
import type { MergeRequestTask } from "../../src/domain/review-task.ts";
import type { Logger } from "../../src/shared/logger.ts";
import { openSecret } from "../../src/shared/secret-box.ts";

const salt = "synthetic-handler-salt";
const task: MergeRequestTask = {
  projectId: 7, iid: 9, fullName: "group/app", sourceBranch: "feature", targetBranch: "main", gitlabUrl: "https://gitlab.example.invalid",
  gitlabToken: "synthetic-task-token", eventKind: "tracking",
};

function logger(lines: Array<{ level: string; message: string; fields?: Record<string, unknown> }>): Logger {
  return {
    debug: (message, fields) => lines.push({ level: "debug", message, fields }),
    info: (message, fields) => lines.push({ level: "info", message, fields }),
    warn: (message, fields) => lines.push({ level: "warn", message, fields }),
    error: (message, fields) => lines.push({ level: "error", message, fields }),
  };
}

function factory() {
  const value = Reflect.get(adoptionTracking, "createAdoptionTrackingEventHandler");
  if (typeof value !== "function") assert.fail("尚未导出 createAdoptionTrackingEventHandler");
  return value as (deps: {
    findings: { refreshTrackingCredentials(projectId: number, iid: number, url: string, sealed: string): number };
    secretKey: string; enabled: boolean; trigger: () => Promise<void>; logger: Logger;
  }) => (task: MergeRequestTask) => void;
}

test("tracking webhook 刷新 pending 凭据并立即触发，日志不包含明文 token", async () => {
  const calls: unknown[][] = [];
  const lines: Array<{ level: string; message: string; fields?: Record<string, unknown> }> = [];
  let triggered = 0;
  const handle = factory()({
    findings: { refreshTrackingCredentials: (...args) => { calls.push(args); return 3; } },
    secretKey: salt, enabled: true, logger: logger(lines),
    trigger: async () => { triggered += 1; },
  });
  handle(task);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 3), [7, 9, "https://gitlab.example.invalid"]);
  assert.equal(openSecret(String(calls[0][3]), salt), "synthetic-task-token");
  assert.equal(triggered, 1);
  assert.match(JSON.stringify(lines), /已刷新建议凭据数.*3/);
  assert.doesNotMatch(JSON.stringify(lines), /synthetic-task-token/);
});

test("凭据刷新失败仍触发追踪；关闭追踪时不刷新凭据也不触发", async () => {
  for (const enabled of [true, false]) {
    const lines: Array<{ level: string; message: string; fields?: Record<string, unknown> }> = [];
    let triggered = 0;
    let refreshCalls = 0;
    const handle = factory()({
      findings: { refreshTrackingCredentials: () => { refreshCalls += 1; throw new Error("private sqlite failure"); } },
      secretKey: salt, enabled, logger: logger(lines), trigger: async () => { triggered += 1; },
    });
    handle(task);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(triggered, enabled ? 1 : 0);
    assert.equal(refreshCalls, enabled ? 1 : 0);
    assert.equal(lines.some((entry) => entry.level === "warn"), enabled);
    assert.doesNotMatch(JSON.stringify(lines), /private sqlite failure|synthetic-task-token/);
  }
});
