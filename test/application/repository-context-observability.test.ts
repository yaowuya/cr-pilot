import { test } from "node:test";
import assert from "node:assert/strict";
import { createReviewPipeline } from "../../src/application/review-pipeline.ts";
import type { GitlabClient, MergeRequestTask, ReviewInput } from "../../src/domain/review-task.ts";
import type { RepositoryPrepareInput, RepositoryReadAccess, RepositoryPreparationEvent } from "../../src/domain/repository-context.ts";
import type { ReviewRecord } from "../../src/domain/review-record.ts";
import { createRepositoryTools } from "../../src/infrastructure/pi/repository-tools.ts";
import { openDatabase } from "../../src/infrastructure/sqlite/database.ts";
import { createPromptRepository } from "../../src/infrastructure/sqlite/prompt-repo.ts";
import { createLogger, type Logger, type LogFields } from "../../src/shared/logger.ts";

const head = "a".repeat(40);
const task: MergeRequestTask = {
  projectId: 7, iid: 2, fullName: "fixture/project", sourceBranch: "feature", targetBranch: "main",
  gitlabUrl: "https://git.example.invalid", gitlabToken: "fixture-private-task-token",
};

/** 用真实内存配置仓储与工具执行包装验证日志；Git、GitLab 和模型均为隔离替身。 */
function harness(options: {
  enabled?: boolean; useTools?: boolean; retryBatch?: boolean;
  fail?: "snapshot" | "prepare" | "note" | "cleanup"; level?: "info" | "debug";
} = {}) {
  const db = openDatabase(":memory:");
  const prompts = createPromptRepository(db);
  prompts.create({
    repository: "fixture-rules", projects: [task.fullName], systemPrompt: "SYS", userPrompt: "{diffs_text}",
    projectSettings: [{ project: task.fullName, repositoryContextEnabled: options.enabled !== false }],
  });
  const entries: { level: string; message: string; fields?: LogFields }[] = [];
  const lines: string[] = [];
  const sink = createLogger(options.level ?? "debug", (line) => { lines.push(line); });
  const logger: Logger = {
    debug: (message, fields) => { entries.push({ level: "debug", message, fields }); sink.debug(message, fields); },
    info: (message, fields) => { entries.push({ level: "info", message, fields }); sink.info(message, fields); },
    warn: (message, fields) => { entries.push({ level: "warn", message, fields }); sink.warn(message, fields); },
    error: (message, fields) => { entries.push({ level: "error", message, fields }); sink.error(message, fields); },
  };
  const records: ReviewRecord[] = [];
  const inputs: ReviewInput[] = [];
  const prepared: RepositoryPrepareInput[] = [];
  const access: RepositoryReadAccess = {
    headSha: head,
    list: async () => ({ text: "fixture-private-path.ts", truncated: false }),
    read: async () => ({ text: "1: fixture-private-source", truncated: true }),
    search: async () => ({ text: "fixture-private-path.ts:1: fixture-private-source", truncated: false }),
  };
  let disposed = 0;
  let batchAttempts = 0;
  const change = { oldPath: "a.ts", newPath: "a.ts", diff: "@@ -1 +1 @@\n-old\n+new" };
  const client: GitlabClient = {
    getRepositoryReviewSnapshot: async () => {
      if (options.fail === "snapshot") throw new Error("synthetic snapshot failure");
      return { changes: [change], commits: [], refs: { headSha: head, baseSha: "b".repeat(40), startSha: "c".repeat(40) },
        sourceProjectId: 9, sourceBranch: "fixture-private-branch", repositoryUrl: "https://git.example.invalid/private/repo.git", gitlabUrl: task.gitlabUrl! };
    },
    getMergeRequestChanges: async () => [change], getMergeRequestCommits: async () => [],
    getMergeRequestVersions: async () => ({ headSha: head, baseSha: "b".repeat(40), startSha: "c".repeat(40) }),
    postMergeRequestNote: async () => { if (options.fail === "note") throw new Error("synthetic note failure"); },
    postDiscussion: async () => ({ id: "fixture", notes: [] }), getDiscussions: async () => [],
    getLatestHeadSha: async () => head, getFileRaw: async () => "fixture", getUser: async () => ({ id: 1, name: "fixture", username: "fixture" }),
  };
  const pipeline = createReviewPipeline({
    client, promptSource: prompts, logger, batchMaxTokens: 6000, retryDelayMs: 1,
    rules: { resolve: () => ({ systemPrompt: "fallback", userPrompt: "{diffs_text}" }) },
    repositoryProvider: { prepare: async (input) => {
      prepared.push(input);
      const emit = (event: RepositoryPreparationEvent) => input.onProgress?.(event);
      emit({ stage: "clone", phase: "start" });
      if (options.fail === "prepare") {
        emit({ stage: "clone", phase: "failed", durationMs: 1 });
        emit({ stage: "cleanup", phase: "start" });
        emit({ stage: "cleanup", phase: "complete", durationMs: 1 });
        throw new Error("synthetic clone failure");
      }
      emit({ stage: "clone", phase: "complete", durationMs: 2 });
      emit({ stage: "verify", phase: "start" });
      emit({ stage: "verify", phase: "complete", durationMs: 1 });
      emit({ stage: "index", phase: "start" });
      emit({ stage: "index", phase: "complete", durationMs: 1, indexedEntries: 8, candidateFiles: 4 });
      return { access, dispose: async () => {
        disposed += 1;
        emit({ stage: "cleanup", phase: "start" });
        if (options.fail === "cleanup") {
          emit({ stage: "cleanup", phase: "failed", durationMs: 1 });
          throw new Error("synthetic cleanup failure");
        }
        emit({ stage: "cleanup", phase: "complete", durationMs: 1 });
      } };
    } },
    reviewer: { review: async (input) => {
      inputs.push(input);
      const summary = input.systemPrompt.includes("你之前分批评审了同一变更的各部分");
      if (!summary) {
        batchAttempts += 1;
        if (options.useTools) {
          assert.ok(input.repositoryContext);
          const tools = createRepositoryTools(input.repositoryContext, input.signal, input.onRepositoryToolCall);
          const context = {} as Parameters<typeof tools[0]["execute"]>[4];
          await tools[0].execute("list", { query: "fixture-private-query" }, undefined, undefined, context);
          await tools[1].execute("read", { path: "fixture-private-path.ts" }, undefined, undefined, context);
          await tools[2].execute("search", { query: task.gitlabToken }, undefined, undefined, context);
        }
        if (options.retryBatch && batchAttempts === 1) throw new Error("synthetic transient batch failure");
      }
      return { text: "总分：90 分\n没有可定位的问题", model: "fixture-model" };
    } },
    recordWriter: { insert: (record) => { records.push(record); } },
  });
  return { pipeline, db, entries, lines, records, prepared, inputs, disposed: () => disposed };
}

test("开启时 INFO 日志串起快照、克隆、版本校验、索引与清理，并关联同一 MR", async () => {
  const h = harness();
  try {
    await h.pipeline.run(task);
    const names = h.entries.map((entry) => entry.message);
    const milestones = ["仓库上下文评审状态", "开始准备仓库评审快照", "仓库评审快照已锁定", "仓库浅克隆开始", "仓库浅克隆完成", "仓库固定版本校验开始", "仓库固定版本校验完成", "仓库文件索引开始", "仓库文件索引完成", "仓库上下文已准备", "仓库临时目录清理开始", "仓库临时目录清理完成"];
    let previous = -1;
    for (const name of milestones) {
      const index = names.indexOf(name);
      assert.ok(index > previous, `${name} 应存在且顺序正确`);
      previous = index;
      const entry = h.entries[index];
      assert.equal(entry.level, "info");
      assert.equal(entry.fields?.项目ID, task.projectId);
      assert.equal(entry.fields?.MR编号, task.iid);
    }
    assert.equal(h.entries.find((entry) => entry.message === "仓库上下文评审状态")?.fields?.已开启, true);
    const indexed = h.entries.find((entry) => entry.message === "仓库文件索引完成")?.fields;
    assert.equal(indexed?.索引条目数, 8);
    assert.equal(indexed?.候选文件数, 4);
    assert.equal(indexed?.提交SHA, head);
    assert.equal(h.disposed(), 1);
  } finally { h.db.close(); }
});

test("开启但模型未调用仓库工具时明确记零，不把准备完成当成已读取", async () => {
  const h = harness();
  try {
    await h.pipeline.run(task);
    const summary = h.entries.find((entry) => entry.message === "仓库工具调用统计")?.fields;
    assert.ok(summary);
    for (const key of ["总调用次数", "成功次数", "失败次数", "repo_list", "repo_read", "repo_search", "返回字符数", "截断次数"]) assert.equal(summary[key], 0);
    assert.equal(h.entries.filter((entry) => entry.message === "仓库工具调用完成").length, 0);
    assert.equal(h.inputs.at(-1)?.onRepositoryToolCall, undefined, "汇总会话不能携带仓库工具观察回调");
  } finally { h.db.close(); }
});

test("工具 DEBUG 只写元数据，INFO 按批次尝试统计且重试不会重复准备仓库", async () => {
  const h = harness({ useTools: true, retryBatch: true });
  try {
    await h.pipeline.run(task);
    const summaries = h.entries.filter((entry) => entry.message === "仓库工具调用统计");
    assert.equal(summaries.length, 2);
    for (const [index, entry] of summaries.entries()) {
      assert.equal(entry.level, "info");
      assert.equal(entry.fields?.尝试次数, index + 1);
      assert.equal(entry.fields?.总调用次数, 3);
      assert.equal(entry.fields?.成功次数, 3);
      assert.equal(entry.fields?.失败次数, 0);
      assert.equal(entry.fields?.repo_list, 1);
      assert.equal(entry.fields?.repo_read, 1);
      assert.equal(entry.fields?.repo_search, 1);
      assert.equal(entry.fields?.截断次数, 1);
      assert.ok(Number(entry.fields?.返回字符数) > 0);
    }
    const tools = h.entries.filter((entry) => entry.message === "仓库工具调用完成");
    assert.equal(tools.length, 6);
    assert.ok(tools.every((entry) => entry.level === "debug" && entry.fields?.项目ID === task.projectId && entry.fields?.MR编号 === task.iid && entry.fields?.提交SHA === head));
    assert.deepEqual(tools.slice(0, 3).map((entry) => entry.fields?.工具), ["repo_list", "repo_read", "repo_search"]);
    assert.equal(h.prepared.length, 1);
    assert.equal(h.disposed(), 1);
    const output = h.lines.join("\n");
    for (const privateValue of [task.gitlabToken!, "fixture-private-query", "fixture-private-source", "fixture-private-path.ts", "fixture-private-branch", "private/repo.git"]) assert.ok(!output.includes(privateValue));
  } finally { h.db.close(); }
});

test("INFO 级别保留调用统计，但不输出逐工具 DEBUG 日志", async () => {
  const h = harness({ useTools: true, level: "info" });
  try {
    await h.pipeline.run(task);
    assert.ok(h.lines.some((line) => line.includes("仓库工具调用统计")));
    assert.ok(!h.lines.some((line) => line.includes("仓库工具调用完成")));
  } finally { h.db.close(); }
});

test("关闭时只说明未开启，不准备仓库或输出虚假的工具/清理过程", async () => {
  const h = harness({ enabled: false });
  try {
    await h.pipeline.run(task);
    assert.equal(h.prepared.length, 0);
    assert.equal(h.entries.find((entry) => entry.message === "仓库上下文评审状态")?.fields?.已开启, false);
    assert.ok(!h.entries.some((entry) => /仓库浅克隆|仓库工具调用|仓库临时目录/.test(entry.message)));
    assert.ok(h.inputs.every((input) => input.repositoryContext === undefined && input.onRepositoryToolCall === undefined));
  } finally { h.db.close(); }
});

for (const fail of ["snapshot", "prepare", "note", "cleanup"] as const) {
  test(`${fail} 失败时日志如实反映阶段，保持原失败和清理语义`, async () => {
    const h = harness({ fail });
    try {
      await h.pipeline.run(task);
      assert.equal(h.records[0].result, fail === "cleanup" ? "success" : "failed");
      if (fail === "snapshot") {
        assert.ok(!h.entries.some((entry) => entry.message === "仓库评审快照已锁定"));
        assert.equal(h.prepared.length, 0);
      } else if (fail === "prepare") {
        assert.ok(h.entries.some((entry) => entry.message === "仓库浅克隆失败" && entry.level === "warn"));
        assert.ok(!h.entries.some((entry) => entry.message === "仓库浅克隆完成"));
        assert.ok(h.entries.some((entry) => entry.message === "仓库临时目录清理完成"));
      } else {
        assert.equal(h.disposed(), 1);
        assert.ok(h.entries.some((entry) => entry.message === `仓库临时目录清理${fail === "cleanup" ? "失败" : "完成"}`));
        if (fail === "cleanup") assert.ok(!h.entries.some((entry) => entry.message === "仓库临时目录清理完成"));
      }
    } finally { h.db.close(); }
  });
}

test("并发 MR 的阶段和工具统计不串任务", async () => {
  const h = harness({ useTools: true });
  try {
    await Promise.all([h.pipeline.run(task), h.pipeline.run({ ...task, iid: 3 })]);
    const summaries = h.entries.filter((entry) => entry.message === "仓库工具调用统计");
    assert.deepEqual(summaries.map((entry) => entry.fields?.MR编号).sort(), [2, 3]);
    assert.ok(summaries.every((entry) => entry.fields?.总调用次数 === 3));
    assert.equal(h.prepared.length, 2);
    assert.equal(h.disposed(), 2);
  } finally { h.db.close(); }
});
