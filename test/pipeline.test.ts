import { test } from "node:test";
import assert from "node:assert/strict";
import { createReviewPipeline, estimateTokens, splitChangesIntoBatches, type MergeRequestTask } from "../src/pipeline.ts";
import type { Change } from "../src/gitlab-client.ts";
import type { GitlabClient } from "../src/gitlab-client.ts";
import { createSilentLogger } from "../src/logger.ts";
import type { ReviewRules } from "../src/rules.ts";
import type { Reviewer } from "../src/reviewer.ts";

function change(diff: string, newPath = "a.ts"): Change {
  return { newPath, oldPath: newPath, diff };
}

test("estimateTokens 按字符数/4 向上取整", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("abc"), 1);
  assert.equal(estimateTokens("abcdefgh"), 2);
});

test("小变更保持单批", () => {
  const batches = splitChangesIntoBatches([change("diff".repeat(10))], 6000, 100);
  assert.equal(batches.length, 1);
});

test("超过预算的多个变更拆成多批，且每批不超阈值", () => {
  const big = "x".repeat(4000); // ≈1000 tokens；单行超阈值时会按字符再拆
  const changes = [change(big, "a.ts"), change(big, "b.ts"), change(big, "c.ts")];
  const batches = splitChangesIntoBatches(changes, 1200, 100); // 阈值 = 1200*0.85-100 = 920 tokens
  assert.ok(batches.length > 3);
  for (const batch of batches) {
    const totalTokens = batch.reduce((sum, c) => sum + estimateTokens(c.diff), 0);
    assert.ok(totalTokens <= 920, `批过大：${totalTokens} tokens`);
  }
});

test("单文件超预算时按 diff 行拆分，且每批不超阈值", () => {
  const lines = Array.from({ length: 8 }, (_, i) => `+line-${i}-${"y".repeat(200)}`);
  const diff = lines.join("\n");
  const batches = splitChangesIntoBatches([change(diff, "big.ts")], 600, 100); // 阈值 = 410 tokens
  assert.ok(batches.length > 1);
  for (const batch of batches) {
    const totalTokens = batch.reduce((sum, c) => sum + estimateTokens(c.diff), 0);
    assert.ok(totalTokens <= 410, `批过大：${totalTokens} tokens`);
  }
});

test("拆分后每批保留文件路径", () => {
  const lines = Array.from({ length: 6 }, (_, i) => `+line-${i}-${"y".repeat(200)}`);
  const batches = splitChangesIntoBatches([change(lines.join("\n"), "keep/me.ts")], 600, 100);
  for (const batch of batches) {
    for (const item of batch) {
      assert.equal(item.newPath, "keep/me.ts");
    }
  }
});

// ============ backend-006：编排 ============

interface FakeClient extends GitlabClient {
  notes: string[];
}

function fakeClient(overrides: Partial<GitlabClient> = {}): FakeClient {
  const notes: string[] = [];
  return {
    getMergeRequestChanges: async () => [{ newPath: "a.ts", oldPath: "a.ts", diff: "diff-a" }],
    getMergeRequestCommits: async () => [{ id: "c1", message: "feat: x" }],
    postMergeRequestNote: async (_p, _i, body) => {
      notes.push(body);
    },
    ...overrides,
    notes,
  };
}

const ruleSet = { systemPrompt: "SYS", userPrompt: "评：{diffs_text}" };
const rules = {
  resolve: () => ruleSet,
} as ReviewRules;

const task: MergeRequestTask = {
  projectId: 1,
  iid: 2,
  fullName: "team/app",
  sourceBranch: "dev",
  targetBranch: "main",
};

test("pipeline 拉取、逐批评审、汇总并回写", async () => {
  const client = fakeClient();
  const prompts: string[] = [];
  const reviewer: Reviewer = {
    review: async ({ systemPrompt, code }) => {
      // 批调用 systemPrompt 是原始规则；汇总调用带后缀，这里只记录不逐一断言
      assert.ok(systemPrompt.startsWith("SYS"));
      prompts.push(code);
      return { text: "批评论", model: "m" };
    },
  };
  const pipeline = createReviewPipeline({
    client,
    rules,
    reviewer,
    logger: createSilentLogger(),
    batchMaxTokens: 6000,
  });
  await pipeline.run(task);
  // 1 批评审 + 1 次汇总 = 2 次 review 调用
  assert.equal(prompts.length, 2);
  assert.match(prompts[0], /diff-a/);
  assert.match(prompts[1], /批评论/); // 汇总输入含各批结果
  assert.equal(client.notes.length, 1);
  assert.match(client.notes[0], /批评论/);
});

test("多批时逐批评审且按序汇总", async () => {
  const changes: Change[] = [
    { newPath: "a.ts", oldPath: "a.ts", diff: "A".repeat(5000) },
    { newPath: "b.ts", oldPath: "b.ts", diff: "B".repeat(5000) },
  ];
  const client = fakeClient({ getMergeRequestChanges: async () => changes });
  const prompts: string[] = [];
  const reviewer: Reviewer = {
    review: async ({ code }) => {
      prompts.push(code);
      // 汇总调用是最后一次，其文本是各批结果的拼接
      return { text: `评论${prompts.length}`, model: "m" };
    },
  };
  const pipeline = createReviewPipeline({
    client,
    rules,
    reviewer,
    logger: createSilentLogger(),
    batchMaxTokens: 1200, // 每个文件 5000 字符 ≈ 1250 tokens，超过阈值，会拆批
  });
  await pipeline.run(task);
  const batchCalls = prompts.slice(0, -1);
  const summaryCall = prompts[prompts.length - 1];
  assert.ok(batchCalls.length >= 2, "应至少 2 批");
  assert.match(summaryCall, /评论1/); // 汇总输入按批序含第一批结果
  assert.equal(client.notes.length, 1);
});

test("拉取失败不抛异常、不回写", async () => {
  const client = fakeClient({
    getMergeRequestChanges: async () => {
      throw new Error("boom");
    },
  });
  const pipeline = createReviewPipeline({
    client,
    rules,
    reviewer: { review: async () => ({ text: "x", model: "m" }) },
    logger: createSilentLogger(),
    batchMaxTokens: 6000,
  });
  await assert.doesNotReject(() => pipeline.run(task));
  assert.equal(client.notes.length, 0);
});

test("单批评审失败不回写", async () => {
  const client = fakeClient();
  const pipeline = createReviewPipeline({
    client,
    rules,
    reviewer: {
      review: async () => {
        throw new Error("boom");
      },
    },
    logger: createSilentLogger(),
    batchMaxTokens: 6000,
  });
  await assert.doesNotReject(() => pipeline.run(task));
  assert.equal(client.notes.length, 0);
});
