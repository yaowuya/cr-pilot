import assert from "node:assert/strict";
import { access, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { LlmApiKind, ResolvedLlmTarget } from "../../../src/domain/llm-provider.ts";
import type { RepositoryReviewSnapshot } from "../../../src/domain/repository-context.ts";
import { GitProcessError } from "../../../src/infrastructure/git/git-runner.ts";
import { createOcrReviewer, parseOcrReview } from "../../../src/infrastructure/ocr/reviewer.ts";

const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);
const snapshot: RepositoryReviewSnapshot = {
  changes: [{
    oldPath: "src/order.ts", newPath: "src/order.ts",
    diff: "@@ -5,2 +5,2 @@\n-const previous = true;\n+const current = true;\n-const shared = false;\n+ const shared = false;\n",
  }, { oldPath: "src/order.test.ts", newPath: "src/order.test.ts", diff: "" }],
  commits: [{ id: headSha, message: "Change order handling" }],
  refs: { baseSha, headSha, startSha: "c".repeat(40) },
  sourceProjectId: 42,
  sourceBranch: "change-order",
  repositoryUrl: "https://gitlab.example.com/team/service.git",
  gitlabUrl: "https://gitlab.example.com",
};

const reviewed = { item_id: "order-item", path: "src/order.ts", old_path: "src/order.ts", new_path: "src/order.ts" };
const excluded = { item_id: "test-item", path: "src/order.test.ts", exclude_reason: "default_path" };
const validReport = {
  status: "complete",
  comments: [{ path: "src/order.ts", start_line: 5, end_line: 5, severity: "high", content: "Handle an empty order.", category: "bug", existing_code: "const current = true;" }],
  summary: { files_reviewed: 1, input_tokens: 15, output_tokens: 8, cache_read_tokens: 3, cache_write_tokens: 2, total_tokens: 23 },
  manifest: {
    schema_version: "ocr.run-manifest/v1",
    operation: "review",
    terminal_state: "complete",
    input: { mode: "range", resolved_base: baseSha, resolved_head: headSha, exact_range: `${baseSha}..${headSha}` },
    coverage: { selected: [reviewed], completed: [reviewed], reused: [], failed: [], waived: [], excluded: [excluded] },
  },
};

test("OCR 将匹配版本且覆盖完整的报告映射为结构化建议", () => {
  const result = parseOcrReview(JSON.stringify(validReport), snapshot);
  assert.deepEqual(result, {
    findings: [{ path: "src/order.ts", line: 5, lineKey: "new_line", body: "Handle an empty order.", severity: "high", category: "bug" }],
    complete: true,
    filesReviewed: 1,
    unreviewedPaths: ["src/order.test.ts"],
    tokenUsage: { input: 10, output: 8, cacheRead: 3, cacheWrite: 2, totalTokens: 23 },
  });
});

test("OCR 只在 diff 唯一证实代码片段时选择行号侧", () => {
  const report = { ...validReport, comments: [
    { ...validReport.comments[0], existing_code: "const previous = true;" },
    { ...validReport.comments[0], existing_code: "const shared = false;", start_line: 6, end_line: 6 },
    { ...validReport.comments[0], existing_code: "const missing = true;" },
  ] };
  const { findings } = parseOcrReview(JSON.stringify(report), snapshot);
  assert.deepEqual(findings.map(({ line, lineKey }) => [line, lineKey]), [[5, "old_line"], [6, undefined], [5, undefined]]);
});

test("OCR 保留已有建议，同时拒绝未覆盖的 GitLab 文件和过大的已排除文件", () => {
  for (const expectedExclusions of [[], [{ ...excluded, exclude_reason: "too_large" }]]) {
    const report = structuredClone(validReport);
    report.manifest.coverage.excluded = expectedExclusions;
    const result = parseOcrReview(JSON.stringify(report), snapshot);
    assert.equal(result.complete, false);
    assert.equal(result.findings.length, 1);
    assert.deepEqual(result.unreviewedPaths, ["src/order.test.ts"]);
  }
});

test("OCR 的失败状态与未知严重级别保留未完成的评审信息", () => {
  const report = structuredClone(validReport);
  report.status = report.manifest.terminal_state = "partial";
  report.comments[0].severity = "unexpected";
  const result = parseOcrReview(JSON.stringify(report), snapshot);
  assert.equal(result.complete, false);
  assert.equal(result.findings[0].severity, "");
});

test("OCR 报告以 null 表示没有问题时仍然读取覆盖率", () => {
  const report = { ...validReport, comments: null };
  const result = parseOcrReview(JSON.stringify(report), snapshot);
  assert.deepEqual(result.findings, []);
  assert.equal(result.complete, true);
});

test("OCR 不能根据未知覆盖契约或损坏的失败清单认定已经完成", () => {
  const unsupported = structuredClone(validReport);
  unsupported.manifest.schema_version = "ocr.run-manifest/v2";
  assert.equal(parseOcrReview(JSON.stringify(unsupported), snapshot).complete, false);

  const corrupt = structuredClone(validReport);
  const report = { ...corrupt, manifest: { ...corrupt.manifest, coverage: { ...corrupt.manifest.coverage, failed: [{}] } } };
  assert.equal(parseOcrReview(JSON.stringify(report), snapshot).complete, false);
});

test("OCR 拒绝不同提交返回的报告", () => {
  const report = structuredClone(validReport);
  report.manifest.input.resolved_head = "d".repeat(40);
  assert.throws(() => parseOcrReview(JSON.stringify(report), snapshot), /版本/);
});

test("OCR 使用固定范围的独立工作目录并在任务结束后清理", async () => {
  let taskDir = "";
  const reviewer = createOcrReviewer({
    env: { OCR_LLM_URL: "https://models.example.com/v1/chat/completions", OCR_LLM_TOKEN: "ocr-credential", OCR_LLM_MODEL: "test-model", UNRELATED_SECRET: "app-credential" },
    gitRunner: async (args, { cwd, env }) => {
      if (args[0] === "fetch") {
        assert.equal(args.at(-1), headSha);
        assert.equal(env.OCR_LLM_TOKEN, undefined);
        assert.ok(Object.values(env).some((value) => value?.includes(Buffer.from("oauth2:gitlab-credential").toString("base64"))));
      }
      if (args[0] === "merge-base") return Buffer.from(baseSha);
      taskDir = String(env.HOME);
      if (args[0] === "init") assert.equal(cwd, join(taskDir, "repo"));
      return Buffer.alloc(0);
    },
    ocrRunner: async (args, { cwd, env }) => {
      assert.equal(args[args.indexOf("--repo") + 1], cwd);
      assert.equal(args[args.indexOf("--from") + 1], baseSha);
      assert.equal(args[args.indexOf("--to") + 1], headSha);
      assert.equal(env.OCR_LLM_TOKEN, "ocr-credential");
      assert.equal(env.UNRELATED_SECRET, undefined);
      assert.ok(!Object.values(env).some((value) => value?.includes("gitlab-credential")));
      assert.deepEqual(await readdir(cwd), []);
      await writeFile(args[args.indexOf("--output") + 1], JSON.stringify(validReport));
      return Buffer.alloc(0);
    },
  });

  const result = await reviewer.review({ snapshot, token: "gitlab-credential", signal: new AbortController().signal });
  assert.equal(result.complete, true);
  await assert.rejects(access(taskDir), { code: "ENOENT" });
});

test("Git merge-base 与快照不同则不调用 OCR", async () => {
  const reviewer = createOcrReviewer({
    env: { OCR_LLM_URL: "https://models.example.com/v1/chat/completions", OCR_LLM_TOKEN: "ocr-credential", OCR_LLM_MODEL: "test-model" },
    gitRunner: async (args) => Buffer.from(args[0] === "merge-base" ? "d".repeat(40) : ""),
    ocrRunner: async () => assert.fail("OCR must not review a different range"),
  });
  await assert.rejects(reviewer.review({ snapshot, token: "gitlab-credential", signal: new AbortController().signal }), /基线/);
});

test("OCR 非零退出仍保留已写入的部分结果", async () => {
  const reviewer = createOcrReviewer({
    env: { OCR_LLM_URL: "https://models.example.com/v1/chat/completions", OCR_LLM_TOKEN: "ocr-credential", OCR_LLM_MODEL: "test-model" },
    gitRunner: async (args) => Buffer.from(args[0] === "merge-base" ? baseSha : ""),
    ocrRunner: async (args) => {
      const report = structuredClone(validReport);
      report.status = report.manifest.terminal_state = "partial";
      await writeFile(args[args.indexOf("--output") + 1], JSON.stringify(report));
      throw new GitProcessError("failed");
    },
  });

  const result = await reviewer.review({ snapshot, token: "gitlab-credential", signal: new AbortController().signal });
  assert.equal(result.complete, false);
  assert.equal(result.findings[0].severity, "high");
});

test("OCR 超时后仍可保留已写出的有效结果，但不能视为完整", async () => {
  const abort = new AbortController();
  const reviewer = createOcrReviewer({
    env: { OCR_LLM_URL: "https://models.example.com/v1/chat/completions", OCR_LLM_TOKEN: "ocr-credential", OCR_LLM_MODEL: "test-model" },
    gitRunner: async (args) => Buffer.from(args[0] === "merge-base" ? baseSha : ""),
    ocrRunner: async (args) => {
      await writeFile(args[args.indexOf("--output") + 1], JSON.stringify(validReport));
      abort.abort(new Error("评审超时"));
      throw new GitProcessError("aborted");
    },
  });

  const result = await reviewer.review({ snapshot, token: "gitlab-credential", signal: abort.signal });
  assert.equal(result.complete, false);
  assert.equal(result.findings[0].severity, "high");
});

const legacyModelEnv = {
  OCR_LLM_URL: "https://fallback.example.com/v1/chat/completions",
  OCR_LLM_TOKEN: "fallback-key",
  OCR_LLM_MODEL: "fallback-model",
  OCR_LLM_PROTOCOL: "openai",
  OCR_LLM_AUTH_HEADER: "authorization",
  OCR_LLM_TIMEOUT: "15",
};

function llmTarget(api: LlmApiKind, baseUrl: string): ResolvedLlmTarget {
  return {
    provider: {
      id: 1, name: "saved-gateway", label: "Saved Gateway", kind: "custom", api, baseUrl, apiKey: "saved-key",
      models: ["default-model", "selected-model"], defaultModel: "default-model", isDefault: true, createdAt: 1, updatedAt: 1,
    },
    model: "selected-model",
  };
}

test("OCR 优先复用选中的模型、密钥和协议并保留 API 网关路径", async (t) => {
  const cases: Array<{ api: LlmApiKind; baseUrl: string; path: string; protocol: string; authHeader?: string }> = [
    { api: "openai-completions", baseUrl: "/api/paas/v4/", path: "/api/paas/v4/chat/completions", protocol: "openai" },
    { api: "openai-completions", baseUrl: "/v1/chat/completions/", path: "/v1/chat/completions", protocol: "openai" },
    { api: "openai-responses", baseUrl: "/tenant/openai/v1", path: "/tenant/openai/v1/responses", protocol: "openai-responses" },
    { api: "openai-responses", baseUrl: "/v1/responses/", path: "/v1/responses", protocol: "openai-responses" },
    { api: "anthropic-messages", baseUrl: "/v1", path: "/v1/messages", protocol: "anthropic", authHeader: "x-api-key" },
    { api: "anthropic-messages", baseUrl: "/v1/anthropic", path: "/v1/anthropic/v1/messages", protocol: "anthropic", authHeader: "x-api-key" },
    { api: "anthropic-messages", baseUrl: "/gateway/v1/messages/", path: "/gateway/v1/messages", protocol: "anthropic", authHeader: "x-api-key" },
  ];
  for (const { api, baseUrl, path, protocol, authHeader } of cases) {
    await t.test(`${api} ${baseUrl}`, async () => {
      const reviewer = createOcrReviewer({
        env: { ...legacyModelEnv, UNRELATED_SECRET: "app-credential" },
        gitRunner: async (args, { env }) => {
          assert.equal(env.OCR_LLM_TOKEN, undefined);
          return Buffer.from(args[0] === "merge-base" ? baseSha : "");
        },
        ocrRunner: async (args, { env }) => {
          assert.equal(env.OCR_LLM_URL, `https://gateway.example.com${path}`);
          assert.equal(env.OCR_LLM_TOKEN, "saved-key");
          assert.equal(env.OCR_LLM_MODEL, "selected-model");
          assert.equal(env.OCR_LLM_PROTOCOL, protocol);
          assert.equal(env.OCR_LLM_AUTH_HEADER, authHeader);
          assert.equal(env.OCR_LLM_TIMEOUT, undefined);
          assert.equal(env.UNRELATED_SECRET, undefined);
          await writeFile(args[args.indexOf("--output") + 1], JSON.stringify(validReport));
          return Buffer.alloc(0);
        },
      });
      const result = await reviewer.review({ snapshot, token: "gitlab-credential", signal: new AbortController().signal,
        llmTarget: llmTarget(api, `https://gateway.example.com${baseUrl}`) });
      assert.equal(result.complete, true);
    });
  }
});

test("OCR 已选厂商缺少密钥或不可兼容时直接报错且不开启子进程", async () => {
  const missingKey = llmTarget("openai-completions", "https://gateway.example.com");
  delete missingKey.provider.apiKey;
  const reviewer = createOcrReviewer({
    env: legacyModelEnv,
    gitRunner: async () => assert.fail("不应启动 Git 进程"),
    ocrRunner: async () => assert.fail("不应启动 OCR 进程"),
  });
  const input = { snapshot, token: "gitlab-credential", signal: new AbortController().signal };
  await assert.rejects(reviewer.review({ ...input, llmTarget: missingKey }), /所选.*密钥/);
  await assert.rejects(reviewer.review({ ...input, llmTarget: llmTarget("openai-codex-responses" as LlmApiKind, "https://gateway.example.com/v1") }), /不支持.*协议/);
  const oauthTarget = llmTarget("anthropic-messages", "https://gateway.example.com/v1");
  oauthTarget.provider.apiKey = "sk-ant-oat-example";
  await assert.rejects(reviewer.review({ ...input, llmTarget: oauthTarget }), (error: Error) =>
    /Anthropic.*API 密钥/.test(error.message) && !error.message.includes("sk-ant-oat-example"));
  const unsafeUrl = llmTarget("openai-responses", "https://gateway.example.com/v1?api-key=secret-in-url");
  await assert.rejects(reviewer.review({ ...input, llmTarget: unsafeUrl }), (error: Error) =>
    /地址.*查询/.test(error.message) && !error.message.includes("secret-in-url"));
  await assert.rejects(reviewer.review({ ...input, llmTarget: llmTarget("openai-responses", "https://gateway.example.com/v1/chat/completions") }), /地址.*协议/);
});

test("OCR 没有选中的厂商时沿用独立环境配置", async () => {
  const reviewer = createOcrReviewer({
    env: legacyModelEnv,
    gitRunner: async (args) => Buffer.from(args[0] === "merge-base" ? baseSha : ""),
    ocrRunner: async (args, { env }) => {
      assert.deepEqual(Object.fromEntries(Object.keys(legacyModelEnv).map((name) => [name, env[name]])), legacyModelEnv);
      await writeFile(args[args.indexOf("--output") + 1], JSON.stringify(validReport));
      return Buffer.alloc(0);
    },
  });
  assert.equal((await reviewer.review({ snapshot, token: "gitlab-credential", signal: new AbortController().signal })).complete, true);
});
