/**
 * 环境变量管理路由。
 *
 * 语义（D-012 / D-014）：查询返回当前生效值，密钥类字段掩码；更新同时写数据库
 * 覆盖与 `process.env`，使可热更新项立即生效，并回报需要重启的键。
 */
import { Router } from "express";
import type { ConfigRepository } from "../../../domain/runtime-config.ts";
import { isSecretKey, READ_ONLY_KEYS, RESTART_REQUIRED_KEYS } from "../../../infrastructure/sqlite/config-repo.ts";

/**
 * 允许通过管理页面修改的配置键白名单。
 *
 * 与 `AppConfig` 的字段一一对应，避免把主机环境变量（`PATH`、`HOME`、`HTTP_PROXY`
 * 等）暴露成可写项——它们不属于本服务的配置，写进覆盖表会在下次启动注入
 * `process.env`，影响 pi 子进程的路径与网络解析。
 */
const MANAGEABLE_KEYS: ReadonlySet<string> = new Set([
  "PORT",
  "HOST",
  "LOG_FILE",
  "REVIEW_PROMPT_PATH",
  "REVIEW_TIMEOUT_MS",
  "REVIEW_BATCH_MAX_TOKENS",
  "REVIEW_RULES_DIR",
  "REVIEW_STYLE",
  "QUEUE_CONCURRENCY",
  "LOG_LEVEL",
  "GITLAB_URL",
  "GITLAB_INSECURE_TLS",
  "GITLAB_API_TIMEOUT",
  "LLMGW_API_KEY",
  "ADMIN_USERNAME",
  "ADMIN_PASSWORD",
  "AUTH_SALT",
  "DB_PATH",
]);

/** 需要正整数取值的键；`0` 或非数字会让 `loadConfig` 在下次启动抛错。 */
const POSITIVE_INT_KEYS: ReadonlySet<string> = new Set([
  "PORT",
  "REVIEW_TIMEOUT_MS",
  "REVIEW_BATCH_MAX_TOKENS",
  "QUEUE_CONCURRENCY",
  "GITLAB_API_TIMEOUT",
]);

/** 只接受 0/1 的布尔键。 */
const BOOLEAN_KEYS: ReadonlySet<string> = new Set(["GITLAB_INSECURE_TLS"]);

/** 枚举取值的键。 */
const ENUM_KEYS: Record<string, readonly string[]> = {
  LOG_LEVEL: ["debug", "info", "warn", "error", "silent"],
};

/**
 * 校验单个配置值；通过返回空串，失败返回中文原因。
 *
 * 空串始终放行：它表示「清空该覆盖、回落到环境变量」，不是非法值。
 * 校验规则必须与 `src/shared/config.ts` 的读取规则一致，否则页面能写入
 * 下次启动会让服务直接退出的值。
 */
function validateValue(key: string, value: string): string {
  if (value === "") return "";
  if (POSITIVE_INT_KEYS.has(key)) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      return `配置项 ${key} 必须是正整数，实际收到 ${value}`;
    }
  }
  if (BOOLEAN_KEYS.has(key) && value !== "0" && value !== "1") {
    return `配置项 ${key} 必须是 0 或 1，实际收到 ${value}`;
  }
  const allowed = ENUM_KEYS[key];
  if (allowed && !allowed.includes(value)) {
    return `配置项 ${key} 只能是 ${allowed.join(" / ")}，实际收到 ${value}`;
  }
  return "";
}

/** 环境变量路由依赖。 */
export interface ConfigRouterDeps {
  config: ConfigRepository;
}

/**
 * 掩码密钥值。
 *
 * 长度大于 8 时保留前 4 与后 4 位，让运维能核对「是不是那把钥匙」而不暴露全值；
 * 更短的值全部掩掉，避免掩码后仍可推断。
 */
export function maskSecret(value: string): string {
  if (value.length <= 8) return "****";
  return `${value.slice(0, 4)}****${value.slice(-4)}`;
}

/**
 * 页面展示的配置键：白名单内的全部配置项 + 历史遗留的覆盖项。
 *
 * 白名单键始终列出（即使进程环境变量里没有），让运维能看到「可配置什么」以及
 * 哪些是只读项；名字后不带值即表示未设置。
 * 不回显主机全部环境变量：那会把 `PATH`、`HOME`、`HTTP_PROXY` 之类的无关项一并
 * 展示成「可管理配置」，既干扰阅读，也让人误以为它们属于本服务。
 */
function collectKeys(repo: ConfigRepository): string[] {
  const keys = new Set<string>(MANAGEABLE_KEYS);
  for (const item of repo.list()) {
    // 历史遗留的覆盖项（如旧版本写入的任意键）仍展示，便于运维清理。
    keys.add(item.key);
  }
  return [...keys].sort();
}

/** 创建环境变量管理路由。 */
export function createConfigRouter(deps: ConfigRouterDeps): Router {
  const router = Router();

  router.get("/", (_req, res) => {
    const overrides = new Map(deps.config.list().map((item) => [item.key, item.value] as const));
    const items = collectKeys(deps.config).map((key) => {
      // 生效值优先取覆盖；覆盖为空串或不存在时取进程环境变量。
      const effective = overrides.get(key) || process.env[key] || "";
      const masked = isSecretKey(key);
      return {
        key,
        value: masked ? maskSecret(effective) : effective,
        masked,
        restartRequired: RESTART_REQUIRED_KEYS.has(key),
        overridden: overrides.has(key),
        // 启动引导类键只读：DB_PATH 改动会让开库路径与启动横幅分叉，
        // ADMIN_* 只在引导时生效。
        readOnly: READ_ONLY_KEYS.has(key),
      };
    });
    res.json({ items });
  });

  router.put("/", (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const rawItems = Array.isArray(body.items) ? body.items : null;
    if (!rawItems) {
      res.status(400).json({ error: "请求体需要 items 数组" });
      return;
    }
    const items: { key: string; value: string }[] = [];
    for (const entry of rawItems) {
      if (typeof entry !== "object" || entry === null) {
        res.status(400).json({ error: "items 每项必须是对象" });
        return;
      }
      const record = entry as Record<string, unknown>;
      const key = typeof record.key === "string" ? record.key.trim() : "";
      const value = typeof record.value === "string" ? record.value : "";
      if (!key) {
        res.status(400).json({ error: "配置项 key 不能为空" });
        return;
      }
      // 只允许改动「配置项」而不是主机任意环境变量：否则 PATH 之类的键会被写进
      // 覆盖表并在下次启动注入 process.env，影响 pi 子进程。
      if (!MANAGEABLE_KEYS.has(key)) {
        res.status(400).json({ error: `不支持修改配置项 ${key}` });
        return;
      }
      if (READ_ONLY_KEYS.has(key)) {
        res.status(400).json({ error: `配置项 ${key} 为只读，请通过 .env 修改后重启` });
        return;
      }
      // 取值校验：非法值会在下次启动让 loadConfig 抛错且进程直接退出，
      // 此时日志器还没建好，排障拿不到任何线索（见 bootstrap 的启动顺序）。
      const invalid = validateValue(key, value);
      if (invalid) {
        res.status(400).json({ error: invalid });
        return;
      }
      items.push({ key, value });
    }

    deps.config.setAll(items);
    // 同步进程环境变量，让消费方在下一次读取时拿到新值。
    for (const item of items) {
      if (item.value === "") delete process.env[item.key];
      else process.env[item.key] = item.value;
    }
    // 只回报「消费方持有快照」的键：它们必须重启才生效。同步写 process.env 并不
    // 等于立即生效——已构造的队列/客户端/管线不会重新读取。
    const restartRequired = items.map((item) => item.key).filter((key) => RESTART_REQUIRED_KEYS.has(key));
    res.json({ items, restartRequired });
  });

  return router;
}
