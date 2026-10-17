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

test("importFromDir 对非法 YAML 只跳过该文件，不中断整个导入", () => {
  const dir = mkdtempSync(join(tmpdir(), "crp-prompts-"));
  try {
    writeFileSync(
      join(dir, "ok.yaml"),
      ["repository: group/ok", "code_review_prompt:", "  system_prompt: SYS", "  user_prompt: u {diffs_text}"].join("\n"),
    );
    // 非法 YAML：flow 序列缩进错误，会让 yaml 解析器抛异常。
    writeFileSync(join(dir, "broken.yaml"), "repository: [unclosed\n  bad: [indent");
    writeFileSync(
      join(dir, "also-ok.yaml"),
      ["repository: group/ok2", "code_review_prompt:", "  system_prompt: SYS", "  user_prompt: u {diffs_text}"].join("\n"),
    );

    const db = openDatabase(":memory:");
    const repo = createPromptRepository(db);
    // 关键：异常文件不中断整体导入，前后文件都能正常导入，且返回精确计数。
    const result = repo.importFromDir(dir);
    assert.equal(result.imported, 2, "非法 YAML 之外的文件应全部导入");
    assert.equal(result.skipped, 1, "非法 YAML 应记为跳过而非抛错");
    assert.ok(repo.resolve("group/ok"));
    assert.ok(repo.resolve("group/ok2"));
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("一条 prompt 可关联多个项目，任一命中即生效", () => {
  const db = openDatabase(":memory:");
  const repo = createPromptRepository(db);
  repo.create({
    repository: "通用评审",
    projects: ["auto-ops", "cw-auto-ops", "auto-ops-platform"],
    systemPrompt: "sys-shared",
    userPrompt: "u {diffs_text}",
  });
  for (const project of ["auto-ops", "cw-auto-ops", "auto-ops-platform"]) {
    assert.equal(repo.resolve(project)?.systemPrompt, "sys-shared", `${project} 应命中同一条 prompt`);
  }
  assert.equal(repo.resolve("unrelated/repo"), undefined, "未关联项目且无 default 时返回 undefined");
  db.close();
});

test("多项目列表去空、去重且大小写不敏感", () => {
  const db = openDatabase(":memory:");
  const repo = createPromptRepository(db);
  const created = repo.create({
    repository: "共享",
    projects: ["auto-ops", " AUTO-OPS ", "cw-auto-ops", ""],
    systemPrompt: "sys",
    userPrompt: "u",
  });
  assert.deepEqual(created.projects, ["auto-ops", "cw-auto-ops"]);
  db.close();
});

test("update 显式传 projects 时覆盖，不传时保留原有关联", () => {
  const db = openDatabase(":memory:");
  const repo = createPromptRepository(db);
  const created = repo.create({
    repository: "r",
    projects: ["a", "b"],
    systemPrompt: "sys",
    userPrompt: "u",
  });
  const kept = repo.update(created.id, { systemPrompt: "sys2", userPrompt: "u2" });
  assert.deepEqual(kept.projects, ["a", "b"], "只改正文不应清空项目");

  const replaced = repo.update(created.id, { projects: ["c"], systemPrompt: "sys3", userPrompt: "u3" });
  assert.deepEqual(replaced.projects, ["c"], "显式传 projects 应覆盖");
  db.close();
});

test("listKnownProjects 汇总去重，供前端下拉建议", () => {
  const db = openDatabase(":memory:");
  const repo = createPromptRepository(db);
  repo.create({ repository: "r1", projects: ["a", "b"], systemPrompt: "s", userPrompt: "u" });
  repo.create({ repository: "r2", projects: ["b", "c"], systemPrompt: "s", userPrompt: "u" });
  assert.deepEqual(repo.listKnownProjects(), ["a", "b", "c"]);
  db.close();
});

test("删除 prompt 级联清理项目关联", () => {
  const db = openDatabase(":memory:");
  const repo = createPromptRepository(db);
  const created = repo.create({ repository: "r", projects: ["a"], systemPrompt: "s", userPrompt: "u" });
  repo.remove(created.id);
  assert.deepEqual(repo.listKnownProjects(), [], "删 prompt 必须连带删关联，否则下拉会残留已失效项目");
  db.close();
});

test("importFromDir 把逗号分隔的 repository 拆成多个项目", () => {
  // 回归：老 yaml 用「auto-ops,cw-auto-ops」这种逗号串表示一套 prompt 覆盖
  // 多个项目。整串存成一个项目会让所有项目的匹配失效。
  const db = openDatabase(":memory:");
  const repo = createPromptRepository(db);
  const dir = mkdtempSync(join(tmpdir(), "cr-pilot-rules-"));
  try {
    writeFileSync(
      join(dir, "shared.yaml"),
      [
        "repository: auto-ops,cw-auto-ops,auto-ops-platform",
        "code_review_prompt:",
        "  system_prompt: |-",
        "    你是评审专家",
        "  user_prompt: |-",
        "    评审 {diffs_text}",
      ].join("\n"),
      "utf8",
    );
    repo.importFromDir(dir);
    const list = repo.list();
    assert.equal(list.length, 1);
    assert.deepEqual(list[0].projects, ["auto-ops", "auto-ops-platform", "cw-auto-ops"], "读取按名称排序");
    // 拆开后每个项目都能命中同一条 prompt。
    assert.equal(repo.resolve("cw-auto-ops")?.repository, "auto-ops,cw-auto-ops,auto-ops-platform");
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
