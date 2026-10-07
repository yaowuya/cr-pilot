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
}

const DEFAULT_PORT = 5001;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PROMPT_PATH = "prompts/review.md";
const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_GITLAB_API_TIMEOUT_MS = 15000;
const DEFAULT_BATCH_MAX_TOKENS = 6000;
const DEFAULT_RULES_DIR = "prompts/rules";
const DEFAULT_REVIEW_STYLE = "professional";
const DEFAULT_QUEUE_CONCURRENCY = 5;

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
    gitlabUrl: normalizeUrl(env.GITLAB_URL),
    gitlabInsecureTls: readBooleanFlag(env, "GITLAB_INSECURE_TLS"),
    gitlabApiTimeoutMs: readPositiveInt(env, "GITLAB_API_TIMEOUT", DEFAULT_GITLAB_API_TIMEOUT_MS),
    batchMaxTokens: readPositiveInt(env, "REVIEW_BATCH_MAX_TOKENS", DEFAULT_BATCH_MAX_TOKENS),
    rulesDir: env.REVIEW_RULES_DIR?.trim() || DEFAULT_RULES_DIR,
    reviewStyle: env.REVIEW_STYLE?.trim() || DEFAULT_REVIEW_STYLE,
    queueConcurrency: readPositiveInt(env, "QUEUE_CONCURRENCY", DEFAULT_QUEUE_CONCURRENCY),
  };
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
