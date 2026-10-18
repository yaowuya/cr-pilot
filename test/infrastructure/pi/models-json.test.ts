import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("以模板为底座：数据库只配一个厂商时，模板里的其他厂商保留", () => {
  // D-025：models.json 是运行时产物（不入库），初始配置来自 models.template.json。
  // 数据库为空时用模板兜底；数据库有配置时以模板为底座、按 name 覆盖同名项。
  const dir = mkdtempSync(join(tmpdir(), "cr-pilot-models-"));
  try {
    writeFileSync(
      join(dir, "models.template.json"),
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
    assert.ok(written.providers.llmgw, "模板里的 llmgw 底座必须保留");
    assert.equal(written.providers.llmgw.apiKey, "$LLMGW_API_KEY");
    assert.ok(written.providers.deepseek, "数据库里的厂商要写进去");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("数据库配置按 name 覆盖模板里的同名厂商", () => {
  const dir = mkdtempSync(join(tmpdir(), "cr-pilot-models-"));
  try {
    writeFileSync(
      join(dir, "models.template.json"),
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

test("数据库为空时用模板兜底，保证新机器首次部署可启动", () => {
  // 没有这条兜底，新部署（数据库空）不会产出 models.json，
  // SDK 读不到文件会报「No API key found」而不是「没配厂商」。
  const dir = mkdtempSync(join(tmpdir(), "cr-pilot-models-"));
  try {
    writeFileSync(
      join(dir, "models.template.json"),
      JSON.stringify({
        providers: { llmgw: { baseUrl: "https://x/v1", api: "openai-responses", apiKey: "$K", models: [{ id: "m" }] } },
      }),
      "utf8",
    );
    const result = writeModelsJson({ agentDir: dir, providers: [] });
    assert.equal(result.written, true, "数据库为空但有模板时应生成文件");
    const written = JSON.parse(readFileSync(join(dir, "models.json"), "utf8")) as {
      providers: Record<string, unknown>;
    };
    assert.ok(written.providers.llmgw, "内容应来自模板");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("数据库与模板都为空时不写文件，由启动日志告警", () => {
  const dir = mkdtempSync(join(tmpdir(), "cr-pilot-models-"));
  try {
    const result = writeModelsJson({ agentDir: dir, providers: [] });
    assert.equal(result.written, false);
    assert.throws(() => readFileSync(join(dir, "models.json"), "utf8"), /ENOENT/);
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

test("仓库内的 models.template.json 是合法模板且已入库", () => {
  // D-025：models.json 是运行时产物（已 gitignore），初始配置靠模板。
  // 模板缺失会导致新部署首次启动没有可用模型配置，因此必须入库并校验。
  const templatePath = join(process.cwd(), "pi-agent", "models.template.json");
  assert.equal(existsSync(templatePath), true, "pi-agent/models.template.json 必须存在");

  const parsed = JSON.parse(readFileSync(templatePath, "utf8")) as {
    providers: Record<string, { baseUrl?: string; apiKey?: string; models?: unknown[] }>;
  };
  assert.ok(parsed.providers && Object.keys(parsed.providers).length > 0, "模板至少含一个厂商");
  for (const [name, item] of Object.entries(parsed.providers)) {
    assert.ok(item.baseUrl, `${name} 缺少 baseUrl`);
    // 密钥必须是环境变量引用，不能是明文
    assert.match(item.apiKey ?? "", /^\$[A-Z_]+$/, `${name} 的 apiKey 必须是环境变量引用`);
    assert.ok(Array.isArray(item.models) && item.models.length > 0, `${name} 缺少模型清单`);
  }
});
