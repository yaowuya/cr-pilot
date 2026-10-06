import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Express } from "express";
import { createApp } from "../src/app.ts";
import { createLogger, createSilentLogger, type Logger } from "../src/logger.ts";
import type { Reviewer } from "../src/reviewer.ts";

/**
 * Fetch 规范定义了一组禁用端口，undici 会直接拒绝连接并报 `bad port`。
 * `listen(0)` 偶尔会分配到这些端口，使测试随机失败，因此绑定后必须校验。
 * 只列出大于 1024 的条目：动态端口不会落在更低的范围。
 */
const FETCH_BAD_PORTS = new Set([
  1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000,
  6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);

/** 启动一个 fetch 可访问的临时服务器，跳过规范禁用的端口。 */
async function listenOnFetchablePort(app: Express): Promise<{ server: Server; port: number }> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const server = createServer(app);
    await new Promise<void>((resolve, reject) => {
      // 先挂事件再 listen：Express 的 listen 回调不对应 listening 事件。
      server.once("error", reject);
      server.once("listening", () => resolve());
      server.listen(0, "127.0.0.1");
    });
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    if (port > 0 && !FETCH_BAD_PORTS.has(port)) return { server, port };
    await new Promise((resolve) => server.close(resolve));
  }
  throw new Error("连续 20 次都分配到 fetch 不可用的端口");
}

async function withApp(
  run: (base: string) => Promise<void>,
  reviewer: Reviewer,
  promptPath: string,
  timeoutMs = 5000,
  logger: Logger = createSilentLogger(),
): Promise<void> {
  const { server, port } = await listenOnFetchablePort(createApp({ reviewer, promptPath, timeoutMs, logger }));
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

/** 收集日志行，用于断言请求处理的每个步骤都有输出。 */
function collectingLogger(): { lines: string[]; logger: Logger } {
  const lines: string[] = [];
  return { lines, logger: createLogger("info", (line) => lines.push(line)) };
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

/** fetch 的 json() 返回 unknown，测试里统一读取为可索引对象。 */
async function readJson(response: { json(): Promise<unknown> }): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

test("成功路径返回 200 与三个字段", async () => {
  await withPromptFile((promptPath) => withApp(async (base) => {
    const response = await fetch(`${base}/review/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "const a = 1;" }),
    });
    assert.equal(response.status, 200);
    const body = await readJson(response);
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
    assert.equal(typeof (await readJson(response)).error, "string");
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
    assert.match(String((await readJson(response)).error), /payload 不含代码/);
  }, okReviewer, promptPath));
});

test("prompt 文件不存在返回 500", async () => {
  await withApp(async (base) => {
    const response = await fetch(`${base}/review/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "x" }),
    });
    assert.equal(response.status, 500);
    assert.equal(typeof (await readJson(response)).error, "string");
  }, okReviewer, join(tmpdir(), "crp-missing-prompt.md"));
});

test("pi 调用抛错返回 502", async () => {
  const failingReviewer: Reviewer = {
    review: async () => {
      throw new Error("模型不可用");
    },
  };
  await withPromptFile((promptPath) => withApp(async (base) => {
    const response = await fetch(`${base}/review/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "x" }),
    });
    assert.equal(response.status, 502);
  }, failingReviewer, promptPath));
});

test("pi 返回空文本返回 502", async () => {
  const emptyReviewer: Reviewer = { review: async () => ({ text: "   ", model: "m" }) };
  await withPromptFile((promptPath) => withApp(async (base) => {
    const response = await fetch(`${base}/review/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "x" }),
    });
    assert.equal(response.status, 502);
  }, emptyReviewer, promptPath));
});

test("超时返回 504 且假实现观察到信号中断", async () => {
  let observedAbort = false;
  const observingReviewer: Reviewer = {
    review: ({ signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            observedAbort = true;
            reject(new Error("aborted"));
          },
          { once: true },
        );
      }),
  };
  await withPromptFile((promptPath) => withApp(async (base) => {
    const response = await fetch(`${base}/review/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "x" }),
    });
    assert.equal(response.status, 504);
    assert.equal(observedAbort, true);
  }, observingReviewer, promptPath, 50));
});

test("未知路径返回 JSON 形状的 404", async () => {
  await withPromptFile((promptPath) => withApp(async (base) => {
    const response = await fetch(`${base}/nope`);
    assert.equal(response.status, 404);
    assert.equal(typeof (await readJson(response)).error, "string");
  }, okReviewer, promptPath));
});

test("成功路径按顺序打印每个处理步骤", async () => {
  const { lines, logger } = collectingLogger();
  await withPromptFile((promptPath) => withApp(async (base) => {
    const response = await fetch(`${base}/review/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "const a = 1;", context: "上下文" }),
    });
    assert.equal(response.status, 200);
  }, okReviewer, promptPath, 5000, logger));

  const steps = ["收到评审请求", "请求体解析完成", "入参校验通过", "prompt 就绪", "开始调用 pi", "评审完成", "响应完成"];
  const positions = steps.map((step) => lines.findIndex((line) => line.includes(step)));
  for (const [index, step] of steps.entries()) {
    assert.notEqual(positions[index], -1, `缺少步骤日志：${step}`);
  }
  const ordered = [...positions].sort((a, b) => a - b);
  assert.deepEqual(positions, ordered, `步骤日志顺序不正确：\n${lines.join("\n")}`);
  assert.match(lines.join("\n"), /status=200/);
});

test("入参校验失败也打印步骤日志", async () => {
  const { lines, logger } = collectingLogger();
  await withPromptFile((promptPath) => withApp(async (base) => {
    const response = await fetch(`${base}/review/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(response.status, 400);
  }, okReviewer, promptPath, 5000, logger));
  const text = lines.join("\n");
  assert.match(text, /收到评审请求/);
  assert.match(text, /入参校验失败/);
  assert.match(text, /status=400/);
});

test("日志不包含代码正文与评审正文", async () => {
  const { lines, logger } = collectingLogger();
  const secretCode = "const API_TOKEN = 'super-secret-value';";
  const secretReview = "评审里不应出现在日志中的内容";
  await withPromptFile((promptPath) => withApp(async (base) => {
    const response = await fetch(`${base}/review/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: secretCode }),
    });
    assert.equal(response.status, 200);
  }, { review: async () => ({ text: secretReview, model: "m" }) }, promptPath, 5000, logger));
  const text = lines.join("\n");
  assert.doesNotMatch(text, /super-secret-value/, "代码正文不应写入日志");
  assert.doesNotMatch(text, /评审里不应出现在日志中的内容/, "评审正文不应写入日志");
  assert.match(text, /codeChars=\d+/);
  assert.match(text, /reviewChars=\d+/);
});
