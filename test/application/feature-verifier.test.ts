import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { buildVerifyMessage, createFeatureVerifier } from "../../src/application/feature-verifier.ts";
import { loadConfig } from "../../src/shared/config.ts";
import { createSilentLogger } from "../../src/shared/logger.ts";
import { openDatabase } from "../../src/infrastructure/sqlite/database.ts";
import { createWecomContactRepository } from "../../src/infrastructure/sqlite/wecom-contact-repo.ts";

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
  assert.ok(outcome.detail.endsWith("\n\n<@synthetic_member>"));
  assert.equal(outcome.detail.includes("<@code.author>"), false, "GitLab 账号不能直接当作企微 userid");
  assert.equal(sent.length, 0, "预览绝不能发群");
});

test("实际发送路径同样使用映射后的成员提及，而非只在预览里补文字", async (t) => {
  const { verifier, sent } = harness(t);
  const outcome = await verifier.verifyWecom({ webhookOverride: WEBHOOK, dryRun: false, gitlabUsername: "Code.Author" });
  assert.equal(outcome.success, true);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /\[验证\]/);
  assert.ok(sent[0].endsWith("\n\n<@synthetic_member>"));
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
