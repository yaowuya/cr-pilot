import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../../../src/infrastructure/sqlite/database.ts";
import { createLlmProviderRepository, maskApiKey } from "../../../src/infrastructure/sqlite/llm-provider-repo.ts";
import type { LlmProviderInput } from "../../../src/domain/llm-provider.ts";

/** 构造一个最小可用的厂商入参。 */
function input(overrides: Partial<LlmProviderInput> = {}): LlmProviderInput {
  return {
    name: "deepseek",
    label: "DeepSeek",
    kind: "deepseek",
    baseUrl: "https://api.deepseek.com/v1",
    apiKey: "sk-test-0123456789",
    api: "openai-completions",
    models: ["deepseek-chat", "deepseek-reasoner"],
    isDefault: false,
    ...overrides,
  };
}

test("create 与 list 往返，密钥只回掩码", () => {
  const db = openDatabase(":memory:");
  const repo = createLlmProviderRepository(db);
  const created = repo.create(input());
  assert.equal(created.name, "deepseek");
  assert.deepEqual(created.models, ["deepseek-chat", "deepseek-reasoner"]);
  // 未指定 defaultModel 时自动取第一个模型，避免存下选不中的默认值。
  assert.equal(created.defaultModel, "deepseek-chat");

  const summary = repo.list()[0];
  assert.equal(summary.hasApiKey, true);
  assert.equal(summary.apiKeyMasked, "sk-t****6789");
  // 摘要里绝不能出现明文密钥。
  assert.equal(JSON.stringify(summary).includes("sk-test-0123456789"), false);
  db.close();
});

test("maskApiKey 短密钥整体掩码", () => {
  assert.equal(maskApiKey("short"), "****");
  assert.equal(maskApiKey("12345678"), "****");
  assert.equal(maskApiKey("123456789"), "1234****6789");
  assert.equal(maskApiKey(undefined), undefined);
});

test("defaultModel 不在清单内时回退第一个模型", () => {
  const db = openDatabase(":memory:");
  const repo = createLlmProviderRepository(db);
  const created = repo.create(input({ defaultModel: "not-in-list" }));
  assert.equal(created.defaultModel, "deepseek-chat");
  db.close();
});

test("模型清单去空去重", () => {
  const db = openDatabase(":memory:");
  const repo = createLlmProviderRepository(db);
  const created = repo.create(input({ models: ["a", " a ", "", "b", "b"] }));
  assert.deepEqual(created.models, ["a", "b"]);
  db.close();
});

test("重复 name 创建被拒并带业务语义消息", () => {
  const db = openDatabase(":memory:");
  const repo = createLlmProviderRepository(db);
  repo.create(input());
  assert.throws(() => repo.create(input({ label: "另一个" })), /已存在/);
  db.close();
});

test("isDefault 全局唯一：新默认会清掉旧的", () => {
  const db = openDatabase(":memory:");
  const repo = createLlmProviderRepository(db);
  repo.create(input({ name: "a", label: "A", isDefault: true }));
  repo.create(input({ name: "b", label: "B", isDefault: true }));
  const defaults = repo.list().filter((item) => item.isDefault);
  assert.equal(defaults.length, 1, "默认厂商必须全局唯一");
  assert.equal(defaults[0].name, "b");
  db.close();
});

test("getDefault 无标记时回退第一条，空库返回 undefined", () => {
  const db = openDatabase(":memory:");
  const repo = createLlmProviderRepository(db);
  assert.equal(repo.getDefault(), undefined, "空库没有默认厂商");
  repo.create(input({ name: "first", label: "第一个" }));
  repo.create(input({ name: "second", label: "第二个" }));
  // 老部署升级后可能只有数据没有 is_default 标记，此时不该失效。
  assert.equal(repo.getDefault()?.name, "first");
  db.close();
});

test("update 保留未提交的 apiKey", () => {
  const db = openDatabase(":memory:");
  const repo = createLlmProviderRepository(db);
  const created = repo.create(input());
  // 页面保存时若不改密钥，传的是掩码或空串——调用方负责换成原值，
  // 仓储层只忠实写入收到的 apiKey；这里验证「不传」时不会丢密钥。
  const updated = repo.update(created.id, {
    ...input(),
    apiKey: created.apiKey,
    label: "改名了",
  });
  assert.equal(updated.label, "改名了");
  assert.equal(updated.apiKey, "sk-test-0123456789");
  db.close();
});

test("resolveTarget：项目绑定优先于全局默认", () => {
  const db = openDatabase(":memory:");
  const repo = createLlmProviderRepository(db);
  const a = repo.create(input({ name: "a", label: "A", isDefault: true }));
  const b = repo.create(input({ name: "b", label: "B" }));
  repo.bindProject("group/special", b.id, "deepseek-reasoner");

  const special = repo.resolveTarget("group/special");
  assert.equal(special?.provider.name, "b");
  assert.equal(special?.model, "deepseek-reasoner");

  const normal = repo.resolveTarget("group/normal");
  assert.equal(normal?.provider.name, "a", "未绑定项目回落全局默认");
  assert.equal(normal?.model, "deepseek-chat");
  assert.equal(a.name, "a");
  db.close();
});

test("resolveTarget：绑定不存在的厂商时回落全局默认", () => {
  const db = openDatabase(":memory:");
  const repo = createLlmProviderRepository(db);
  repo.create(input({ name: "a", label: "A", isDefault: true }));
  const b = repo.create(input({ name: "b", label: "B" }));
  repo.bindProject("group/x", b.id);
  repo.remove(b.id); // 厂商被删，绑定由外键级联清理
  const target = repo.resolveTarget("group/x");
  assert.equal(target?.provider.name, "a");
  db.close();
});

test("remove 级联清理项目绑定", () => {
  const db = openDatabase(":memory:");
  const repo = createLlmProviderRepository(db);
  const created = repo.create(input());
  repo.bindProject("group/x", created.id);
  assert.equal(repo.listProjectBindings().length, 1);
  repo.remove(created.id);
  assert.equal(repo.listProjectBindings().length, 0, "删厂商必须连带删绑定");
  db.close();
});

test("unbindProject 删除单条绑定", () => {
  const db = openDatabase(":memory:");
  const repo = createLlmProviderRepository(db);
  const created = repo.create(input());
  repo.bindProject("group/x", created.id);
  repo.unbindProject("group/x");
  assert.equal(repo.listProjectBindings().length, 0);
  db.close();
});

test("空库 resolveTarget 返回 undefined，由调用方回落 models.json", () => {
  const db = openDatabase(":memory:");
  const repo = createLlmProviderRepository(db);
  assert.equal(repo.resolveTarget("any/project"), undefined);
  db.close();
});
