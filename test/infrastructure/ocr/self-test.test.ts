import assert from "node:assert/strict";
import { access, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import test from "node:test";
import { createGitRunner } from "../../../src/infrastructure/git/git-runner.ts";
import { runOcrSelfTest } from "../../../src/infrastructure/ocr/self-test.ts";

test("OCR 自检把包含实际除零缺陷的两个 Git 提交交给同一评审运行器", async () => {
  const signal = new AbortController().signal;
  const git = createGitRunner();
  const path = "src/order_totals.py";
  const providerKey = `provider-credential-${"s".repeat(120)}`;
  const fallbackToken = `fallback-credential-${"t".repeat(120)}`;
  const description = "The tax calculation raises ZeroDivisionError for every order.";
  const beforeKey = description.padEnd(2030, " ");
  const runs: Array<{ workspace: string; baseSha: string; headSha: string }> = [];
  const result = await runOcrSelfTest({ signal, llmTarget: {
    model: "configured-model",
    provider: {
      id: 1, name: "configured", label: "Configured", kind: "custom", isDefault: true,
      baseUrl: "https://configured.example.test/v1", api: "openai-completions", apiKey: providerKey,
      models: ["configured-model"], defaultModel: "configured-model", createdAt: 0, updatedAt: 0,
    },
  } }, {
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, OCR_LLM_TOKEN: fallbackToken, OTHER_SECRET: "outside-fixture" },
    ocrRunner: async (args, options) => {
      assert.equal(args[0], "review");
      assert.equal(args[args.indexOf("--repo") + 1], options.cwd);
      assert.equal(options.env.OCR_LLM_URL, "https://configured.example.test/v1/chat/completions");
      assert.equal(options.env.OCR_LLM_MODEL, "configured-model");
      assert.equal(options.env.OCR_LLM_TOKEN, providerKey);
      assert.equal(options.env.OTHER_SECRET, undefined);
      assert.ok(!Object.values(options.env).some((value) => value?.includes("Authorization: Basic")));
      const baseSha = args[args.indexOf("--from") + 1];
      const headSha = args[args.indexOf("--to") + 1];
      runs.push({ workspace: dirname(options.cwd), baseSha, headSha });
      const gitText = async (...command: string[]) => (await git(command, options)).toString("utf8").trimEnd();
      assert.equal(await gitText("rev-parse", `${headSha}^`), baseSha);
      assert.match(await gitText("show", `${baseSha}:${path}`), /return subtotal \* 0\.2$/u);
      const changedLine = (await gitText("show", `${headSha}:${path}`)).split("\n")[2];
      assert.equal(changedLine, "    return subtotal // 0");
      const item = { path };
      await writeFile(args[args.indexOf("--output") + 1], JSON.stringify({
        status: "complete",
        comments: [{ path, start_line: 3, end_line: 3, severity: "high", category: "bug", existing_code: changedLine,
          content: `${beforeKey}${providerKey}\n${fallbackToken}`, suggestion_code: `    return subtotal * 0.2 # ${fallbackToken}` }],
        manifest: { schema_version: "ocr.run-manifest/v1", operation: "review", terminal_state: "complete",
          input: { mode: "range", resolved_base: baseSha, resolved_head: headSha },
          coverage: { selected: [item], completed: [item], reused: [], failed: [], waived: [], excluded: [] } },
        summary: { files_reviewed: 1 },
      }));
      return Buffer.alloc(0);
    },
  });

  assert.equal(result.complete, true);
  assert.equal(result.filesReviewed, 1);
  assert.equal(result.rawCommentsFormat, "array");
  assert.equal(runs.length, 1);
  const [{ baseSha, headSha, workspace }] = runs;
  assert.deepEqual(result.fixture, { path, line: 3, baseSha, headSha });
  assert.match(result.fixture.baseSha, /^[0-9a-f]{40}$/u);
  assert.match(result.fixture.headSha, /^[0-9a-f]{40}$/u);
  assert.notEqual(result.fixture.baseSha, result.fixture.headSha);
  assert.ok(!result.findings[0].body.slice(0, 2048).includes(providerKey.slice(0, 12)), "截断前必须先隐藏跨越边界的密钥");
  assert.deepEqual(result.findings, [{ path, line: 3, lineKey: "new_line", severity: "high", category: "bug",
    body: `${beforeKey}[凭据已隐去]\n[凭据已隐去]`, suggestionCode: "    return subtotal * 0.2 # [凭据已隐去]" }]);
  await assert.rejects(access(workspace), { code: "ENOENT" });
});

test("OCR 自检区分报告中的 null 和建议数组", async () => {
  const result = await runOcrSelfTest({ signal: new AbortController().signal }, {
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, OCR_LLM_URL: "https://mock.example.test/v1/chat/completions",
      OCR_LLM_TOKEN: "synthetic", OCR_LLM_MODEL: "synthetic" },
    ocrRunner: async (args) => {
      await writeFile(args[args.indexOf("--output") + 1], JSON.stringify({ status: "failed", comments: null }));
      return Buffer.alloc(0);
    },
  });
  assert.equal(result.rawCommentsFormat, "null");
  assert.deepEqual(result.findings, []);
  assert.equal(result.complete, false);
});

test("OCR 自检收到已取消信号时停止", async () => {
  const reason = new Error("cancelled fixture");
  await assert.rejects(runOcrSelfTest({ signal: AbortSignal.abort(reason) }), (error) => error === reason);
});
