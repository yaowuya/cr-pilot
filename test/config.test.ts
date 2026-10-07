import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.ts";

/** 两个必填 GitLab 配置的合法值，供各用例复用。 */
const GITLAB_REQUIRED = { GITLAB_URL: "https://gitlab.example.com", GITLAB_TOKEN: "t" };

test("loadConfig 默认端口为 5001，缺失必填 GitLab 配置时快速失败", () => {
  assert.throws(() => loadConfig({}), /GITLAB_URL/);
  assert.throws(() => loadConfig({ GITLAB_URL: "https://x" }), /GITLAB_TOKEN/);
  assert.equal(loadConfig(GITLAB_REQUIRED).port, 5001);
});

test("loadConfig 在无环境变量时返回默认值", () => {
  assert.deepEqual(loadConfig(GITLAB_REQUIRED), {
    port: 5001,
    host: "127.0.0.1",
    promptPath: "prompts/review.md",
    timeoutMs: 120000,
    logLevel: "info",
    gitlabUrl: "https://gitlab.example.com",
    gitlabToken: "t",
    gitlabInsecureTls: false,
    gitlabApiTimeoutMs: 15000,
    batchMaxTokens: 6000,
    rulesDir: "prompts/rules",
    reviewStyle: "professional",
  });
});

test("loadConfig 忽略不再支持的 GITLAB_WEBHOOK_SECRET", () => {
  // 多项目场景下各项目 secret 不同，单一全局 secret 没有意义，配置已移除。
  // 遗留的 GITLAB_WEBHOOK_SECRET 环境变量被忽略，不参与配置。
  const config = loadConfig({ ...GITLAB_REQUIRED, GITLAB_WEBHOOK_SECRET: "legacy" });
  assert.equal("gitlabWebhookSecret" in config, false);
});

test("loadConfig 采用环境变量覆盖", () => {
  const config = loadConfig({
    ...GITLAB_REQUIRED,
    PORT: "8080",
    HOST: "0.0.0.0",
    REVIEW_PROMPT_PATH: "a.md",
    REVIEW_TIMEOUT_MS: "5000",
    LOG_LEVEL: "debug",
    GITLAB_INSECURE_TLS: "1",
    GITLAB_API_TIMEOUT: "20000",
    REVIEW_BATCH_MAX_TOKENS: "9000",
    REVIEW_RULES_DIR: "other/rules",
    REVIEW_STYLE: "gentle",
  });
  assert.equal(config.port, 8080);
  assert.equal(config.host, "0.0.0.0");
  assert.equal(config.promptPath, "a.md");
  assert.equal(config.timeoutMs, 5000);
  assert.equal(config.logLevel, "debug");
  assert.equal(config.gitlabInsecureTls, true);
  assert.equal(config.gitlabApiTimeoutMs, 20000);
  assert.equal(config.batchMaxTokens, 9000);
  assert.equal(config.rulesDir, "other/rules");
  assert.equal(config.reviewStyle, "gentle");
});

test("loadConfig 对非法数值快速失败", () => {
  assert.throws(() => loadConfig({ ...GITLAB_REQUIRED, REVIEW_TIMEOUT_MS: "abc" }), /REVIEW_TIMEOUT_MS/);
  assert.throws(() => loadConfig({ ...GITLAB_REQUIRED, GITLAB_API_TIMEOUT: "-1" }), /GITLAB_API_TIMEOUT/);
  assert.throws(() => loadConfig({ ...GITLAB_REQUIRED, REVIEW_BATCH_MAX_TOKENS: "0" }), /REVIEW_BATCH_MAX_TOKENS/);
});

test("loadConfig 对非法日志级别与非法布尔值快速失败", () => {
  assert.throws(() => loadConfig({ ...GITLAB_REQUIRED, LOG_LEVEL: "verbose" }), /LOG_LEVEL/);
  assert.throws(() => loadConfig({ ...GITLAB_REQUIRED, GITLAB_INSECURE_TLS: "maybe" }), /GITLAB_INSECURE_TLS/);
});

test("loadConfig 去掉 GITLAB_URL 尾部斜杠", () => {
  assert.equal(loadConfig({ ...GITLAB_REQUIRED, GITLAB_URL: "https://gitlab.example.com/" }).gitlabUrl, "https://gitlab.example.com");
});
