import { test } from "node:test";
import assert from "node:assert/strict";
import { createLogger } from "../src/logger.ts";
import { createTaskQueue } from "../src/queue.ts";
import { createReviewPipeline } from "../src/pipeline.ts";
import { startServer, type ServerDeps } from "../src/server.ts";
import type { GitlabClient } from "../src/gitlab-client.ts";
import type { ReviewRules } from "../src/rules.ts";
import { createSilentLogger } from "../src/logger.ts";

const config = {
  port: 0,
  host: "127.0.0.1",
  promptPath: "prompts/review.md",
  timeoutMs: 1000,
  logLevel: "info" as const,
  gitlabUrl: "https://gitlab.example.com",
  gitlabToken: "t",
  gitlabInsecureTls: false,
  gitlabApiTimeoutMs: 1000,
  batchMaxTokens: 6000,
  rulesDir: "prompts/rules",
};

/** 收集日志行，便于断言启动日志内容。 */
function collectingLogger(): { lines: string[]; logger: ReturnType<typeof createLogger> } {
  const lines: string[] = [];
  return { lines, logger: createLogger("info", (line) => lines.push(line)) };
}

/** 构造最小可用的装配依赖：队列 + 空管线 + webhook 入队。 */
function makeDeps(logger: ReturnType<typeof createLogger>): ServerDeps {
  const queue = createTaskQueue(logger);
  const client = {} as GitlabClient;
  const rules = { resolve: () => ({ systemPrompt: "s", userPrompt: "u" }) } as unknown as ReviewRules;
  const pipeline = createReviewPipeline({
    client,
    rules,
    reviewer: { review: async () => ({ text: "x", model: "m" }) },
    logger: createSilentLogger(),
    batchMaxTokens: 6000,
  });
  return { queue, pipeline, logger };
}

test("startServer 装配后监听并可关闭，打印监听日志", async () => {
  const { lines, logger } = collectingLogger();
  const server = await startServer(config, makeDeps(logger), logger);
  const address = server.address();
  assert.equal(typeof address === "object" && address !== null && address.port > 0, true);
  await new Promise((resolve) => server.close(resolve));
  assert.match(lines.join("\n"), /监听/);
});

test("startServer 端口被占用时拒绝", async () => {
  const { logger } = collectingLogger();
  const first = await startServer(config, makeDeps(logger), logger);
  const address = first.address();
  assert.equal(typeof address === "object" && address !== null, true);
  const taken = (address as { port: number }).port;
  try {
    await assert.rejects(() => startServer({ ...config, port: taken }, makeDeps(logger), logger));
  } finally {
    await new Promise((resolve) => first.close(resolve));
  }
});
