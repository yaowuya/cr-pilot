import { test } from "node:test";
import assert from "node:assert/strict";
import { createReviewPipeline, type MergeRequestTask } from "../../src/application/review-pipeline.ts";
import { estimateTokens, splitChangesIntoBatches } from "../../src/domain/change.ts";
import { stripMarkdownFences } from "../../src/domain/review-rules.ts";
import type { Change } from "../../src/domain/review-task.ts";
import type { GitlabClient } from "../../src/domain/review-task.ts";
import type { ReviewRecord } from "../../src/domain/review-record.ts";
import type { PromptRepository } from "../../src/domain/review-prompt.ts";
import { createSilentLogger } from "../../src/shared/logger.ts";
import type { ReviewRules } from "../../src/infrastructure/rules/review-rules.ts";
import type { Reviewer } from "../../src/infrastructure/pi/reviewer.ts";

function change(diff: string, newPath = "a.ts"): Change {
  return { newPath, oldPath: newPath, diff };
}

test("estimateTokens 按字符数/4 向上取整", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("abc"), 1);
  assert.equal(estimateTokens("abcdefgh"), 2);
});

test("stripMarkdownFences 剥离首尾成对的代码块包裹", () => {
  const fenced = "```markdown\n## 问题清单\n- [严重] x\n\n## 结论\n\n不适合合入。\n```";
  assert.equal(stripMarkdownFences(fenced), "## 问题清单\n- [严重] x\n\n## 结论\n\n不适合合入。");
});

test("stripMarkdownFences 对纯 Markdown 原样返回", () => {
  const plain = "## 问题清单\n\n- [严重] 位置：描述\n\n## 结论\n\n可以合入。";
  assert.equal(stripMarkdownFences(plain), plain);
});

test("stripMarkdownFences 处理无语言标记的围栏", () => {
  const fenced = "```\n正文内容\n```";
  assert.equal(stripMarkdownFences(fenced), "正文内容");
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
    // 默认给出行内评论相关方法的可用替身：既有用例不关心行内评论，缺省实现让
    // 管线走「全部 finding 降级进汇总」的路径（版本查询返回空 SHA 会整体降级）。
    getMergeRequestVersions: async () => ({ baseSha: "b", startSha: "s", headSha: "h" }),
    postDiscussion: async () => ({ id: "d", notes: [] }),
    getDiscussions: async () => [],
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

test("汇总输出带代码块包裹时，回写前剥离围栏", async () => {
  const client = fakeClient();
  const pipeline = createReviewPipeline({
    client,
    rules,
    reviewer: {
      // 批评审返回普通文本；汇总返回被 ```markdown 包裹的最终评论。
      review: async ({ systemPrompt }) => ({
        text: systemPrompt.includes("合并") ? "```markdown\n## 问题清单\n- [一般] a\n\n## 结论\n\n可合入。\n```" : "批评论",
        model: "m",
      }),
    },
    logger: createSilentLogger(),
    batchMaxTokens: 6000,
  });
  await pipeline.run(task);
  assert.equal(client.notes.length, 1);
  assert.ok(!client.notes[0].includes("```"), "回写正文不应包含代码块围栏");
  assert.match(client.notes[0], /^## 问题清单/);
});

test("评分低于阈值且配置 webhook 时推送企微", async () => {
  const client = fakeClient();
  const sent: string[] = [];
  const wecomNotifier = {
    send: async (_url: string, markdown: string) => {
      sent.push(markdown);
    },
  };
  const wecomRules = {
    resolve: () => ({
      systemPrompt: "SYS",
      userPrompt: "评：{diffs_text}",
      wecomWebhookUrl: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=t",
      wecomScoreThreshold: 70,
    }),
  } as ReviewRules;
  const pipeline = createReviewPipeline({
    client,
    rules: wecomRules,
    reviewer: {
      // 汇总返回带总分的低分评审。
      review: async ({ systemPrompt }) => ({
        text: systemPrompt.includes("合并") ? "## 问题清单\n- [严重] x\n\n总分:65分" : "批评论",
        model: "m",
      }),
    },
    logger: createSilentLogger(),
    batchMaxTokens: 6000,
    wecomNotifier,
  });
  await pipeline.run(task);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /代码评审提醒/);
  assert.match(sent[0], /65 分/);
});

test("评分不低于阈值时不推送企微", async () => {
  const client = fakeClient();
  const sent: string[] = [];
  const wecomRules = {
    resolve: () => ({
      systemPrompt: "SYS",
      userPrompt: "评：{diffs_text}",
      wecomWebhookUrl: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=t",
      wecomScoreThreshold: 70,
    }),
  } as ReviewRules;
  const pipeline = createReviewPipeline({
    client,
    rules: wecomRules,
    reviewer: {
      review: async ({ systemPrompt }) => ({
        text: systemPrompt.includes("合并") ? "总分:85分" : "批评论",
        model: "m",
      }),
    },
    logger: createSilentLogger(),
    batchMaxTokens: 6000,
    wecomNotifier: { send: async (_url, markdown) => { sent.push(markdown); } },
  });
  await pipeline.run(task);
  assert.equal(sent.length, 0);
});

test("企微推送失败不影响评审回写", async () => {
  const client = fakeClient();
  const wecomRules = {
    resolve: () => ({
      systemPrompt: "SYS",
      userPrompt: "评：{diffs_text}",
      wecomWebhookUrl: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=t",
      wecomScoreThreshold: 70,
    }),
  } as ReviewRules;
  const pipeline = createReviewPipeline({
    client,
    rules: wecomRules,
    reviewer: {
      review: async ({ systemPrompt }) => ({
        text: systemPrompt.includes("合并") ? "总分:60分" : "批评论",
        model: "m",
      }),
    },
    logger: createSilentLogger(),
    batchMaxTokens: 6000,
    wecomNotifier: { send: async () => { throw new Error("网络错误"); } },
  });
  await assert.doesNotReject(() => pipeline.run(task));
  assert.equal(client.notes.length, 1);
});

// ============ backend-009：评审记录写入 ============

const headSha = "a".repeat(40);

/** 构造一个按批/汇总调用返回不同内容的 reviewer。 */
function reviewerReturning(batchText: string, summaryText: string): Reviewer {
  return {
    review: async ({ systemPrompt }) => ({
      text: systemPrompt.includes("合并") || systemPrompt.includes("汇总") ? summaryText : batchText,
      model: "m",
    }),
  };
}

test("评审成功时写入成功记录，含分数与文件数", async () => {
  const inserted: ReviewRecord[] = [];
  const pipeline = createReviewPipeline({
    client: fakeClient(),
    rules,
    reviewer: reviewerReturning("批评论", "总分：88 分"),
    logger: createSilentLogger(),
    batchMaxTokens: 6000,
    recordWriter: { insert: (record) => inserted.push(record) },
  });
  await pipeline.run({ ...task, committerName: "张三" });
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].result, "success");
  assert.equal(inserted[0].score, 88);
  assert.equal(inserted[0].committerName, "张三");
  assert.equal(inserted[0].changeCount, 1);
  assert.equal(inserted[0].batchCount, 1);
  assert.equal(inserted[0].errorMessage, null);
  assert.ok(inserted[0].finishedAt >= inserted[0].startedAt);
});

test("未解析出分数时 score 写 null 而非 0", async () => {
  const inserted: ReviewRecord[] = [];
  const pipeline = createReviewPipeline({
    client: fakeClient(),
    rules,
    reviewer: reviewerReturning("批评论", "本次评审未给出总分"),
    logger: createSilentLogger(),
    batchMaxTokens: 6000,
    recordWriter: { insert: (record) => inserted.push(record) },
  });
  await pipeline.run(task);
  assert.equal(inserted[0].score, null, "0 分会拉低平均分，必须用 null 表示缺失");
});

test("评审失败时仍写入失败记录且含错误原因", async () => {
  const inserted: ReviewRecord[] = [];
  const pipeline = createReviewPipeline({
    client: fakeClient(),
    rules,
    reviewer: { review: async () => { throw new Error("模型超时"); } },
    logger: createSilentLogger(),
    batchMaxTokens: 6000,
    recordWriter: { insert: (record) => inserted.push(record) },
  });
  await pipeline.run(task);
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].result, "failed");
  assert.equal(inserted[0].errorMessage, "模型超时");
});

test("拉取失败时写入失败记录", async () => {
  const inserted: ReviewRecord[] = [];
  const pipeline = createReviewPipeline({
    client: fakeClient({
      getMergeRequestChanges: async () => {
        throw new Error("GitLab 403");
      },
    }),
    rules,
    reviewer: reviewerReturning("x", "y"),
    logger: createSilentLogger(),
    batchMaxTokens: 6000,
    recordWriter: { insert: (record) => inserted.push(record) },
  });
  await pipeline.run(task);
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].result, "failed");
  assert.equal(inserted[0].errorMessage, "GitLab 403");
});

test("未注入 recordWriter 时管线行为不变", async () => {
  const pipeline = createReviewPipeline({
    client: fakeClient(),
    rules,
    reviewer: reviewerReturning("批评论", "总分：90 分"),
    logger: createSilentLogger(),
    batchMaxTokens: 6000,
  });
  await assert.doesNotReject(() => pipeline.run(task));
});

// ============ backend-010：prompt 数据库优先 ============

test("数据库命中 prompt 时不使用 yaml 规则", async () => {
  const used: string[] = [];
  const pipeline = createReviewPipeline({
    client: fakeClient(),
    rules: { resolve: () => ({ systemPrompt: "FROM-YAML", userPrompt: "u {diffs_text}" }) } as ReviewRules,
    promptSource: {
      resolve: () => ({ id: 1, repository: "team/app", systemPrompt: "FROM-DB", userPrompt: "u {diffs_text}", updatedAt: 1 }),
    } as unknown as PromptRepository,
    reviewer: {
      review: async ({ systemPrompt }) => {
        used.push(systemPrompt);
        return { text: "总分：90 分", model: "m" };
      },
    },
    logger: createSilentLogger(),
    batchMaxTokens: 6000,
  });
  await pipeline.run(task);
  assert.ok(used.length > 0);
  assert.ok(used.every((prompt) => prompt.includes("FROM-DB")), "数据库 prompt 必须优先于 yaml");
});

test("数据库未命中时回落 yaml 规则", async () => {
  const used: string[] = [];
  const pipeline = createReviewPipeline({
    client: fakeClient(),
    rules: { resolve: () => ({ systemPrompt: "FROM-YAML", userPrompt: "u {diffs_text}" }) } as ReviewRules,
    promptSource: { resolve: () => undefined } as unknown as PromptRepository,
    reviewer: {
      review: async ({ systemPrompt }) => {
        used.push(systemPrompt);
        return { text: "总分：90 分", model: "m" };
      },
    },
    logger: createSilentLogger(),
    batchMaxTokens: 6000,
  });
  await pipeline.run(task);
  assert.ok(used.some((prompt) => prompt.includes("FROM-YAML")));
});

// ============ backend-011 / backend-016：行内评论发布与降级 ============

/** 构造一个带行内评论能力的假客户端，记录发布的讨论。 */
function inlineClient(options: {
  diff: string;
  existingBodies?: string[];
  postFails?: (attemptIndex: number) => boolean;
  headSha?: string;
  /** 为 true 时 getMergeRequestVersions 抛错，用于验证「取不到 SHA 全量降级」。 */
  versionsFail?: boolean;
}) {
  const posted: { body: string; position: Record<string, unknown> }[] = [];
  const notes: string[] = [];
  const head = options.headSha ?? headSha;
  // 用独立的尝试计数器而不是 posted.length：失败的尝试不会入 posted，
  // 用它做判定会让后续每条都「失败」。
  let attempts = 0;
  const client = fakeClient({
    getMergeRequestChanges: async () => [{ newPath: "a.ts", oldPath: "a.ts", diff: options.diff }],
    getMergeRequestCommits: async () => [],
    getMergeRequestVersions: async () => {
      if (options.versionsFail) throw new Error("MR 没有 diff 版本");
      return { baseSha: "b", startSha: "s", headSha: head };
    },
    getDiscussions: async () => [{ id: "d0", notes: (options.existingBodies ?? []).map((body, index) => ({ id: index + 1, body })) }],
    postMergeRequestNote: async (_p, _i, body) => {
      notes.push(body);
    },
    postDiscussion: async (_p, _i, body, position) => {
      const current = attempts;
      attempts += 1;
      if (options.postFails?.(current)) throw new Error("GitLab 400 position invalid");
      posted.push({ body, position: position as unknown as Record<string, unknown> });
      return { id: `d${posted.length}`, notes: [{ id: posted.length, body }] };
    },
  });
  return { client, posted, notes };
}

/** 两行新增的 diff：合法 new_line 为 1、2。 */
const twoAddedLines = "@@ -0,0 +1,2 @@\n+one\n+two";

test("行内评论按 finding 逐条发布并带 marker", async () => {
  const { client, posted, notes } = inlineClient({ diff: twoAddedLines });
  const pipeline = createReviewPipeline({
    client,
    rules,
    reviewer: reviewerReturning(
      JSON.stringify({
        reviewed_head_sha: headSha,
        summary: { body: "总分：80 分" },
        findings: [{ id: "f1", severity: "high", path: "a.ts", new_line: 2, body: "第二条有问题" }],
      }),
      "总分：80 分",
    ),
    logger: createSilentLogger(),
    batchMaxTokens: 6000,
  });
  await pipeline.run(task);
  assert.equal(posted.length, 1);
  assert.match(posted[0].body, /第二条有问题/);
  assert.match(posted[0].body, new RegExp(`<!-- marker:${headSha}:f1 -->`));
  assert.equal(posted[0].position.new_line, 2);
  assert.equal(posted[0].position.position_type, "text");
});

test("行号不是 diff 变更行时并入汇总而不发行内评论", async () => {
  const { client, posted, notes } = inlineClient({ diff: twoAddedLines });
  const pipeline = createReviewPipeline({
    client,
    rules,
    reviewer: reviewerReturning(
      JSON.stringify({
        reviewed_head_sha: headSha,
        summary: { body: "总分：80 分" },
        findings: [{ id: "f1", severity: "high", path: "a.ts", new_line: 99, body: "越界行号" }],
      }),
      "总分：80 分",
    ),
    logger: createSilentLogger(),
    batchMaxTokens: 6000,
  });
  await pipeline.run(task);
  assert.equal(posted.length, 0, "越界行号不得发行内评论");
  assert.equal(notes.length, 1);
  assert.match(notes[0], /越界行号/, "无法定位的 finding 必须出现在汇总评论中");
  assert.match(notes[0], /无法定位到行的问题/);
});

test("评审 head 与当前 head 不一致时全部并入汇总", async () => {
  const stale = "c".repeat(40);
  const { client, posted, notes } = inlineClient({ diff: twoAddedLines });
  const pipeline = createReviewPipeline({
    client,
    rules,
    reviewer: reviewerReturning(
      JSON.stringify({
        reviewed_head_sha: stale,
        summary: { body: "总分：80 分" },
        findings: [{ id: "f1", severity: "low", path: "a.ts", new_line: 1, body: "过期评审" }],
      }),
      "总分：80 分",
    ),
    logger: createSilentLogger(),
    batchMaxTokens: 6000,
  });
  await pipeline.run(task);
  assert.equal(posted.length, 0, "head 不一致时不得发行内评论");
  assert.match(notes[0], /无法定位到行的问题/);
});

test("已存在同 marker 的讨论时跳过重复发布", async () => {
  const { client, posted, notes } = inlineClient({
    diff: twoAddedLines,
    existingBodies: [`旧内容\n\n<!-- marker:${headSha}:f1 -->`],
  });
  const pipeline = createReviewPipeline({
    client,
    rules,
    reviewer: reviewerReturning(
      JSON.stringify({
        reviewed_head_sha: headSha,
        summary: { body: "总分：80 分" },
        findings: [{ id: "f1", severity: "low", path: "a.ts", new_line: 1, body: "重复项" }],
      }),
      "总分：80 分",
    ),
    logger: createSilentLogger(),
    batchMaxTokens: 6000,
  });
  await pipeline.run(task);
  assert.equal(posted.length, 0, "同 marker 不得重复发布");
  assert.doesNotMatch(notes[0], /无法定位到行的问题/, "已发布过的条目不进汇总");
});

test("单条行内评论失败时该条并入汇总且其余继续发布", async () => {
  const { client, posted, notes } = inlineClient({ diff: twoAddedLines, postFails: (index) => index === 0 });
  const pipeline = createReviewPipeline({
    client,
    rules,
    reviewer: reviewerReturning(
      JSON.stringify({
        reviewed_head_sha: headSha,
        summary: { body: "总分：80 分" },
        findings: [
          { id: "f1", severity: "high", path: "a.ts", new_line: 1, body: "第一条会失败" },
          { id: "f2", severity: "low", path: "a.ts", new_line: 2, body: "第二条应成功" },
        ],
      }),
      "总分：80 分",
    ),
    logger: createSilentLogger(),
    batchMaxTokens: 6000,
  });
  await pipeline.run(task);
  assert.equal(posted.length, 1, "第二条仍应成功发布");
  assert.match(posted[0].body, /第二条应成功/);
  assert.match(notes[0], /第一条会失败/, "失败的那条必须并入汇总");
});

test("无法解析为 JSON 的批次整体并入汇总", async () => {
  const { client, posted, notes } = inlineClient({ diff: twoAddedLines });
  const pipeline = createReviewPipeline({
    client,
    rules,
    reviewer: reviewerReturning("这是一段自由文本评论，不是 JSON", "总分：80 分"),
    logger: createSilentLogger(),
    batchMaxTokens: 6000,
  });
  await pipeline.run(task);
  assert.equal(posted.length, 0);
  assert.match(notes[0], /自由文本评论/);
});

test("取 diff version 失败时全部降级进汇总且仍回写评论", async () => {
  const { client: failing, notes } = inlineClient({ diff: twoAddedLines, versionsFail: true });
  const pipeline = createReviewPipeline({
    client: failing,
    rules,
    reviewer: reviewerReturning(
      JSON.stringify({
        reviewed_head_sha: headSha,
        summary: { body: "总分：80 分" },
        findings: [{ id: "f1", severity: "low", path: "a.ts", new_line: 1, body: "应降级" }],
      }),
      "总分：80 分",
    ),
    logger: createSilentLogger(),
    batchMaxTokens: 6000,
  });
  await assert.doesNotReject(() => pipeline.run(task));
  assert.equal(notes.length, 1, "降级不等于放弃回写");
  assert.match(notes[0], /无法定位到行的问题/);
});

test("old_line 锚点使用 removed 行号集", async () => {
  const diff = "@@ -1,2 +1,1 @@\n ctx\n-gone";
  const { client, posted } = inlineClient({ diff });
  const pipeline = createReviewPipeline({
    client,
    rules,
    reviewer: reviewerReturning(
      JSON.stringify({
        reviewed_head_sha: headSha,
        summary: { body: "总分：80 分" },
        findings: [{ id: "f1", severity: "medium", path: "a.ts", old_line: 2, body: "删除行的问题" }],
      }),
      "总分：80 分",
    ),
    logger: createSilentLogger(),
    batchMaxTokens: 6000,
  });
  await pipeline.run(task);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].position.old_line, 2, "old_line 必须用原文件行号");
});

// ============ 终审修复：C-1 汇总去重 与 H-5 head_sha 注入 ============

test("已成功发行内评论的 finding 从汇总评论中剔除，不重复出现", async () => {
  const { client, posted, notes } = inlineClient({ diff: twoAddedLines });
  // 汇总评论正文含已发布 finding 的正文（符合 SUMMARY_SUFFIX「保留各条问题的位置与证据」）
  const summaryText = ["## 问题清单", "", "已发布的问题描述文字", "", "总分：80 分"].join("\n");
  const pipeline = createReviewPipeline({
    client,
    rules,
    reviewer: reviewerReturning(
      JSON.stringify({
        reviewed_head_sha: headSha,
        summary: { body: "总分：80 分" },
        findings: [{ id: "f1", severity: "high", path: "a.ts", new_line: 1, body: "已发布的问题描述文字" }],
      }),
      summaryText,
    ),
    logger: createSilentLogger(),
    batchMaxTokens: 6000,
  });
  await pipeline.run(task);
  assert.equal(posted.length, 1, "该条应成功发行内评论");
  assert.equal(notes.length, 1);
  assert.doesNotMatch(notes[0], /已发布的问题描述文字/, "已发行内评论的条目不得再出现在汇总评论中");
  assert.match(notes[0], /总分：80 分/, "剔除后必须保留总分，否则企微评分会失效");
  assert.match(notes[0], /## 问题清单/, "只剔除命中行，其余正文保持原样");
});

test("未发行内评论的 finding 仍保留在汇总评论中", async () => {
  const { client, notes } = inlineClient({ diff: twoAddedLines });
  const pipeline = createReviewPipeline({
    client,
    rules,
    reviewer: reviewerReturning(
      JSON.stringify({
        reviewed_head_sha: headSha,
        summary: { body: "总分：80 分" },
        // 行号 99 越界 → 降级进汇总，不得被剔除
        findings: [{ id: "f1", severity: "low", path: "a.ts", new_line: 99, body: "越界问题描述" }],
      }),
      ["## 问题清单", "", "越界问题描述", "", "总分：80 分"].join("\n"),
    ),
    logger: createSilentLogger(),
    batchMaxTokens: 6000,
  });
  await pipeline.run(task);
  assert.match(notes[0], /越界问题描述/, "降级的 finding 必须保留在汇总中，不能被误剔除");
});

test("提交给模型的 user prompt 注入当前 head sha", async () => {
  const seen: string[] = [];
  const pipeline = createReviewPipeline({
    // 默认 fakeClient 的 headSha 是占位符 "h"，这里覆盖为 40 位真实形状的 sha，
    // 以便断言注入值与 parseReviewJson 的要求一致。
    client: fakeClient({ getMergeRequestVersions: async () => ({ baseSha: "b", startSha: "s", headSha }) }),
    // 模板带 {head_sha} 占位符
    rules: { resolve: () => ({ systemPrompt: "SYS", userPrompt: "head={head_sha}\n评：{diffs_text}" }) } as ReviewRules,
    reviewer: {
      review: async ({ code }) => {
        seen.push(code);
        return { text: "总分：80 分", model: "m" };
      },
    },
    logger: createSilentLogger(),
    batchMaxTokens: 6000,
  });
  await pipeline.run(task);
  assert.ok(seen.length > 0);
  // 只断言批次调用：汇总调用（最后一次）的输入是各批结果文本，不需要 head_sha。
  assert.ok(seen[0].includes(headSha), "批次的 user prompt 必须含 head_sha，否则模型无法回显 reviewed_head_sha");
  assert.ok(!seen[0].includes("{head_sha}"), "占位符必须被替换而不是原样保留");
});
