import { test } from "node:test";
import assert from "node:assert/strict";
import { createLogger, createSilentLogger, parseLogLevel, type LogLevel } from "../src/logger.ts";

/** 收集日志行，避免测试改写全局输出流。 */
function collector(level: LogLevel): { lines: string[]; kinds: string[]; logger: ReturnType<typeof createLogger> } {
  const lines: string[] = [];
  const kinds: string[] = [];
  const logger = createLogger(level, (line, kind) => {
    lines.push(line);
    kinds.push(kind);
  });
  return { lines, kinds, logger };
}

test("parseLogLevel 接受合法级别并忽略大小写", () => {
  assert.equal(parseLogLevel(undefined), "info");
  assert.equal(parseLogLevel("  "), "info");
  assert.equal(parseLogLevel("DEBUG"), "debug");
  assert.equal(parseLogLevel(" silent "), "silent");
  assert.equal(parseLogLevel(undefined, "debug"), "debug");
});

test("parseLogLevel 对非法值快速失败", () => {
  assert.throws(() => parseLogLevel("verbose"), /LOG_LEVEL/);
});

test("低于阈值的日志被丢弃", () => {
  const { lines, logger } = collector("warn");
  logger.debug("d");
  logger.info("i");
  assert.equal(lines.length, 0);
  logger.warn("w");
  logger.error("e");
  assert.equal(lines.length, 2);
});

test("silent 关闭全部输出", () => {
  const { lines, logger } = collector("silent");
  logger.debug("d");
  logger.info("i");
  logger.warn("w");
  logger.error("e");
  assert.equal(lines.length, 0);
});

test("日志行包含时间戳、级别、消息与字段", () => {
  const { lines, logger } = collector("debug");
  logger.info("收到评审请求", { method: "POST", bodyBytes: 128, gitlab: true });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\] INFO {2}收到评审请求 method=POST bodyBytes=128 gitlab=true$/);
});

test("含空格与 undefined 的字段按约定渲染", () => {
  const { lines, logger } = collector("info");
  logger.info("msg", { note: "两个 词", missing: undefined });
  assert.match(lines[0], /note="两个 词"$/);
  assert.doesNotMatch(lines[0], /missing/);
});

test("无字段时不留尾随空格", () => {
  const { lines, logger } = collector("info");
  logger.info("只有消息");
  assert.match(lines[0], /INFO {2}只有消息$/);
});

test("silent logger 可安全调用", () => {
  const logger = createSilentLogger();
  assert.doesNotThrow(() => {
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
  });
});
