import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../../src/infrastructure/sqlite/database.ts";
import { createPromptRepository } from "../../src/infrastructure/sqlite/prompt-repo.ts";

const ROOT = process.cwd();
const AUTH_SALT = "rollback-test-auth-salt-32-bytes";

function runCli(dbPath: string) {
  return spawnSync(process.execPath, ["scripts/disable-auto-merge.ts"], {
    cwd: ROOT,
    env: { ...process.env, AUTH_SALT, DB_PATH: dbPath },
    encoding: "utf8",
  });
}

test("package 与 README 把批量关闭命令列为旧版本回退硬门禁", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts?: Record<string, string> };
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  assert.equal(pkg.scripts?.["disable:auto-merge"], "node scripts/disable-auto-merge.ts");
  assert.match(readme, /回退到不支持自动合并的旧版本前[\s\S]*npm run disable:auto-merge/);
  assert.match(readme, /不得直接重新升级并启动服务/);
});

test("回退 CLI 批量关闭策略、保留参数并可安全重复执行", () => {
  const dir = mkdtempSync(join(tmpdir(), "crp-disable-auto-merge-"));
  const path = join(dir, "review.db");
  try {
    const db = openDatabase(path);
    const repo = createPromptRepository(db);
    repo.create({
      repository: "rules",
      projects: ["group/app"],
      systemPrompt: "system",
      userPrompt: "review {diffs_text}",
      projectSettings: [{
        project: "group/app",
        autoMergePolicy: {
          enabled: true,
          minimumScore: 97,
          targetMode: "specified",
          targetBranches: ["main"],
          method: "squash",
          removeSourceBranch: true,
        },
      }],
    });
    db.close();

    const first = runCli(path);
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /关闭策略=1/);
    assert.match(first.stdout, /管理员逐项复核并重新开启/);

    const reopened = openDatabase(path);
    const policy = createPromptRepository(reopened).resolveProjectSetting?.("group/app")?.autoMergePolicy;
    assert.deepEqual(policy, {
      enabled: false,
      minimumScore: 97,
      targetMode: "specified",
      targetBranches: ["main"],
      method: "squash",
      removeSourceBranch: true,
    });
    reopened.close();

    const second = runCli(path);
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /关闭策略=0/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("回退 CLI 拒绝错误 DB_PATH，不能静默创建空库", () => {
  const dir = mkdtempSync(join(tmpdir(), "crp-disable-auto-merge-missing-"));
  const path = join(dir, "missing.db");
  try {
    const result = runCli(path);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /数据库不存在/);
    assert.equal(existsSync(path), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("回退 CLI 拒绝已存在的空文件且不写入 SQLite schema", () => {
  const dir = mkdtempSync(join(tmpdir(), "crp-disable-auto-merge-empty-"));
  const path = join(dir, "empty.db");
  try {
    writeFileSync(path, "");
    const result = runCli(path);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /数据库不是|file is not a database|database disk image is malformed/i);
    assert.equal(statSync(path).size, 0, "只读身份验证不能把空文件初始化成应用数据库");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("回退 CLI 拒绝缺少 target mode 身份列的旧自动合并 schema", () => {
  const dir = mkdtempSync(join(tmpdir(), "crp-disable-auto-merge-old-schema-"));
  const path = join(dir, "old.db");
  try {
    const old = new DatabaseSync(path);
    old.exec(`
      CREATE TABLE review_prompts (id INTEGER PRIMARY KEY);
      CREATE TABLE config_overrides (key TEXT PRIMARY KEY);
      CREATE TABLE review_records (id INTEGER PRIMARY KEY);
      CREATE TABLE project_review_settings (
        project TEXT PRIMARY KEY,
        repository_context_enabled INTEGER,
        auto_merge_enabled INTEGER,
        auto_merge_minimum_score INTEGER,
        auto_merge_target_branches TEXT,
        auto_merge_method TEXT,
        auto_merge_remove_source_branch INTEGER,
        updated_at INTEGER
      );
    `);
    old.close();
    const result = runCli(path);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /缺少列 auto_merge_target_mode/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("回退 CLI 拒绝其他 SQLite 数据库且不注入 cr-pilot 表", () => {
  const dir = mkdtempSync(join(tmpdir(), "crp-disable-auto-merge-foreign-"));
  const path = join(dir, "foreign.db");
  try {
    const foreign = new DatabaseSync(path);
    foreign.exec("CREATE TABLE unrelated (id INTEGER PRIMARY KEY)");
    foreign.close();

    const result = runCli(path);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /不是 cr-pilot 当前 schema/);

    const reopened = new DatabaseSync(path, { readOnly: true });
    const names = reopened.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => String(row.name));
    reopened.close();
    assert.deepEqual(names, ["unrelated"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
