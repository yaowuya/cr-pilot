import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { buildVerifyMessage, createFeatureVerifier } from "../../src/application/feature-verifier.ts";
import { loadConfig } from "../../src/shared/config.ts";
import { createSilentLogger } from "../../src/shared/logger.ts";
import { openDatabase } from "../../src/infrastructure/sqlite/database.ts";
import { createWecomContactRepository } from "../../src/infrastructure/sqlite/wecom-contact-repo.ts";
import { createPromptRepository } from "../../src/infrastructure/sqlite/prompt-repo.ts";

const WEBHOOK = "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=synthetic-test";
const SAMPLE = { score: 60, comment: "P1：合成问题。", ranAt: new Date("2026-10-21T00:00:00Z") };

/** 使用真实内存映射仓储，只替换企微网络边界，绝不发送真实群消息。 */
function harness(t: TestContext) {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const contacts = createWecomContactRepository(db);
  contacts.upsert({ gitlabUsername: "Code.Author", wecomName: "测试提交人", wecomUserId: "synthetic_member" });
  const sent: string[] = [];
  t.mock.method(globalThis, "fetch", async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const payload = JSON.parse(String(init?.body)) as { msgtype: string; markdown: { content: string } };
    assert.equal(payload.msgtype, "markdown");
    sent.push(payload.markdown.content);
    return new Response(JSON.stringify({ errcode: 0 }), { status: 200 });
  });
  const deps = { config: loadConfig({}), logger: createSilentLogger(), wecomContacts: contacts };
  return { contacts, sent, verifier: createFeatureVerifier(deps) };
}

test("自检消息把成员提及保留在最后一行，且仍带验证标记", () => {
  const message = buildVerifyMessage({ ...SAMPLE, mention: { userId: "synthetic_member", name: "测试提交人" } });
  assert.match(message, /\[验证\]/);
  assert.ok(message.endsWith("\n\n<@synthetic_member>"), "自检包装不能丢掉正式模板的提交人提及");
});

test("没有 userid 时，自检末行仅展示中文名，不伪造真实提醒", () => {
  const message = buildVerifyMessage({ ...SAMPLE, mention: { name: "测试提交人" } });
  assert.ok(message.endsWith("\n\n@测试提交人"));
  assert.equal(message.includes("<@"), false);
});

test("自检预览按所选 GitLab 账号查询真实映射，大小写与首尾空白不影响匹配", async (t) => {
  const { verifier, sent } = harness(t);
  const outcome = await verifier.verifyWecom({ webhookOverride: WEBHOOK, dryRun: true, gitlabUsername: " code.author " });
  assert.equal(outcome.success, true);
  assert.ok(outcome.detail.endsWith("\n\n<@sy**er>"), "预览只展示中间掩码");
  assert.equal(outcome.detail.includes("synthetic_member"), false, "API 预览结果不能暴露完整 userid");
  assert.equal(outcome.detail.includes("<@code.author>"), false, "GitLab 账号不能直接当作企微 userid");
  assert.equal(sent.length, 0, "预览绝不能发群");
});

test("实际发送路径同样使用映射后的成员提及，而非只在预览里补文字", async (t) => {
  const { verifier, sent } = harness(t);
  const outcome = await verifier.verifyWecom({ webhookOverride: WEBHOOK, dryRun: false, gitlabUsername: "Code.Author" });
  assert.equal(outcome.success, true);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /\[验证\]/);
  assert.ok(sent[0].endsWith("\n\n<@synthetic_member>"), "真实企微通知必须用原始 userid 才能提醒成员");
  assert.equal(outcome.detail.includes("synthetic_member"), false, "发送结果也不能回显完整 userid");
  assert.ok(outcome.detail.endsWith("\n\n<@sy**er>"));
});

test("企微错误若回显 userid 或 webhook，自检结果也必须脱敏", async (t) => {
  const { verifier } = harness(t);
  t.mock.restoreAll();
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({
    errcode: 93000,
    errmsg: `invalid member synthetic_member at ${WEBHOOK}`,
  }), { status: 200 }));
  const outcome = await verifier.verifyWecom({ webhookOverride: WEBHOOK, dryRun: false, gitlabUsername: "Code.Author" });
  assert.equal(outcome.success, false);
  assert.equal(outcome.message.includes("synthetic_member"), false);
  assert.equal(outcome.message.includes(WEBHOOK), false);
  assert.match(outcome.message, /sy\*\*er/);
});

test("仅配置中文名的提交人，在自检预览中沿用纯文本降级", async (t) => {
  const { contacts, verifier, sent } = harness(t);
  contacts.upsert({ gitlabUsername: "name-only", wecomName: "中文提交人", wecomUserId: "" });
  const outcome = await verifier.verifyWecom({ webhookOverride: WEBHOOK, dryRun: true, gitlabUsername: "name-only" });
  assert.equal(outcome.success, true);
  assert.ok(outcome.detail.endsWith("\n\n@中文提交人"));
  assert.equal(outcome.detail.includes("<@"), false);
  assert.equal(sent.length, 0);
});

test("选择不存在或已删除的映射时失败，不猜测其他人且不发送", async (t) => {
  const { contacts, verifier, sent } = harness(t);
  contacts.remove("Code.Author");
  const outcome = await verifier.verifyWecom({ webhookOverride: WEBHOOK, dryRun: false, gitlabUsername: "Code.Author" });
  assert.equal(outcome.success, false);
  assert.match(outcome.message, /映射/);
  assert.equal(sent.length, 0);
});

test("发送前会重新读取映射，不使用页面加载时的过期姓名或 userid", async (t) => {
  const { contacts, verifier, sent } = harness(t);
  contacts.upsert({ gitlabUsername: "Code.Author", wecomName: "更新的提交人", wecomUserId: "updated_member" });
  const outcome = await verifier.verifyWecom({ webhookOverride: WEBHOOK, dryRun: false, gitlabUsername: "code.author" });
  assert.equal(outcome.success, true);
  assert.ok(sent[0].endsWith("\n\n<@updated_member>"));
  assert.equal(sent[0].includes("<@synthetic_member>"), false);
});

test("选了提交人但未装配映射来源时失败，避免装配缺失又静默丢掉提及", async (t) => {
  const { sent } = harness(t);
  const verifier = createFeatureVerifier({ config: loadConfig({}), logger: createSilentLogger() });
  const outcome = await verifier.verifyWecom({ webhookOverride: WEBHOOK, dryRun: false, gitlabUsername: "Code.Author" });
  assert.equal(outcome.success, false);
  assert.match(outcome.message, /映射/);
  assert.equal(sent.length, 0);
});

test("既有 CLI 未提供提交人时保留预览能力，但明确提示未验证提及", async (t) => {
  const { verifier, sent } = harness(t);
  const outcome = await verifier.verifyWecom({ webhookOverride: WEBHOOK, dryRun: true });
  assert.equal(outcome.success, true);
  assert.match(outcome.detail, /未验证 @ 提交人/);
  assert.equal(sent.length, 0);
});

// ============ 企微机器人选择 ============

/** 用临时规则目录构造验证器，避免依赖仓库真实 webhook。 */
async function botHarness(t: TestContext, rules: Record<string, string>) {
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "crp-bots-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(dir, { recursive: true, force: true });
  });
  // 规则文件必须含 code_review_prompt，否则加载器按结构非法跳过（与真实规则一致）。
  const prompt = "code_review_prompt:\n  system_prompt: SYS\n  user_prompt: \"评：{diffs_text}\"\n";
  await writeFile(join(dir, "default.yaml"), `wecom_score_threshold: 80\n${prompt}`, "utf8");
  for (const [name, body] of Object.entries(rules)) await writeFile(join(dir, `${name}.yaml`), `${body}${prompt}`, "utf8");
  const sent: string[] = [];
  const targets: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    targets.push(String(input));
    sent.push(String(init?.body));
    return new Response(JSON.stringify({ errcode: 0 }), { status: 200 });
  });
  const config = { ...loadConfig({}), rulesDir: dir };
  return { config, verifier: createFeatureVerifier({ config, logger: createSilentLogger() }), sent, targets };
}

test("机器人列表按 webhook 去重，并只暴露脱敏 key", async (t) => {
  const { verifier } = await botHarness(t, {
    "team-a": 'repository: "group/a,group/b"\nwecom_webhook_url: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=aaaa1111-bbbb"\n',
    "team-a-copy": 'repository: "group/c"\nwecom_webhook_url: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=aaaa1111-bbbb"\n',
    "team-b": 'repository: "group/d"\nwecom_webhook_url: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=cccc2222-dddd"\n',
    "no-hook": 'repository: "group/e"\nwecom_webhook_url: ""\n',
  });
  const bots = await verifier.listWecomBots();
  assert.equal(bots.length, 2, "同一地址的多条规则只算一个机器人");
  const raw = JSON.stringify(bots);
  assert.equal(raw.includes("aaaa1111"), false, "不能下发完整 webhook key");
  assert.equal(raw.includes("cccc2222"), false);
  assert.equal(raw.includes("qyapi.weixin.qq.com"), false, "不能下发 webhook 地址");
  const merged = bots.find((bot) => bot.repositories.includes("group/a"));
  assert.ok(merged);
  assert.deepEqual([...merged.repositories].sort(), ["group/a", "group/b", "group/c"], "复用地址的仓库合并到同一机器人");
  assert.equal(merged.maskedKey, "****bbbb");
});

test("按机器人 id 发送，地址由服务端解析", async (t) => {
  const { verifier, sent } = await botHarness(t, {
    "team-a": 'repository: "group/a"\nwecom_webhook_url: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=aaaa1111-bbbb"\n',
    "team-b": 'repository: "group/b"\nwecom_webhook_url: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=cccc2222-dddd"\n',
  });
  const bots = await verifier.listWecomBots();
  const target = bots.find((bot) => bot.repositories.includes("group/b"));
  assert.ok(target);
  const outcome = await verifier.verifyWecom({ webhookId: target.id, gitlabUsername: undefined, dryRun: false });
  assert.equal(outcome.success, true);
  assert.match(outcome.detail, /机器人 \*\*\*\*dddd/);
  assert.equal(sent.length, 1);
});

test("机器人列表按正式评审的数据库优先级：DB 独有可选，DB 覆盖的 YAML 旧机器人不可选", async (t) => {
  const yamlOld = "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=synthetic-yaml-old";
  const yamlOnly = "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=synthetic-yaml-only";
  const dbOverride = "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=synthetic-db-override";
  const dbOnly = "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=synthetic-db-only";
  const { config, targets, sent } = await botHarness(t, {
    "team-a": `repository: "group/a"\nwecom_webhook_url: "${yamlOld}"\n`,
    "team-b": `repository: "group/b"\nwecom_webhook_url: "${yamlOnly}"\n`,
  });
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const prompts = createPromptRepository(db);
  prompts.create({ repository: "configured", projects: ["group/a"], systemPrompt: "SYS", userPrompt: "{diffs_text}", wecomWebhookUrl: dbOverride });
  prompts.create({ repository: "db-only", projects: ["group/new"], systemPrompt: "SYS", userPrompt: "{diffs_text}", wecomWebhookUrl: dbOnly });
  const verifier = createFeatureVerifier({ config, logger: createSilentLogger(), promptSource: prompts });
  const bots = await verifier.listWecomBots();
  assert.equal(bots.length, 3, "DB 项目独有 + 覆盖旧 YAML + 未被覆盖的 YAML");
  assert.ok(bots.some((bot) => bot.repositories.includes("group/new")), "数据库独有机器人必须可选");
  assert.ok(bots.some((bot) => bot.repositories.includes("group/b")), "未被 DB 覆盖的 YAML 应保留");
  assert.equal(JSON.stringify(bots).includes("synthetic-"), false, "列表不能泄露任意 webhook 密钥或完整地址");
  const selected = bots.find((bot) => bot.repositories.includes("group/a"));
  assert.ok(selected);
  const outcome = await verifier.verifyWecom({ webhookId: selected.id, dryRun: false });
  assert.equal(outcome.success, true);
  assert.equal(targets.at(-1), dbOverride, "发送必须使用 DB 当前生效地址，不能误用 YAML 旧地址");
  assert.equal(sent.length, 1);
});

test("数据库 default 即使未设置 webhook，也会遮蔽未匹配项目的 YAML 机器人", async (t) => {
  const { config } = await botHarness(t, {
    "team-a": 'repository: "group/a"\nwecom_webhook_url: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=synthetic-yaml-a"\n',
  });
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const prompts = createPromptRepository(db);
  prompts.create({ repository: "default", projects: [], systemPrompt: "SYS", userPrompt: "{diffs_text}" });
  const verifier = createFeatureVerifier({ config, logger: createSilentLogger(), promptSource: prompts });
  assert.deepEqual(await verifier.listWecomBots(), [], "正式评审命中 DB default 后不再回落 YAML");
});

test("数据库独有机器人在 YAML 目录缺失时仍可列出；数据库 default 也可选择", async (t) => {
  const { config } = await botHarness(t, {});
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const prompts = createPromptRepository(db);
  prompts.create({ repository: "db-only", projects: ["group/only"], systemPrompt: "SYS", userPrompt: "{diffs_text}",
    wecomWebhookUrl: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=synthetic-db-only" });
  prompts.create({ repository: "default", projects: [], systemPrompt: "SYS", userPrompt: "{diffs_text}",
    wecomWebhookUrl: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=synthetic-default" });
  const verifier = createFeatureVerifier({ config: { ...config, rulesDir: `${config.rulesDir}/not-found` },
    logger: createSilentLogger(), promptSource: prompts });
  const bots = await verifier.listWecomBots();
  assert.equal(bots.length, 2);
  assert.ok(bots.some((bot) => bot.repositories.includes("group/only")));
  assert.ok(bots.some((bot) => bot.repositories.includes("default")), "未匹配项目可使用 DB default 机器人");
  assert.equal(JSON.stringify(bots).includes("synthetic-"), false);
});

test("未知机器人 id 直接失败，不发送任何消息", async (t) => {
  const { verifier, sent } = await botHarness(t, {
    "team-a": 'repository: "group/a"\nwecom_webhook_url: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=aaaa1111-bbbb"\n',
  });
  const outcome = await verifier.verifyWecom({ webhookId: "000000000000", dryRun: false });
  assert.equal(outcome.success, false);
  assert.match(outcome.message, /机器人/);
  assert.equal(sent.length, 0);
});
