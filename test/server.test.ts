import { test } from "node:test";
import assert from "node:assert/strict";
import { startServer } from "../src/server.ts";
import type { Reviewer } from "../src/reviewer.ts";

const config = { port: 0, host: "127.0.0.1", promptPath: "prompts/review.md", timeoutMs: 1000 };

const okReviewer: Reviewer = { review: async () => ({ text: "ok", model: "m" }) };

test("startServer 在随机端口监听并可关闭", async () => {
  const server = await startServer(config, okReviewer);
  const address = server.address();
  assert.equal(typeof address === "object" && address !== null && address.port > 0, true);
  await new Promise((resolve) => server.close(resolve));
});

test("startServer 端口被占用时拒绝", async () => {
  const first = await startServer(config, okReviewer);
  const address = first.address();
  assert.equal(typeof address === "object" && address !== null, true);
  const taken = (address as { port: number }).port;
  try {
    await assert.rejects(() => startServer({ ...config, port: taken }, okReviewer));
  } finally {
    await new Promise((resolve) => first.close(resolve));
  }
});
