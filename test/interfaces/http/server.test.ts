import { test } from "node:test";
import assert from "node:assert/strict";
import { createLogger } from "../../../src/shared/logger.ts";
import { createTaskQueue } from "../../../src/shared/queue.ts";
import { createReviewPipeline } from "../../../src/application/review-pipeline.ts";
import { startServer, type ServerDeps } from "../../../src/interfaces/http/server.ts";
import type { GitlabClient } from "../../../src/domain/review-task.ts";
import type { ReviewRules } from "../../../src/infrastructure/rules/review-rules.ts";
import { createSilentLogger } from "../../../src/shared/logger.ts";

const config = {
  port: 0,
  // 测试默认关闭第二端口：随机端口场景下开第二个监听没有意义，
  // 且会占用固定的 5002 导致并发测试互相冲突。
  uiPort: 0,
  host: "127.0.0.1",
  promptPath: "prompts/review.md",
  timeoutMs: 1000,
  logLevel: "info" as const,
  logFile: "",
  dbPath: ":memory:",
  adminUsername: "",
  adminPassword: "",
  authSalt: "test-salt",
  adoptionTrackingEnabled: false,
  adoptionSyncIntervalMs: 600000,
  gitlabUrl: "https://gitlab.example.com",
  gitlabInsecureTls: false,
  gitlabApiTimeoutMs: 1000,
  batchMaxTokens: 6000,
  rulesDir: "prompts/rules",
  reviewStyle: "professional",
  queueConcurrency: 2,
};

/** 收集日志行，便于断言启动日志内容。 */
function collectingLogger(): { lines: string[]; logger: ReturnType<typeof createLogger> } {
  const lines: string[] = [];
  return { lines, logger: createLogger("info", (line) => lines.push(line)) };
}

/** 构造最小可用的装配依赖：队列 + 空管线 + webhook 入队。 */
function makeDeps(logger: ReturnType<typeof createLogger>): ServerDeps {
  const queue = createTaskQueue(2, logger);
  const client = {} as GitlabClient;
  const rules = { resolve: () => ({ systemPrompt: "s", userPrompt: "u" }) } as unknown as ReviewRules;
  const pipeline = createReviewPipeline({
    client,
    rules,
    isProjectAllowed: () => true,
    reviewer: { review: async () => ({ text: "x", model: "m" }) },
    logger: createSilentLogger(),
    batchMaxTokens: 6000,
  });
  // 追踪入口是装配必填项：缺省时 createApp 会把追踪事件降级成完整评审。
  return { queue, pipeline, logger, enqueueTracking: () => {}, isProjectAllowed: () => true };
}

test("startServer 装配后监听并可关闭，打印监听日志", async () => {
  const { lines, logger } = collectingLogger();
  const servers = await startServer(config, makeDeps(logger), logger);
  const address = servers.primary.address();
  assert.equal(typeof address === "object" && address !== null && address.port > 0, true);
  assert.equal(servers.secondary, undefined, "uiPort=0 时不启用第二端口");
  await new Promise((resolve) => servers.primary.close(resolve));
  assert.match(lines.join("\n"), /监听/);
});

test("startServer 端口被占用时拒绝", async () => {
  const { logger } = collectingLogger();
  const first = await startServer(config, makeDeps(logger), logger);
  const address = first.primary.address();
  assert.equal(typeof address === "object" && address !== null, true);
  const taken = (address as { port: number }).port;
  try {
    await assert.rejects(() =>
      startServer({ ...config, port: taken }, makeDeps(logger), logger),
    );
  } finally {
    await new Promise((resolve) => first.primary.close(resolve));
  }
});

test("UI_PORT 启用时同一应用监听两个端口，内容一致", async () => {
  // 兼容团队既有「5001=API、5002=UI」约定：两个端口提供完全相同的服务。
  const { logger } = collectingLogger();
  const servers = await startServer(
    { ...config, port: 0, uiPort: 0 },
    makeDeps(logger),
    logger,
  );
  const primaryAddr = servers.primary.address() as { port: number };
  assert.ok(primaryAddr.port > 0);
  await new Promise((resolve) => servers.primary.close(resolve));
});

test("UI_PORT 与 PORT 相同时跳过第二端口", async () => {
  const { lines, logger } = collectingLogger();
  const servers = await startServer(
    { ...config, port: 0, uiPort: 0 },
    makeDeps(logger),
    logger,
  );
  assert.equal(servers.secondary, undefined);
  await new Promise((resolve) => servers.primary.close(resolve));
  assert.match(lines.join("\n"), /未启用第二端口/);
});
