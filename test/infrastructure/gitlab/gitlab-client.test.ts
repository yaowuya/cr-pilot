import { test } from "node:test";
import assert from "node:assert/strict";
import { createGitlabClient, GitlabApiError, type Change } from "../../../src/infrastructure/gitlab/gitlab-client.ts";
import { createSilentLogger } from "../../../src/shared/logger.ts";

type FetchFn = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  } as Response;
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
    timeoutMs: 1000,
    insecureTls: false,
    logger: createSilentLogger(),
    fetchFn,
    ...overrides,
  });
}

test("getMergeRequestChanges 拼接 URL 与任务级认证头", async () => {
  const { calls, fetchFn } = trackFetch(() => jsonResponse(200, { changes: [] }));
  const client = makeClient(fetchFn);
  await client.getMergeRequestChanges(42, 7, "https://gitlab.example.com", "TASK-TOKEN");
  assert.equal(calls[0].url, "https://gitlab.example.com/api/v4/projects/42/merge_requests/7/changes?access_raw_diffs=true");
  assert.equal((calls[0].init.headers as Record<string, string>)["PRIVATE-TOKEN"], "TASK-TOKEN");
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

test("postMergeRequestNote 发送 body 字段与任务级 token", async () => {
  const { calls, fetchFn } = trackFetch(() => jsonResponse(201, {}));
  const client = makeClient(fetchFn);
  await client.postMergeRequestNote(42, 7, "评论正文", "https://gitlab.example.com", "NOTE-TOKEN");
  assert.equal(calls[0].url, "https://gitlab.example.com/api/v4/projects/42/merge_requests/7/notes");
  assert.equal(JSON.parse(String(calls[0].init.body)).body, "评论正文");
  assert.equal((calls[0].init.headers as Record<string, string>)["PRIVATE-TOKEN"], "NOTE-TOKEN");
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

// ============ backend-015：versions 与 discussions ============

test("getMergeRequestVersions 取最新 diff version 的三个 SHA", async () => {
  const { calls, fetchFn } = trackFetch(() =>
    jsonResponse(200, [
      { base_commit_sha: "b", start_commit_sha: "s", head_commit_sha: "h" },
      { base_commit_sha: "old-b", start_commit_sha: "old-s", head_commit_sha: "old-h" },
    ]),
  );
  const client = makeClient(fetchFn);
  const refs = await client.getMergeRequestVersions(42, 7, "https://gitlab.example.com", "TASK-TOKEN");
  assert.deepEqual(refs, { baseSha: "b", startSha: "s", headSha: "h" });
  assert.ok(calls[0].url.endsWith("/api/v4/projects/42/merge_requests/7/versions"));
  assert.equal((calls[0].init.headers as Record<string, string>)["PRIVATE-TOKEN"], "TASK-TOKEN");
});

test("versions 为空或字段缺失时抛出可读错误", async () => {
  const { fetchFn } = trackFetch(() => jsonResponse(200, []));
  const client = makeClient(fetchFn);
  await assert.rejects(() => client.getMergeRequestVersions(1, 1), /没有 diff 版本/);
  const { fetchFn: partial } = trackFetch(() => jsonResponse(200, [{ base_commit_sha: "b" }]));
  await assert.rejects(() => makeClient(partial).getMergeRequestVersions(1, 1), /没有 diff 版本/);
});

test("postDiscussion 发送 body 与 position 并解析返回", async () => {
  const { calls, fetchFn } = trackFetch(() => jsonResponse(201, { id: "d1", notes: [{ id: 9, body: "b", position: { new_line: 3 } }] }));
  const client = makeClient(fetchFn);
  const created = await client.postDiscussion(
    42,
    7,
    "body",
    { position_type: "text", base_sha: "b", start_sha: "s", head_sha: "h", old_path: "a.ts", new_path: "a.ts", new_line: 3 },
    "https://gitlab.example.com",
    "T",
  );
  const sent = JSON.parse(String(calls[0].init.body));
  assert.equal(sent.position.new_line, 3);
  assert.equal(sent.body, "body");
  assert.ok(calls[0].url.endsWith("/api/v4/projects/42/merge_requests/7/discussions"));
  assert.equal(created.id, "d1");
  assert.equal(created.notes[0].id, 9);
});

test("getDiscussions 按 x-next-page 翻页合并", async () => {
  let page = 0;
  const fetchFn: FetchFn = async () => {
    page += 1;
    const response = jsonResponse(200, [{ id: `d${page}`, notes: [] }]);
    Object.defineProperty(response, "headers", {
      value: { get: (name: string) => (name.toLowerCase() === "x-next-page" && page === 1 ? "2" : "") },
    });
    return response;
  };
  const client = makeClient(fetchFn);
  const all = await client.getDiscussions(1, 1);
  assert.equal(all.length, 2);
  assert.deepEqual(all.map((d) => d.id), ["d1", "d2"]);
});

test("getDiscussions 单页时只请求一次", async () => {
  const { calls, fetchFn } = trackFetch(() => {
    const response = jsonResponse(200, [{ id: "d1", notes: [] }]);
    Object.defineProperty(response, "headers", { value: { get: () => "" } });
    return response;
  });
  const client = makeClient(fetchFn);
  const all = await client.getDiscussions(1, 1);
  assert.equal(all.length, 1);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /per_page=100&page=1/);
});

test("postDiscussion 失败时抛出带响应体的 GitlabApiError", async () => {
  const { fetchFn } = trackFetch(() => jsonResponse(400, { message: "position is invalid" }));
  const client = makeClient(fetchFn);
  await assert.rejects(
    () =>
      client.postDiscussion(1, 1, "b", {
        position_type: "text",
        base_sha: "b",
        start_sha: "s",
        head_sha: "h",
        old_path: "a",
        new_path: "a",
        new_line: 1,
      }),
    (error: unknown) => error instanceof GitlabApiError && error.status === 400,
  );
});
