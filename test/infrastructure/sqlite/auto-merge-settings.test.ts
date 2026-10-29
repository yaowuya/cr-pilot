import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../../../src/infrastructure/sqlite/database.ts";
import { createPromptRepository } from "../../../src/infrastructure/sqlite/prompt-repo.ts";

const policy = {
  enabled: true,
  minimumScore: 88,
  targetMode: "specified" as const,
  targetBranches: ["main", "release/stable"],
  method: "squash" as const,
  removeSourceBranch: true,
};

function input(repository: string) {
  return { repository, systemPrompt: "system", userPrompt: "review {diffs_text}" };
}

test("project_review_settings 新库默认关闭并约束自动合并字段", () => {
  const db = openDatabase(":memory:");
  try {
    db.prepare("INSERT INTO project_review_settings (project, updated_at) VALUES (?, ?)").run("group/app", 1);
    assert.deepEqual({ ...db.prepare("SELECT * FROM project_review_settings").get() }, {
      project: "group/app",
      repository_context_enabled: 0,
      auto_merge_enabled: 0,
      auto_merge_minimum_score: 100,
      auto_merge_target_mode: "default",
      auto_merge_target_branches: "[]",
      auto_merge_method: "merge",
      auto_merge_remove_source_branch: 0,
      updated_at: 1,
    });
    assert.throws(() => db.prepare("UPDATE project_review_settings SET auto_merge_minimum_score = 101").run(), /CHECK/);
    assert.throws(() => db.prepare("UPDATE project_review_settings SET auto_merge_method = 'rebase'").run(), /CHECK/);
    assert.throws(() => db.prepare("UPDATE project_review_settings SET auto_merge_target_mode = 'glob'").run(), /CHECK/);
  } finally { db.close(); }
});

test("旧库幂等迁移补齐自动合并列并保留已有仓库上下文设置", () => {
  const dir = mkdtempSync(join(tmpdir(), "crp-auto-merge-migrate-"));
  const path = join(dir, "old.db");
  try {
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE project_review_settings (
      project TEXT PRIMARY KEY NOT NULL,
      repository_context_enabled INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
    INSERT INTO project_review_settings VALUES ('group/app', 1, 7);`);
    old.close();

    const first = openDatabase(path);
    try {
      assert.deepEqual({ ...first.prepare(`SELECT repository_context_enabled, auto_merge_enabled,
        auto_merge_minimum_score, auto_merge_target_mode, auto_merge_target_branches, auto_merge_method,
        auto_merge_remove_source_branch FROM project_review_settings`).get() }, {
        repository_context_enabled: 1,
        auto_merge_enabled: 0,
        auto_merge_minimum_score: 100,
        auto_merge_target_mode: "default",
        auto_merge_target_branches: "[]",
        auto_merge_method: "merge",
        auto_merge_remove_source_branch: 0,
      });
    } finally { first.close(); }
    openDatabase(path).close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("从旧自动合并 schema 迁移时保留 allowlist 语义，且重复启动不改写用户模式", () => {
  const dir = mkdtempSync(join(tmpdir(), "crp-target-mode-migrate-"));
  const path = join(dir, "old-auto.db");
  try {
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE project_review_settings (
      project TEXT PRIMARY KEY NOT NULL,
      repository_context_enabled INTEGER NOT NULL DEFAULT 0,
      auto_merge_enabled INTEGER NOT NULL DEFAULT 0,
      auto_merge_minimum_score INTEGER NOT NULL DEFAULT 100,
      auto_merge_target_branches TEXT NOT NULL DEFAULT '[]',
      auto_merge_method TEXT NOT NULL DEFAULT 'merge',
      auto_merge_remove_source_branch INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
    INSERT INTO project_review_settings VALUES ('group/enabled', 0, 1, 90, '["main"]', 'merge', 0, 1);
    INSERT INTO project_review_settings VALUES ('group/disabled-empty', 0, 0, 100, '[]', 'merge', 0, 1);
    INSERT INTO project_review_settings VALUES ('group/disabled-list', 0, 0, 100, '["release"]', 'merge', 0, 1);`);
    old.close();

    const first = openDatabase(path);
    try {
      const modes = Object.fromEntries((first.prepare(
        "SELECT project, auto_merge_target_mode AS mode FROM project_review_settings ORDER BY project",
      ).all() as unknown as Array<{ project: string; mode: string }>).map((row) => [row.project, row.mode]));
      assert.deepEqual(modes, {
        "group/disabled-empty": "default",
        "group/disabled-list": "specified",
        "group/enabled": "specified",
      });
      first.prepare("UPDATE project_review_settings SET auto_merge_target_mode = 'specified' WHERE project = 'group/disabled-empty'").run();
    } finally { first.close(); }

    const second = openDatabase(path);
    try {
      assert.equal(second.prepare("SELECT auto_merge_target_mode AS mode FROM project_review_settings WHERE project = 'group/disabled-empty'").get()?.mode, "specified");
      assert.equal(second.prepare("SELECT auto_merge_target_mode AS mode FROM project_review_settings WHERE project = 'group/enabled'").get()?.mode, "specified");
    } finally { second.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("仓储按项目部分更新并在详情、列表、精确解析中返回完整策略", () => {
  const db = openDatabase(":memory:");
  try {
    const repo = createPromptRepository(db);
    const created = repo.create({
      ...input("rules"),
      projects: ["Group/App", "legacy-app"],
      projectSettings: [{ project: "Group/App", repositoryContextEnabled: true }],
    });
    assert.deepEqual(created.projectSettings, [
      {
        project: "Group/App",
        repositoryContextEnabled: true,
        autoMergePolicy: { enabled: false, minimumScore: 100, targetMode: "default", targetBranches: [], method: "merge", removeSourceBranch: false },
      },
      {
        project: "legacy-app",
        repositoryContextEnabled: false,
        autoMergePolicy: { enabled: false, minimumScore: 100, targetMode: "default", targetBranches: [], method: "merge", removeSourceBranch: false },
      },
    ]);

    repo.update(created.id, {
      systemPrompt: "system-2",
      userPrompt: "review {diffs_text}",
      projectSettings: [{ project: "group/app", autoMergePolicy: policy }],
    });
    assert.equal(repo.resolveProjectSetting?.(" GROUP/APP ")?.repositoryContextEnabled, true, "自动合并 patch 不重置上下文");
    assert.deepEqual(repo.resolveProjectSetting?.("group/app")?.autoMergePolicy, policy);
    assert.equal(repo.resolveProjectSetting?.("team/app"), undefined, "不得用短名或后缀解析自动合并");
    assert.equal(repo.resolveProjectSetting?.("legacy-app"), undefined, "执行 seam 只接受完整项目全名");

    repo.update(created.id, {
      systemPrompt: "system-3",
      userPrompt: "review {diffs_text}",
      projectSettings: [{ project: "group/app", repositoryContextEnabled: false }],
    });
    assert.equal(repo.resolveProjectSetting?.("group/app")?.repositoryContextEnabled, false);
    assert.deepEqual(repo.resolveProjectSetting?.("group/app")?.autoMergePolicy, policy, "上下文 patch 不重置自动合并");
    assert.deepEqual(repo.listProjectSettings?.().find((item) => item.project === "group/app")?.autoMergePolicy, policy);
    assert.deepEqual(repo.list().find((item) => item.repository === "rules")?.projectSettings?.find((item) => item.project === "Group/App")?.autoMergePolicy, policy);
  } finally { db.close(); }
});

test("仓储持久化 default、specified 与 any 三种目标模式", () => {
  const db = openDatabase(":memory:");
  try {
    const repo = createPromptRepository(db);
    for (const targetMode of ["default", "any"] as const) {
      const project = `group/${targetMode}`;
      repo.create({
        ...input(`rules-${targetMode}`), projects: [project],
        projectSettings: [{
          project,
          autoMergePolicy: { ...policy, targetMode, targetBranches: [] },
        }],
      });
      assert.equal(repo.resolveProjectSetting?.(project)?.autoMergePolicy.targetMode, targetMode);
      assert.deepEqual(repo.resolveProjectSetting?.(project)?.autoMergePolicy.targetBranches, []);
      assert.equal(repo.resolveProjectSetting?.(project)?.autoMergePolicy.enabled, true);
    }
  } finally { db.close(); }
});

test("启用策略要求项目只关联一个非 default Prompt，失败时整笔更新回滚", () => {
  const db = openDatabase(":memory:");
  try {
    const repo = createPromptRepository(db);
    const first = repo.create({ ...input("rules-a"), projects: ["group/app"] });
    const second = repo.create({ ...input("rules-b"), projects: ["GROUP/APP"] });
    assert.throws(() => repo.update(first.id, {
      systemPrompt: "must-rollback",
      userPrompt: "changed",
      projectSettings: [{ project: "group/app", autoMergePolicy: policy }],
    }), /必须且只能关联一个/);
    assert.equal(repo.get(first.id)?.systemPrompt, "system", "策略与正文必须同事务回滚");
    assert.equal(repo.resolveProjectSetting?.("group/app")?.autoMergePolicy.enabled, false);

    repo.remove(second.id);
    repo.update(first.id, {
      systemPrompt: "enabled",
      userPrompt: "review {diffs_text}",
      projectSettings: [{ project: "group/app", autoMergePolicy: policy }],
    });
    assert.equal(repo.resolveProjectSetting?.("group/app")?.autoMergePolicy.enabled, true);
  } finally { db.close(); }
});

test("已启用项目拒绝大小写变体的第二 Prompt，显式关闭后允许清理脏关联", () => {
  const db = openDatabase(":memory:");
  try {
    const repo = createPromptRepository(db);
    const protectedPrompt = repo.create({
      ...input("protected"), projects: ["group/app"],
      projectSettings: [{ project: "group/app", autoMergePolicy: policy }],
    });
    assert.throws(() => repo.create({ ...input("competing"), projects: ["GROUP/APP"] }), /必须且只能关联一个/);
    assert.equal(repo.findByRepository("competing"), undefined, "失败创建不得留下竞争 Prompt");

    const safe = repo.create({ ...input("safe"), projects: ["group/safe"] });
    assert.throws(() => repo.update(safe.id, {
      systemPrompt: "must-rollback", userPrompt: "changed", projects: ["Group/App"],
    }), /必须且只能关联一个/);
    assert.deepEqual(repo.get(safe.id)?.projects, ["group/safe"]);

    repo.update(protectedPrompt.id, {
      systemPrompt: "disabled", userPrompt: "changed",
      projectSettings: [{ project: "group/app", autoMergePolicy: { ...policy, enabled: false } }],
    });
    assert.doesNotThrow(() => repo.update(safe.id, {
      systemPrompt: "now-allowed", userPrompt: "changed", projects: ["Group/App"],
    }));
  } finally { db.close(); }
});

test("启用自动合并要求最终 Prompt 注入 diffs_text，失败时正文与策略同事务回滚", () => {
  const db = openDatabase(":memory:");
  try {
    const repo = createPromptRepository(db);
    assert.throws(() => repo.create({
      repository: "invalid",
      projects: ["group/new"],
      systemPrompt: "system",
      userPrompt: "只看提交说明",
      projectSettings: [{ project: "group/new", autoMergePolicy: policy }],
    }), /diffs_text/);
    assert.equal(repo.findByRepository("invalid"), undefined, "创建失败不能留下 Prompt 或启用策略");

    const prompt = repo.create({ ...input("rules"), projects: ["group/app"] });
    repo.update(prompt.id, {
      systemPrompt: "enabled",
      userPrompt: "review {diffs_text}",
      projectSettings: [{ project: "group/app", autoMergePolicy: policy }],
    });
    assert.throws(() => repo.update(prompt.id, {
      systemPrompt: "must-rollback",
      userPrompt: "占位符已删除",
    }), /diffs_text/);
    assert.equal(repo.get(prompt.id)?.systemPrompt, "enabled");
    assert.equal(repo.get(prompt.id)?.userPrompt, "review {diffs_text}");
    assert.equal(repo.resolveProjectSetting?.("group/app")?.autoMergePolicy.enabled, true);
  } finally { db.close(); }
});

test("同一更新显式关闭自动合并后允许移除 diffs_text 占位符", () => {
  const db = openDatabase(":memory:");
  try {
    const repo = createPromptRepository(db);
    const prompt = repo.create({
      ...input("rules"),
      projects: ["group/app"],
      projectSettings: [{ project: "group/app", autoMergePolicy: policy }],
    });
    const updated = repo.update(prompt.id, {
      systemPrompt: "disabled",
      userPrompt: "无需 diff 的普通模板",
      projectSettings: [{ project: "group/app", autoMergePolicy: { ...policy, enabled: false } }],
    });
    assert.equal(updated.userPrompt, "无需 diff 的普通模板");
    assert.equal(repo.resolveProjectSetting?.("group/app")?.autoMergePolicy.enabled, false);
  } finally { db.close(); }
});

test("损坏的目标分支 JSON 按安全关闭读取", () => {
  const db = openDatabase(":memory:");
  try {
    const repo = createPromptRepository(db);
    repo.create({
      ...input("rules"), projects: ["group/app"],
      projectSettings: [{ project: "group/app", autoMergePolicy: policy }],
    });
    db.prepare("UPDATE project_review_settings SET auto_merge_target_branches = 'not-json' WHERE project = 'group/app'").run();
    assert.equal(repo.resolveProjectSetting?.("group/app")?.autoMergePolicy.enabled, false);
    assert.deepEqual(repo.resolveProjectSetting?.("group/app")?.autoMergePolicy.targetBranches, []);
    assert.equal(repo.resolveProjectSetting?.("group/app")?.autoMergePolicy.targetMode, "specified");

    db.exec("PRAGMA ignore_check_constraints = ON");
    db.prepare("UPDATE project_review_settings SET auto_merge_target_mode = 'glob', auto_merge_target_branches = '[\"main\"]' WHERE project = 'group/app'").run();
    db.exec("PRAGMA ignore_check_constraints = OFF");
    assert.deepEqual(repo.resolveProjectSetting?.("group/app")?.autoMergePolicy, {
      enabled: false,
      minimumScore: 88,
      targetMode: "default",
      targetBranches: [],
      method: "squash",
      removeSourceBranch: true,
    });
  } finally { db.close(); }
});

test("解绑最后一个 Prompt 会清理项目自动合并设置", () => {
  const db = openDatabase(":memory:");
  try {
    const repo = createPromptRepository(db);
    const prompt = repo.create({
      ...input("rules"), projects: ["group/app"],
      projectSettings: [{ project: "group/app", autoMergePolicy: policy }],
    });
    repo.remove(prompt.id);
    assert.equal(repo.resolveProjectSetting?.("group/app"), undefined);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM project_review_settings").get()?.n, 0);
  } finally { db.close(); }
});

test("回退门禁批量关闭全部策略且保留配置供管理员重新审核", () => {
  const db = openDatabase(":memory:");
  try {
    const repo = createPromptRepository(db);
    repo.create({
      ...input("rules-a"), projects: ["group/a"],
      projectSettings: [{ project: "group/a", autoMergePolicy: policy }],
    });
    repo.create({
      ...input("rules-b"), projects: ["group/b"],
      projectSettings: [{ project: "group/b", autoMergePolicy: { ...policy, minimumScore: 98, targetBranches: ["release"] } }],
    });

    assert.equal(repo.disableAllAutoMergePolicies?.(), 2);
    const first = repo.resolveProjectSetting?.("group/a")?.autoMergePolicy;
    const second = repo.resolveProjectSetting?.("group/b")?.autoMergePolicy;
    assert.deepEqual(first, { ...policy, enabled: false });
    assert.deepEqual(second, { ...policy, enabled: false, minimumScore: 98, targetBranches: ["release"] });
    assert.equal(repo.disableAllAutoMergePolicies?.(), 0, "重复执行必须幂等");
  } finally { db.close(); }
});
