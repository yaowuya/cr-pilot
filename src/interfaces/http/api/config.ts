/**
 * 环境变量管理路由。
 *
 * 语义（D-012 / D-014）：查询返回当前生效值，密钥类字段掩码；管理员更新时
 * 同时写数据库覆盖与 `process.env`，使可热更新项立即生效，并回报需要重启的键。
 * 运行配置会影响自动合并 evaluator 与执行链，因此普通账号只读。
 */
import { Router, type RequestHandler } from "express";
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
  "ADOPTION_TRACKING_ENABLED",
  "ADOPTION_SYNC_INTERVAL_MS",
]);

/** 需要正整数取值的键；`0` 或非数字会让 `loadConfig` 在下次启动抛错。 */
const POSITIVE_INT_KEYS: ReadonlySet<string> = new Set([
  "PORT",
  "REVIEW_TIMEOUT_MS",
  "REVIEW_BATCH_MAX_TOKENS",
  "QUEUE_CONCURRENCY",
  "GITLAB_API_TIMEOUT",
  "ADOPTION_SYNC_INTERVAL_MS",
]);

/** 只接受 0/1 的布尔键。 */
const BOOLEAN_KEYS: ReadonlySet<string> = new Set(["GITLAB_INSECURE_TLS", "ADOPTION_TRACKING_ENABLED"]);

/** 枚举取值的键。 */
const ENUM_KEYS: Record<string, readonly string[]> = {
  LOG_LEVEL: ["debug", "info", "warn", "error", "silent"],
};

/**
 * 配置项说明元数据：中文名、用途、默认值与取值示例。
 *
 * 页面只显示英文键名，运维看不出每一项是干什么的。说明集中在这里而不是前端：
 * 1) 新增配置键时与 `MANAGEABLE_KEYS` 在同一文件内，遗漏容易被发现；
 * 2) 说明随接口下发，任何客户端（含 Apifox、curl）都能拿到，不只服务前端；
 * 3) 默认值直接抄自 `src/shared/config.ts`，改默认值时改这里一处即可对照。
 *
 * 未在此登记的键（如历史遗留覆盖项）页面会退化为只显示键名，不阻断展示。
 */
interface ConfigDoc {
  /** 中文名，页面主标题。 */
  label: string;
  /** 用途说明，页面副标题。 */
  description: string;
  /** 生效默认值；空串表示默认未设置。 */
  defaultValue?: string;
  /** 取值提示，如单位、可选值、格式示例。 */
  hint?: string;
}

const CONFIG_DOCS: Record<string, ConfigDoc> = {
  PORT: {
    label: "监听端口",
    description: "服务 HTTP 监听端口，容器部署时通常由 compose 固定为 5001",
    defaultValue: "5001",
    hint: "正整数，1-65535",
  },
  HOST: {
    label: "监听地址",
    description: "绑定的网卡地址。127.0.0.1 只允许本机访问；容器内需 0.0.0.0 才能被外部访问",
    defaultValue: "127.0.0.1",
    hint: "0.0.0.0 表示所有网卡",
  },
  LOG_FILE: {
    label: "日志文件路径",
    description: "非空时日志同时写入该文件（目录不存在会自动创建）；留空只输出到控制台",
    defaultValue: "",
    hint: "例如 /app/logs/cr-pilot.log",
  },
  LOG_LEVEL: {
    label: "日志级别",
    description: "控制日志详细程度。debug 会输出每个处理步骤，排障时用；silent 完全静默",
    defaultValue: "info",
    hint: "debug / info / warn / error / silent",
  },
  DB_PATH: {
    label: "数据库文件路径",
    description: "SQLite 数据库位置，存放评审记录、账号、prompt、厂商配置。只读，需改 .env 后重启",
    defaultValue: "./data/cr-pilot.db",
    hint: "只读项；容器内建议 /app/data/cr-pilot.db",
  },
  ADMIN_USERNAME: {
    label: "管理员账号名",
    description:
      "引导创建的首个账号，同时决定谁是管理员——只有这个账号能进「管理员」页。只读，需改 .env 后重启",
    defaultValue: "",
    hint: "只读项；留空则无人拥有管理员权限",
  },
  ADMIN_PASSWORD: {
    label: "管理员初始密码",
    description: "仅在账号表为空时用于创建首个账号；账号已存在时不生效。只读，需改 .env 后重启",
    defaultValue: "",
    hint: "只读项；至少 8 位",
  },
  AUTH_SALT: {
    label: "令牌盐",
    description:
      "登录令牌与密码哈希的部署盐。留空等于任何人都能离线算出管理员令牌，服务会拒绝启动",
    defaultValue: "",
    hint: "必填；建议 32 位随机 hex",
  },
  ADOPTION_TRACKING_ENABLED: {
    label: "启用采纳追踪",
    description:
      "追踪 AI 评审建议在后续提交中是否真的改了代码。开启后每条建议会追加少量 GitLab 文件读取与讨论查询",
    defaultValue: "true",
    hint: "true / false；关闭后已有数据保留但不再更新",
  },
  ADOPTION_SYNC_INTERVAL_MS: {
    label: "采纳追踪间隔",
    description: "多久扫描一次待追踪建议。间隔越短数据越新，GitLab 调用量越大",
    defaultValue: "600000",
    hint: "毫秒；600000 = 10 分钟",
  },
  GITLAB_URL: {
    label: "GitLab 实例地址",
    description: "拉取变更、回写评论及显式自动合并的目标实例。可留空——webhook 请求头会带实例地址，会自动派生",
    defaultValue: "",
    hint: "例如 https://code.cwoa.net（不带尾部斜杠）",
  },
  GITLAB_INSECURE_TLS: {
    label: "跳过 GitLab 证书校验",
    description: "仅内网自签名证书场景使用。开启后不再校验 HTTPS 证书，有中间人风险",
    defaultValue: "0",
    hint: "0 = 校验（推荐）/ 1 = 跳过",
  },
  GITLAB_API_TIMEOUT: {
    label: "GitLab API 超时",
    description: "单次调用 GitLab 接口的超时毫秒数。网络慢或变更很大时可适当调大",
    defaultValue: "15000",
    hint: "毫秒；15000 = 15 秒",
  },
  REVIEW_TIMEOUT_MS: {
    label: "评审超时",
    description: "单批评审与最终汇总各自的超时毫秒数。超时视为该次评审失败",
    defaultValue: "1200000",
    hint: "毫秒；1200000 = 20 分钟",
  },
  REVIEW_BATCH_MAX_TOKENS: {
    label: "单批 Token 预算",
    description: "一次送进模型的最大 token 数。变更大时会按此拆成多批评审，过小会导致批次过多、过大会超模型上限",
    defaultValue: "120000",
    hint: "正整数；需小于模型的上下文窗口",
  },
  REVIEW_PROMPT_PATH: {
    label: "兜底 prompt 文件",
    description: "数据库与 yaml 规则都没有命中时使用的 Markdown prompt 路径",
    defaultValue: "prompts/review.md",
    hint: "相对仓库根目录的路径",
  },
  REVIEW_RULES_DIR: {
    label: "规则目录",
    description: "仓库级 yaml 规则目录，default.yaml 为全局默认。「Prompt 管理 → 从 yaml 导入」会扫描这里",
    defaultValue: "prompts/rules",
    hint: "相对仓库根目录的路径",
  },
  REVIEW_STYLE: {
    label: "评审风格",
    description: "注入规则模板的 {{ style }} 变量，影响 prompt 里的风格分支选择",
    defaultValue: "professional",
    hint: "需与 prompt 模板里的风格分支名一致",
  },
  QUEUE_CONCURRENCY: {
    label: "评审并发数",
    description: "同时处理多少个 MR 任务。过大可能压垮模型网关或触发 GitLab 限流",
    defaultValue: "5",
    hint: "正整数",
  },
  LLMGW_API_KEY: {
    label: "旧版模型密钥",
    description:
      "单厂商时代的模型密钥，供 pi-agent/models.json 的 $LLMGW_API_KEY 插值使用。多厂商配置请到「AI 厂商」页",
    defaultValue: "",
    hint: "留空表示未配置",
  },
};

/** 读取某键的说明；未登记时返回 undefined，由前端退化为只显示键名。 */
function readDoc(key: string): ConfigDoc | undefined {
  return CONFIG_DOCS[key];
}

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

  /**
   * 运行配置是自动合并 evaluator 与执行链的信任根，因此写操作始终仅管理员。
   * 不能按“当前是否已启用自动合并”放行，否则普通账号可先预植恶意模型或
   * GitLab 配置，再由管理员开启策略，从而绕过启用时的权限边界。
   */
  const requireConfigWriteAccess: RequestHandler = (_req, res, next) => {
    if (res.locals.isAdmin === true) {
      next();
      return;
    }
    res.status(403).json({ error: "修改运行配置需要管理员权限" });
  };

  router.get("/", (_req, res) => {
    const overrides = new Map(deps.config.list().map((item) => [item.key, item.value] as const));
    const items = collectKeys(deps.config).map((key) => {
      // 生效值优先取覆盖；覆盖为空串或不存在时取进程环境变量。
      const effective = overrides.get(key) || process.env[key] || "";
      const masked = isSecretKey(key);
      const doc = readDoc(key);
      return {
        key,
        value: masked ? maskSecret(effective) : effective,
        masked,
        restartRequired: RESTART_REQUIRED_KEYS.has(key),
        overridden: overrides.has(key),
        // 启动引导类键只读：DB_PATH 改动会让开库路径与启动横幅分叉，
        // ADMIN_* 只在引导时生效。
        readOnly: READ_ONLY_KEYS.has(key),
        // 说明元数据：页面据此展示中文名与用途。未登记的键这几个字段为空，
        // 前端退化为只显示键名，不影响编辑功能。
        label: doc?.label ?? "",
        description: doc?.description ?? "",
        defaultValue: doc?.defaultValue ?? "",
        hint: doc?.hint ?? "",
      };
    });
    res.json({ items });
  });

  router.put("/", requireConfigWriteAccess, (req, res) => {
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
