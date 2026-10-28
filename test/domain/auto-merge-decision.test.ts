import { test } from "node:test";
import assert from "node:assert/strict";
import { decideAutoMerge, type AutoMergeDecisionInput, type AutoMergePolicy } from "../../src/domain/review-task.ts";

const SHA = "a".repeat(40);
const REFS = { baseSha: "b".repeat(40), startSha: "c".repeat(40), headSha: SHA };
const policy: AutoMergePolicy = {
  enabled: true,
  minimumScore: 90,
  targetBranches: ["main", "release"],
  method: "squash",
  removeSourceBranch: true,
};

function eligible(overrides: Partial<AutoMergeDecisionInput> = {}): AutoMergeDecisionInput {
  return {
    policy,
    currentPolicy: policy,
    score: 95,
    skippedBatches: 0,
    expectedBatchCount: 2,
    structuredBatchCount: 2,
    structuredHeadShas: [SHA, SHA],
    mergeGateCount: 2,
    mergeGateMaxSeverities: ["medium", "low"],
    mergeGateBlockingFindings: 0,
    severities: ["medium", "low"],
    versionSnapshotLocked: true,
    inlinePublishFailed: 0,
    finalComment: "总分：95 分\n\n可以合入。",
    reviewedHeadSha: SHA,
    currentHeadSha: SHA,
    reviewedRefs: REFS,
    currentRefs: REFS,
    currentState: "opened",
    reviewedTargetBranch: "main",
    currentTargetBranch: "main",
    ...overrides,
  };
}

test("所有安全条件满足时给出带 sha 的 squash 合并命令", () => {
  assert.deepEqual(decideAutoMerge(eligible()), {
    allowed: true,
    command: { sha: SHA, method: "squash", removeSourceBranch: true },
  });
});

test("critical/high 为固定阻断，大小写也不能绕过", () => {
  for (const severity of ["critical", "high", "HIGH"]) {
    const result = decideAutoMerge(eligible({ severities: [severity] }));
    assert.deepEqual(result, { allowed: false, reason: "blocking-finding" });
  }
});

test("缺分、低于门槛、跳批、非结构化批次或空最终评论均阻断", () => {
  const cases: Array<[Partial<AutoMergeDecisionInput>, string]> = [
    [{ score: null }, "score-missing"],
    [{ score: 89 }, "score-below-threshold"],
    [{ skippedBatches: 1 }, "batch-skipped"],
    [{ skippedBatches: -1 }, "batch-skipped"],
    [{ skippedBatches: 0.5 }, "batch-skipped"],
    [{ structuredBatchCount: 1 }, "structured-output-incomplete"],
    [{ structuredHeadShas: [SHA, "b".repeat(40)] }, "structured-output-incomplete"],
    [{ mergeGateCount: 1 }, "merge-gate-incomplete"],
    [{ versionSnapshotLocked: false }, "review-snapshot-unlocked"],
    [{ inlinePublishFailed: 1 }, "inline-publish-failed"],
    [{ inlinePublishFailed: -1 }, "inline-publish-failed"],
    [{ inlinePublishFailed: 0.5 }, "inline-publish-failed"],
    [{ finalComment: "   " }, "final-comment-missing"],
  ];
  for (const [patch, reason] of cases) {
    assert.deepEqual(decideAutoMerge(eligible(patch)), { allowed: false, reason });
  }
});

test("merge_gate 覆盖无锚点问题，high/critical 或 positive blocking 固定阻断", () => {
  const cases: Partial<AutoMergeDecisionInput>[] = [
    { mergeGateMaxSeverities: ["high", "low"] },
    { mergeGateMaxSeverities: ["critical", "none"] },
    { mergeGateBlockingFindings: 1 },
  ];
  for (const patch of cases) {
    assert.deepEqual(decideAutoMerge(eligible(patch)), { allowed: false, reason: "blocking-finding" });
  }
});

test("refs、当前 opened 状态、head 与精确目标分支均须在合并前复核", () => {
  const cases: Array<[Partial<AutoMergeDecisionInput>, string]> = [
    [{ reviewedHeadSha: "" }, "review-version-missing"],
    [{ currentState: "closed" }, "merge-request-not-open"],
    [{ currentState: "other" }, "merge-request-not-open"],
    [{ currentHeadSha: "d".repeat(40) }, "head-changed"],
    [{ reviewedRefs: undefined }, "diff-refs-missing"],
    [{ currentRefs: undefined }, "diff-refs-missing"],
    [{ currentRefs: { ...REFS, baseSha: "d".repeat(40) } }, "diff-refs-changed"],
    [{ currentRefs: { ...REFS, startSha: "d".repeat(40) } }, "diff-refs-changed"],
    [{ reviewedTargetBranch: undefined }, "target-branch-missing"],
    [{ currentTargetBranch: undefined }, "target-branch-missing"],
    [{ currentTargetBranch: "release" }, "target-branch-changed"],
    [{ reviewedTargetBranch: "Main", currentTargetBranch: "Main" }, "target-branch-not-allowed"],
    [{ reviewedTargetBranch: "feature/main", currentTargetBranch: "feature/main" }, "target-branch-not-allowed"],
  ];
  for (const [patch, reason] of cases) {
    assert.deepEqual(decideAutoMerge(eligible(patch)), { allowed: false, reason });
  }
});

test("关闭、撤销、变更或非法策略安全阻断，不猜测合并方式", () => {
  assert.deepEqual(decideAutoMerge(eligible({ policy: { ...policy, enabled: false } })), { allowed: false, reason: "disabled" });
  assert.deepEqual(decideAutoMerge(eligible({ currentPolicy: { ...policy, enabled: false } })), { allowed: false, reason: "policy-revoked" });
  assert.deepEqual(decideAutoMerge(eligible({ currentPolicy: { ...policy, minimumScore: 96 } })), { allowed: false, reason: "policy-changed" });
  assert.deepEqual(decideAutoMerge(eligible({ currentPolicy: { ...policy, targetBranches: ["release", "main"] } })).allowed, true, "仅重排分支不算策略变化");
  assert.deepEqual(decideAutoMerge(eligible({ policy: { ...policy, minimumScore: 0 } })), { allowed: false, reason: "invalid-policy" });
  assert.deepEqual(decideAutoMerge(eligible({ policy: { ...policy, minimumScore: 101 } })), { allowed: false, reason: "invalid-policy" });
  assert.deepEqual(decideAutoMerge(eligible({ policy: { ...policy, targetBranches: ["main", "main"] } })), { allowed: false, reason: "invalid-policy" });
  assert.deepEqual(decideAutoMerge(eligible({ policy: { ...policy, method: "rebase" as "merge" } })), { allowed: false, reason: "invalid-policy" });
});
