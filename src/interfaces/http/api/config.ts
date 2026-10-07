/**
 * 环境变量管理路由。
 *
 * 语义（D-012 / D-014）：查询返回当前生效值，密钥类字段掩码；更新同时写数据库
 * 覆盖与 `process.env`，使可热更新项立即生效，并回报需要重启的键。
 */
import { Router } from "express";
import type { ConfigRepository } from "../../../domain/runtime-config.ts";
import { isSecretKey, RESTART_REQUIRED_KEYS } from "../../../infrastructure/sqlite/config-repo.ts";

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

/** 页面可管理的配置键白名单来源：库里已有的覆盖 + 进程环境变量中已知的配置项。 */
function collectKeys(repo: ConfigRepository, env: NodeJS.ProcessEnv): string[] {
  const keys = new Set<string>();
  for (const item of repo.list()) keys.add(item.key);
  // 只暴露形如全大写下划线的配置键，避免把 shell 的无关变量（PATH、HOME 等）
  // 一并展示给页面。
  for (const key of Object.keys(env)) {
    if (/^[A-Z][A-Z0-9_]*$/.test(key)) keys.add(key);
  }
  return [...keys].sort();
}

/** 创建环境变量管理路由。 */
export function createConfigRouter(deps: ConfigRouterDeps): Router {
  const router = Router();

  router.get("/", (_req, res) => {
    const overrides = new Map(deps.config.list().map((item) => [item.key, item.value] as const));
    const items = collectKeys(deps.config, process.env).map((key) => {
      // 生效值优先取覆盖；覆盖为空串或不存在时取进程环境变量。
      const effective = overrides.get(key) || process.env[key] || "";
      const masked = isSecretKey(key);
      return {
        key,
        value: masked ? maskSecret(effective) : effective,
        masked,
        restartRequired: RESTART_REQUIRED_KEYS.has(key),
        overridden: overrides.has(key),
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
      items.push({ key, value });
    }

    deps.config.setAll(items);
    // 同步进程环境变量：可热更新项（超时、并发、日志级别等）下一次读取即生效。
    for (const item of items) {
      if (item.value === "") delete process.env[item.key];
      else process.env[item.key] = item.value;
    }
    const restartRequired = items.map((item) => item.key).filter((key) => RESTART_REQUIRED_KEYS.has(key));
    res.json({ items, restartRequired });
  });

  return router;
}
