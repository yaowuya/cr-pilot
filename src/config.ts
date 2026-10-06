import { parseLogLevel, type LogLevel } from "./logger.ts";

/** 服务运行期配置。所有字段都有默认值，只有非法输入才会让启动失败。 */
export interface AppConfig {
  /** 监听端口。 */
  port: number;
  /** 监听地址。默认只绑本机，接口按已确认决策不做鉴权。 */
  host: string;
  /** 评审 prompt 文件路径，每次评审都重新读取。 */
  promptPath: string;
  /** 单次评审的超时毫秒数。 */
  timeoutMs: number;
  /** 日志级别。默认 info，输出请求处理的每个步骤。 */
  logLevel: LogLevel;
}

const DEFAULT_PORT = 3000;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PROMPT_PATH = "prompts/review.md";
const DEFAULT_TIMEOUT_MS = 120000;

/**
 * 读取服务配置。
 *
 * 非法数值直接抛出，而不是回退到默认值：把 NaN 或负数透传给监听端口或超时计时器，
 * 会在运行期以难以定位的方式失败，启动即失败更容易排查。
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    port: readPositiveInt(env, "PORT", DEFAULT_PORT),
    host: env.HOST?.trim() || DEFAULT_HOST,
    promptPath: env.REVIEW_PROMPT_PATH?.trim() || DEFAULT_PROMPT_PATH,
    timeoutMs: readPositiveInt(env, "REVIEW_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
    logLevel: parseLogLevel(env.LOG_LEVEL),
  };
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
