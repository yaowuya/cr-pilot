import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import type { Reviewer } from "../src/reviewer.ts";

async function withApp(
  run: (base: string) => Promise<void>,
  reviewer: Reviewer,
  promptPath: string,
  timeoutMs = 5000,
): Promise<void> {
  const server = createApp({ reviewer, promptPath, timeoutMs }).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function withPromptFile(run: (path: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "crp-app-"));
  try {
    const path = join(dir, "review.md");
    await writeFile(path, "PROMPT", "utf8");
    await run(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const okReviewer: Reviewer = {
  review: async () => ({ text: "REVIEW", model: "test-model" }),
};

test("成功路径返回 200 与三个字段", async () => {
  await withPromptFile((promptPath) => withApp(async (base) => {
    const response = await fetch(`${base}/review/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "const a = 1;" }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.review, "REVIEW");
    assert.equal(body.model, "test-model");
    assert.equal(typeof body.duration_ms, "number");
  }, okReviewer, promptPath));
});

test("缺少 code 返回 400", async () => {
  await withPromptFile((promptPath) => withApp(async (base) => {
    const response = await fetch(`${base}/review/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(response.status, 400);
    assert.equal(typeof (await response.json()).error, "string");
  }, okReviewer, promptPath));
});

test("空白 code 返回 400", async () => {
  await withPromptFile((promptPath) => withApp(async (base) => {
    const response = await fetch(`${base}/review/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "   " }),
    });
    assert.equal(response.status, 400);
  }, okReviewer, promptPath));
});

test("GitLab payload 缺 code 时错误信息点明 payload 不含代码", async () => {
  await withPromptFile((promptPath) => withApp(async (base) => {
    const response = await fetch(`${base}/review/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ object_kind: "merge_request", object_attributes: { iid: 1, title: "t" } }),
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /payload 不含代码/);
  }, okReviewer, promptPath));
});
