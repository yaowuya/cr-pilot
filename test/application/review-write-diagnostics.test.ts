import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReviewPipeline } from "../../src/application/review-pipeline.ts";
import type { GitlabClient, MergeRequestTask } from "../../src/domain/review-task.ts";
import type { ReviewRecord } from "../../src/domain/review-record.ts";
import { createGitlabClient } from "../../src/infrastructure/gitlab/gitlab-client.ts";
import { createSilentLogger, type LogFields } from "../../src/shared/logger.ts";

const head = "a".repeat(40);
const task: MergeRequestTask = {
  projectId: 7, iid: 8, fullName: "fixture/project", sourceBranch: "feature", targetBranch: "main",
  gitlabUrl: "https://gitlab.example.invalid", gitlabToken: "fixture-private-task-token",
};

/** 管线走真实追加/剔除流程，外部调用用隔离替身收集，绝不访问 GitLab。 */
function harness(batch: string, summary: string, failNote = false) {
  const logs: { message: string; fields?: LogFields }[] = [];
  const errors: { message: string; fields?: LogFields }[] = [];
  const logger = {
    ...createSilentLogger(),
    info: (message: string, fields?: LogFields) => { logs.push({ message, fields }); },
    warn: (message: string, fields?: LogFields) => { logs.push({ message, fields }); },
    error: (message: string, fields?: LogFields) => { errors.push({ message, fields }); },
  };
  const notes: string[] = [];
  const discussions: string[] = [];
  const records: ReviewRecord[] = [];
  let notifications = 0;
  const writer = createGitlabClient({
    url: task.gitlabUrl!, timeoutMs: 1000, insecureTls: false, logger,
    fetchFn: async () => new Response(`<html><title>WAF拦截页面</title><body>${task.gitlabToken}</body></html>`, {
      status: 403, headers: { "content-type": "text/html", "x-request-id": "waf-fixture-request" },
    }),
  });
  const client: GitlabClient = {
    getMergeRequestChanges: async () => [{ newPath: "a.ts", oldPath: "a.ts", diff: "@@ -0,0 +1 @@\n+one" }],
    getMergeRequestCommits: async () => [],
    getMergeRequestVersions: async () => ({ baseSha: "b".repeat(40), startSha: "c".repeat(40), headSha: head }),
    getDiscussions: async () => [],
    postDiscussion: async (_project, _iid, body) => {
      discussions.push(body);
      return { id: "discussion-1", notes: [{ id: 1, body }] };
    },
    postMergeRequestNote: async (project, iid, body, url, token) => {
      notes.push(body);
      if (failNote) await writer.postMergeRequestNote(project, iid, body, url, token);
    },
    getLatestHeadSha: async () => head,
    getFileRaw: async () => "one",
    getUser: async (id) => ({ id, name: "fixture author", username: "fixture-author" }),
  };
  const pipeline = createReviewPipeline({
    client, logger, isProjectAllowed: () => true, batchMaxTokens: 6000,
    rules: { resolve: () => ({ systemPrompt: "SYS", userPrompt: "评审 {diffs_text}", wecomWebhookUrl: "https://wecom.example.invalid" }) },
    reviewer: {
      review: async ({ systemPrompt }) => ({
        text: systemPrompt.includes("你之前分批评审了同一变更的各部分") ? summary : batch,
        model: "fixture-model",
      }),
    },
    recordWriter: { insert: (record) => { records.push(record); } },
    wecomNotifier: { send: async () => { notifications += 1; } },
  });
  return { pipeline, notes, discussions, records, logs, errors, notifications: () => notifications };
}

function assertCommentDiagnostics(logs: { message: string; fields?: LogFields }[], actual: string): void {
  const fields = logs.find((entry) => entry.message === "准备回写汇总评论")?.fields;
  assert.ok(fields, "应在最后一次正文变换之后记录汇总回写元数据");
  assert.equal(fields.项目ID, task.projectId);
  assert.equal(fields.MR编号, task.iid);
  assert.equal(fields.评论字数, actual.length);
  assert.equal(fields.评论字节数, Buffer.byteLength(actual, "utf8"));
  assert.equal(fields.评论SHA256, createHash("sha256").update(actual, "utf8").digest("hex"));
}

test("汇总回写诊断基于追加降级内容后的正文，而非模型汇总字数", async () => {
  const batch = "批次私有正文 fixture-private-source🙂";
  const h = harness(batch, "总分：90 分\n汇总正文");
  await h.pipeline.run(task);
  assert.equal(h.notes.length, 1);
  assert.ok(h.notes[0].includes(batch), "仍按原有逻辑保留未结构化批次");
  assertCommentDiagnostics(h.logs, h.notes[0]);
  assert.ok(!JSON.stringify(h.logs).includes("fixture-private-source"));
  assert.equal(h.records[0].result, "success");
});

test("汇总回写诊断基于剔除已发行内 finding 后的正文，发布行为不变", async () => {
  const finding = "fixture-private-finding：此行存在问题";
  const batch = JSON.stringify({
    reviewed_head_sha: head,
    summary: { body: "总分：90 分" },
    findings: [{ id: "f1", severity: "high", path: "a.ts", new_line: 1, body: finding }],
  });
  const h = harness(batch, `总分：90 分\n${finding}\n保留汇总结论`);
  await h.pipeline.run(task);
  assert.equal(h.discussions.length, 1);
  assert.equal(h.notes.length, 1);
  assert.equal(h.notes[0], "总分：90 分\n保留汇总结论");
  assertCommentDiagnostics(h.logs, h.notes[0]);
  assert.ok(!JSON.stringify(h.logs).includes("fixture-private-finding"));
});

test("WAF 回写失败仍只发布一次、记录失败并跳过企微，不落原始 HTML、正文或 token", async () => {
  const h = harness("fixture-private-source", "总分：90 分\n汇总私有内容", true);
  await h.pipeline.run(task);
  assert.equal(h.notes.length, 1);
  assert.equal(h.records.length, 1);
  assert.equal(h.records[0].result, "failed");
  assert.match(h.records[0].errorMessage ?? "", /WAF.*拦截/);
  assert.match(h.records[0].errorMessage ?? "", /waf-fixture-request/);
  assert.equal(h.notifications(), 0);
  assertCommentDiagnostics(h.logs, h.notes[0]);
  const output = JSON.stringify({ logs: h.logs, errors: h.errors, records: h.records });
  assert.ok(!output.includes(task.gitlabToken!));
  assert.ok(!output.includes("fixture-private-source"));
  assert.ok(!output.includes("<html>"));
  const request = h.logs.find((entry) => entry.message === "GitLab 写入请求")?.fields;
  const json = JSON.stringify({ body: h.notes[0] });
  assert.equal(request?.请求体字节数, Buffer.byteLength(json, "utf8"));
  assert.equal(request?.请求体SHA256, createHash("sha256").update(json, "utf8").digest("hex"));
});
