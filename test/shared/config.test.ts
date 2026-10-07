import { test } from "node:test";
import assert from "node:assert/strict";
import { applyConfigOverrides, loadConfig } from "../../src/shared/config.ts";

// 全部 GitLab 配置均可选：GITLAB_URL 从 webhook 派生，GITLAB_TOKEN 随 webhook
// 请求头携带（对齐参考项目），不再需要任何必填环境变量。
const EMPTY_ENV = {};

test("loadConfig 默认端口为 5001，无任何必填配置", () => {
  assert.equal(loadConfig(EMPTY_ENV).port, 5001);
});

test("loadConfig 未配置 GITLAB_URL 时为空串（从 webhook 派生）", () => {
  assert.equal(loadConfig(EMPTY_ENV).gitlabUrl, "");
  assert.equal(loadConfig({ GITLAB_URL: "" }).gitlabUrl, "");
});

test("loadConfig 在无环境变量时返回默认值", () => {
  assert.deepEqual(loadConfig({ GITLAB_URL: "https://gitlab.example.com" }), {
    port: 5001,
    host: "127.0.0.1",
    promptPath: "prompts/review.md",
    timeoutMs: 1200000,
    logLevel: "info",
    logFile: "",
    gitlabUrl: "https://gitlab.example.com",
    gitlabInsecureTls: false,
    gitlabApiTimeoutMs: 15000,
    batchMaxTokens: 120000,
    rulesDir: "prompts/rules",
    reviewStyle: "professional",
    queueConcurrency: 5,
    dbPath: "./data/cr-pilot.db",
    adminUsername: "",
    adminPassword: "",
    authSalt: "",
  });
});

test("loadConfig 读取数据库、初始管理员与部署盐配置", () => {
  const config = loadConfig({
    DB_PATH: "/var/lib/cr-pilot/db.sqlite",
    ADMIN_USERNAME: "root",
    ADMIN_PASSWORD: "initial-pw",
    AUTH_SALT: "deploy-salt",
  });
  assert.equal(config.dbPath, "/var/lib/cr-pilot/db.sqlite");
  assert.equal(config.adminUsername, "root");
  assert.equal(config.adminPassword, "initial-pw");
  assert.equal(config.authSalt, "deploy-salt");
});

test("applyConfigOverrides 让数据库覆盖值优先于环境变量", () => {
  const env: NodeJS.ProcessEnv = { QUEUE_CONCURRENCY: "2", REVIEW_TIMEOUT_MS: "1000" };
  applyConfigOverrides(env, { QUEUE_CONCURRENCY: "9" });
  assert.equal(env.QUEUE_CONCURRENCY, "9");
  assert.equal(loadConfig(env).queueConcurrency, 9, "loadConfig 必须读到覆盖后的值");
  assert.equal(env.REVIEW_TIMEOUT_MS, "1000", "未覆盖的键保持原值");
});

test("applyConfigOverrides 空串表示清空覆盖、保留原环境变量", () => {
  const env: NodeJS.ProcessEnv = { LOG_FILE: "/app/logs/cr-pilot.log" };
  applyConfigOverrides(env, { LOG_FILE: "" });
  assert.equal(env.LOG_FILE, "/app/logs/cr-pilot.log", "空串不得写入空值");
});

test("loadConfig 忽略不再支持的 GITLAB_TOKEN 与 GITLAB_WEBHOOK_SECRET", () => {
  // 访问令牌随 webhook 请求头 X-Gitlab-Token 携带，每个项目独立；
  // webhook secret 因多项目各自配置不同，单实例无法统一校验，均已移除。
  const config = loadConfig({ GITLAB_TOKEN: "legacy", GITLAB_WEBHOOK_SECRET: "legacy" });
  assert.equal("gitlabToken" in config, false);
  assert.equal("gitlabWebhookSecret" in config, false);
});

test("loadConfig 采用环境变量覆盖", () => {
  const config = loadConfig({
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
    QUEUE_CONCURRENCY: "3",
    LOG_FILE: "/app/logs/cr-pilot.log",
  });
  assert.equal(config.port, 8080);
  assert.equal(config.host, "0.0.0.0");
  assert.equal(config.promptPath, "a.md");
  assert.equal(config.timeoutMs, 5000);
  assert.equal(config.logLevel, "debug");
  assert.equal(config.logFile, "/app/logs/cr-pilot.log");
  assert.equal(config.gitlabInsecureTls, true);
  assert.equal(config.gitlabApiTimeoutMs, 20000);
  assert.equal(config.batchMaxTokens, 9000);
  assert.equal(config.rulesDir, "other/rules");
  assert.equal(config.reviewStyle, "gentle");
  assert.equal(config.queueConcurrency, 3);
});

test("loadConfig 对非法数值快速失败", () => {
  assert.throws(() => loadConfig({ REVIEW_TIMEOUT_MS: "abc" }), /REVIEW_TIMEOUT_MS/);
  assert.throws(() => loadConfig({ GITLAB_API_TIMEOUT: "-1" }), /GITLAB_API_TIMEOUT/);
  assert.throws(() => loadConfig({ REVIEW_BATCH_MAX_TOKENS: "0" }), /REVIEW_BATCH_MAX_TOKENS/);
});

test("loadConfig 对非法日志级别与非法布尔值快速失败", () => {
  assert.throws(() => loadConfig({ LOG_LEVEL: "verbose" }), /LOG_LEVEL/);
  assert.throws(() => loadConfig({ GITLAB_INSECURE_TLS: "maybe" }), /GITLAB_INSECURE_TLS/);
});

test("loadConfig 去掉 GITLAB_URL 尾部斜杠", () => {
  assert.equal(loadConfig({ GITLAB_URL: "https://gitlab.example.com/" }).gitlabUrl, "https://gitlab.example.com");
});
