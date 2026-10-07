/**
 * 一次性把 `prompts/rules/*.yaml` 导入数据库。
 *
 * 用途：升级到 prompt 入库版本后，既有的规则文件不会自动迁移。启动日志会显示
 * 数据库与 yaml 的命中分布，若全部走兜底说明需要执行本脚本。
 *
 * 用法：`node scripts/import-prompts.ts`（读取与主程序相同的 .env 与 DB_PATH）。
 * 已存在的 repository 会跳过，因此可安全重复执行。
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { loadConfig } from "../src/shared/config.ts";
import { openDatabase } from "../src/infrastructure/sqlite/database.ts";
import { createPromptRepository } from "../src/infrastructure/sqlite/prompt-repo.ts";

/** 加载 .env（存在才加载），与 bootstrap 的加载顺序保持一致。 */
function loadEnvFileIfPresent(path: string): void {
  try {
    process.loadEnvFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

loadEnvFileIfPresent(".env");
const config = loadConfig();
// 与 bootstrap 一致：首次运行时 data 目录可能还不存在，先建好再开库。
if (config.dbPath !== ":memory:") {
  mkdirSync(dirname(config.dbPath), { recursive: true });
}
const db = openDatabase(config.dbPath);
const prompts = createPromptRepository(db);
const result = prompts.importFromDir(config.rulesDir);

process.stdout.write(
  `prompt 导入完成：目录=${config.rulesDir} 导入=${result.imported} 跳过=${result.skipped}\n` +
    `数据库：${config.dbPath}\n` +
    `现有 prompt：${prompts.list().map((item) => item.repository).join(", ") || "（空）"}\n` +
    `跳过原因：文件缺少 repository、结构非法，或同名 repository 已存在。\n`,
);
db.close();
