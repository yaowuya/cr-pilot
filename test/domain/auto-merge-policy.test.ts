import { test } from "node:test";
import assert from "node:assert/strict";
import {
  defaultProjectAutoMergePolicy,
  PromptValidationError,
  validateProjectSettings,
  type ProjectReviewSettingPatch,
} from "../../src/domain/review-prompt.ts";

const enabledPolicy = {
  enabled: true,
  minimumScore: 92,
  targetBranches: ["main", "release/2026-Q4"],
  method: "squash" as const,
  removeSourceBranch: true,
};

/** 自动合并默认关闭且每次返回独立数组，调用方不得串改全局默认值。 */
test("项目自动合并默认值安全关闭", () => {
  const first = defaultProjectAutoMergePolicy();
  assert.deepEqual(first, {
    enabled: false,
    minimumScore: 100,
    targetBranches: [],
    method: "merge",
    removeSourceBranch: false,
  });
  first.targetBranches.push("main");
  assert.deepEqual(defaultProjectAutoMergePolicy().targetBranches, []);
});

test("项目设置支持仓库上下文和自动合并独立部分更新", () => {
  const patches: ProjectReviewSettingPatch[] = [
    { project: "group/app", autoMergePolicy: enabledPolicy },
    { project: "legacy-short", repositoryContextEnabled: true },
  ];
  assert.deepEqual(validateProjectSettings(patches, ["group/app", "legacy-short"], "rules"), patches);
});

test("自动合并只允许完整项目路径，启用时目标分支至少一项且分支精确去重", () => {
  const invalid: Array<[ProjectReviewSettingPatch, RegExp]> = [
    [{ project: "app", autoMergePolicy: enabledPolicy }, /完整.*namespace\/project|完整项目/],
    [{ project: "group/app", autoMergePolicy: { ...enabledPolicy, targetBranches: [] } }, /目标分支/],
    [{ project: "group/app", autoMergePolicy: { ...enabledPolicy, targetBranches: ["main", " main "] } }, /重复/],
    [{ project: "group/app", autoMergePolicy: { ...enabledPolicy, targetBranches: ["main", " "] } }, /非空/],
    ...["feature bad", "topic..bad", "@{bad", "/main", "main/", "a//b", "main.", "-main", "a~b", "a^b", "a:b", "a?b", "a*b", "a[b", "a\\b", ".hidden/main", "main.lock"].map(
      (branch) => [{ project: "group/app", autoMergePolicy: { ...enabledPolicy, targetBranches: [branch] } }, /格式非法/] as [ProjectReviewSettingPatch, RegExp],
    ),
    [{ project: "group/app", autoMergePolicy: { ...enabledPolicy, minimumScore: 0 } }, /1.*100/],
    [{ project: "group/app", autoMergePolicy: { ...enabledPolicy, minimumScore: 50.5 } }, /整数/],
    [{ project: "group/app", autoMergePolicy: { ...enabledPolicy, method: "rebase" as "merge" } }, /merge.*squash/],
    [{ project: "group/app", autoMergePolicy: { ...enabledPolicy, removeSourceBranch: "yes" as unknown as boolean } }, /布尔/],
    [{ project: "group/app" }, /至少包含一个/],
  ];
  for (const [patch, expected] of invalid) {
    assert.throws(
      () => validateProjectSettings([patch], [patch.project], "rules"),
      (error) => error instanceof PromptValidationError && expected.test(error.message),
      JSON.stringify(patch),
    );
  }
});

test("关闭策略可保留精确目标分支，但 default 不能配置任何项目设置", () => {
  const patch: ProjectReviewSettingPatch = {
    project: "short-name",
    autoMergePolicy: { ...enabledPolicy, enabled: false, targetBranches: ["Main", "main"] },
  };
  assert.deepEqual(validateProjectSettings([patch], ["short-name"], "rules"), [patch], "分支名大小写敏感");
  assert.throws(() => validateProjectSettings([patch], ["short-name"], "default"), /default/);
});
