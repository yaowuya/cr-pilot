import { test } from "node:test";
import assert from "node:assert/strict";
import { createReviewPipeline } from "../../src/application/review-pipeline.ts";
import type { GitlabClient, MergeRequestTask } from "../../src/domain/review-task.ts";
import type { ReviewRecord } from "../../src/domain/review-record.ts";
import { openDatabase } from "../../src/infrastructure/sqlite/database.ts";
import { createPromptRepository } from "../../src/infrastructure/sqlite/prompt-repo.ts";
import { createLogger } from "../../src/shared/logger.ts";
import { createTaskQueue } from "../../src/shared/queue.ts";

const task: MergeRequestTask = {
  projectId: 7, iid: 8, fullName: "group/app", sourceBranch: "feature", targetBranch: "main",
  authorId: 3, gitlabUrl: "https://gitlab.example.invalid", gitlabToken: "fixture-private-task-token",
};

/** 执行真实白名单查询；所有外部步骤用计数替身，拒绝必须发生在作者查询前。 */
function harness(options: { allow?: boolean; missingPolicy?: boolean; policyFailure?: boolean; removeDuringFetch?: boolean } = {}) {
  const db = openDatabase(":memory:");
  const prompts = createPromptRepository(db);
  prompts.create({ repository: "default", projects: [], systemPrompt: "DEFAULT", userPrompt: "{diffs_text}" });
  const configured = prompts.create({ repository: "configured-rules", projects: options.allow ? ["group/app"] : [], systemPrompt: "CONFIGURED", userPrompt: "{diffs_text}" });
  const calls: string[] = [];
  const records: ReviewRecord[] = [];
  const lines: string[] = [];
  const notes: string[] = [];
  const change = { oldPath: "a.ts", newPath: "a.ts", diff: "@@ -1 +1 @@\n-old\n+new" };
  const client: GitlabClient = {
    getUser: async (id) => { calls.push("author"); return { id, name: "fixture", username: "fixture" }; },
    getMergeRequestChanges: async () => {
      calls.push("changes");
      if (options.removeDuringFetch) prompts.remove(configured.id);
      return [change];
    },
    getMergeRequestCommits: async () => { calls.push("commits"); return []; },
    getMergeRequestVersions: async () => { calls.push("versions"); return { headSha: "a".repeat(40), baseSha: "b".repeat(40), startSha: "c".repeat(40) }; },
    getRepositoryReviewSnapshot: async () => { calls.push("snapshot"); throw new Error("unexpected snapshot"); },
    postMergeRequestNote: async (_p, _i, body) => { calls.push("note"); notes.push(body); },
    postDiscussion: async () => { calls.push("discussion"); return { id: "fixture", notes: [] }; },
    getDiscussions: async () => { calls.push("discussions"); return []; },
    getLatestHeadSha: async () => { calls.push("head"); return "a".repeat(40); },
    getFileRaw: async () => { calls.push("raw"); return "one"; },
  };
  const pipeline = createReviewPipeline({
    client, promptSource: prompts,
    isProjectAllowed: options.missingPolicy ? undefined : (fullName) => {
      if (options.policyFailure) throw new Error(`fixture-config-secret ${task.gitlabToken}`);
      return prompts.isProjectConfigured(fullName);
    },
    rules: { resolve: () => { calls.push("yaml"); return { systemPrompt: "YAML", userPrompt: "{diffs_text}" }; } },
    reviewer: { review: async () => { calls.push("model"); return { text: "总分：90 分\n评审结论", model: "fixture" }; } },
    wecomNotifier: { send: async () => { calls.push("notification"); } },
    repositoryProvider: { prepare: async () => { calls.push("clone"); throw new Error("unexpected clone"); } },
    logger: createLogger("debug", (line) => { lines.push(line); }), batchMaxTokens: 6000,
    recordWriter: { insert: (record) => { records.push(record); } },
  });
  return { db, prompts, configured, pipeline, calls, records, lines, notes };
}

function assertRejected(h: ReturnType<typeof harness>, configurationFailure = false): void {
  assert.deepEqual(h.calls, [], "拒绝前不得解析作者、拉取 GitLab/Git、调用模型、评论、通知或解析 YAML 兜底");
  assert.equal(h.records.length, 1);
  assert.equal(h.records[0].result, "failed");
  assert.match(h.records[0].errorMessage ?? "", configurationFailure ? /白名单.*失败|白名单.*不可用/ : /项目.*未.*配置.*拒绝评审/);
  assert.equal(h.records[0].changeCount, 0);
  assert.equal(h.records[0].batchCount, 0);
  const output = JSON.stringify({ records: h.records, lines: h.lines });
  assert.ok(!output.includes(task.gitlabToken!));
  assert.ok(!output.includes("fixture-config-secret"));
}

test("未关联项目即使存在 default 或 YAML 也在执行开始拒绝，外部步骤均不调用", async () => {
  const h = harness();
  try { await h.pipeline.run(task); assertRejected(h); } finally { h.db.close(); }
});

test("项目已关联时正常读取配置并完成原评审/回写流程", async () => {
  const h = harness({ allow: true });
  try {
    await h.pipeline.run(task);
    assert.equal(h.records[0].result, "success");
    assert.equal(h.notes.length, 1);
    assert.equal(h.calls.filter((step) => step === "model").length, 2);
    assert.ok(h.calls.includes("author"));
    assert.ok(h.calls.includes("changes"));
  } finally { h.db.close(); }
});

test("排队后项目被移除，真实队列释放后在执行开始复核并拒绝", async () => {
  const h = harness({ allow: true });
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => { finish = resolve; });
  const queue = createTaskQueue(1);
  queue.push(() => barrier);
  queue.push(async () => { try { await h.pipeline.run(task); } finally { finish(); } });
  try {
    assert.equal(h.prompts.isProjectConfigured(task.fullName), true);
    h.prompts.remove(h.configured.id);
    release();
    await finished;
    assertRejected(h);
  } finally {
    release();
    await finished;
    h.db.close();
  }
});

for (const fixture of [
  { name: "缺少白名单检查器", options: { allow: true, missingPolicy: true } },
  { name: "白名单查询抛错", options: { allow: true, policyFailure: true } },
]) {
  test(`${fixture.name}也拒绝执行，不退化成默认或 YAML 放行`, async () => {
    const h = harness(fixture.options);
    try { await h.pipeline.run(task); assertRejected(h, true); } finally { h.db.close(); }
  });
}

test("已开始执行的任务不因关联在外部调用期间删除而被半途取消", async () => {
  const h = harness({ allow: true, removeDuringFetch: true });
  try {
    await h.pipeline.run(task);
    assert.equal(h.records[0].result, "success");
    assert.equal(h.notes.length, 1);
    assert.equal(h.prompts.isProjectConfigured(task.fullName), false);
    const priorCalls = h.calls.length;
    await h.pipeline.run(task);
    assert.equal(h.calls.length, priorCalls, "删除后下一轮不能再次触发外部步骤");
    assert.equal(h.records.at(-1)?.result, "failed");
  } finally { h.db.close(); }
});
