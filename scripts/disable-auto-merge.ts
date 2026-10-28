#!/usr/bin/env node
/**
 * 回退旧版本前批量撤销全部自动合并授权。
 *
 * 旧二进制会忽略 auto_merge_* 列，也不会保护 Prompt / evaluator 信任根；若保留
 * enabled=1，日后重新升级会让策略在未经管理员复核的配置上复活。本脚本只关闭
 * enabled，不删除门槛、目标分支和合并方式，便于升级后由管理员逐项重新审核。
 */
import { existsSync } from "node:fs";
import { loadConfig } from "../src/shared/config.ts";
import { openDatabase } from "../src/infrastructure/sqlite/database.ts";
import { createPromptRepository } from "../src/infrastructure/sqlite/prompt-repo.ts";

/** 加载与服务相同的本地环境文件；部署环境可直接注入变量。 */
function loadEnvFileIfPresent(path: string): void {
  try {
    process.loadEnvFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function main(): void {
  loadEnvFileIfPresent(".env");
  const config = loadConfig();
  if (config.dbPath === ":memory:" || !existsSync(config.dbPath)) {
    throw new Error(`数据库不存在，拒绝生成空库：${config.dbPath}`);
  }

  const db = openDatabase(config.dbPath);
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
