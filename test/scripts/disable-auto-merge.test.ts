import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
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
