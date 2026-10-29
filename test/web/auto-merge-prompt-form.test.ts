import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPromptPayload,
  canEnableAutoMerge,
  canUseAutoMergeTargetBranch,
  createPromptDraft,
  projectKey,
  summarizeAutoMergeConfirmation,
  synchronizeProjectSettings,
  validatePromptDraft,
} from "../../web/src/views/prompt-form.ts";
import type { ProjectAutoMergePolicy, ProjectReviewSetting, StoredPrompt } from "../../web/src/types.ts";

const detail: StoredPrompt = {
  id: 1,
  repository: "rules",
  projects: ["group/app", "group/api"],
  systemPrompt: "system",
  userPrompt: "user",
  projectSettings: [
    { project: "group/app", repositoryContextEnabled: false },
    {
      project: "group/api",
      repositoryContextEnabled: true,
      autoMergePolicy: {
        enabled: true,
        minimumScore: 90,
        targetBranches: ["main"],
        method: "squash",
        removeSourceBranch: false,
      },
    },
  ],
  updatedAt: 1,
};

test("自动合并默认关闭，dirty-only 与仓库上下文合并为同一项目 patch", () => {
  const draft = createPromptDraft(detail);
  const appKey = projectKey("group/app");
  assert.equal(draft.autoMergeKnown[appKey], true);
  const expectedDefault: ProjectAutoMergePolicy = {
    enabled: false,
    minimumScore: 100,
    targetMode: "default",
    targetBranches: [],
    method: "merge",
    removeSourceBranch: false,
  };
  assert.deepEqual(draft.autoMergePolicies[appKey], expectedDefault);
  assert.deepEqual(buildPromptPayload(draft).project_settings, []);

  draft.projectStates[appKey] = true;
  draft.autoMergePolicies[appKey].enabled = true;
  draft.autoMergePolicies[appKey].targetMode = "specified";
  draft.autoMergePolicies[appKey].targetBranches = [" main ", "release", "main"];
  assert.deepEqual(buildPromptPayload(draft).project_settings, [{
    project: "group/app",
    repository_context_enabled: true,
    auto_merge_policy: {
      enabled: true,
      minimum_score: 100,
      target_mode: "specified",
      target_branches: ["main", "release"],
      method: "merge",
      remove_source_branch: false,
    },
  }]);
});

test("只改自动合并策略时不携带仓库上下文；default 永远不提交项目策略", () => {
  const draft = createPromptDraft(detail);
  const key = projectKey("group/api");
  assert.equal(draft.autoMergePolicies[key].targetMode, "specified", "旧响应有分支时按 specified 兼容");
  draft.autoMergePolicies[key].minimumScore = 95;
  const [patch] = buildPromptPayload(draft).project_settings;
  assert.deepEqual(patch, {
    project: "group/api",
    auto_merge_policy: {
      enabled: true,
      minimum_score: 95,
      target_mode: "specified",
      target_branches: ["main"],
      method: "squash",
      remove_source_branch: false,
    },
  });
  assert.equal("repository_context_enabled" in patch, false);

  draft.repository = "default";
  assert.deepEqual(buildPromptPayload(draft).project_settings, []);
});

test("meta 失败时新项目保持未知且不提交；重试只初始化未知状态", () => {
  const draft = createPromptDraft(detail);
  const appKey = projectKey("group/app");
  draft.autoMergePolicies[appKey].minimumScore = 80;
  draft.projects.push("group/new");
  synchronizeProjectSettings(draft);
  const newKey = projectKey("group/new");
  assert.equal(draft.projectStates[newKey], undefined);
  assert.equal(draft.autoMergeKnown[newKey], false);
  assert.deepEqual(buildPromptPayload(draft).project_settings, [{
    project: "group/app",
    auto_merge_policy: {
      enabled: false,
      minimum_score: 80,
      target_mode: "default",
      target_branches: [],
      method: "merge",
      remove_source_branch: false,
    },
  }]);

  const metadata: ProjectReviewSetting[] = [{
    project: "group/new",
    repositoryContextEnabled: true,
    autoMergePolicy: {
      enabled: true,
      minimumScore: 92,
      targetBranches: ["stable"],
      method: "merge",
      removeSourceBranch: false,
    },
  }];
  synchronizeProjectSettings(draft, metadata);
  assert.equal(draft.autoMergeKnown[newKey], true);
  assert.equal(draft.autoMergePolicies[newKey].targetMode, "specified");
  assert.equal(draft.autoMergePolicies[newKey].minimumScore, 92);
  assert.equal(draft.autoMergePolicies[appKey].minimumScore, 80, "meta 刷新不能覆盖用户已修改策略");
});

test("自动合并仅允许完整项目路径，且启用策略需合法门槛与目标分支", () => {
  assert.equal(canEnableAutoMerge("group/app"), true);
  assert.equal(canEnableAutoMerge("group/sub/app"), true);
  for (const project of ["auto-ops", "group/../app", "group//app", "https://git/a/b"]) {
    assert.equal(canEnableAutoMerge(project), false);
  }
  for (const branch of ["main", "release/1.0", "feature/topic"]) assert.equal(canUseAutoMergeTargetBranch(branch), true);
  for (const branch of ["", "feature/*", "-main", ".hidden/main", "main.lock", "a//b", "a..b", "a@{b"]) {
    assert.equal(canUseAutoMergeTargetBranch(branch), false, `${branch} 应与后端一致被拒绝`);
  }

  const draft = createPromptDraft({ ...detail, projects: ["auto-ops", "group/app"] });
  synchronizeProjectSettings(draft, []);
  const shortKey = projectKey("auto-ops");
  draft.autoMergePolicies[shortKey].enabled = true;
  draft.autoMergePolicies[shortKey].targetMode = "specified";
  draft.autoMergePolicies[shortKey].targetBranches = ["main"];
  assert.match(validatePromptDraft(draft).map(item => item.message).join("\n"), /完整的 namespace\/project/);

  draft.projects = ["group/app"];
  synchronizeProjectSettings(draft, []);
  const key = projectKey("group/app");
  draft.autoMergePolicies[key] = { enabled: true, minimumScore: 0, targetMode: "specified", targetBranches: [], method: "merge", removeSourceBranch: false };
  let messages = validatePromptDraft(draft).map(item => item.message).join("\n");
  assert.match(messages, /1 到 100/);
  assert.match(messages, /目标分支/);
  draft.autoMergePolicies[key].minimumScore = 101;
  draft.autoMergePolicies[key].targetBranches = ["main"];
  messages = validatePromptDraft(draft).map(item => item.message).join("\n");
  assert.match(messages, /1 到 100/);
  draft.autoMergePolicies[key].minimumScore = 100;
  draft.autoMergePolicies[key].targetBranches = ["feature/*"];
  messages = validatePromptDraft(draft).map(item => item.message).join("\n");
  assert.match(messages, /GitLab 不接受/);

  for (const targetMode of ["default", "any"] as const) {
    draft.autoMergePolicies[key].targetMode = targetMode;
    draft.autoMergePolicies[key].targetBranches = [];
    messages = validatePromptDraft(draft).map(item => item.message).join("\n");
    assert.doesNotMatch(messages, /目标分支|GitLab 不接受/, `${targetMode} 不要求填写分支`);
  }
});

test("任一最终启用项目都要求 User Prompt 含 diffs_text，关闭后允许普通模板", () => {
  const draft = createPromptDraft(detail);
  let placeholderErrors = validatePromptDraft(draft).filter((item) => item.message.includes("diffs_text"));
  assert.deepEqual(placeholderErrors, [{
    field: "userPrompt",
    group: "prompt",
    message: "启用自动合并时 User Prompt 必须包含 {diffs_text} 占位符",
  }]);

  draft.userPrompt = "评审 {diffs_text}";
  assert.equal(validatePromptDraft(draft).some((item) => item.message.includes("diffs_text")), false);

  draft.userPrompt = "普通评审模板";
  for (const project of draft.projects) {
    draft.autoMergePolicies[projectKey(project)].enabled = false;
  }
  placeholderErrors = validatePromptDraft(draft).filter((item) => item.message.includes("diffs_text"));
  assert.deepEqual(placeholderErrors, [], "最终全部关闭时可移除占位符");
});

test("确认摘要只包含首次启用、删除源分支与新切换任意目标的项目", () => {
  const draft = createPromptDraft(detail);
  const appKey = projectKey("group/app");
  const apiKey = projectKey("group/api");
  draft.autoMergePolicies[appKey].enabled = true;
  draft.autoMergePolicies[appKey].targetBranches = ["main"];
  draft.autoMergePolicies[apiKey].removeSourceBranch = true;
  assert.deepEqual(summarizeAutoMergeConfirmation(draft), {
    enabledProjects: ["group/app"],
    removeSourceBranchProjects: ["group/api"],
    anyTargetProjects: [],
  });
  draft.originalAutoMergePolicies[appKey] = structuredClone(draft.autoMergePolicies[appKey]);
  draft.originalAutoMergePolicies[apiKey] = structuredClone(draft.autoMergePolicies[apiKey]);
  assert.deepEqual(summarizeAutoMergeConfirmation(draft), { enabledProjects: [], removeSourceBranchProjects: [], anyTargetProjects: [] });

  draft.autoMergePolicies[apiKey].targetMode = "any";
  draft.autoMergePolicies[apiKey].targetBranches = [];
  assert.deepEqual(summarizeAutoMergeConfirmation(draft), {
    enabledProjects: [],
    removeSourceBranchProjects: [],
    anyTargetProjects: ["group/api"],
  });
});
