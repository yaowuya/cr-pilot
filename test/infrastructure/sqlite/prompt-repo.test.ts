import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../../src/infrastructure/sqlite/database.ts";
import { createPromptRepository, DEFAULT_PROMPT_REPOSITORY } from "../../../src/infrastructure/sqlite/prompt-repo.ts";

/** 创建一条 prompt 的输入。 */
function input(repository: string, systemPrompt = `sys-${repository}`) {
  return { repository, systemPrompt, userPrompt: "u {diffs_text}" };
}

test("resolve 优先命中项目，未命中回落 default", () => {
  const db = openDatabase(":memory:");
  const repo = createPromptRepository(db);
  repo.create(input(DEFAULT_PROMPT_REPOSITORY, "sys-default"));
  repo.create(input("group/proj", "sys-proj"));
  assert.equal(repo.resolve("group/proj")?.systemPrompt, "sys-proj");
  assert.equal(repo.resolve("other/repo")?.systemPrompt, "sys-default");
  assert.equal(repo.resolve()?.systemPrompt, "sys-default", "不传项目名时取 default");
  db.close();
});

test("resolve 大小写与空白不敏感", () => {
  const db = openDatabase(":memory:");
  const repo = createPromptRepository(db);
  repo.create(input("group/proj", "sys-proj"));
  assert.equal(repo.resolve("  Group/Proj  ")?.systemPrompt, "sys-proj");
  db.close();
});

test("resolve 在只有 default 时不把 default 误匹配为项目", () => {
  const db = openDatabase(":memory:");
  const repo = createPromptRepository(db);
  repo.create(input(DEFAULT_PROMPT_REPOSITORY, "sys-default"));
  assert.equal(repo.resolve("default")?.systemPrompt, "sys-default");
  assert.equal(repo.resolve("some/repo")?.systemPrompt, "sys-default");
  db.close();
});

test("remove 后该仓库回落 default", () => {
  const db = openDatabase(":memory:");
  const repo = createPromptRepository(db);
  repo.create(input(DEFAULT_PROMPT_REPOSITORY, "sys-default"));
  const created = repo.create(input("g/p", "sys-p"));
  repo.remove(created.id);
  assert.equal(repo.resolve("g/p")?.systemPrompt, "sys-default");
  assert.equal(repo.get(created.id), undefined);
  db.close();
});

test("重复 repository 创建被拒并带业务语义消息", () => {
  const db = openDatabase(":memory:");
  const repo = createPromptRepository(db);
  repo.create(input("g/p"));
  assert.throws(() => repo.create(input("g/p")), /已存在/);
  db.close();
});

test("list 返回摘要且不含正文", () => {
  const db = openDatabase(":memory:");
  const repo = createPromptRepository(db);
  repo.create({ ...input("g/p"), wecomWebhookUrl: "https://wecom.example/hook", wecomScoreThreshold: 70 });
  const summary = repo.list()[0];
  assert.equal("systemPrompt" in summary, false, "列表不得返回完整正文");
  assert.equal(summary.hasWecomWebhook, true);
  assert.equal(summary.wecomScoreThreshold, 70);
  db.close();
});

test("update 修改正文与企微配置并刷新 updatedAt", async () => {
  const db = openDatabase(":memory:");
  const repo = createPromptRepository(db);
  const created = repo.create(input("g/p"));
  await new Promise((resolve) => setTimeout(resolve, 5));
  const updated = repo.update(created.id, { systemPrompt: "new-sys", userPrompt: "new-u {diffs_text}", wecomScoreThreshold: 60 });
  assert.equal(updated.systemPrompt, "new-sys");
  assert.equal(updated.wecomScoreThreshold, 60);
  assert.equal(updated.repository, "g/p", "update 不得改 repository");
  assert.ok(updated.updatedAt >= created.updatedAt);
  db.close();
});

test("importFromDir 导入 yaml，跳过已存在项与无 repository 项", () => {
  const dir = mkdtempSync(join(tmpdir(), "crp-prompts-"));
  try {
    writeFileSync(
      join(dir, "default.yaml"),
      ["repository: ignored/by/default", "code_review_prompt:", "  system_prompt: sys-default", "  user_prompt: u {diffs_text}"].join("\n"),
    );
    writeFileSync(
      join(dir, "proj.yaml"),
      ["repository: group/proj", "code_review_prompt:", "  system_prompt: sys-proj", "  user_prompt: u {diffs_text}", "wecom_score_threshold: 70"].join("\n"),
    );
    writeFileSync(join(dir, "no-repo.yaml"), ["code_review_prompt:", "  system_prompt: s", "  user_prompt: u"].join("\n"));
    writeFileSync(join(dir, "broken.yaml"), "not: a rule file");
    writeFileSync(join(dir, "readme.txt"), "ignored");

    const db = openDatabase(":memory:");
    const repo = createPromptRepository(db);
    const result = repo.importFromDir(dir);
    assert.equal(result.imported, 2, "default.yaml 与 proj.yaml 各导入一条");
    assert.equal(result.skipped, 2, "缺 repository 与结构非法各跳过一个");
    assert.equal(repo.resolve("ignored/by/default")?.systemPrompt, "sys-default");
    assert.equal(repo.resolve("group/proj")?.systemPrompt, "sys-proj");
    assert.equal(repo.list().find((item) => item.repository === "group/proj")?.wecomScoreThreshold, 70);

    // 重复导入应全部跳过，不得产生重复行。
    const again = repo.importFromDir(dir);
    assert.equal(again.imported, 0);
    assert.equal(again.skipped, 4);
    assert.equal(repo.list().length, 2);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("importFromDir 对不存在目录返回零而不抛错", () => {
  const db = openDatabase(":memory:");
  const repo = createPromptRepository(db);
  assert.deepEqual(repo.importFromDir(join(tmpdir(), "definitely-missing-crp-dir")), { imported: 0, skipped: 0 });
  db.close();
});
