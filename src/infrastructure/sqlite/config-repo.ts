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
 * 判定标准是「消费方是否在每次使用时重新读取」：
 * - 启动期一次性绑定：`PORT`、`HOST`、`LOG_FILE`、`REVIEW_PROMPT_PATH`、`REVIEW_RULES_DIR`
 * - 由外部进程读取：`LLMGW_API_KEY`（pi 子进程）
 * - 只在引导时读取：`ADMIN_USERNAME`、`ADMIN_PASSWORD`
 * - 消费方持有构造时快照：`GITLAB_API_TIMEOUT` / `GITLAB_INSECURE_TLS`（客户端构造时固定）、
 *   `QUEUE_CONCURRENCY`（队列按并发数创建槽位）、`REVIEW_TIMEOUT_MS` /
 *   `REVIEW_BATCH_MAX_TOKENS`（管线构造时解构）、`LOG_LEVEL`（日志器创建时求值阈值）、
 *   `REVIEW_STYLE`（规则模板启动时渲染一次）
 * - 开库路径：`DB_PATH`（见下方说明）
 *
 * 关于 `DB_PATH`：`src/bootstrap.ts` 用第一次 `loadConfig()` 的路径开库，之后才应用
 * 覆盖；若把它当作可热更新项，启动横幅显示的路径与实际打开的库会分叉，导入脚本也会
 * 写到另一个库。因此它必须在此清单中，同时由 `READ_ONLY_KEYS` 禁止页面修改。
 *
 * 新增配置项时，若消费方是启动期绑定或持有快照，务必同步加入本集合，否则页面会
 * 错误地提示「已立即生效」。
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
  "DB_PATH",
  "GITLAB_URL",
  "GITLAB_API_TIMEOUT",
  "GITLAB_INSECURE_TLS",
  "QUEUE_CONCURRENCY",
  "REVIEW_TIMEOUT_MS",
  "REVIEW_BATCH_MAX_TOKENS",
  "LOG_LEVEL",
  "REVIEW_STYLE",
  "AUTH_SALT",
]);

/**
 * 管理页面不可修改的配置键（启动引导类）。
 *
 * `DB_PATH` 改动会使启动横幅与实际打开的库分叉；`ADMIN_*` 只在引导创建首个账号时
 * 生效，改了也没有意义。三者只在页面上只读展示。
 */
export const READ_ONLY_KEYS: ReadonlySet<string> = new Set(["DB_PATH", "ADMIN_USERNAME", "ADMIN_PASSWORD"]);

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
