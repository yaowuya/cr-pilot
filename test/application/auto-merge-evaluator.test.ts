import { test } from "node:test";
import assert from "node:assert/strict";
import { createReviewPipeline } from "../../src/application/review-pipeline.ts";
import type { LlmProvider, LlmProviderRepository, ResolvedLlmTarget } from "../../src/domain/llm-provider.ts";
import type { AutoMergePolicy, GitlabClient, Reviewer, ReviewResult } from "../../src/domain/review-task.ts";
import { createLogger, createSilentLogger } from "../../src/shared/logger.ts";

const HEAD = "a".repeat(40);
const REFS = { baseSha: "b".repeat(40), startSha: "c".repeat(40), headSha: HEAD };
const TASK = { projectId: 1, iid: 2, fullName: "group/app", sourceBranch: "feat", targetBranch: "main" };
const POLICY: AutoMergePolicy = {
  enabled: true,
  minimumScore: 90,
  targetMode: "specified",
  targetBranches: ["main"],
  method: "merge",
  removeSourceBranch: false,
};
const EXPECTED_PROVIDER: LlmProvider = {
  id: 1,
  name: "expected-provider",
  label: "Expected Provider",
  kind: "custom",
  baseUrl: "https://llm.example/v1",
  api: "openai-responses",
  models: ["shared-model"],
  defaultModel: "shared-model",
  isDefault: true,
  createdAt: 1,
  updatedAt: 1,
};
const EXPECTED_TARGET: ResolvedLlmTarget = { provider: EXPECTED_PROVIDER, model: "shared-model" };
const STRUCTURED_BATCH = JSON.stringify({
  reviewed_head_sha: HEAD,
  summary: { body: "无阻断问题" },
  findings: [],
  merge_gate: { max_severity: "none", blocking_findings: 0 },
});

/** 仅实现管线模型选择会读取的仓储面，避免测试依赖 SQLite。 */
function llmRepository(target: ResolvedLlmTarget | undefined): LlmProviderRepository {
  return {
    list: () => [],
    get: () => target?.provider,
    findByName: () => target?.provider,
    create: () => EXPECTED_PROVIDER,
    update: () => EXPECTED_PROVIDER,
    remove: () => {},
    getDefault: () => target?.provider,
    setDefault: () => {},
    bindProject: () => {},
    unbindProject: () => {},
    listProjectBindings: () => [],
    resolveProjectTarget: () => undefined,
    resolveTarget: () => target,
  };
}

function harness(options: {
  expectedTarget?: ResolvedLlmTarget;
  userPrompt?: string;
  batchEvaluator?: Pick<ReviewResult, "provider" | "model" | "baseUrl" | "api">;
  summaryEvaluator?: Pick<ReviewResult, "provider" | "model" | "baseUrl" | "api">;
  logLines?: string[];
}) {
  const events: string[] = [];
  let policyReads = 0;
  const batchEvaluator = options.batchEvaluator ?? {
    provider: "expected-provider",
    model: "shared-model",
    baseUrl: "https://llm.example/v1",
    api: "openai-responses",
  };
  const summaryEvaluator = options.summaryEvaluator ?? {
    provider: "expected-provider",
    model: "shared-model",
    baseUrl: "https://llm.example/v1",
    api: "openai-responses",
  };
  const reviewer: Reviewer = {
    review: async ({ systemPrompt }): Promise<ReviewResult> => {
      const summary = systemPrompt.includes("你之前分批评审了同一变更的各部分");
      const evaluator = summary ? summaryEvaluator : batchEvaluator;
      return {
        text: summary ? "总分：95 分\n\n可以合入。" : STRUCTURED_BATCH,
        ...evaluator,
      };
    },
  };
  const client: GitlabClient = {
    getRepositoryReviewSnapshot: async () => ({
      changes: [{ newPath: "a.ts", oldPath: "a.ts", diff: "@@ -0,0 +1 @@\n+const x = 1;" }],
      commits: [{ id: "c1", message: "feat" }],
      refs: REFS,
      sourceProjectId: 1,
      sourceBranch: "feat",
      targetBranch: "main",
      repositoryUrl: "https://gitlab.example/group/app.git",
      gitlabUrl: "https://gitlab.example",
    }),
    getMergeRequestChanges: async () => [],
    getMergeRequestCommits: async () => [],
    getMergeRequestVersions: async () => REFS,
    getDiscussions: async () => [],
    postDiscussion: async () => ({ id: "d", notes: [] }),
    postMergeRequestNote: async () => { events.push("comment"); },
    getLatestHeadSha: async () => HEAD,
    getMergeRequestAutoMergeState: async () => {
      events.push("state");
      return { headSha: HEAD, state: "opened", targetBranch: "main", refs: REFS };
    },
    mergeMergeRequest: async () => { events.push("merge"); },
    getFileRaw: async () => "const x = 1;",
    getUser: async (id) => ({ id, name: "作者", username: "author" }),
  };
  const pipeline = createReviewPipeline({
    isProjectAllowed: () => true,
    client,
    rules: { resolve: () => ({ systemPrompt: "SYS", userPrompt: options.userPrompt ?? "请评审 {diffs_text}" }) },
    reviewer,
    logger: options.logLines
      ? createLogger("debug", (line) => options.logLines!.push(line))
      : createSilentLogger(),
    batchMaxTokens: 6000,
    retryDelayMs: 0,
    llmProviders: options.expectedTarget === undefined ? undefined : llmRepository(options.expectedTarget),
    resolveAutoMergePolicy: () => {
      policyReads += 1;
      return POLICY;
    },
  });
  return { pipeline, events, policyReads: () => policyReads };
}

test("期望 target 与每批及汇总实际 evaluator 身份完全一致时才执行自动合并", async () => {
  const run = harness({ expectedTarget: EXPECTED_TARGET });
  await run.pipeline.run(TASK);
  assert.equal(run.events.includes("comment"), true);
  assert.equal(run.events.includes("merge"), true);
  assert.equal(run.policyReads(), 2);
});

test("批次静默回退到同名模型的另一 provider 时仅保留普通评审", async () => {
  const run = harness({
    expectedTarget: EXPECTED_TARGET,
    batchEvaluator: {
      provider: "fallback-provider",
      model: "shared-model",
      baseUrl: "https://llm.example/v1",
      api: "openai-responses",
    },
  });
  await run.pipeline.run(TASK);
  assert.equal(run.events.includes("comment"), true);
  assert.equal(run.events.includes("state"), false, "evaluator 证据失败后不应继续读取合并状态");
  assert.equal(run.events.includes("merge"), false);
  assert.equal(run.policyReads(), 1, "证据硬门失败后不做 PUT 前策略复核");
});

test("provider/model 同名但实际 baseUrl 或协议漂移时不得自动合并", async () => {
  for (const batchEvaluator of [
    {
      provider: "expected-provider",
      model: "shared-model",
      baseUrl: "https://fallback.example/v1",
      api: "openai-responses",
    },
    {
      provider: "expected-provider",
      model: "shared-model",
      baseUrl: "https://llm.example/v1",
      api: "openai-completions",
    },
  ]) {
    const run = harness({ expectedTarget: EXPECTED_TARGET, batchEvaluator });
    await run.pipeline.run(TASK);
    assert.equal(run.events.includes("comment"), true);
    assert.equal(run.events.includes("merge"), false);
  }
});

test("evaluator 不匹配日志只记录 baseUrl 指纹，不泄露原始端点或 userinfo", async () => {
  const logLines: string[] = [];
  const sensitiveBaseUrl = "https://internal-user:secret@internal.example/v1";
  const run = harness({
    expectedTarget: EXPECTED_TARGET,
    batchEvaluator: {
      provider: "expected-provider",
      model: "shared-model",
      baseUrl: sensitiveBaseUrl,
      api: "openai-responses",
    },
    logLines,
  });
  await run.pipeline.run(TASK);
  const logs = logLines.join("\n");
  assert.doesNotMatch(logs, /internal-user|secret@|internal\.example/);
  assert.match(logs, /API地址指纹=/);
});

test("汇总静默回退或旧 fake 缺 provider 时均不得自动合并", async () => {
  for (const summaryEvaluator of [
    {
      provider: "fallback-provider",
      model: "shared-model",
      baseUrl: "https://llm.example/v1",
      api: "openai-responses",
    },
    { model: "shared-model" },
  ]) {
    const run = harness({ expectedTarget: EXPECTED_TARGET, summaryEvaluator });
    await run.pipeline.run(TASK);
    assert.equal(run.events.includes("comment"), true);
    assert.equal(run.events.includes("state"), false);
    assert.equal(run.events.includes("merge"), false);
  }
});

test("没有可解析的期望 target 时实际模型即使看似正确也不得自动合并", async () => {
  const run = harness({});
  await run.pipeline.run(TASK);
  assert.equal(run.events.includes("comment"), true);
  assert.equal(run.events.includes("state"), false);
  assert.equal(run.events.includes("merge"), false);
});

test("自动合并 Prompt 缺少 diffs_text 占位符时 fail closed，普通评审仍完成", async () => {
  const run = harness({ expectedTarget: EXPECTED_TARGET, userPrompt: "请根据提交说明评审" });
  await run.pipeline.run(TASK);
  assert.equal(run.events.includes("comment"), true);
  assert.equal(run.events.includes("state"), false);
  assert.equal(run.events.includes("merge"), false);
});
