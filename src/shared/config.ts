import { parseLogLevel, type LogLevel } from "./logger.ts";

/** 服务运行期配置。所有字段都有默认值，只有非法输入才会让启动失败。 */
export interface AppConfig {
  /** 监听端口。默认 5001，对齐团队既有约定。 */
  port: number;
  /** 监听地址。默认只绑本机。 */
  host: string;
  /** 评审 prompt 兜底文件路径（无 YAML 规则时使用）。 */
  promptPath: string;
  /** 单次评审（单批 / 汇总）的超时毫秒数。 */
  timeoutMs: number;
  /** 日志级别。默认 info，输出请求处理的每个步骤。 */
  logLevel: LogLevel;
  /** 日志文件路径。空串 = 只写控制台；非空 = 同时写入该文件（目录不存在时自动创建）。 */
  logFile: string;
  /** GitLab 实例地址，不带尾部斜杠。可选：缺省时从 webhook 的 X-Gitlab-Instance 头或 payload 派生。 */
  gitlabUrl: string;
  /** 为 true 时跳过 GitLab TLS 证书校验，仅用于内网自签名场景。 */
  gitlabInsecureTls: boolean;
  /** GitLab API 单次请求超时毫秒数。 */
  gitlabApiTimeoutMs: number;
  /** 单批评审的 token 预算。 */
  batchMaxTokens: number;
  /** 仓库规则目录，default.yaml 为全局默认。 */
  rulesDir: string;
  /** 评审风格，注入规则模板的 `{{ style }}` 与风格分支。 */
  reviewStyle: string;
  /** 后台队列并发数：同时处理的 MR 任务上限。 */
  queueConcurrency: number;
  /** SQLite 数据库文件路径。容器部署时挂在持久卷下。 */
  dbPath: string;
  /** 首次启动时创建的首个管理员用户名；账号已存在时不生效。 */
  adminUsername: string;
  /** 首次启动时创建的首个管理员密码；账号已存在时不生效。 */
  adminPassword: string;
  /**
   * 令牌与密码盐的部署盐，来自 `AUTH_SALT`。
   *
   * 不入库：数据库被单独取走时，哈希无法用已知字典直接比对。为空时启动会告警
   * ——空盐会让令牌可预测。
   */
  authSalt: string;
}

const DEFAULT_PORT = 5001;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PROMPT_PATH = "prompts/review.md";
const DEFAULT_TIMEOUT_MS = 1200000;
const DEFAULT_GITLAB_API_TIMEOUT_MS = 15000;
const DEFAULT_BATCH_MAX_TOKENS = 120000;
const DEFAULT_RULES_DIR = "prompts/rules";
const DEFAULT_REVIEW_STYLE = "professional";
const DEFAULT_QUEUE_CONCURRENCY = 5;
const DEFAULT_LOG_FILE = "";
/** 数据库默认路径：容器内解析到 WORKDIR 下的 data 目录（挂持久卷）。 */
const DEFAULT_DB_PATH = "./data/cr-pilot.db";

/**
 * 读取服务配置。
 *
 * 非法值与缺失的必填项直接抛出，而不是回退默认。`GITLAB_URL` 可选：
 * 现代 GitLab 的 webhook 请求头自带实例地址（X-Gitlab-Instance），payload 也有
 * homepage/web_url 可以派生，客户端会在任务级用「任务 URL > 配置 URL」兜底。
 * 访问令牌不在这里配置：GitLab webhook 请求头的 X-Gitlab-Token 随事件携带，
 * 每个项目的 token 各自独立（对齐参考项目）。返回的 URL 会去掉尾部斜杠。
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    port: readPositiveInt(env, "PORT", DEFAULT_PORT),
    host: env.HOST?.trim() || DEFAULT_HOST,
    promptPath: env.REVIEW_PROMPT_PATH?.trim() || DEFAULT_PROMPT_PATH,
    timeoutMs: readPositiveInt(env, "REVIEW_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
    logLevel: parseLogLevel(env.LOG_LEVEL),
    logFile: env.LOG_FILE?.trim() || DEFAULT_LOG_FILE,
    gitlabUrl: normalizeUrl(env.GITLAB_URL),
    gitlabInsecureTls: readBooleanFlag(env, "GITLAB_INSECURE_TLS"),
    gitlabApiTimeoutMs: readPositiveInt(env, "GITLAB_API_TIMEOUT", DEFAULT_GITLAB_API_TIMEOUT_MS),
    batchMaxTokens: readPositiveInt(env, "REVIEW_BATCH_MAX_TOKENS", DEFAULT_BATCH_MAX_TOKENS),
    rulesDir: env.REVIEW_RULES_DIR?.trim() || DEFAULT_RULES_DIR,
    reviewStyle: env.REVIEW_STYLE?.trim() || DEFAULT_REVIEW_STYLE,
    queueConcurrency: readPositiveInt(env, "QUEUE_CONCURRENCY", DEFAULT_QUEUE_CONCURRENCY),
    dbPath: env.DB_PATH?.trim() || DEFAULT_DB_PATH,
    adminUsername: env.ADMIN_USERNAME?.trim() || "",
    adminPassword: env.ADMIN_PASSWORD?.trim() || "",
    authSalt: env.AUTH_SALT?.trim() || "",
  };
}

/**
 * 把数据库中的配置覆盖写入环境变量（P-005「启动时 DB 优先」）。
 *
 * 调用顺序必须是「先应用覆盖，再 loadConfig」：loadConfig 读取的是进程环境变量
 * 快照，覆盖写晚了就不生效。空串覆盖视为清空——不写入环境变量，保留进程原有值，
 * 与页面「清空该覆盖」的语义一致。
 */
export function applyConfigOverrides(env: NodeJS.ProcessEnv, overrides: Record<string, string>): void {
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== "") env[key] = value;
  }
}

/** 规范化实例 URL：去空白与尾部斜杠；空值返回空串（表示「从 webhook 派生」）。 */
function normalizeUrl(value: string | undefined): string {
  return value?.trim().replace(/\/+$/, "") ?? "";
}

/** 读取 0/1 布尔开关。空值走 false，其它值抛错，避免拼错后静默关闭安全开关。 */
function readBooleanFlag(env: NodeJS.ProcessEnv, name: string): boolean {
  const raw = env[name]?.trim();
  if (!raw) return false;
  if (raw === "1" || raw === "true") return true;
  if (raw === "0" || raw === "false") return false;
  throw new Error(`环境变量 ${name} 必须是 0 或 1，实际收到 ${raw}`);
}

/** 读取正整数环境变量。空值走默认值，非正整数抛错并带上变量名。 */
function readPositiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`环境变量 ${name} 必须是正整数，实际收到 ${raw}`);
  }
  return value;
}
