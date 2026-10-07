import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** 日志级别。`silent` 关闭全部输出，用于测试。 */
export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

/** 结构化日志字段。`undefined` 的字段会被跳过。 */
export type LogFields = Record<string, unknown>;

/** 日志记录器。 */
export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

/** 已格式化的单行日志的落点。抽出来是为了测试能直接收集输出，不必改写全局流。 */
export type LogSink = (line: string, kind: Exclude<LogLevel, "silent">) => void;

/** 级别数值越大越严重；低于阈值的日志被丢弃。 */
const LEVEL_ORDER: Record<Exclude<LogLevel, "silent">, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const LEVEL_LABEL: Record<Exclude<LogLevel, "silent">, string> = {
  debug: "DEBUG",
  info: "INFO ",
  warn: "WARN ",
  error: "ERROR",
};

/**
 * 解析 `LOG_LEVEL`。
 *
 * 非法值抛出而不是回退默认：把级别名拼错却继续运行，会让「日志怎么没了」变成
 * 新的排查问题，启动即失败更容易发现。
 */
export function parseLogLevel(value: string | undefined, fallback: LogLevel = "info"): LogLevel {
  const raw = value?.trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error" || raw === "silent") {
    return raw;
  }
  throw new Error(`环境变量 LOG_LEVEL 必须是 debug/info/warn/error/silent 之一，实际收到 ${value}`);
}

/**
 * 按级别过滤并格式化日志，交给给定落点。
 *
 * 不引入第三方日志库：本服务的需求是「按步骤打印到控制台」，结构化输出与轮转
 * 由运行环境（WebStorm 控制台、容器日志）承担。
 */
export function createLogger(level: LogLevel, sink: LogSink): Logger {
  const threshold = level === "silent" ? Number.POSITIVE_INFINITY : LEVEL_ORDER[level];
  const emit = (kind: Exclude<LogLevel, "silent">, message: string, fields?: LogFields): void => {
    if (LEVEL_ORDER[kind] < threshold) return;
    sink(`[${formatTimestamp(new Date())}] ${LEVEL_LABEL[kind]} ${message}${formatFields(fields)}`, kind);
  };
  return {
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
  };
}

/**
 * 创建控制台日志器。
 *
 * 时间使用本地时区，便于与 WebStorm 控制台、终端里的时间直接对照。
 * `debug` 与 `info` 走标准输出，`warn` 与 `error` 走标准错误，方便在日志系统里分流。
 */
export function createConsoleLogger(level: LogLevel): Logger {
  return createLogger(level, (line, kind) => {
    if (kind === "warn" || kind === "error") {
      process.stderr.write(`${line}\n`);
      return;
    }
    process.stdout.write(`${line}\n`);
  });
}

/**
 * 创建带文件落点的日志器：控制台 + 日志文件双写。
 *
 * `filePath` 为空串时等价于 `createConsoleLogger`。文件用同步追加写入——
 * 本服务日志量低（每秒几行），同步写保证每行即时落盘、进程崩溃不丢最后几行，
 * 同时避免流式缓冲带来的测试与排障不确定性。目录不存在时用 mkdirSync 递归
 * 创建（Docker 挂载的 /app/logs 首次启动时可能还不存在）。文件写入失败不
 * 抛出——日志丢失不应拖垮评审链路，只降级为控制台输出。
 */
export function createFileLogger(level: LogLevel, filePath: string): Logger {
  if (!filePath) return createConsoleLogger(level);
  let ready = true;
  try {
    mkdirSync(dirname(filePath), { recursive: true });
  } catch (error) {
    // 目录创建失败（通常是没有父目录写权限）：降级为控制台并在 stderr 提示一次，
    // 让挂载/权限问题启动时立即可见。
    ready = false;
    process.stderr.write(`[WARN] 日志目录不可写，仅输出到控制台：${dirname(filePath)}（${error instanceof Error ? error.message : String(error)}）\n`);
  }
  let warned = false;
  const emit: LogSink = (line, kind) => {
    if (ready) {
      try {
        appendFileSync(filePath, `${line}\n`);
      } catch {
        // 文件写入失败：只降级为控制台输出，并在 stderr 报一次错，
        // 让权限/挂载问题在启动时立即可见而不是静默丢日志。
        if (!warned) {
          warned = true;
          process.stderr.write(`[WARN] 日志文件写入失败，仅输出到控制台：${filePath}（请检查目录权限或挂载）\n`);
        }
      }
    }
    // 同时保留控制台输出，便于 docker logs 与本地调试。
    if (kind === "warn" || kind === "error") {
      process.stderr.write(`${line}\n`);
      return;
    }
    process.stdout.write(`${line}\n`);
  };
  return createLogger(level, emit);
}

/** 创建不输出任何内容的日志器。测试与需要静默运行的场景使用。 */
export function createSilentLogger(): Logger {
  return createLogger("silent", () => {});
}

/** 本地时区时间戳，形如 `2026-10-06 19:52:23.123`。 */
function formatTimestamp(date: Date): string {
  const pad = (value: number, width = 2): string => String(value).padStart(width, "0");
  const ymd = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const hms = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  return `${ymd} ${hms}.${pad(date.getMilliseconds(), 3)}`;
}

/** 把字段渲染成 `key=value`。含空格的字符串加引号，便于日志按空格切分。 */
function formatFields(fields?: LogFields): string {
  if (!fields) return "";
  const parts: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    const text = typeof value === "string" ? value : JSON.stringify(value);
    parts.push(`${key}=${text.includes(" ") ? JSON.stringify(text) : text}`);
  }
  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}
