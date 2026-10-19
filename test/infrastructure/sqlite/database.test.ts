import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("openDatabase 支持内存库（测试用）", () => {
  const db = openDatabase(":memory:");
  const row = db.prepare("SELECT COUNT(*) AS n FROM admins").get() as { n: number };
  assert.equal(row.n, 0);
  db.close();
});
