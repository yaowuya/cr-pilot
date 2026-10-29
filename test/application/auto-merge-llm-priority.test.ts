import { test } from "node:test";
import assert from "node:assert/strict";
import { createReviewPipeline } from "../../src/application/review-pipeline.ts";
import type { LlmProvider, LlmProviderInput, LlmProviderRepository } from "../../src/domain/llm-provider.ts";
import type { PromptRepository, StoredPrompt } from "../../src/domain/review-prompt.ts";
import type { GitlabClient, Reviewer } from "../../src/domain/review-task.ts";
import { openDatabase } from "../../src/infrastructure/sqlite/database.ts";
import { createLlmProviderRepository } from "../../src/infrastructure/sqlite/llm-provider-repo.ts";
import { createSilentLogger } from "../../src/shared/logger.ts";

const TASK = { projectId: 1, iid: 2, fullName: "group/app", sourceBranch: "feat", targetBranch: "main" };

/** 构造模型厂商，测试只覆盖选择优先级，不依赖真实模型或网络。 */
function providerInput(name: string, models: string[], overrides: Partial<LlmProviderInput> = {}): LlmProviderInput {
  return {
    name,
    label: name,
    kind: "custom",
    baseUrl: `https://${name}.example/v1`,
    api: "openai-responses",
    models,
    isDefault: false,
    ...overrides,
  };
}

/** 只实现管线会读取的 Prompt 行为，其余端口方法用于保持替身契约完整。 */
function promptRepository(stored: StoredPrompt): PromptRepository {
  return {
    resolve: () => stored,
    isProjectConfigured: () => true,
    list: () => [],
    get: () => stored,
    findByRepository: () => stored,
    create: () => stored,
    update: () => stored,
    remove: () => {},
    importFromDir: () => ({ imported: 0, skipped: 0 }),
    listKnownProjects: () => stored.projects,
  };
}

/** 跑一条最小评审并收集批次与汇总实际收到的 provider/model。 */
async function selectedTargets(
  providers: LlmProviderRepository,
  stored: StoredPrompt,
): Promise<Array<{ provider?: string; model?: string }>> {
  const selected: Array<{ provider?: string; model?: string }> = [];
  const reviewer: Reviewer = {
    review: async ({ provider, model, systemPrompt }) => {
      selected.push({ provider, model });
      return {
        text: systemPrompt.includes("你之前分批评审了同一变更的各部分") ? "总分：95 分" : "批次评审完成",
        model: model ?? "models-json-default",
      };
    },
  };
  const client: GitlabClient = {
    getMergeRequestChanges: async () => [{ newPath: "a.ts", oldPath: "a.ts", diff: "@@ -0,0 +1 @@\n+const x = 1;" }],
    getMergeRequestCommits: async () => [{ id: "c1", message: "feat" }],
    getMergeRequestVersions: async () => ({ baseSha: "b", startSha: "s", headSha: "h" }),
    getLatestHeadSha: async () => "h",
    getDiscussions: async () => [],
    postDiscussion: async () => ({ id: "d", notes: [] }),
    postMergeRequestNote: async () => {},
    getFileRaw: async () => "const x = 1;",
    getUser: async (id) => ({ id, name: "作者", username: "author" }),
  };
  const pipeline = createReviewPipeline({
    isProjectAllowed: () => true,
    client,
    rules: { resolve: () => ({ systemPrompt: "fallback", userPrompt: "{diffs_text}" }) },
    reviewer,
    logger: createSilentLogger(),
    batchMaxTokens: 6000,
    promptSource: promptRepository(stored),
    llmProviders: providers,
  });

  await pipeline.run(TASK);
  return selected;
}

function storedPrompt(provider: LlmProvider, model?: string): StoredPrompt {
  return {
    id: 7,
    repository: "project-prompt",
    projects: [TASK.fullName],
    systemPrompt: "SYS",
    userPrompt: "{diffs_text}",
    providerId: provider.id,
    model,
    updatedAt: 1,
  };
}

test("项目 binding、Prompt 与全局默认冲突时，批次和汇总都使用项目 binding", async (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const providers = createLlmProviderRepository(db);
  providers.create(providerInput("global", ["global-model"], { isDefault: true }));
  const prompt = providers.create(providerInput("prompt", ["prompt-model"]));
  const project = providers.create(providerInput("project", ["project-default", "project-model"]));
  providers.bindProject(TASK.fullName, project.id, "project-model");

  const selected = await selectedTargets(providers, storedPrompt(prompt, "prompt-model"));

  assert.deepEqual(selected, [
    { provider: "project", model: "project-model" },
    { provider: "project", model: "project-model" },
  ]);
});

test("删除项目绑定的 provider 后，级联清理绑定并回落 Prompt，而非越过 Prompt 选全局默认", async (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const providers = createLlmProviderRepository(db);
  providers.create(providerInput("global", ["global-model"], { isDefault: true }));
  const prompt = providers.create(providerInput("prompt", ["prompt-default"]));
  const removed = providers.create(providerInput("removed", ["removed-model"]));
  providers.bindProject(TASK.fullName, removed.id, "removed-model");
  providers.remove(removed.id);

  const selected = await selectedTargets(providers, storedPrompt(prompt));

  assert.equal(providers.listProjectBindings().length, 0);
  assert.deepEqual(selected, [
    { provider: "prompt", model: "prompt-default" },
    { provider: "prompt", model: "prompt-default" },
  ]);
});

test("Prompt 绑定的模型已从厂商清单移除时回落厂商默认模型", async (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const providers = createLlmProviderRepository(db);
  providers.create(providerInput("global", ["global-model"], { isDefault: true }));
  const prompt = providers.create(providerInput("prompt", ["prompt-first", "prompt-default"], {
    defaultModel: "prompt-default",
  }));

  const selected = await selectedTargets(providers, storedPrompt(prompt, "removed-model"));

  assert.deepEqual(selected, [
    { provider: "prompt", model: "prompt-default" },
    { provider: "prompt", model: "prompt-default" },
  ]);
});

test("旧仓储替身没有窄项目解析方法时仍可安全使用 Prompt 选择", async () => {
  const prompt: LlmProvider = {
    id: 2,
    name: "prompt",
    label: "Prompt",
    kind: "custom",
    baseUrl: "https://prompt.example/v1",
    api: "openai-responses",
    models: ["prompt-default"],
    defaultModel: "prompt-default",
    isDefault: false,
    createdAt: 1,
    updatedAt: 1,
  };
  const legacy: LlmProviderRepository = {
    list: () => [],
    get: (id) => id === prompt.id ? prompt : undefined,
    findByName: () => undefined,
    create: () => prompt,
    update: () => prompt,
    remove: () => {},
    getDefault: () => undefined,
    setDefault: () => {},
    bindProject: () => {},
    unbindProject: () => {},
    listProjectBindings: () => [],
    resolveTarget: () => undefined,
  };

  const selected = await selectedTargets(legacy, storedPrompt(prompt));

  assert.deepEqual(selected, [
    { provider: "prompt", model: "prompt-default" },
    { provider: "prompt", model: "prompt-default" },
  ]);
});
