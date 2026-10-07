/**
 * 配置覆盖仓储：基于 `node:sqlite` 的同步实现。
 *
 * 表中每行一个键，`value` 为空串表示清空覆盖（回落环境变量），
 * 因此不会删除行——保留行便于页面展示「曾被覆盖」的状态。
 */
import type { DatabaseSync } from "node:sqlite";
import type { ConfigOverride, ConfigRepository } from "../../domain/runtime-config.ts";

/**
 * 需要重启容器才能生效的配置键。
 *
 * 判定依据来自 design 接口章节的可热更新项清单：启动期一次性绑定（PORT/HOST/
 * 日志文件路径/规则目录）或由 pi 子进程读取（LLMGW_API_KEY）的键在此列。
 * 其余键（如 REVIEW_TIMEOUT_MS、QUEUE_CONCURRENCY、LOG_LEVEL）在每次评审或
 * 每次写入时读取，可热更新。
 */
export const RESTART_REQUIRED_KEYS: ReadonlySet<string> = new Set([
  "PORT",
  "HOST",
  "LOG_FILE",
  "REVIEW_PROMPT_PATH",
  "REVIEW_RULES_DIR",
  "ADMIN_USERNAME",
  "ADMIN_PASSWORD",
  "LLMGW_API_KEY",
]);

/** 判断配置键是否属于密钥类（读取时需掩码）。 */
export function isSecretKey(key: string): boolean {
  return /KEY|SECRET|TOKEN|PASSWORD/i.test(key);
}

/** 创建配置覆盖仓储。 */
export function createConfigRepository(db: DatabaseSync): ConfigRepository {
  return {
    list() {
      const rows = db.prepare("SELECT key, value, updated_at FROM config_overrides ORDER BY key ASC").all() as unknown as {
        key: string;
        value: string | null;
        updated_at: number;
      }[];
      return rows.map((row) => ({ key: row.key, value: row.value ?? "", updatedAt: row.updated_at }) satisfies ConfigOverride);
    },

    setAll(items) {
      const now = Date.now();
      // UPSERT：同一事务内逐条写入，避免中途失败留下部分覆盖。
      const statement = db.prepare(`
        INSERT INTO config_overrides (key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `);
      for (const item of items) {
        statement.run(item.key, item.value, now);
      }
    },

    clear(keys) {
      const statement = db.prepare("DELETE FROM config_overrides WHERE key = ?");
      for (const key of keys) {
        statement.run(key);
      }
    },
  };
}
