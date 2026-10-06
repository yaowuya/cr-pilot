import { test } from "node:test";
import assert from "node:assert/strict";
import { createLogger } from "../src/logger.ts";
import { startServer } from "../src/server.ts";
import type { Reviewer } from "../src/reviewer.ts";

const config = {
  port: 0,
  host: "127.0.0.1",
  promptPath: "prompts/review.md",
  timeoutMs: 1000,
  logLevel: "info" as const,
  // backend-008 会整体重写本文件；此处先补 GitLab 必填字段保持可编译。
  gitlabUrl: "https://gitlab.example.com",
  gitlabToken: "t",
  gitlabWebhookSecret: "s",
  gitlabInsecureTls: false,
  gitlabApiTimeoutMs: 1000,
  batchMaxTokens: 6000,
  rulesDir: "prompts/rules",
};

const okReviewer: Reviewer = { review: async () => ({ text: "ok", model: "m" }) };

/** 收集日志行，便于断言启动日志内容。 */
function collectingLogger(): { lines: string[]; logger: ReturnType<typeof createLogger> } {
  const lines: string[] = [];
  return { lines, logger: createLogger("info", (line) => lines.push(line)) };
}

test("startServer 在随机端口监听并可关闭", async () => {
  const { lines, logger } = collectingLogger();
  const server = await startServer(config, okReviewer, logger);
  const address = server.address();
  assert.equal(typeof address === "object" && address !== null && address.port > 0, true);
  await new Promise((resolve) => server.close(resolve));
  assert.match(lines.join("\n"), /监听/);
});

test("startServer 端口被占用时拒绝", async () => {
  const { logger } = collectingLogger();
  const first = await startServer(config, okReviewer, logger);
  const address = first.address();
  assert.equal(typeof address === "object" && address !== null, true);
  const taken = (address as { port: number }).port;
  try {
    await assert.rejects(() => startServer({ ...config, port: taken }, okReviewer, logger));
  } finally {
    await new Promise((resolve) => first.close(resolve));
  }
});
