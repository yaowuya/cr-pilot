#!/usr/bin/env node
/**
 * 回退旧版本前批量撤销全部自动合并授权。
 *
 * 旧二进制会忽略 auto_merge_* 列，也不会保护 Prompt / evaluator 信任根；若保留
 * enabled=1，日后重新升级会让策略在未经管理员复核的配置上复活。本脚本只关闭
 * enabled，不删除门槛、目标分支和合并方式，便于升级后由管理员逐项重新审核。
 */
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { loadConfig } from "../src/shared/config.ts";
import { createPromptRepository } from "../src/infrastructure/sqlite/prompt-repo.ts";

/** 加载与服务相同的本地环境文件；部署环境可直接注入变量。 */
function loadEnvFileIfPresent(path: string): void {
  try {
    process.loadEnvFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** 写入前以只读连接验证应用库身份；错误路径不能被初始化成一个看似成功的空库。 */
function assertTargetDatabase(path: string): void {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const tables = new Set(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => String(row.name)),
    );
    for (const table of ["review_prompts", "project_review_settings", "config_overrides", "review_records"]) {
      if (!tables.has(table)) throw new Error(`数据库不是 cr-pilot 当前 schema：缺少表 ${table}`);
    }
    const columns = new Set(
      db.prepare("PRAGMA table_info(project_review_settings)").all().map((row) => String(row.name)),
    );
    for (const column of [
      "project", "repository_context_enabled", "auto_merge_enabled", "auto_merge_minimum_score",
      "auto_merge_target_mode", "auto_merge_target_branches", "auto_merge_method",
      "auto_merge_remove_source_branch", "updated_at",
    ]) {
      if (!columns.has(column)) throw new Error(`数据库不支持自动合并回退门禁：缺少列 ${column}`);
    }
  } finally {
    db.close();
  }
}

function main(): void {
  loadEnvFileIfPresent(".env");
  const config = loadConfig();
  if (config.dbPath === ":memory:" || !existsSync(config.dbPath)) {
    throw new Error(`数据库不存在，拒绝生成空库：${config.dbPath}`);
  }

  assertTargetDatabase(config.dbPath);
  // 身份验证通过后才以读写模式打开；不调用 openDatabase，避免回退命令隐式建表或迁移。
  const db = new DatabaseSync(config.dbPath);
  db.exec("PRAGMA busy_timeout = 5000");
  try {
    const prompts = createPromptRepository(db);
    const disabled = prompts.disableAllAutoMergePolicies?.();
    if (disabled === undefined) throw new Error("当前仓储不支持批量关闭自动合并策略");
    process.stdout.write(`自动合并回退门禁已完成：关闭策略=${disabled}；数据库=${config.dbPath}\n`);
    process.stdout.write("门槛、分支和合并方式已保留；重新升级后须由管理员逐项复核并重新开启。\n");
  } finally {
    db.close();
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`自动合并回退门禁失败：${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
