import assert from "node:assert/strict";
import { test } from "node:test";
import { createReviewPipeline, type PendingFinding } from "../../src/application/review-pipeline.ts";
import type { ResolvedLlmTarget } from "../../src/domain/llm-provider.ts";
import type { OcrReviewResult } from "../../src/domain/ocr-review.ts";
import type { RepositoryReviewSnapshot } from "../../src/domain/repository-context.ts";
import type { ReviewRecord } from "../../src/domain/review-record.ts";
import type { DiscussionPosition, GitlabClient, MergeRequestTask } from "../../src/domain/review-task.ts";
import { openDatabase } from "../../src/infrastructure/sqlite/database.ts";
import { createLlmProviderRepository } from "../../src/infrastructure/sqlite/llm-provider-repo.ts";
import { createPromptRepository } from "../../src/infrastructure/sqlite/prompt-repo.ts";
import { createSilentLogger, type LogFields } from "../../src/shared/logger.ts";

const task: MergeRequestTask = {
  projectId: 5,
  iid: 12,
  fullName: "team/example",
  sourceBranch: "feature",
  targetBranch: "main",
  gitlabUrl: "https://gitlab.example",
  gitlabToken: "test-token",
};
const snapshot: RepositoryReviewSnapshot = {
  refs: { baseSha: "a".repeat(40), startSha: "b".repeat(40), headSha: "c".repeat(40) },
  changes: [{ oldPath: "store.ts", newPath: "store.ts", diff: "@@ -1 +1 @@\n-old()\n+newValue()" }],
  commits: [],
  sourceProjectId: 5,
  sourceBranch: "feature",
  repositoryUrl: "https://gitlab.example/team/example.git",
  gitlabUrl: "https://gitlab.example",
};

function setup(result: OcrReviewResult, options: Pick<Parameters<typeof createReviewPipeline>[0], "llmProviders" | "promptSource"> & {
  currentRefs?: typeof snapshot.refs;
  currentHead?: string;
  headAfterDiscussion?: string;
} = {}) {
  const { currentRefs = snapshot.refs, headAfterDiscussion, llmProviders, promptSource } = options;
  let currentHead = options.currentHead ?? currentRefs.headSha;
  const notes: string[] = [];
  const discussions: string[] = [];
  const positions: DiscussionPosition[] = [];
  const records: ReviewRecord[] = [];
  const findings: PendingFinding[] = [];
  const reviewedSnapshots: RepositoryReviewSnapshot[] = [];
  const modelTargets: Array<ResolvedLlmTarget | undefined> = [];
  const logs: Array<{ message: string; fields?: LogFields; notesPosted: number }> = [];
  const client: GitlabClient = {
    getRepositoryReviewSnapshot: async () => snapshot,
    getMergeRequestChanges: async () => assert.fail("OCR must use the locked MR diff"),
    getMergeRequestCommits: async () => assert.fail("OCR must use the locked MR commits"),
    getMergeRequestVersions: async () => currentRefs,
    getLatestHeadSha: async () => currentHead,
    getFileRaw: async () => "newValue()",
    getUser: async (id) => ({ id, name: "Author", username: "author" }),
    getDiscussions: async () => [],
    postDiscussion: async (_projectId, _iid, body, position) => {
      assert.equal(position.head_sha, snapshot.refs.headSha);
      discussions.push(body);
      positions.push(position);
      currentHead = headAfterDiscussion ?? currentHead;
      return { id: "discussion", notes: [{ id: 42, body, position }] };
    },
    postMergeRequestNote: async (_projectId, _iid, body) => { notes.push(body); },
    mergeMergeRequest: async () => assert.fail("OCR must not trigger automatic merge"),
  };
  const pipeline = createReviewPipeline({
    isProjectAllowed: () => true,
    resolveReviewEngine: () => "ocr",
    llmProviders,
    promptSource,
    client,
    rules: { resolve: () => ({ systemPrompt: "Pi only", userPrompt: "{diffs_text}" }) },
    reviewer: { review: async () => assert.fail("OCR must not call Pi") },
    ocrReviewer: {
      async review(input) {
        assert.equal(input.token, task.gitlabToken);
        reviewedSnapshots.push(input.snapshot);
        modelTargets.push(input.llmTarget);
        return result;
      },
    },
    logger: { ...createSilentLogger(), info: (message, fields) => { logs.push({ message, fields, notesPosted: notes.length }); } },
    recordWriter: { insert(record) { records.push(record); return records.length; } },
    findingWriter: { insert(finding) { findings.push(finding); } },
    batchMaxTokens: 6000,
  });
  return { pipeline, notes, discussions, positions, records, findings, reviewedSnapshots, modelTargets, logs };
}

test("OCR 只评审一次，重复建议只扣一次，按固定 diff 发布并存储 90 分", async () => {
  const high = { path: "store.ts", line: 1, lineKey: "new_line" as const, body: "Handle missing rows", severity: "high" };
  const { pipeline, notes, discussions, positions, records, findings, reviewedSnapshots } = setup({
    complete: true,
    filesReviewed: 1,
    unreviewedPaths: [],
    findings: [
      high, { ...high },
      { ...high, line: 0, body: "Handle timeouts", severity: "medium" },
      { ...high, line: 0, body: "Release handles", severity: "medium" },
      { ...high, line: 0, body: "Clarify name", severity: "low" },
    ],
  });
  await pipeline.run(task);
  assert.deepEqual(reviewedSnapshots, [snapshot]);
  assert.equal(discussions.length, 1);
  assert.equal("new_line" in positions[0] && positions[0].new_line, 1);
  assert.match(discussions[0], /Handle missing rows/);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /90\/100/);
  assert.match(notes[0], /aaaaaaaaaaaa\.\.cccccccccccc/);
  assert.match(notes[0], /Handle timeouts/);
  assert.match(notes[0], /Release handles/);
  assert.doesNotMatch(notes[0], /Handle missing rows/);
  assert.equal(records[0]?.reviewEngine, "ocr");
  assert.equal(records[0]?.score, 90);
  assert.equal(findings.length, 4);
});

test("OCR 在回写前记录原始、映射和去重建议数，且评分沿用现有规则", async () => {
  const finding = { path: "store.ts", line: 0, body: "Handle missing rows", severity: "high" };
  const { pipeline, notes, logs } = setup({
    complete: false,
    filesReviewed: 1,
    unreviewedPaths: [],
    findings: [finding, finding],
    diagnostics: {
      status: "partial", returnedComments: 3, codeCommentCalls: 4, codeCommentFailures: 1,
      acceptedCodeCommentCalls: 3, unsubmittedTextCompletions: 0, session: "complete",
      warningCounts: {}, exclusionCounts: {},
    },
  });
  await pipeline.run(task);
  const index = logs.findIndex(({ message }) => message === "Open Code Review 诊断");
  assert.notEqual(index, -1);
  const { fields, notesPosted } = logs[index];
  assert.equal(fields?.项目ID, task.projectId);
  assert.equal(fields?.MR编号, task.iid);
  assert.equal(fields?.映射后建议数, 2);
  assert.equal(fields?.去重后建议数, 1);
  assert.equal((fields?.引擎诊断 as { returnedComments: number }).returnedComments, 3);
  assert.equal(notesPosted, 0);
  assert.match(notes[0], /OCR 评分暂缺/);
});

test("OCR 部分评审保留可用建议并将评分置空", async () => {
  const { pipeline, notes, records } = setup({
    complete: false,
    filesReviewed: 0,
    unreviewedPaths: ["store.ts"],
    findings: [{ path: "store.ts", line: 0, body: "Check this code", severity: "low" }],
  });
  await pipeline.run(task);
  assert.match(notes[0], /store\.ts/);
  assert.match(notes[0], /Check this code/);
  assert.equal(records[0]?.score, null);
  assert.ok(records[0]?.errorMessage);
});

test("OCR 存储真实 0 分并且不为无有效级别的结果猜分", async () => {
  const findings = Array.from({ length: 10 }, (_, i) => ({
    path: "store.ts", line: 0, severity: "critical", body: `Critical issue ${i + 1}`,
  }));
  const zero = setup({ complete: true, filesReviewed: 1, unreviewedPaths: [], findings });
  await zero.pipeline.run(task);
  assert.equal(zero.records[0]?.score, 0);
  assert.match(zero.notes[0], /0\/100/);

  const unknown = setup({
    complete: true, filesReviewed: 1, unreviewedPaths: [], findings: [{ ...findings[0], severity: "" }],
  });
  await unknown.pipeline.run(task);
  assert.equal(unknown.records[0]?.score, null);
  assert.match(unknown.notes[0], /Critical issue 1/);
});

test("OCR 不向已变化的 MR 版本发布评论或存储评分", async () => {
  const { pipeline, notes, discussions, records, reviewedSnapshots } = setup({
    complete: true, filesReviewed: 1, unreviewedPaths: [], findings: [],
  }, { currentRefs: { ...snapshot.refs, headSha: "d".repeat(40) } });
  await pipeline.run(task);
  assert.deepEqual(reviewedSnapshots, [snapshot]);
  assert.deepEqual(notes, []);
  assert.deepEqual(discussions, []);
  assert.equal(records[0]?.result, "failed");
  assert.equal(records[0]?.score, null);
});

test("MR 已推进且 GitLab 尚未生成新 diff 版本时，OCR 也不回写旧评审", async () => {
  const { pipeline, notes, records } = setup({
    complete: true, filesReviewed: 1, unreviewedPaths: [], findings: [],
  }, { currentHead: "d".repeat(40) });
  await pipeline.run(task);
  assert.deepEqual(notes, []);
  assert.equal(records[0]?.score, null);
});

test("MR 在发布行内评论期间推进时，OCR 保留已发建议的记录且不给新版本贴旧总分", async () => {
  const { pipeline, notes, positions, records, findings } = setup({
    complete: true, filesReviewed: 1, unreviewedPaths: [],
    findings: [{ path: "store.ts", line: 1, lineKey: "new_line", severity: "high", body: "Handle missing rows" }],
  }, { headAfterDiscussion: "d".repeat(40) });
  await pipeline.run(task);
  assert.equal(positions.length, 1);
  assert.equal(positions[0].head_sha, snapshot.refs.headSha);
  assert.deepEqual(notes, []);
  assert.equal(records[0]?.result, "failed");
  assert.equal(records[0]?.score, null);
  assert.equal(findings[0]?.discussionId, "discussion");
});

test("OCR 行内评论显示问题级别，并只把模型文本当作引用内容发布", async () => {
  const { pipeline, discussions } = setup({
    complete: true, filesReviewed: 1, unreviewedPaths: [],
    findings: [{ path: "store.ts", line: 1, lineKey: "new_line", severity: "high", category: "bug",
      body: "Handle missing rows\n/close\n![image](https://example.test) @team", suggestionCode: "return null;" }],
  });
  await pipeline.run(task);
  assert.match(discussions[0], /\*\*high · bug\*\*/);
  assert.match(discussions[0], /^> Handle missing rows$/m);
  assert.match(discussions[0], /^> return null;$/m);
  assert.doesNotMatch(discussions[0], /^\s*\/close$/m);
  assert.doesNotMatch(discussions[0], /!\[image\]|@team/);
});

test("OCR 只使用经核实的 diff 行一侧，方向未知的建议仍计分并进入汇总", async () => {
  const { pipeline, notes, positions, records } = setup({
    complete: true, filesReviewed: 1, unreviewedPaths: [],
    findings: [
      { path: "store.ts", line: 1, lineKey: "old_line", severity: "medium", body: "Removed guard" },
      { path: "store.ts", line: 1, severity: "high", body: "Verify access" },
    ],
  });
  await pipeline.run(task);
  assert.equal(positions.length, 1);
  assert.equal("old_line" in positions[0] && positions[0].old_line, 1);
  assert.match(notes[0], /Verify access/);
  assert.equal(records[0]?.score, 93);
});

test("OCR 从现有厂商配置按项目绑定、Prompt 绑定、全局默认的优先级选择地址、密钥和模型", async (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const providers = createLlmProviderRepository(db);
  const prompts = createPromptRepository(db);
  function createProvider(name: string, isDefault = false) {
    return providers.create({
      name, label: name, isDefault, kind: "custom", baseUrl: `https://${name}.example/v1`,
      api: "openai-completions", apiKey: `${name}-test-key`, models: ["a", "b"], defaultModel: "a",
    });
  }
  const global = createProvider("global", true);
  const promptProvider = createProvider("prompt");
  const bound = createProvider("project");
  const promptInput = { repository: "team-prompt", projects: [task.fullName], systemPrompt: "Pi only", userPrompt: "{diffs_text}" };
  const prompt = prompts.create({ ...promptInput, providerId: promptProvider.id, model: "b" });
  providers.bindProject(task.fullName, bound.id, "b");
  const { pipeline, modelTargets } = setup({ complete: true, filesReviewed: 1, unreviewedPaths: [], findings: [] }, {
    llmProviders: providers, promptSource: prompts,
  });

  await pipeline.run(task);
  providers.unbindProject(task.fullName);
  await pipeline.run(task);
  prompts.remove(prompt.id);
  prompts.create(promptInput);
  await pipeline.run(task);

  assert.deepEqual(modelTargets, [
    { provider: bound, model: "b" },
    { provider: promptProvider, model: "b" },
    { provider: global, model: "a" },
  ]);
});
