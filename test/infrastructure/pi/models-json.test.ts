import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("writeModelsJson 保留文件里已有的其他厂商，不整体覆盖", () => {
  // 回归：生产部署依赖仓库里手写的 models.json（llmgw）。早期实现是整体
  // 覆盖，数据库一旦有厂商就会把这份手写配置静默抹掉。
  const dir = mkdtempSync(join(tmpdir(), "cr-pilot-models-"));
  try {
    writeFileSync(
      join(dir, "models.json"),
      JSON.stringify({
        providers: {
          llmgw: { baseUrl: "https://llmgw.cwoa.net/v1", api: "openai-responses", apiKey: "$LLMGW_API_KEY", models: [{ id: "gpt-5.6-terra" }] },
        },
      }),
      "utf8",
    );
    writeModelsJson({ agentDir: dir, providers: [provider({ name: "deepseek" })] });

    const written = JSON.parse(readFileSync(join(dir, "models.json"), "utf8")) as {
      providers: Record<string, { apiKey: string }>;
    };
    assert.ok(written.providers.llmgw, "手写的 llmgw 配置必须保留");
    assert.equal(written.providers.llmgw.apiKey, "$LLMGW_API_KEY");
    assert.ok(written.providers.deepseek, "数据库里的厂商要写进去");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeModelsJson 中数据库厂商覆盖同名手写项", () => {
  const dir = mkdtempSync(join(tmpdir(), "cr-pilot-models-"));
  try {
    writeFileSync(
      join(dir, "models.json"),
      JSON.stringify({
        providers: { deepseek: { baseUrl: "https://old.example/v1", api: "openai-completions", apiKey: "$OLD", models: [{ id: "old" }] } },
      }),
      "utf8",
    );
    writeModelsJson({ agentDir: dir, providers: [provider({ name: "deepseek", baseUrl: "https://api.deepseek.com/v1" })] });

    const written = JSON.parse(readFileSync(join(dir, "models.json"), "utf8")) as {
      providers: Record<string, { baseUrl: string }>;
    };
    assert.equal(written.providers.deepseek.baseUrl, "https://api.deepseek.com/v1", "同名项以数据库为准");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeModelsJson 遇到损坏的旧文件时不抛错", () => {
  const dir = mkdtempSync(join(tmpdir(), "cr-pilot-models-"));
  try {
    writeFileSync(join(dir, "models.json"), "{ 这不是合法 JSON", "utf8");
    // 坏文件应被本次写入修好，而不是阻断启动
    const result = writeModelsJson({ agentDir: dir, providers: [provider()] });
    assert.equal(result.written, true);
    const written = JSON.parse(readFileSync(join(dir, "models.json"), "utf8")) as { providers: Record<string, unknown> };
    assert.ok(written.providers.deepseek);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("内容未变化时不重写文件（保持入库文件不被格式化污染）", () => {
  // 回归：早期实现每次启动都重新序列化 models.json，即使 providers 没变，
  // 也会因格式差异（["text"] 展开成多行）让入库文件变成「已修改」，
  // 污染 git 工作区，甚至被误提交覆盖掉手写配置。
  const dir = mkdtempSync(join(tmpdir(), "cr-pilot-models-"));
  try {
    const first = writeModelsJson({ agentDir: dir, providers: [provider()] });
    assert.equal(first.written, true, "首次写入应发生");

    const before = readFileSync(join(dir, "models.json"), "utf8");
    const second = writeModelsJson({ agentDir: dir, providers: [provider()] });
    assert.equal(second.written, false, "内容未变不应重写");
    assert.equal(readFileSync(join(dir, "models.json"), "utf8"), before, "文件内容必须逐字节不变");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("providers 变化时仍会重写", () => {
  const dir = mkdtempSync(join(tmpdir(), "cr-pilot-models-"));
  try {
    writeModelsJson({ agentDir: dir, providers: [provider({ models: ["a"] })] });
    const result = writeModelsJson({ agentDir: dir, providers: [provider({ models: ["a", "b"] })] });
    assert.equal(result.written, true, "模型清单变化必须落盘");
    const content = JSON.parse(readFileSync(join(dir, "models.json"), "utf8")) as {
      providers: Record<string, { models: Array<{ id: string }> }>;
    };
    assert.equal(content.providers.deepseek.models.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
