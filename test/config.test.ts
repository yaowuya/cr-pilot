import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.ts";

test("loadConfig 在无环境变量时返回默认值", () => {
  assert.deepEqual(loadConfig({}), {
    port: 3000,
    host: "127.0.0.1",
    promptPath: "prompts/review.md",
    timeoutMs: 120000,
    logLevel: "info",
  });
});

test("loadConfig 采用环境变量覆盖", () => {
  const config = loadConfig({ PORT: "8080", HOST: "0.0.0.0", REVIEW_PROMPT_PATH: "a.md", REVIEW_TIMEOUT_MS: "5000", LOG_LEVEL: "debug" });
  assert.equal(config.port, 8080);
  assert.equal(config.host, "0.0.0.0");
  assert.equal(config.promptPath, "a.md");
  assert.equal(config.timeoutMs, 5000);
  assert.equal(config.logLevel, "debug");
});

test("loadConfig 对非法数值快速失败", () => {
  assert.throws(() => loadConfig({ REVIEW_TIMEOUT_MS: "abc" }), /REVIEW_TIMEOUT_MS/);
});

test("loadConfig 对非法日志级别快速失败", () => {
  assert.throws(() => loadConfig({ LOG_LEVEL: "verbose" }), /LOG_LEVEL/);
});
