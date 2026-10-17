import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apiKeyEnvName, buildModelsJson, writeModelsJson } from "../../../src/infrastructure/pi/models-json.ts";
import type { LlmProvider } from "../../../src/domain/llm-provider.ts";

/** 构造一个完整厂商对象（只关心 models.json 相关字段）。 */
function provider(overrides: Partial<LlmProvider> = {}): LlmProvider {
  return {
    id: 1,
    name: "deepseek",
    label: "DeepSeek",
    kind: "deepseek",
    baseUrl: "https://api.deepseek.com/v1",
    apiKey: "sk-secret",
    api: "openai-completions",
    models: ["deepseek-chat"],
    defaultModel: "deepseek-chat",
    isDefault: true,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

test("buildModelsJson 生成 provider 与模型清单", () => {
  const result = buildModelsJson([provider()]);
  assert.ok(result);
  const entry = result.providers.deepseek;
  assert.equal(entry.baseUrl, "https://api.deepseek.com/v1");
  assert.equal(entry.api, "openai-completions");
  assert.equal(entry.models.length, 1);
  assert.equal(entry.models[0].id, "deepseek-chat");
  // pi 要求这些字段齐全，缺失会导致模型加载失败。
  assert.deepEqual(entry.models[0].input, ["text"]);
  assert.equal(typeof entry.models[0].contextWindow, "number");
  assert.equal(typeof entry.models[0].maxTokens, "number");
  assert.equal(typeof entry.models[0].reasoning, "boolean");
});

test("models.json 里不写明文密钥，只写环境变量引用", () => {
  const result = buildModelsJson([provider({ apiKey: "sk-very-secret-value" })]);
  assert.ok(result);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("sk-very-secret-value"), false, "models.json 不得包含明文密钥");
  assert.equal(result.providers.deepseek.apiKey, "$LLM_KEY_DEEPSEEK");
});

test("apiKeyEnvName 生成合法且稳定的大写变量名", () => {
  assert.equal(apiKeyEnvName("deepseek"), "LLM_KEY_DEEPSEEK");
  assert.equal(apiKeyEnvName("my-gw"), "LLM_KEY_MY_GW");
  assert.equal(apiKeyEnvName("a.b c"), "LLM_KEY_A_B_C");
});

test("空厂商列表返回 undefined，调用方据此不覆盖既有文件", () => {
  assert.equal(buildModelsJson([]), undefined);
});

test("writeModelsJson 落盘 models.json 与 settings.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "cr-pilot-models-"));
  try {
    const result = writeModelsJson({ agentDir: dir, providers: [provider()], defaultProvider: provider() });
    assert.equal(result.written, true);
    assert.equal(result.defaultModel, "deepseek-chat");

    const models = JSON.parse(readFileSync(join(dir, "models.json"), "utf8")) as {
      providers: Record<string, { models: Array<{ id: string }> }>;
    };
    assert.equal(models.providers.deepseek.models[0].id, "deepseek-chat");

    const settings = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")) as { defaultModel: string };
    assert.equal(settings.defaultModel, "deepseek-chat");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeModelsJson 空列表不写文件", () => {
  const dir = mkdtempSync(join(tmpdir(), "cr-pilot-models-"));
  try {
    const result = writeModelsJson({ agentDir: dir, providers: [] });
    assert.equal(result.written, false);
    assert.throws(() => readFileSync(join(dir, "models.json"), "utf8"), /ENOENT/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("多厂商同时写入，互不覆盖", () => {
  const result = buildModelsJson([
    provider({ id: 1, name: "deepseek", models: ["deepseek-chat"] }),
    provider({ id: 2, name: "openai", models: ["gpt-4o"], api: "openai-responses", baseUrl: "https://api.openai.com/v1" }),
  ]);
  assert.ok(result);
  assert.deepEqual(Object.keys(result.providers).sort(), ["deepseek", "openai"]);
  assert.equal(result.providers.openai.api, "openai-responses");
});
