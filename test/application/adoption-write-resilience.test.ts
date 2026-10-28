import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createReviewPipeline,
  type PendingFinding,
} from "../../src/application/review-pipeline.ts";
import { fingerprintLine } from "../../src/domain/review-finding.ts";
import type { ReviewRecord } from "../../src/domain/review-record.ts";
import type { GitlabClient, MergeRequestTask } from "../../src/domain/review-task.ts";
import { createSilentLogger } from "../../src/shared/logger.ts";

const HEAD_SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);
const START_SHA = "c".repeat(40);
const DIFF = "@@ -0,0 +1,2 @@\n+const stable = true;\n+return stable;";
const WAF_ERROR = "GitLab 汇总评论写入失败：WAF 拦截（synthetic-request-id）";

const task: MergeRequestTask = {
  projectId: 41,
  iid: 17,
  fullName: "fixture/adoption-resilience",
  sourceBranch: "feature/adoption-resilience",
  targetBranch: "main",
  gitlabUrl: "https://gitlab.example.invalid",
};

interface FixtureFinding {
  id: string;
  severity: "high" | "medium";
  path: string;
  new_line: number;
  body: string;
}

/** 运行真实管线，只把模型、GitLab 与持久化边界替换成确定性内存替身。 */
function resilienceHarness(input: {
  findings: FixtureFinding[];
  summary: string;
  discussionFails?: boolean;
}) {
  const discussionAttempts: string[] = [];
  const noteAttempts: string[] = [];
  const records: Array<{ id: number; value: ReviewRecord }> = [];
  const savedFindings: PendingFinding[] = [];
  let reviewCalls = 0;

  const client: GitlabClient = {
    getMergeRequestChanges: async () => [{ newPath: "src/example.ts", oldPath: "src/example.ts", diff: DIFF }],
    getMergeRequestCommits: async () => [],
    getMergeRequestVersions: async () => ({ baseSha: BASE_SHA, startSha: START_SHA, headSha: HEAD_SHA }),
    getDiscussions: async () => [],
    postDiscussion: async (_projectId, _iid, body) => {
      discussionAttempts.push(body);
      if (input.discussionFails) throw new Error("synthetic inline publication failure");
      return { id: "discussion-17", notes: [{ id: 91, body }] };
    },
    postMergeRequestNote: async (_projectId, _iid, body) => {
      noteAttempts.push(body);
      throw new Error(WAF_ERROR);
    },
    getLatestHeadSha: async () => HEAD_SHA,
    getFileRaw: async () => "const stable = true;\nreturn stable;\n",
    getUser: async (id) => ({ id, name: "Fixture Author", username: "fixture-author" }),
  };

  const batchOutput = JSON.stringify({
    reviewed_head_sha: HEAD_SHA,
    summary: { body: "总分：80 分" },
    findings: input.findings,
  });
  const pipeline = createReviewPipeline({
    isProjectAllowed: () => true,
    client,
    rules: { resolve: () => ({ systemPrompt: "fixture-system", userPrompt: "Review {diffs_text}" }) },
    reviewer: {
      review: async () => {
        const text = reviewCalls === 0 ? batchOutput : input.summary;
        reviewCalls += 1;
        return { text, model: "fixture-model" };
      },
    },
    logger: createSilentLogger(),
    batchMaxTokens: 6000,
    recordWriter: {
      insert: (record) => {
        const id = 700 + records.length;
        records.push({ id, value: record });
        return id;
      },
    },
    findingWriter: { insert: (finding) => savedFindings.push(finding) },
  });

  return {
    pipeline,
    discussionAttempts,
    noteAttempts,
    records,
    savedFindings,
    reviewCalls: () => reviewCalls,
  };
}

/** 统计正文片段出现次数，用于证明失败路径没有重复发布同一问题。 */
function occurrences(text: string, fragment: string): number {
  return text.split(fragment).length - 1;
}

test("行内 finding 已发布后汇总评论被 WAF 拦截，仍关联失败记录写入采纳明细", async () => {
  const body = "已发布的问题只应保留在行内讨论";
  const harness = resilienceHarness({
    findings: [{ id: "published", severity: "high", path: "src/example.ts", new_line: 2, body }],
    summary: `总分：80 分\n${body}\n保留汇总结论`,
  });

  await harness.pipeline.run(task);

  assert.equal(harness.reviewCalls(), 2, "单批评审与汇总各调用一次模型");
  assert.equal(harness.discussionAttempts.length, 1, "行内评论不得因后续 WAF 错误重发");
  assert.equal(harness.noteAttempts.length, 1, "汇总评论失败后不得重试造成重复评论");
  assert.equal(occurrences(harness.discussionAttempts[0], body), 1);
  assert.equal(occurrences(harness.noteAttempts[0], body), 0, "已发行内 finding 必须从汇总中剔除");

  assert.equal(harness.records.length, 1);
  const failedRecord = harness.records[0];
  assert.equal(failedRecord.value.result, "failed");
  assert.match(failedRecord.value.errorMessage ?? "", /WAF/);

  assert.equal(harness.savedFindings.length, 1, "最终汇总失败不能丢掉已产生的行内建议");
  const saved = harness.savedFindings[0];
  assert.equal(saved.recordId, failedRecord.id, "建议必须关联同一次失败记录");
  assert.equal(saved.codeFingerprint, fingerprintLine("return stable;"));
  assert.notEqual(saved.codeFingerprint, "");
  assert.equal(saved.discussionId, "discussion-17");
  assert.equal(saved.noteId, 91);
  assert.equal(saved.outcome, "pending");
});

test("汇总评论失败时，未发布与纯降级 finding 仍沿用既有指纹语义且不重复尝试", async () => {
  const unpublishedBody = "位置合法但行内发布失败";
  const fallbackBody = "行号不在 diff 中的纯降级问题";
  const harness = resilienceHarness({
    findings: [
      { id: "unpublished", severity: "high", path: "src/example.ts", new_line: 1, body: unpublishedBody },
      { id: "fallback", severity: "medium", path: "src/example.ts", new_line: 99, body: fallbackBody },
    ],
    summary: "总分：75 分\n保留汇总结论",
    discussionFails: true,
  });

  await harness.pipeline.run(task);

  assert.equal(harness.discussionAttempts.length, 1, "只有位置合法项尝试一次行内发布");
  assert.equal(harness.noteAttempts.length, 1, "两个降级项只合并进同一条汇总评论");
  assert.equal(occurrences(harness.noteAttempts[0], unpublishedBody), 1);
  assert.equal(occurrences(harness.noteAttempts[0], fallbackBody), 1);
  assert.equal(harness.records.length, 1);
  assert.equal(harness.records[0].value.result, "failed");

  assert.equal(harness.savedFindings.length, 2);
  const unpublished = harness.savedFindings.find((finding) => finding.findingId === "unpublished");
  const fallback = harness.savedFindings.find((finding) => finding.findingId === "fallback");
  assert.ok(unpublished);
  assert.ok(fallback);
  assert.equal(unpublished.recordId, harness.records[0].id);
  assert.equal(unpublished.codeFingerprint, fingerprintLine("const stable = true;"), "发布失败但位置合法仍可追踪");
  assert.equal(unpublished.discussionId, null);
  assert.equal(unpublished.noteId, null);
  assert.equal(fallback.recordId, harness.records[0].id);
  assert.equal(fallback.codeFingerprint, "", "纯降级项没有行锚点");
  assert.equal(fallback.discussionId, null);
  assert.equal(fallback.noteId, null);
});
