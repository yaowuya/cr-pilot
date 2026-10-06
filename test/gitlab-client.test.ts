import { test } from "node:test";
import assert from "node:assert/strict";
import { createGitlabClient, GitlabApiError, type Change } from "../src/gitlab-client.ts";
import { createSilentLogger } from "../src/logger.ts";

type FetchFn = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

function jsonResponse(status: number, body: unknown): Response {
  return { status, ok: status >= 200 && status < 300, json: async () => body } as Response;
}

function trackFetch(respond: (url: string) => Response | Promise<Response>): { calls: { url: string; init: RequestInit }[]; fetchFn: FetchFn } {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    return respond(String(url));
  };
  return { calls, fetchFn };
}

function makeClient(fetchFn: FetchFn, overrides: Partial<Parameters<typeof createGitlabClient>[0]> = {}) {
  return createGitlabClient({
    url: "https://gitlab.example.com",
    token: "TOKEN",
    timeoutMs: 1000,
    insecureTls: false,
    logger: createSilentLogger(),
    fetchFn,
    ...overrides,
  });
}

test("getMergeRequestChanges 拼接 URL 与认证头", async () => {
  const { calls, fetchFn } = trackFetch(() => jsonResponse(200, { changes: [] }));
  const client = makeClient(fetchFn);
  await client.getMergeRequestChanges(42, 7);
  assert.equal(calls[0].url, "https://gitlab.example.com/api/v4/projects/42/merge_requests/7/changes?access_raw_diffs=true");
  assert.equal((calls[0].init.headers as Record<string, string>)["PRIVATE-TOKEN"], "TOKEN");
});

test("changes 为空时重试，最多 3 次", async () => {
  let attempts = 0;
  const fetchFn: FetchFn = async () => {
    attempts += 1;
    return jsonResponse(200, { changes: attempts >= 3 ? [{ diff: "d", new_path: "a.ts", old_path: "a.ts" }] : [] });
  };
  const client = makeClient(fetchFn, { retryDelayMs: 0 });
  const changes = await client.getMergeRequestChanges(1, 1);
  assert.equal(attempts, 3);
  assert.equal(changes.length, 1);
});

test("changes 三次重试后仍为空时返回空数组（不抛错）", async () => {
  const fetchFn: FetchFn = async () => jsonResponse(200, { changes: [] });
  const client = makeClient(fetchFn, { retryDelayMs: 0 });
  assert.deepEqual(await client.getMergeRequestChanges(1, 1), []);
});

test("非 2xx 抛 GitlabApiError 并带状态码，不重试", async () => {
  let attempts = 0;
  const fetchFn: FetchFn = async () => {
    attempts += 1;
    return jsonResponse(401, { message: "unauthorized" });
  };
  const client = makeClient(fetchFn, { retryDelayMs: 0 });
  await assert.rejects(
    () => client.getMergeRequestChanges(1, 1),
    (error: unknown) => {
      assert.ok(error instanceof GitlabApiError);
      assert.equal((error as GitlabApiError).status, 401);
      return true;
    },
  );
  assert.equal(attempts, 1);
});

test("getMergeRequestCommits 返回提交列表", async () => {
  const { calls, fetchFn } = trackFetch(() => jsonResponse(200, [{ id: "c1", message: "feat: x" }]));
  const client = makeClient(fetchFn);
  const commits = await client.getMergeRequestCommits(42, 7);
  assert.equal(calls[0].url, "https://gitlab.example.com/api/v4/projects/42/merge_requests/7/commits");
  assert.equal(commits[0].id, "c1");
});

test("postMergeRequestNote 发送 body 字段", async () => {
  const { calls, fetchFn } = trackFetch(() => jsonResponse(201, {}));
  const client = makeClient(fetchFn);
  await client.postMergeRequestNote(42, 7, "评论正文");
  assert.equal(calls[0].url, "https://gitlab.example.com/api/v4/projects/42/merge_requests/7/notes");
  assert.equal(JSON.parse(String(calls[0].init.body)).body, "评论正文");
});

test("URL 尾部斜杠被规范化", async () => {
  const { calls, fetchFn } = trackFetch(() => jsonResponse(200, { changes: [] }));
  const client = makeClient(fetchFn, { url: "https://gitlab.example.com/" });
  await client.getMergeRequestChanges(1, 1);
  assert.equal(calls[0].url, "https://gitlab.example.com/api/v4/projects/1/merge_requests/1/changes?access_raw_diffs=true");
});

test("insecureTls 为真且未配置全局信任时给出告警", async () => {
  const warnings: string[] = [];
  const logger = {
    debug: () => {},
    info: () => {},
    warn: (message: string) => {
      warnings.push(message);
    },
    error: () => {},
  };
  // 返回非空结果避免触发 changes 重试日志，让告警成为唯一 warn
  const { fetchFn } = trackFetch(() => jsonResponse(200, { changes: [{ diff: "d", new_path: "a.ts", old_path: "a.ts" }] }));
  const client = makeClient(fetchFn, { insecureTls: true, logger, retryDelayMs: 0 });
  await client.getMergeRequestChanges(1, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /NODE_TLS_REJECT_UNAUTHORIZED/);
});
