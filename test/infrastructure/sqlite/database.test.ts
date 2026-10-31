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
      first.prepare("INSERT INTO project_review_settings (project, repository_context_enabled, updated_at) VALUES (?, ?, ?)").run("group/a", 1, 2);
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

test("旧库升级补齐 token 五列，历史记录保持 NULL 且可重复升级", () => {
  const dir = mkdtempSync(join(tmpdir(), "crp-db-token-"));
  const path = join(dir, "old.db");
  try {
    // 模拟升级前只有基础列的 review_records，并写入一条历史记录。
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE review_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, project_name TEXT NOT NULL,
      mr_iid INTEGER NOT NULL, committer_name TEXT NOT NULL, change_count INTEGER NOT NULL,
      batch_count INTEGER NOT NULL, score INTEGER, duration_ms INTEGER NOT NULL, result TEXT NOT NULL,
      error_message TEXT, comment_url TEXT, started_at INTEGER NOT NULL, finished_at INTEGER NOT NULL
    );
    INSERT INTO review_records (project_id, project_name, mr_iid, committer_name, change_count,
      batch_count, score, duration_ms, result, started_at, finished_at)
    VALUES (1, 'g/p', 7, 'alice', 2, 1, 88, 100, 'success', 1, 2);`);
    old.close();

    const first = openDatabase(path);
    try {
      const columns = first.prepare("PRAGMA table_info(review_records)").all() as unknown as Array<{ name: string }>;
      for (const column of ["input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "total_tokens"]) {
        assert.ok(columns.some((item) => item.name === column), `迁移必须补齐 ${column}`);
      }
      const row = first.prepare("SELECT * FROM review_records").get() as Record<string, unknown>;
      assert.equal(row.score, 88, "历史数据不能被改写");
      for (const column of ["input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "total_tokens"]) {
        assert.equal(row[column], null, `${column} 必须是 NULL：历史用量不可回填，不能伪造为 0`);
      }
    } finally {
      first.close();
    }

    // 二次升级必须幂等（不能因列已存在而抛错，也不能重置已有值）。
    const second = openDatabase(path);
    try {
      second.prepare("UPDATE review_records SET total_tokens = 1234 WHERE id = 1").run();
    } finally {
      second.close();
    }
    const third = openDatabase(path);
    try {
      assert.equal(third.prepare("SELECT total_tokens FROM review_records WHERE id = 1").get()?.total_tokens, 1234);
    } finally {
      third.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
