import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../../../src/infrastructure/sqlite/database.ts";

test("openDatabase 建四张表并启用 WAL", () => {
  const dir = mkdtempSync(join(tmpdir(), "crp-db-"));
  try {
    const db = openDatabase(join(dir, "test.db"));
    const mode = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    assert.equal(mode.journal_mode, "wal");
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    const names = tables.map((row) => row.name);
    for (const expected of ["review_records", "admins", "config_overrides", "review_prompts"]) {
      assert.ok(names.includes(expected), `缺少表 ${expected}`);
    }
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("openDatabase 建立设计要求的索引", () => {
  const db = openDatabase(":memory:");
  const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as { name: string }[]).map((row) => row.name);
  for (const expected of ["idx_reviews_started_at", "idx_reviews_project", "idx_reviews_committer"]) {
    assert.ok(indexes.includes(expected), `缺少索引 ${expected}`);
  }
  db.close();
});

test("openDatabase 对同一路径重复调用保持幂等", () => {
  const dir = mkdtempSync(join(tmpdir(), "crp-db-"));
  try {
    openDatabase(join(dir, "a.db")).close();
    const db = openDatabase(join(dir, "a.db"));
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    assert.equal(tables.filter((row) => row.name === "admins").length, 1, "重复打开不得重复建表");
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("仓库上下文配置初始为空，布尔字段受数据库约束", () => {
  const db = openDatabase(":memory:");
  try {
    db.prepare("INSERT INTO review_prompts (repository, system_prompt, user_prompt, updated_at) VALUES ('r', 's', 'u', 1)").run();
    assert.equal(db.prepare("SELECT repository_standards FROM review_prompts").get()?.repository_standards, "");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM project_review_settings").get()?.n, 0);
    db.prepare("INSERT INTO project_review_settings (project, updated_at) VALUES ('group/a', 1)").run();
    assert.equal(db.prepare("SELECT repository_context_enabled FROM project_review_settings").get()?.repository_context_enabled, 0);
    assert.throws(() => db.prepare("UPDATE project_review_settings SET repository_context_enabled = 2").run(), /CHECK/);
  } finally {
    db.close();
  }
});

test("旧库升级默认关闭，重复升级保留已保存的规范和开关", () => {
  const dir = mkdtempSync(join(tmpdir(), "crp-db-upgrade-"));
  const path = join(dir, "old.db");
  try {
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE review_prompts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, repository TEXT NOT NULL UNIQUE,
      system_prompt TEXT NOT NULL, user_prompt TEXT NOT NULL,
      wecom_webhook_url TEXT, wecom_score_threshold INTEGER, updated_at INTEGER NOT NULL
    );
    INSERT INTO review_prompts (repository,system_prompt,user_prompt,updated_at) VALUES ('r','old-system','old-user',1);`);
    old.close();
    const first = openDatabase(path);
    try {
      const row = first.prepare("SELECT * FROM review_prompts").get();
      assert.equal(row?.system_prompt, "old-system");
      assert.equal(row?.user_prompt, "old-user");
      assert.equal(row?.repository_standards, "");
      assert.equal(first.prepare("SELECT COUNT(*) AS n FROM project_review_settings").get()?.n, 0);
      first.prepare("UPDATE review_prompts SET repository_standards = ?").run("仓库约束");
      first.prepare("INSERT INTO project_review_settings VALUES (?, ?, ?)").run("group/a", 1, 2);
    } finally {
      first.close();
    }
    const second = openDatabase(path);
    try {
      assert.equal(second.prepare("SELECT repository_standards FROM review_prompts").get()?.repository_standards, "仓库约束");
      assert.equal(second.prepare("SELECT repository_context_enabled FROM project_review_settings").get()?.repository_context_enabled, 1);
    } finally {
      second.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("openDatabase 支持内存库（测试用）", () => {
  const db = openDatabase(":memory:");
  const row = db.prepare("SELECT COUNT(*) AS n FROM admins").get() as { n: number };
  assert.equal(row.n, 0);
  db.close();
});
