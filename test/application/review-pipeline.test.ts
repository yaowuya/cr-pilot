import { test } from "node:test";
import assert from "node:assert/strict";
import { createReviewPipeline, type MergeRequestTask, type PendingFinding } from "../../src/application/review-pipeline.ts";
import { estimateTokens, splitChangesIntoBatches } from "../../src/domain/change.ts";
import { fingerprintLine } from "../../src/domain/review-finding.ts";
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

/**
 * 判定这次 reviewer 调用是不是「汇总」阶段。
 *
 * 不能用 includes("合并"/"汇总") 判断：批次调用的 system prompt 现在会被管线
 * 追加「输出格式（系统要求）」契约段，其中出现「汇总」字样，导致批次被误判为汇总。
 * 改用它独有的开头语——只有 SUMMARY_SUFFIX 含「你之前分批评审了同一变更的各部分」。
 */
function isSummaryCall(systemPrompt: string): boolean {
  return systemPrompt.includes("你之前分批评审了同一变更的各部分");
}

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
    getLatestHeadSha: async () => "h",
    getFileRaw: async () => "",
    postDiscussion: async () => ({ id: "d", notes: [] }),
    getDiscussions: async () => [],
    // 默认作者可解析：既有多数用例不带 author_id，走不到这里；
    // 带 author_id 的用例默认拿到这个名字，需要降级的用例用 overrides 覆盖。
    getUser: async (userId: number) => ({ id: userId, name: "作者甲", username: "author-a" }),
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
        text: isSummaryCall(systemPrompt) ? "```markdown\n## 问题清单\n- [一般] a\n\n## 结论\n\n可合入。\n```" : "批评论",
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

test("评分低于阈值且配置 webhook 时推送企微，末行提及 MR 作者而非触发者", async () => {
  const authorLookups: [number, string | undefined, string | undefined][] = [];
  const client = fakeClient({
    getUser: async (id, gitlabUrl, gitlabToken) => {
      authorLookups.push([id, gitlabUrl, gitlabToken]);
      return { id, name: "真正的作者", username: "real-author" };
    },
  });
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
        text: isSummaryCall(systemPrompt) ? "## 问题清单\n- [严重] x\n\n总分:65分" : "批评论",
        model: "m",
      }),
    },
    logger: createSilentLogger(),
    batchMaxTokens: 6000,
    wecomNotifier,
  });
  await pipeline.run({
    ...task,
    authorId: 1751,
    triggerUserName: "unrelated-trigger",
    gitlabUrl: "https://gitlab.example.com",
    gitlabToken: "test-token",
  });
  assert.equal(sent.length, 1);
  assert.match(sent[0], /代码评审提醒/);
  assert.match(sent[0], /65 分/);
  // 没有映射时退回作者显示名做纯文本 @，绝不把 GitLab 账号当企微 userid。
  assert.ok(sent[0].endsWith("\n\n@真正的作者"), "必须使用作者显示名且将提及放在最底部");
  assert.equal(sent[0].includes("<@real-author>"), false, "GitLab 账号不是企微 userid");
  assert.equal(sent[0].includes("unrelated-trigger"), false);
  assert.deepEqual(authorLookups, [[1751, "https://gitlab.example.com", "test-token"]], "复用同一次作者查询及任务级实例信息");
});

test("正式通知正确处理作者姓名的账号后缀，且保留原始统计姓名与映射优先级", async (t) => {
  const cases: { name: string; expected: string; mapping?: { wecomName: string; wecomUserId: string } }[] = [
    { name: "王秦[wangqin]", expected: "@王秦" },
    { name: " 王秦 [WangQin] ", expected: "@王秦" },
    { name: "王秦", expected: "@王秦" },
    { name: "欧阳·王秦[wangqin]", expected: "@欧阳·王秦" },
    { name: "王秦[wangqin]", mapping: { wecomName: "企微王秦", wecomUserId: "" }, expected: "@企微王秦" },
    { name: "王秦[wangqin]", mapping: { wecomName: "企微王秦", wecomUserId: "synthetic_member" }, expected: "<@synthetic_member>" },
  ];
  for (const scenario of cases) {
    await t.test(`${scenario.name} → ${scenario.expected}`, async () => {
      const sent: string[] = [];
      const records: ReviewRecord[] = [];
      const pipeline = createReviewPipeline({
        client: fakeClient({ getUser: async (id) => ({ id, name: scenario.name, username: "wangqin" }) }),
        rules: { resolve: () => ({ systemPrompt: "SYS", userPrompt: "评：{diffs_text}", wecomWebhookUrl: "https://example.invalid/wecom", wecomScoreThreshold: 80 }) } as ReviewRules,
        reviewer: reviewerReturning("批评论", "总分：60 分"),
        logger: createSilentLogger(),
        batchMaxTokens: 6000,
        recordWriter: { insert: (record) => { records.push(record); } },
        wecomNotifier: { send: async (_url, message) => { sent.push(message); } },
        wecomContacts: scenario.mapping ? { findByGitlabUsername: () => scenario.mapping } : undefined,
      });
      await pipeline.run({ ...task, authorId: 1751, triggerUserName: "无关触发者" });
      assert.equal(sent.length, 1);
      assert.ok(sent[0].endsWith(`\n\n${scenario.expected}`), "正式评审完成后的群通知必须保留末行中文名或真实成员提及");
      assert.equal(sent[0].includes("无关触发者"), false);
      assert.equal(records[0].committerName, scenario.name, "仅调整通知显示，不改统计里的原始作者名");
    });
  }
});

test("正式通知不会把不匹配的账号标签或注入内容清洗成提及，并记录省略原因", async (t) => {
  for (const name of ["王秦[other]", "王秦\n[wangqin]", "王秦[wangqin]\n<@all>", "[wangqin]"]) {
    await t.test(JSON.stringify(name), async () => {
      const sent: string[] = [];
      const warnings: string[] = [];
      const pipeline = createReviewPipeline({
        client: fakeClient({ getUser: async (id) => ({ id, name, username: "wangqin" }) }),
        rules: { resolve: () => ({ systemPrompt: "SYS", userPrompt: "评：{diffs_text}", wecomWebhookUrl: "https://example.invalid/wecom", wecomScoreThreshold: 80 }) } as ReviewRules,
        reviewer: reviewerReturning("批评论", "总分：60 分"),
        logger: { ...createSilentLogger(), warn: (message) => { warnings.push(message); } },
        batchMaxTokens: 6000,
        wecomNotifier: { send: async (_url, message) => { sent.push(message); } },
      });
      await pipeline.run({ ...task, authorId: 1751, triggerUserName: "无关触发者" });
      assert.equal(sent.length, 1, "不安全姓名不能中断低分通知");
      assert.equal(sent[0].includes("@"), false, "只移除与作者账号一致的末尾标签，不放宽提及安全边界");
      assert.ok(warnings.some((message) => message.includes("未追加提交人提及")), "发送成功不能掩盖没有提及的原因");
    });
  }
});

test("已登记企微映射时使用 userid 真实提醒提交人", async () => {
  const client = fakeClient({
    getUser: async (id) => ({ id, name: "王秦", username: "samxiao" }),
  });
  const sent: string[] = [];
  const pipeline = createReviewPipeline({
    client,
    rules: {
      resolve: () => ({
        systemPrompt: "SYS",
        userPrompt: "评：{diffs_text}",
        wecomWebhookUrl: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=t",
        wecomScoreThreshold: 70,
      }),
    } as ReviewRules,
    reviewer: reviewerReturning("批评论", "总分：60 分"),
    logger: createSilentLogger(),
    batchMaxTokens: 6000,
    wecomNotifier: { send: async (_url, markdown) => { sent.push(markdown); } },
    wecomContacts: {
      findByGitlabUsername: (username) =>
        username === "samxiao" ? { wecomName: "王秦", wecomUserId: "wangqin" } : undefined,
    },
  });

  await pipeline.run({ ...task, authorId: 1751, triggerUserName: "unrelated-trigger" });
  assert.equal(sent.length, 1);
  assert.ok(sent[0].endsWith("\n\n<@wangqin>"), "映射的 userid 必须优先于显示名");
  assert.equal(sent[0].includes("@王秦"), false, "已有 userid 时不再重复输出姓名");
});

test("映射只有姓名时按中文名展示，不伪造 userid", async () => {
  const client = fakeClient({
    getUser: async (id) => ({ id, name: "拼音名", username: "samxiao" }),
  });
  const sent: string[] = [];
  const pipeline = createReviewPipeline({
    client,
    rules: {
      resolve: () => ({
        systemPrompt: "SYS",
        userPrompt: "评：{diffs_text}",
        wecomWebhookUrl: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=t",
        wecomScoreThreshold: 70,
      }),
    } as ReviewRules,
    reviewer: reviewerReturning("批评论", "总分：60 分"),
    logger: createSilentLogger(),
    batchMaxTokens: 6000,
    wecomNotifier: { send: async (_url, markdown) => { sent.push(markdown); } },
    wecomContacts: {
      findByGitlabUsername: () => ({ wecomName: "王秦", wecomUserId: "" }),
    },
  });

  await pipeline.run({ ...task, authorId: 1751, triggerUserName: "unrelated-trigger" });
  assert.ok(sent[0].endsWith("\n\n@王秦"), "映射姓名优先于 GitLab 显示名");
  assert.equal(sent[0].includes("<@"), false);
});

test("映射查询异常时照常推送并退回作者显示名", async () => {
  const client = fakeClient({
    getUser: async (id) => ({ id, name: "王秦", username: "samxiao" }),
  });
  const sent: string[] = [];
  const pipeline = createReviewPipeline({
    client,
    rules: {
      resolve: () => ({
        systemPrompt: "SYS",
        userPrompt: "评：{diffs_text}",
        wecomWebhookUrl: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=t",
        wecomScoreThreshold: 70,
      }),
    } as ReviewRules,
    reviewer: reviewerReturning("批评论", "总分：60 分"),
    logger: createSilentLogger(),
    batchMaxTokens: 6000,
    wecomNotifier: { send: async (_url, markdown) => { sent.push(markdown); } },
    wecomContacts: {
      findByGitlabUsername: () => { throw new Error("数据库锁"); },
    },
  });

  await pipeline.run({ ...task, authorId: 1751, triggerUserName: "unrelated-trigger" });
  assert.equal(sent.length, 1, "映射读失败不能中断通知");
  assert.ok(sent[0].endsWith("\n\n@王秦"));
});

test("无法确认作者身份时照常推送企微，但不提及触发者", async (t) => {
  const cases: {
    name: string;
    authorId?: number;
    getUser: GitlabClient["getUser"];
    /** 解析成功但无账号时可退回作者显示名；其余情况不能有任何提及。 */
    expectedMention?: string;
  }[] = [
    {
      name: "缺少 author_id",
      getUser: async () => { throw new Error("不应调用用户接口"); },
    },
    {
      name: "作者查询失败",
      authorId: 1751,
      getUser: async () => { throw new Error("用户接口返回 403"); },
    },
    {
      name: "只有作者显示名，没有账号",
      authorId: 1751,
      getUser: async (id) => ({ id, name: "作者甲", username: "" }),
      expectedMention: "@作者甲",
    },
    {
      name: "作者信息全为空",
      authorId: 1751,
      getUser: async (id) => ({ id, name: "", username: "" }),
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      let authorLookups = 0;
      const client = fakeClient({
        getUser: async (id, url, token) => {
          authorLookups += 1;
          return scenario.getUser(id, url, token);
        },
      });
      const sent: string[] = [];
      const pipeline = createReviewPipeline({
        client,
        rules: {
          resolve: () => ({
            systemPrompt: "SYS",
            userPrompt: "评：{diffs_text}",
            wecomWebhookUrl: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=t",
            wecomScoreThreshold: 70,
          }),
        } as ReviewRules,
        reviewer: reviewerReturning("批评论", "总分：60 分"),
        logger: createSilentLogger(),
        batchMaxTokens: 6000,
        wecomNotifier: { send: async (_url, markdown) => { sent.push(markdown); } },
      });

      await pipeline.run({ ...task, authorId: scenario.authorId, triggerUserName: "unrelated-trigger" });
      assert.equal(client.notes.length, 1, "作者信息缺失不能影响 MR 评论回写");
      assert.equal(sent.length, 1, "原来的低分通知仍须发送");
      assert.equal(sent[0].includes("<@"), false, "不能用触发者或账号冒充企微 userid");
      assert.equal(sent[0].includes("unrelated-trigger"), false, "绝不能提及触发者");
      if (scenario.expectedMention) {
        assert.ok(sent[0].endsWith(`\n\n${scenario.expectedMention}`), "解析成功但无账号时退回显示名");
      } else {
        assert.equal(sent[0].includes("@"), false, "作者未知时不应输出任何提及");
      }
      assert.equal(authorLookups, scenario.authorId === undefined ? 0 : 1);
    });
  }
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
        text: isSummaryCall(systemPrompt) ? "总分:85分" : "批评论",
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
        text: isSummaryCall(systemPrompt) ? "总分:60分" : "批评论",
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
      text: isSummaryCall(systemPrompt) ? summaryText : batchText,
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
  await pipeline.run({ ...task, triggerUserName: "张三" });
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

// ============ 采纳追踪：建议明细落库 ============

/** 收集建议明细的写入端口，模拟仓储返回自增记录 ID。 */
function findingWriterHarness() {
  const inserted: (Omit<PendingFinding, "recordId"> & { recordId: number })[] = [];
  return {
    inserted,
    writer: { insert: (finding: PendingFinding) => { inserted.push(finding); } },
    /** 记录写入返回 1，让管线认为拿到了记录 ID。 */
    recordWriter: { insert: () => 1 },
  };
}

test("行内评论发布成功后写入建议明细与指纹", async () => {
  const { client } = inlineClient({ diff: twoAddedLines });
  const harness = findingWriterHarness();
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
    recordWriter: harness.recordWriter,
    findingWriter: harness.writer,
  });

  await pipeline.run(task);
  assert.equal(harness.inserted.length, 1);
  const saved = harness.inserted[0];
  assert.equal(saved.recordId, 1, "必须关联评审记录");
  assert.equal(saved.codeFingerprint, fingerprintLine("two"), "指纹取被评论行文本");
  assert.equal(saved.discussionId, "d1");
  assert.equal(saved.noteId, 1);
  assert.equal(saved.outcome, "pending");
});

test("降级进汇总的建议写入空指纹，用于统计不可追踪", async () => {
  const { client } = inlineClient({ diff: twoAddedLines });
  const harness = findingWriterHarness();
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
    recordWriter: harness.recordWriter,
    findingWriter: harness.writer,
  });

  await pipeline.run(task);
  assert.equal(harness.inserted.length, 1);
  assert.equal(harness.inserted[0].codeFingerprint, "", "未发布行内评论时不能有指纹");
  assert.equal(harness.inserted[0].discussionId, null);
});

test("行内评论发布失败但有合法行位置时，仍记录建议并保留可追踪指纹", async () => {
  const { client } = inlineClient({ diff: twoAddedLines, postFails: () => true });
  const harness = findingWriterHarness();
  const pipeline = createReviewPipeline({
    client,
    rules,
    reviewer: reviewerReturning(
      JSON.stringify({
        reviewed_head_sha: headSha,
        summary: { body: "总分：80 分" },
        findings: [{ id: "f1", severity: "high", path: "a.ts", new_line: 2, body: "发布会失败" }],
      }),
      "总分：80 分",
    ),
    logger: createSilentLogger(),
    batchMaxTokens: 6000,
    recordWriter: harness.recordWriter,
    findingWriter: harness.writer,
  });

  await pipeline.run(task);
  assert.equal(harness.inserted.length, 1);
  // 位置已通过 diff 校验，只是发布失败；保留指纹才能继续参与采纳追踪。
  assert.equal(harness.inserted[0].codeFingerprint, fingerprintLine("two"), "发布失败不应丢失行锚点");
  assert.equal(harness.inserted[0].discussionId, null);
});

test("未注入 findingWriter 或记录无 ID 时不写建议，既有行为不变", async () => {
  const { client } = inlineClient({ diff: twoAddedLines });
  const harness = findingWriterHarness();
  const reviewJson = JSON.stringify({
    reviewed_head_sha: headSha,
    summary: { body: "总分：80 分" },
    findings: [{ id: "f1", severity: "high", path: "a.ts", new_line: 2, body: "x" }],
  });

  // 场景一：没有 findingWriter
  const pipelineWithoutWriter = createReviewPipeline({
    client,
    rules,
    reviewer: reviewerReturning(reviewJson, "总分：80 分"),
    logger: createSilentLogger(),
    batchMaxTokens: 6000,
    recordWriter: harness.recordWriter,
  });
  await pipelineWithoutWriter.run(task);

  // 场景二：recordWriter 返回 void，拿不到记录 ID
  const pipelineWithoutRecordId = createReviewPipeline({
    client,
    rules,
    reviewer: reviewerReturning(reviewJson, "总分：80 分"),
    logger: createSilentLogger(),
    batchMaxTokens: 6000,
    recordWriter: { insert: () => {} },
    findingWriter: harness.writer,
  });
  await pipelineWithoutRecordId.run(task);

  assert.equal(harness.inserted.length, 0);
});

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
  // marker 的 id 带批次前缀（单批时批次号为 0），避免跨批同名 finding 互相误判。
  assert.match(posted[0].body, new RegExp(`<!-- marker:${headSha}:0:f1 -->`));
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
    existingBodies: [`旧内容\n\n<!-- marker:${headSha}:0:f1 -->`],
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

// ============ MR 作者解析（提交人字段正确性） ============

test("提交人取 MR 作者而非事件触发者", async () => {
  // 关键回归：别人评论/推代码会触发 update 事件，payload.user 是那个别人。
  // 评审记录必须记 MR 作者，否则统计「谁提交的 MR」全是错的。
  const inserted: ReviewRecord[] = [];
  const pipeline = createReviewPipeline({
    client: fakeClient({
      getUser: async (id: number) => ({ id, name: "真正的作者", username: "real-author" }),
    }),
    rules,
    reviewer: reviewerReturning("批评论", "总分：90 分"),
    logger: createSilentLogger(),
    batchMaxTokens: 6000,
    recordWriter: { insert: (record) => inserted.push(record) },
  });
  await pipeline.run({ ...task, authorId: 1751, triggerUserName: "无关的触发者" });
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].committerName, "真正的作者", "应记录 MR 作者而不是触发者");
});

test("作者接口失败时降级为触发者名字，评审不中断", async () => {
  // token 缺 read_user 权限会 403。查不到名字只影响一个统计字段，
  // 不能让整次评审失败——否则一个权限问题会导致评审功能全挂。
  const inserted: ReviewRecord[] = [];
  const pipeline = createReviewPipeline({
    client: fakeClient({
      getUser: async () => {
        throw new Error("GitLab API /api/v4/users/1751 返回 403");
      },
    }),
    rules,
    reviewer: reviewerReturning("批评论", "总分：70 分"),
    logger: createSilentLogger(),
    batchMaxTokens: 6000,
    recordWriter: { insert: (record) => inserted.push(record) },
  });
  await pipeline.run({ ...task, authorId: 1751, triggerUserName: "触发者乙" });
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].result, "success", "作者查询失败不应让评审失败");
  assert.equal(inserted[0].committerName, "触发者乙", "降级为触发者名字");
});

test("作者接口返回空名字时降级为触发者", async () => {
  const inserted: ReviewRecord[] = [];
  const pipeline = createReviewPipeline({
    client: fakeClient({ getUser: async (id: number) => ({ id, name: "", username: "" }) }),
    rules,
    reviewer: reviewerReturning("批评论", "总分：60 分"),
    logger: createSilentLogger(),
    batchMaxTokens: 6000,
    recordWriter: { insert: (record) => inserted.push(record) },
  });
  await pipeline.run({ ...task, authorId: 1, triggerUserName: "触发者丙" });
  assert.equal(inserted[0].committerName, "触发者丙");
});

test("没有 author_id 时不调用户接口，直接用触发者", async () => {
  // 老版本 GitLab 或精简 payload 没有 author_id：保持原有行为，不多发一次请求。
  let called = 0;
  const inserted: ReviewRecord[] = [];
  const pipeline = createReviewPipeline({
    client: fakeClient({
      getUser: async (id: number) => {
        called += 1;
        return { id, name: "不该被调用", username: "x" };
      },
    }),
    rules,
    reviewer: reviewerReturning("批评论", "总分：80 分"),
    logger: createSilentLogger(),
    batchMaxTokens: 6000,
    recordWriter: { insert: (record) => inserted.push(record) },
  });
  await pipeline.run({ ...task, triggerUserName: "触发者丁" });
  assert.equal(called, 0, "缺 author_id 时不应调用用户接口");
  assert.equal(inserted[0].committerName, "触发者丁");
});

test("作者接口返回 username 时优先用 name，name 空则用 username", async () => {
  const inserted: ReviewRecord[] = [];
  const pipeline = createReviewPipeline({
    client: fakeClient({ getUser: async (id: number) => ({ id, name: "", username: "only-username" }) }),
    rules,
    reviewer: reviewerReturning("批评论", "总分：85 分"),
    logger: createSilentLogger(),
    batchMaxTokens: 6000,
    recordWriter: { insert: (record) => inserted.push(record) },
  });
  await pipeline.run({ ...task, authorId: 2, triggerUserName: "触发者" });
  assert.equal(inserted[0].committerName, "only-username", "name 为空时退回 username");
});

// ============ Markdown 兜底：prompt 缺结构化块时仍能发行内评论 ============

test("模型只输出 Markdown（无 JSON 块）时，从正文反推并发布行内评论", async () => {
  // 根因场景：仓库级 prompt 漏了「行内评论定位块」要求（gitignored、各自维护），
  // 模型只输出 Markdown。此时不能直接降级——正文里的「位置：文件:行号」信息是齐的。
  const { client, posted } = inlineClient({ diff: twoAddedLines });
  const markdown = [
    "代码审查报告",
    "",
    "P0：第二条有问题",
    "- 位置： `a.ts:2`",
    "- 问题：这里明显不对。",
    "",
    "总分：80 分",
  ].join("\n");

  const pipeline = createReviewPipeline({
    client,
    rules,
    reviewer: reviewerReturning(markdown, "总分：80 分"),
    logger: createSilentLogger(),
    batchMaxTokens: 6000,
  });
  await pipeline.run(task);

  assert.equal(posted.length, 1, "应从 Markdown 反推出 1 条可定位问题");
  assert.equal(posted[0].position.new_line, 2);
  assert.match(posted[0].body, /第二条有问题|这里明显不对/);
  // 反推的 finding 也必须带 marker，保证重跑幂等
  assert.match(posted[0].body, /<!-- marker:/);
});

test("Markdown 里没有可定位信息时仍降级进汇总，不丢失内容", async () => {
  const { client, posted, notes } = inlineClient({ diff: twoAddedLines });
  const markdown = "代码整体质量不错，未发现可定位的具体问题。\n\n总分：95 分";
  const pipeline = createReviewPipeline({
    client,
    rules,
    reviewer: reviewerReturning(markdown, "总分：95 分"),
    logger: createSilentLogger(),
    batchMaxTokens: 6000,
  });
  await pipeline.run(task);
  assert.equal(posted.length, 0, "无可定位信息时不应强行发行内评论");
  assert.equal(notes.length, 1);
  assert.match(notes[0], /代码整体质量不错/, "原文必须保留在汇总评论里");
});

test("Markdown 反推出的行号不在 diff 变更行时，该条降级进汇总", async () => {
  // 反推是启发式的，行号可能指向未变更的行；position 校验必须照样拦下
  const { client, posted, notes } = inlineClient({ diff: twoAddedLines });
  const markdown = ["P1：越界行号", "- 位置： `a.ts:999`", "", "总分：70 分"].join("\n");
  const pipeline = createReviewPipeline({
    client,
    rules,
    reviewer: reviewerReturning(markdown, "总分：70 分"),
    logger: createSilentLogger(),
    batchMaxTokens: 6000,
  });
  await pipeline.run(task);
  assert.equal(posted.length, 0, "越界行号不得强行发行内评论");
  assert.equal(notes.length, 1);
});

// ============ 行内评论的结构化契约由管线统一注入 ============

test("批次调用的 system prompt 自动带结构化输出契约，无需 prompt 文件配合", async () => {
  // 机制保证：无论仓库级 prompt 写成什么样，管线都追加 JSON 定位块要求。
  // 线上出现过只有 default.yaml 写了这段、其余仓库没写，导致行内评论全失效。
  const promptsSeen: string[] = [];
  const client = fakeClient();
  const pipeline = createReviewPipeline({
    client,
    // 故意用一个「完全没提结构化输出」的极简 prompt，模拟仓库级 yaml 遗漏
    rules: { resolve: () => ({ systemPrompt: "你是评审专家", userPrompt: "评：{diffs_text}" }) },
    reviewer: {
      review: async ({ systemPrompt }) => {
        promptsSeen.push(systemPrompt);
        return { text: "批评论", model: "m" };
      },
    },
    logger: createSilentLogger(),
    batchMaxTokens: 6000,
  });
  await pipeline.run(task);

  const batchCall = promptsSeen.find((p) => !isSummaryCall(p));
  assert.ok(batchCall, "应有批次调用");
  assert.match(batchCall, /输出格式（系统要求/, "必须注入契约标题");
  assert.match(batchCall, /reviewed_head_sha/, "必须要求回显 head_sha");
  assert.match(batchCall, /"findings"/, "必须要求 findings 数组");
  assert.match(batchCall, /你是评审专家/, "原有 prompt 内容必须保留");
});

test("汇总调用不带结构化契约，避免要求模型在汇总阶段再输出 JSON", () => {
  // 汇总阶段输出的是最终 Markdown 评论正文，加定位块要求会让模型多吐一段 JSON
  const promptsSeen: string[] = [];
  const client = fakeClient();
  const pipeline = createReviewPipeline({
    client,
    rules,
    reviewer: {
      review: async ({ systemPrompt }) => {
        promptsSeen.push(systemPrompt);
        return { text: "总分：80 分", model: "m" };
      },
    },
    logger: createSilentLogger(),
    batchMaxTokens: 6000,
  });
  return pipeline.run(task).then(() => {
    const summaryCall = promptsSeen.find((p) => isSummaryCall(p));
    assert.ok(summaryCall, "应有汇总调用");
    assert.equal(
      summaryCall.includes("输出格式（系统要求"),
      false,
      "汇总调用不应带定位块契约",
    );
  });
});

test("user 消息末尾自动补充 head_sha，即使 prompt 模板没有占位符", async () => {
  // 仓库级 prompt 普遍没写 {head_sha}；不补的话模型拿不到值，
  // reviewed_head_sha 只能编造或为空，定位块整体校验失败。
  const userMessages: string[] = [];
  const client = fakeClient({
    getMergeRequestVersions: async () => ({ baseSha: "b", startSha: "s", headSha: headSha }),
  });
  const pipeline = createReviewPipeline({
    client,
    // 模板里刻意不含 {head_sha}
    rules: { resolve: () => ({ systemPrompt: "S", userPrompt: "评：{diffs_text}" }) },
    reviewer: {
      review: async ({ code }) => {
        userMessages.push(code);
        return { text: "批评论", model: "m" };
      },
    },
    logger: createSilentLogger(),
    batchMaxTokens: 6000,
  });
  await pipeline.run(task);

  const batchMessage = userMessages.find((m) => !m.includes("你之前分批评审"));
  assert.ok(batchMessage);
  assert.match(batchMessage, new RegExp(`head_sha.*${headSha}`), "必须把 head_sha 传给模型");
});

// ============ 行内评论降级原因诊断 ============

test("行内评论发布失败时保留真实指纹，使该建议仍可被采纳追踪", async () => {
  const { client } = inlineClient({ diff: twoAddedLines, postFails: () => true });
  const harness = findingWriterHarness();
  const pipeline = createReviewPipeline({
    client,
    rules,
    reviewer: reviewerReturning(
      JSON.stringify({
        reviewed_head_sha: headSha,
        summary: { body: "总分：80 分" },
        findings: [{ id: "f1", severity: "high", path: "a.ts", new_line: 2, body: "发布失败但有行锚点" }],
      }),
      "总分：80 分",
    ),
    logger: createSilentLogger(),
    batchMaxTokens: 6000,
    recordWriter: harness.recordWriter,
    findingWriter: harness.writer,
  });

  await pipeline.run(task);
  assert.equal(harness.inserted.length, 1, "发布失败的建议仍要落库");
  // 该条位置合法，只是发布时网络/接口失败；行锚点信息完整，不能丢成不可追踪。
  assert.equal(
    harness.inserted[0].codeFingerprint,
    fingerprintLine("two"),
    "有行锚点的建议即使发布失败也必须保留指纹",
  );
  assert.equal(harness.inserted[0].discussionId, null, "未发布成功时没有 discussion");
});

test("无结构化块且正文无可定位信息时，日志说明降级原因与条数", async () => {
  const { client, notes } = inlineClient({ diff: twoAddedLines });
  const logs: { message: string; fields?: Record<string, unknown> }[] = [];
  const logger = {
    ...createSilentLogger(),
    info: (message: string, fields?: Record<string, unknown>) => { logs.push({ message, fields }); },
  };
  const pipeline = createReviewPipeline({
    client,
    rules,
    // 只给一句总评：既没有 JSON 块，也没有「位置：文件:行号」。
    reviewer: reviewerReturning("整体看起来没有明显问题，可以合入。", "总分：100 分"),
    logger,
    batchMaxTokens: 6000,
  });

  await pipeline.run(task);
  assert.equal(notes.length, 1, "总评论仍要回写");
  const summary = logs.find((entry) => entry.message === "行内评论处理完成");
  assert.ok(summary, "必须有一条汇总行内评论处理的日志");
  assert.equal(summary.fields?.解析条数, 0, "模型未给出可定位问题时应如实记为 0");
  assert.equal(summary.fields?.发布条数, 0);
  assert.equal(summary.fields?.降级批次, 1, "整批无法解析时按批计入降级");
  assert.equal(summary.fields?.无结构化块批次, 1, "原因应能区分「没有结构化块」");
});

test("行号不在变更行时，日志按原因分类计数", async () => {
  const { client } = inlineClient({ diff: twoAddedLines });
  const logs: { message: string; fields?: Record<string, unknown> }[] = [];
  const logger = {
    ...createSilentLogger(),
    info: (message: string, fields?: Record<string, unknown>) => { logs.push({ message, fields }); },
    warn: () => {},
  };
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
    logger,
    batchMaxTokens: 6000,
  });

  await pipeline.run(task);
  const summary = logs.find((entry) => entry.message === "行内评论处理完成");
  assert.ok(summary);
  assert.equal(summary.fields?.解析条数, 1, "结构化块解析出 1 条");
  assert.equal(summary.fields?.发布条数, 0);
  assert.equal(summary.fields?.降级条数, 1);
  assert.equal(summary.fields?.行号非法条数, 1, "原因应能区分「行号不在变更行」");
});
