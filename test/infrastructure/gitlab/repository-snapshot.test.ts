import { test } from "node:test";
import assert from "node:assert/strict";
import { createGitlabClient } from "../../../src/infrastructure/gitlab/gitlab-client.ts";
import { createSilentLogger } from "../../../src/shared/logger.ts";

const head = "a".repeat(40);
const base = "b".repeat(40);
const start = "c".repeat(40);
const refs = { head_sha: head, base_sha: base, start_sha: start };

/** 合成 GitLab 版本协议，不访问外部实例；可在任一响应制造版本或权限失败。 */
function harness(overrides: {
  mr?: Record<string, unknown>;
  finalMr?: Record<string, unknown>;
  version?: Record<string, unknown>;
  project?: Record<string, unknown>;
  versions?: unknown;
  status?: number;
} = {}) {
  let mrReads = 0;
  const calls: { url: string; init?: RequestInit }[] = [];
  const mr = { id: 105, iid: 2, project_id: 7, source_project_id: 9, source_branch: "feature/review", target_branch: "main", sha: head, diff_refs: refs, ...overrides.mr };
  const version = { id: 110, merge_request_id: 105, head_commit_sha: head, base_commit_sha: base, start_commit_sha: start, state: "collected", real_size: "1", commits: [{id:head,message:"fixture commit"}], diffs: [{old_path:"src/a.ts",new_path:"src/a.ts",diff:"@@ -1 +1 @@\n-old\n+new"}], ...overrides.version };
  const client = createGitlabClient({
    url: "https://fallback.invalid", timeoutMs: 1000, insecureTls: false, logger: createSilentLogger(),
    fetchFn: async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      if (overrides.status) return new Response("leaked-fixture-token", {status:overrides.status});
      const path = new URL(url).pathname;
      let body: unknown;
      if (path === "/api/v4/projects/7/merge_requests/2") {
        mrReads += 1;
        body = mrReads > 1 ? { ...mr, ...overrides.finalMr } : mr;
      } else if (path === "/api/v4/projects/7/merge_requests/2/versions") {
        body = overrides.versions ?? [{id:110,head_commit_sha:head,base_commit_sha:base,start_commit_sha:start}];
      } else if (path === "/api/v4/projects/7/merge_requests/2/versions/110") {
        body = version;
      } else if (path === "/api/v4/projects/9") {
        body = {id:9,http_url_to_repo:"https://git.example/fork/repo.git",...overrides.project};
      } else {
        throw new Error(`unexpected fixture path: ${path}`);
      }
      return Response.json(body);
    },
  });
  return { client, calls };
}

test("固定版本快照从 fork 源项目读取仓库，diff/commits/refs 同源且不跟随跳转", async () => {
  const { client, calls } = harness();
  const snapshot = await client.getRepositoryReviewSnapshot!(7, 2, "https://git.example", "fixture-token");
  assert.equal(snapshot.sourceProjectId, 9);
  assert.equal(snapshot.sourceBranch, "feature/review");
  assert.equal(snapshot.repositoryUrl, "https://git.example/fork/repo.git");
  assert.equal(snapshot.gitlabUrl, "https://git.example");
  assert.deepEqual(snapshot.refs, {headSha:head,baseSha:base,startSha:start});
  assert.deepEqual(snapshot.commits, [{id:head,message:"fixture commit"}]);
  assert.deepEqual(snapshot.changes, [{oldPath:"src/a.ts",newPath:"src/a.ts",diff:"@@ -1 +1 @@\n-old\n+new"}]);
  assert.equal(calls.filter(c=>new URL(c.url).pathname.endsWith("/merge_requests/2")).length, 2);
  assert(!calls.some(c=>c.url.includes("/changes") || c.url.includes("/commits")), "不能另取动态最新内容混入固定版本");
  for (const call of calls) {
    assert.equal(new URL(call.url).origin, "https://git.example");
    assert.equal(new Headers(call.init?.headers).get("PRIVATE-TOKEN"), "fixture-token");
    assert.equal(call.init?.redirect, "error");
  }
});

test("快照拒绝准备期间 head、source project、branch 或 diff refs 变化", async () => {
  for (const finalMr of [{sha:"d".repeat(40)},{source_project_id:10},{source_branch:"other"},{diff_refs:{...refs,base_sha:"d".repeat(40)}}]) {
    const {client} = harness({finalMr});
    await assert.rejects(client.getRepositoryReviewSnapshot!(7,2,"https://git.example","token"), /版本|变化|快照/);
  }
});

test("快照拒绝缺元数据、缺匹配版本、截断或不完整 diff", async () => {
  for (const overrides of [
    {mr:{source_project_id:null}}, {mr:{sha:"invalid"}}, {mr:{source_branch:""}}, {mr:{diff_refs:null}},
    {versions:[]}, {versions:[{id:110,head_commit_sha:"d".repeat(40)}]},
    {version:{state:"overflow"}}, {version:{real_size:"1000+"}}, {version:{real_size:"2"}},
    {version:{head_commit_sha:"d".repeat(40)}}, {version:{merge_request_id:999}},
    {version:{diffs:[{old_path:"a",new_path:"a",diff:"x",too_large:true}]}},
    {version:{diffs:[{old_path:"a",new_path:"a",diff:"x",collapsed:true}]}},
    {version:{diffs:[{old_path:"a",new_path:"a"}]}}, {version:{commits:null}},
  ]) {
    const {client} = harness(overrides);
    await assert.rejects(client.getRepositoryReviewSnapshot!(7,2,"https://git.example","token"), /版本|快照|完整|元数据|提交|源项目/);
  }
});

test("源仓库 URL 不允许跨域、带凭据、查询串或非 HTTP(S) 协议", async () => {
  for (const http_url_to_repo of ["https://other.example/g/r.git", "https://user:secret@git.example/g/r.git", "https://git.example/g/r.git?token=x", "https://git.example/g/r.git#x", "file:///tmp/repo", "ssh://git@git.example/g/r.git"]) {
    const {client} = harness({project:{http_url_to_repo}});
    await assert.rejects(client.getRepositoryReviewSnapshot!(7,2,"https://git.example","token"), /仓库|地址|同源|协议/);
  }
});

test("API 权限和网络失败不回显响应里的凭据或原始错误", async () => {
  const {client} = harness({status:403});
  await assert.rejects(client.getRepositoryReviewSnapshot!(7,2,"https://git.example","leaked-fixture-token"), (error: Error) => {
    assert.match(error.message, /403/);
    assert.doesNotMatch(error.message, /leaked-fixture-token/);
    return true;
  });
});
