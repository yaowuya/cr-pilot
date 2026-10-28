import { test } from "node:test";
import assert from "node:assert/strict";
import { createGitlabClient } from "../../../src/infrastructure/gitlab/gitlab-client.ts";
import { createSilentLogger } from "../../../src/shared/logger.ts";

/** 离线 GitLab 替身：只记录请求，不访问网络。 */
function clientWith(payload: unknown) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const client = createGitlabClient({
    url: "https://gitlab.default.invalid", timeoutMs: 1_000, insecureTls: false,
    logger: createSilentLogger(),
    fetchFn: (async (input, init) => {
      calls.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> });
      return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch,
  });
  return { client, calls };
}

test("读取 MR 追踪状态使用任务级实例与凭据，并返回当前 head 和 merged", async () => {
  const { client, calls } = clientWith({ state: "merged", sha: "a".repeat(40) });
  const state = await client.getMergeRequestTrackingState!(7, 9, "https://gitlab.task.invalid", "synthetic-token");
  assert.deepEqual(state, { headSha: "a".repeat(40), state: "merged" });
  assert.equal(calls[0].url, "https://gitlab.task.invalid/api/v4/projects/7/merge_requests/9");
  assert.equal(calls[0].headers["PRIVATE-TOKEN"], "synthetic-token");
});

test("追踪状态支持 closed，未知/缺失状态保守视为 opened", async () => {
  for (const [raw, expected] of [["closed", "closed"], ["locked", "opened"], [undefined, "opened"]] as const) {
    const { client } = clientWith({ state: raw, diff_refs: { head_sha: "b".repeat(40) } });
    assert.deepEqual(await client.getMergeRequestTrackingState!(1, 2), { headSha: "b".repeat(40), state: expected });
  }
});

test("MR 详情缺少 sha 时返回空串而不猜测版本", async () => {
  const { client } = clientWith({ state: "opened" });
  assert.deepEqual(await client.getMergeRequestTrackingState!(1, 2), { headSha: "", state: "opened" });
});
