import { test } from "node:test";
import assert from "node:assert/strict";
import { createGitlabClient, GitlabApiError } from "../../../src/infrastructure/gitlab/gitlab-client.ts";
import { createSilentLogger } from "../../../src/shared/logger.ts";

type FetchCall = { url: string; init: RequestInit };

function response(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

function clientWith(respond: (call: FetchCall) => Response) {
  const calls: FetchCall[] = [];
  const client = createGitlabClient({
    url: "https://gitlab.example.com",
    timeoutMs: 1000,
    insecureTls: false,
    logger: createSilentLogger(),
    fetchFn: async (input, init) => {
      const call = { url: String(input), init: init ?? {} };
      calls.push(call);
      return respond(call);
    },
  });
  return { client, calls };
}

test("项目默认分支读取使用任务级实例与 token，不缓存或猜测缺失字段", async () => {
  const { client, calls } = clientWith(() => response(200, { default_branch: "main" }));
  assert.ok(client.getProjectDefaultBranch);
  assert.equal(await client.getProjectDefaultBranch(42, "https://gitlab.task.example", "TASK-TOKEN"), "main");
  assert.equal(calls[0].url, "https://gitlab.task.example/api/v4/projects/42");
  assert.equal((calls[0].init.headers as Record<string, string>)["PRIVATE-TOKEN"], "TASK-TOKEN");

  const missing = clientWith(() => response(200, {}));
  assert.ok(missing.client.getProjectDefaultBranch);
  await assert.rejects(missing.client.getProjectDefaultBranch(42), /默认分支/);
  assert.equal(missing.calls.length, 1);
});

test("合并请求使用 PUT、expected sha 与明确的 squash/删源分支字段", async () => {
  const { client, calls } = clientWith(() => response(200, { state: "merged", sha: "a".repeat(40), merge_commit_sha: "b".repeat(40) }));
  assert.ok(client.mergeMergeRequest);
  await client.mergeMergeRequest(42, 7, {
    sha: "a".repeat(40),
    method: "squash",
    removeSourceBranch: true,
  }, "https://gitlab.example.com", "TASK-TOKEN");

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://gitlab.example.com/api/v4/projects/42/merge_requests/7/merge");
  assert.equal(calls[0].init.method, "PUT");
  assert.equal((calls[0].init.headers as Record<string, string>)["PRIVATE-TOKEN"], "TASK-TOKEN");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
    sha: "a".repeat(40),
    squash: true,
    should_remove_source_branch: true,
  });
});

test("普通 merge 明确发送 squash=false，写请求失败不盲重试", async () => {
  const { client, calls } = clientWith(() => response(409, { message: "SHA does not match HEAD" }));
  assert.ok(client.mergeMergeRequest);
  await assert.rejects(
    client.mergeMergeRequest(1, 2, { sha: "c".repeat(40), method: "merge", removeSourceBranch: false }),
    (error: unknown) => error instanceof GitlabApiError && error.status === 409,
  );
  assert.equal(calls.length, 2, "只允许一次 PUT 和一次只读状态对账，不能重放写请求");
  assert.equal(calls.filter((call) => call.init.method === "PUT").length, 1);
  assert.equal(JSON.parse(String(calls[0].init.body)).squash, false);
});

test("响应 merged 但 head 不同仍视为失败，不把他人合并当本次成功", async () => {
  const { client, calls } = clientWith(() => response(200, { state: "merged", sha: "0".repeat(40) }));
  assert.ok(client.mergeMergeRequest);
  await assert.rejects(client.mergeMergeRequest(1, 2, { sha: "e".repeat(40), method: "merge", removeSourceBranch: false }));
  assert.equal(calls.length, 2, "响应不可信时只做一次只读对账");
  assert.equal(calls.filter((call) => call.init.method === "PUT").length, 1);
});

test("PUT 响应未知但对账确认同一 sha 已 merged 时视为幂等成功", async () => {
  let index = 0;
  const sha = "e".repeat(40);
  const { client, calls } = clientWith(() => {
    index += 1;
    return index === 1 ? response(500, { message: "unknown" }) : response(200, { state: "merged", sha });
  });
  assert.ok(client.mergeMergeRequest);
  await client.mergeMergeRequest(8, 9, { sha, method: "merge", removeSourceBranch: false });
  assert.equal(calls.length, 2);
  assert.equal(calls.filter((call) => call.init.method === "PUT").length, 1);
});

test("401/403 明确拒绝时直接失败，不额外请求或重放", async () => {
  const { client, calls } = clientWith(() => response(403, { message: "forbidden" }));
  assert.ok(client.mergeMergeRequest);
  await assert.rejects(client.mergeMergeRequest(1, 2, { sha: "f".repeat(40), method: "merge", removeSourceBranch: false }));
  assert.equal(calls.length, 1);
});

test("合并前状态读取返回当前 target branch 与完整 diff refs，tracking 字段保持兼容", async () => {
  const head = "d".repeat(40);
  const refs = { base_sha: "b".repeat(40), start_sha: "c".repeat(40), head_sha: head };
  const { client } = clientWith(() => response(200, {
    state: "opened",
    sha: head,
    target_branch: "release/1.0",
    diff_refs: refs,
  }));
  assert.ok(client.getMergeRequestTrackingState);
  assert.ok(client.getMergeRequestAutoMergeState);
  const expectedTracking = { headSha: head, state: "opened", targetBranch: "release/1.0" };
  assert.deepEqual(await client.getMergeRequestTrackingState(3, 4), expectedTracking);
  assert.deepEqual(await client.getMergeRequestAutoMergeState(3, 4), {
    ...expectedTracking,
    refs: { baseSha: refs.base_sha, startSha: refs.start_sha, headSha: head },
  });
});

test("自动合并状态缺少完整 diff refs 时不猜测版本", async () => {
  const { client } = clientWith(() => response(200, {
    state: "opened",
    sha: "d".repeat(40),
    target_branch: "main",
    diff_refs: { head_sha: "d".repeat(40) },
  }));
  assert.ok(client.getMergeRequestAutoMergeState);
  assert.equal((await client.getMergeRequestAutoMergeState(3, 4)).refs, undefined);
});

test("自动合并严格状态把 locked/未知/缺失映射为 other，而 tracking 仍兼容 opened", async () => {
  for (const rawState of ["locked", "reopened", undefined]) {
    const { client } = clientWith(() => response(200, {
      state: rawState,
      sha: "9".repeat(40),
      target_branch: "main",
    }));
    assert.ok(client.getMergeRequestTrackingState);
    assert.ok(client.getMergeRequestAutoMergeState);
    assert.equal((await client.getMergeRequestTrackingState(1, 2)).state, "opened");
    assert.equal((await client.getMergeRequestAutoMergeState(1, 2)).state, "other");
  }
});
