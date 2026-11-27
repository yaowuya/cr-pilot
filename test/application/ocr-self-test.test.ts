import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as wait } from "node:timers/promises";
import { createOcrSelfTestVerifier, type OcrSelfTestRunResult } from "../../src/application/ocr-self-test.ts";
import { createLlmProviderRepository } from "../../src/infrastructure/sqlite/llm-provider-repo.ts";
import { openDatabase } from "../../src/infrastructure/sqlite/database.ts";
import { createPromptRepository } from "../../src/infrastructure/sqlite/prompt-repo.ts";
import { createSilentLogger } from "../../src/shared/logger.ts";

const fixture = { path: "src/order_totals.py", line: 3, baseSha: "a".repeat(40), headSha: "b".repeat(40) };
const result: OcrSelfTestRunResult = {
  fixture, complete: true, filesReviewed: 1, unreviewedPaths: [], findings: [], rawCommentsFormat: "null",
};
const defect = { path: fixture.path, line: fixture.line, lineKey: "new_line" as const, severity: "high",
  body: "This expression will raise ZeroDivisionError whenever the function is called." };
const logger = createSilentLogger();

test("OCR 自检按项目实际模型运行，并返回明确命中的建议和真实扣分", async () => {
  const db = openDatabase(":memory:");
  try {
    const providers = createLlmProviderRepository(db);
    const prompts = createPromptRepository(db);
    const global = providers.create({
      name: "global", label: "Global", kind: "openai", api: "openai-completions", baseUrl: "https://models.example.com/v1",
      apiKey: "fixture-global-secret", models: ["global-model"], defaultModel: "global-model", isDefault: true,
    });
    const project = providers.create({
      name: "project-ai", label: "Project", kind: "openai", api: "openai-completions", baseUrl: "https://models.example.com/v1",
      apiKey: "fixture-project-secret", models: ["project-model", "alt"], defaultModel: "project-model", isDefault: false,
    });
    prompts.create({ repository: "shop", projects: ["dev/shop"], systemPrompt: "strict", userPrompt: "{diffs_text}",
      providerId: project.id, model: "alt" });
    const seen: Array<string | undefined> = [];
    const verify = createOcrSelfTestVerifier({
      logger, prompts, providers, run: async ({ llmTarget }) => {
        seen.push(llmTarget?.model);
        return { ...result, findings: [defect], rawCommentsFormat: "array" };
      },
    });
    const outcome = await verify("dev/shop");
    assert.equal(outcome.success, true);
    assert.equal(outcome.ocr?.verdict, "detected");
    assert.equal(outcome.ocr?.score, 95);
    assert.equal(outcome.ocr?.model, "alt");
    assert.equal(outcome.ocr?.provider, "project-ai");
    assert.equal(outcome.ocr?.rawCommentsFormat, "array");
    assert.deepEqual(outcome.ocr?.findings, [{
      path: fixture.path, line: fixture.line, severity: "high", message: defect.body,
    }]);
    assert.doesNotMatch(JSON.stringify(outcome), /fixture-project-secret|models\.example\.com/);
    assert.equal((await verify()).ocr?.provider, global.name);
    assert.deepEqual(seen, ["alt", "global-model"]);
  } finally {
    db.close();
  }
});

test("OCR 自检区分满分漏检、无关建议和覆盖不足", async () => {
  const cases: Array<[OcrSelfTestRunResult, string, number | null]> = [
    [result, "missed", 100],
    [{ ...result, findings: [{ ...defect, body: "Improve the function name." }] }, "missed", 95],
    [{ ...result, complete: false, findings: [defect] }, "incomplete", null],
  ];
  for (const [output, verdict, score] of cases) {
    const verify = createOcrSelfTestVerifier({ logger, run: async () => output });
    const outcome = await verify();
    assert.equal(outcome.success, false);
    assert.equal(outcome.ocr?.verdict, verdict);
    assert.equal(outcome.ocr?.score, score);
  }
  const verify = createOcrSelfTestVerifier({ logger, run: async () => { throw new Error("private upstream secret"); } });
  const failure = await verify();
  assert.equal(failure.success, false);
  assert.doesNotMatch(JSON.stringify(failure), /private upstream secret/);
});

test("OCR 自检通过信号限制样例运行耗时", async () => {
  const verify = createOcrSelfTestVerifier({
    logger, timeoutMs: 5, run: async ({ signal }) => {
      await wait(1000, undefined, { signal });
      return result;
    },
  });
  const outcome = await verify();
  assert.equal(outcome.success, false);
  assert.equal(outcome.message, "OCR 自检超时");
  assert.equal(outcome.ocr, undefined);
});

test("OCR 自检接口只展示固定样例文件上的建议", async () => {
  const verify = createOcrSelfTestVerifier({
    logger, run: async () => ({ ...result, complete: false, findings: [{ ...defect, path: "unexpected.py" }] }),
  });
  const outcome = await verify();
  assert.equal(outcome.ocr?.verdict, "incomplete");
  assert.deepEqual(outcome.ocr?.findings, []);
});
