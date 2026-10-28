import { test } from "node:test";
import assert from "node:assert/strict";
import { createReviewPipeline, type ReviewRecordWriter } from "../../src/application/review-pipeline.ts";
import type { LlmProvider, LlmProviderRepository } from "../../src/domain/llm-provider.ts";
import type { ReviewRecord } from "../../src/domain/review-record.ts";
import type { AutoMergePolicy, Change, GitlabClient, Reviewer } from "../../src/domain/review-task.ts";
import { createSilentLogger } from "../../src/shared/logger.ts";

const HEAD = "a".repeat(40);
const REFS = { baseSha: "b".repeat(40), startSha: "c".repeat(40), headSha: HEAD };
const policy: AutoMergePolicy = {
  enabled: true,
  minimumScore: 90,
  targetBranches: ["main", "release"],
  method: "squash",
  removeSourceBranch: true,
};
const evaluatorProvider: LlmProvider = {
  id: 1,
  name: "fixture-provider",
  label: "Fixture Provider",
  kind: "custom",
  baseUrl: "https://fixture.example/v1",
  api: "openai-responses",
  models: ["m"],
  defaultModel: "m",
  isDefault: true,
  createdAt: 1,
  updatedAt: 1,
};

/** 自动合并用例必须有可解析的期望 evaluator，不能依赖 SDK 默认值猜测。 */
function evaluatorRepository(): LlmProviderRepository {
  return {
    list: () => [],
    get: () => evaluatorProvider,
    findByName: () => evaluatorProvider,
    create: () => evaluatorProvider,
    update: () => evaluatorProvider,
    remove: () => {},
    getDefault: () => evaluatorProvider,
    setDefault: () => {},
    bindProject: () => {},
    unbindProject: () => {},
    listProjectBindings: () => [],
    resolveProjectTarget: () => undefined,
    resolveTarget: () => ({ provider: evaluatorProvider, model: "m" }),
  };
}
const structured = JSON.stringify({
  reviewed_head_sha: HEAD,
  summary: { body: "低风险建议" },
  findings: [{ id: "f1", severity: "low", path: "a.ts", new_line: 1, body: "建议改名" }],
  merge_gate: { max_severity: "low", blocking_findings: 0 },
});

function harness(options: {
  batchText?: string;
  currentPolicy?: AutoMergePolicy;
  mergeError?: Error;
  summaryText?: string;
  changes?: Change[];
  failBatchMarker?: string;
  batchMaxTokens?: number;
  snapshotError?: Error;
  omitSnapshot?: boolean;
  publishError?: Error;
  versionsHead?: string;
  currentTargetBranch?: string;
  currentRefs?: typeof REFS;
} = {}) {
  const events: string[] = [];
  const records: ReviewRecord[] = [];
  let reviewCalls = 0;
  let policyCalls = 0;
  const systemPrompts: string[] = [];
  const changes = options.changes ?? [{ newPath: "a.ts", oldPath: "a.ts", diff: "@@ -0,0 +1 @@\n+const x = 1;" }];
  const commits = [{ id: "c1", message: "feat" }];
  const client: GitlabClient = {
    getRepositoryReviewSnapshot: async () => {
      events.push("snapshot");
      if (options.snapshotError) throw options.snapshotError;
      return {
        changes,
        commits,
        refs: REFS,
        sourceProjectId: 1,
        sourceBranch: "feat",
        targetBranch: "main",
        repositoryUrl: "https://gitlab.example/group/app.git",
        gitlabUrl: "https://gitlab.example",
      };
    },
    getMergeRequestChanges: async () => { events.push("legacyChanges"); return changes; },
    getMergeRequestCommits: async () => { events.push("legacyCommits"); return commits; },
    getMergeRequestVersions: async () => {
      events.push("versions");
      return { baseSha: "b".repeat(40), startSha: "c".repeat(40), headSha: options.versionsHead ?? HEAD };
    },
    getDiscussions: async () => [],
    postDiscussion: async () => {
      if (options.publishError) throw options.publishError;
      return { id: "d1", notes: [{ id: 1, body: "建议改名" }] };
    },
    postMergeRequestNote: async () => { events.push("comment"); },
    getLatestHeadSha: async () => HEAD,
    getMergeRequestAutoMergeState: async () => {
      events.push("state");
      return { headSha: HEAD, state: "opened", targetBranch: options.currentTargetBranch ?? "main", refs: options.currentRefs ?? REFS };
    },
    mergeMergeRequest: async (_project, _iid, command) => {
      events.push(`merge:${command.sha}:${command.method}:${command.removeSourceBranch}`);
      if (options.mergeError) throw options.mergeError;
    },
    getFileRaw: async () => "const x = 1;",
    getUser: async (id) => ({ id, name: "作者", username: "author" }),
  };
  if (options.omitSnapshot) delete client.getRepositoryReviewSnapshot;
  const reviewer: Reviewer = {
    review: async ({ systemPrompt, code }) => {
      reviewCalls += 1;
      systemPrompts.push(systemPrompt);
      const summary = systemPrompt.includes("你之前分批评审了同一变更的各部分");
      if (!summary && options.failBatchMarker && code.includes(options.failBatchMarker)) throw new Error("synthetic batch failure");
      return {
        text: summary ? (options.summaryText ?? "总分：95 分\n\n可以合入。") : (options.batchText ?? structured),
        provider: "fixture-provider",
        model: "m",
        baseUrl: "https://fixture.example/v1",
        api: "openai-responses",
      };
    },
  };
  const recordWriter: ReviewRecordWriter = {
    insert: (record) => { events.push("record"); records.push(record); return 7; },
  };
  const pipeline = createReviewPipeline({
    isProjectAllowed: () => true,
    client,
    rules: { resolve: () => ({ systemPrompt: "SYS", userPrompt: "{diffs_text}" }) },
    reviewer,
    logger: createSilentLogger(),
    batchMaxTokens: options.batchMaxTokens ?? 6000,
    retryDelayMs: 0,
    recordWriter,
    findingWriter: { insert: () => { events.push("finding"); } },
    llmProviders: evaluatorRepository(),
    resolveAutoMergePolicy: () => {
      policyCalls += 1;
      events.push(`policy:${policyCalls}`);
      return policyCalls === 1 ? policy : (options.currentPolicy ?? policy);
    },
  });
  return { pipeline, events, records, systemPrompts, getReviewCalls: () => reviewCalls, getPolicyCalls: () => policyCalls };
}

const task = { projectId: 1, iid: 2, fullName: "group/app", sourceBranch: "feat", targetBranch: "main" };

test("记录与 findings 落库后复核 state/policy，再用 expected sha 合并", async () => {
  const run = harness({ versionsHead: "f".repeat(40) });
  await run.pipeline.run(task);
  assert.equal(run.getReviewCalls(), 2);
  assert.match(run.systemPrompts[0] ?? "", /"merge_gate"/);
  assert.match(run.systemPrompts[0] ?? "", /blocking_findings/);
  assert.equal(run.getPolicyCalls(), 2, "任务开始与 PUT 前各解析一次策略");
  assert.equal(run.events.includes("snapshot"), true);
  assert.equal(run.events.includes("legacyChanges") || run.events.includes("versions"), false, "自动合并必须只使用同一 version 快照");
  assert.deepEqual(run.events.slice(-5), ["record", "finding", "state", "policy:2", `merge:${HEAD}:squash:true`]);
  assert.equal(run.records[0]?.result, "success");
});

test("目标分支在评审后从 main 改为同样允许的 release 仍阻断合并", async () => {
  const run = harness({ currentTargetBranch: "release" });
  await run.pipeline.run(task);
  assert.equal(run.events.some((event) => event.startsWith("merge:")), false);
  assert.equal(run.records[0]?.result, "success");
});

test("目标分支同名但 base/start tip 已推进时阻断合并", async () => {
  for (const currentRefs of [
    { ...REFS, baseSha: "d".repeat(40) },
    { ...REFS, startSha: "d".repeat(40) },
  ]) {
    const run = harness({ currentRefs });
    await run.pipeline.run(task);
    assert.equal(run.events.some((event) => event.startsWith("merge:")), false);
  }
});

test("合并失败只记录辅助动作失败，不改变已完成评审的成功记录", async () => {
  const run = harness({ mergeError: new Error("merge conflict") });
  await run.pipeline.run(task);
  assert.equal(run.records.length, 1);
  assert.equal(run.records[0]?.result, "success");
  assert.equal(run.events.filter((event) => event.startsWith("merge:")).length, 1);
});

test("非结构化批次即使总分足够也不调用合并写接口", async () => {
  const run = harness({ batchText: "整体看起来不错，没有结构化 JSON。" });
  await run.pipeline.run(task);
  assert.equal(run.events.some((event) => event.startsWith("merge:")), false);
  assert.equal(run.records[0]?.result, "success", "自动合并资格不影响评审结果");
});

test("快照能力缺失或锁定失败时继续普通评审，但关闭本次自动合并", async () => {
  for (const patch of [{ omitSnapshot: true }, { snapshotError: new Error("snapshot race") }]) {
    const run = harness(patch);
    await run.pipeline.run(task);
    assert.equal(run.events.includes("legacyChanges"), true, "应降级完成普通评审");
    assert.equal(run.events.includes("versions"), true, "普通行内评论仍可读取动态 refs");
    assert.equal(run.events.some((event) => event.startsWith("merge:")), false);
    assert.equal(run.records[0]?.result, "success");
  }
});

test("每批缺少 merge_gate 时即使 JSON 其余结构完整也不自动合并", async () => {
  const run = harness({ batchText: JSON.stringify({
    reviewed_head_sha: HEAD,
    summary: { body: "看起来安全" },
    findings: [],
  }) });
  await run.pipeline.run(task);
  assert.equal(run.events.some((event) => event.startsWith("merge:")), false);
});

test("无锚点 high 只出现在正文和 merge_gate 时仍固定阻断", async () => {
  const batch = `## 报告\n\n### P1：跨文件架构风险，无可靠行锚点\n\n\`\`\`json\n${JSON.stringify({
    reviewed_head_sha: HEAD,
    summary: { body: "有阻断问题" },
    findings: [],
    merge_gate: { max_severity: "high", blocking_findings: 1 },
  })}\n\`\`\``;
  const run = harness({ batchText: batch });
  await run.pipeline.run(task);
  assert.equal(run.events.some((event) => event.startsWith("merge:")), false);
});

test("行内评论发布失败即使建议级别低也固定阻断", async () => {
  const run = harness({ publishError: new Error("discussion unavailable") });
  await run.pipeline.run(task);
  assert.equal(run.events.some((event) => event.startsWith("merge:")), false);
  assert.equal(run.records[0]?.result, "success");
});

test("任一批次重试耗尽被跳过时，即使其余批次成功也不自动合并", async () => {
  const run = harness({
    changes: [
      { newPath: "a.ts", oldPath: "a.ts", diff: `FAIL${"x".repeat(5000)}` },
      { newPath: "b.ts", oldPath: "b.ts", diff: `OK${"y".repeat(5000)}` },
    ],
    failBatchMarker: "FAIL",
    batchMaxTokens: 1200,
  });
  await run.pipeline.run(task);
  assert.equal(run.events.some((event) => event.startsWith("merge:")), false);
  assert.equal(run.records[0]?.result, "success", "部分跳批仍按既有语义完成评审，但必须阻断合并");
});

test("最终评论重新判为 P0/P1 时固定阻断合并，Markdown 标题不能绕过", async () => {
  for (const heading of ["P0：", "P1:", "### P0：", "### P1:"]) {
    const run = harness({ summaryText: `总分：95 分\n\n${heading} 汇总阶段发现阻断问题` });
    await run.pipeline.run(task);
    assert.equal(run.events.some((event) => event.startsWith("merge:")), false);
    assert.equal(run.records[0]?.result, "success");
  }
});

test("安全扫描使用去重前汇总，P1 标题与已发布 low body 重合也不能被删除绕过", async () => {
  const run = harness({ summaryText: "总分：95 分\n\n### P1：建议改名" });
  await run.pipeline.run(task);
  assert.equal(run.events.some((event) => event.startsWith("merge:")), false);
  assert.equal(run.records[0]?.result, "success");
});

test("自动合并评分使用去重前最低分，已发布 finding 不能删除低分后抬高门槛", async () => {
  const batchText = JSON.stringify({
    reviewed_head_sha: HEAD,
    summary: { body: "低分建议" },
    findings: [{ id: "score", severity: "low", path: "a.ts", new_line: 1, body: "总分：80 分" }],
    merge_gate: { max_severity: "low", blocking_findings: 0 },
  });
  const run = harness({ batchText, summaryText: "总分：95 分\n总分：80 分" });
  await run.pipeline.run(task);
  assert.equal(run.events.some((event) => event.startsWith("merge:")), false);
  assert.equal(run.records[0]?.score, 95, "ReviewRecord 仍可沿用去重后实际回写正文分数");
});

test("PUT 前策略被关闭或关键字段变化时跳过合并", async () => {
  for (const currentPolicy of [
    { ...policy, enabled: false },
    { ...policy, minimumScore: 100 },
  ]) {
    const run = harness({ currentPolicy });
    await run.pipeline.run(task);
    assert.equal(run.events.some((event) => event.startsWith("merge:")), false);
    assert.equal(run.records[0]?.result, "success");
  }
});
