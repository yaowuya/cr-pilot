- [x] **Task backend-006: HTTP 应用与入参校验**

**Files:**
- Create: `src/app.ts`
- Test: `test/app.test.ts`

**Reasoning:**
- 成功路径与入参边界是一个可独立 review 的交付增量；失败状态码映射留给下一个任务。
- 接口层必须能注入 `Reviewer`，否则测试要真的调用模型。

**Depends on:** `backend-005`

**Interfaces:**
- Consumes: `Reviewer`、`loadReviewPrompt`、`isGitlabPayload`、`extractGitlabContext`
- Produces: `createApp(deps)` 与 `POST /review/webhook` 的 200 / 400 行为
- Contract checks: 非对象体、缺 `code`、空白 `code` 返回 400；GitLab payload 缺 `code` 的错误信息点明 payload 不含代码；正常请求返回 200 与三个字段

**Step 1: Write the failing test**

```ts
// test/app.test.ts
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
```

**Step 2: Run test to verify it fails**

Run: `node --test test/app.test.ts`
Expected: FAIL with `ERR_MODULE_NOT_FOUND`，因为 `src/app.ts` 尚不存在

**Step 3: Write minimal implementation**

```ts
// src/app.ts
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { extractGitlabContext, isGitlabPayload } from "./gitlab.ts";
import { loadReviewPrompt } from "./prompt.ts";
import type { Reviewer } from "./reviewer.ts";

/** 应用依赖。全部显式注入，接口层测试无需触碰真实模型。 */
export interface AppDeps {
  reviewer: Reviewer;
  promptPath: string;
  timeoutMs: number;
}

/** 创建 Express 应用。不含监听逻辑，便于测试用随机端口启动。 */
export function createApp(deps: AppDeps): Express {
  const app = express();
  // diff 可能较大，放宽默认的 100kb 限制；上限仍是常量，避免无界读取。
  app.use(express.json({ limit: "2mb" }));

  app.post("/review/webhook", async (req, res) => {
    const body: unknown = req.body;
    if (!isRecord(body)) {
      res.status(400).json({ error: "请求体必须是 JSON 对象" });
      return;
    }
    const code = typeof body.code === "string" ? body.code.trim() : "";
    if (!code) {
      res.status(400).json({ error: describeMissingCode(body) });
      return;
    }
    const contextParts: string[] = [];
    if (typeof body.context === "string" && body.context.trim()) contextParts.push(body.context.trim());
    if (isGitlabPayload(body)) {
      const gitlabContext = extractGitlabContext(body);
      if (gitlabContext) contextParts.push(gitlabContext);
    }
    // ...读取 prompt、调用 reviewer、映射状态码（见 backend-007）
  });
  // ...404 与错误处理中间件（见 backend-007）
  return app;
}
```

`describeMissingCode`：当 `isGitlabPayload(body)` 为真时返回「GitLab payload 不含代码内容，请在请求体中附带非空的 code 字段」，否则返回「请求体缺少非空的 code 字段」。

本任务先实现 200 路径：读取 prompt、以 `AbortSignal.timeout(deps.timeoutMs)` 调用 `reviewer.review`、返回 `{ review, model, duration_ms }`。

**Step 4: Run test to verify it passes**

Run: `node --test test/app.test.ts`
Expected: PASS（4 个用例）

自审：`AppDeps` 三个字段都有说明；`2mb` 上限有原因注释；路由未引入鉴权（`P-006`）。

**Step 5: Commit**

```bash
git add src/app.ts test/app.test.ts
git commit -m "feat: add review webhook route with request validation"
```

- [x] **Task backend-007: 失败状态码映射与错误响应**

**Files:**
- Modify: `src/app.ts`
- Test: `test/app.test.ts`

**Reasoning:**
- prompt 不可用、pi 失败、超时三类失败必须可区分，否则调用方无法判断是否重试。
- 超时判定统一用「信号是否已中断」，避免依赖 pi 抛出的具体错误类型。

**Depends on:** `backend-006`

**Interfaces:**
- Consumes: `backend-006` 的 `createApp` 与路由骨架
- Produces: 400 / 500 / 502 / 504 的完整映射与统一 JSON 错误体
- Contract checks: 不存在的 prompt 路径返回 500；reviewer 抛错返回 502；reviewer 超时返回 504 并让假实现观察到信号已中断

**Step 1: Write the failing test**

```ts
// test/app.test.ts（追加）
test("prompt 文件不存在返回 500", async () => {
  await withApp(async (base) => {
    const response = await fetch(`${base}/review/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "x" }),
    });
    assert.equal(response.status, 500);
  }, okReviewer, join(tmpdir(), "crp-missing-prompt.md"));
});

test("pi 调用抛错返回 502", async () => {
  await withPromptFile((promptPath) => withApp(async (base) => {
    const response = await fetch(`${base}/review/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "x" }),
    });
    assert.equal(response.status, 502);
  }, { review: async () => { throw new Error("模型不可用"); } }, promptPath));
});

test("pi 返回空文本返回 502", async () => {
  await withPromptFile((promptPath) => withApp(async (base) => {
    const response = await fetch(`${base}/review/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "x" }),
    });
    assert.equal(response.status, 502);
  }, { review: async () => ({ text: "   ", model: "m" }) }, promptPath));
});

test("超时返回 504 且假实现观察到信号中断", async () => {
  let observedAbort = false;
  const observingReviewer: Reviewer = {
    review: ({ signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        observedAbort = true;
        reject(new Error("aborted"));
      }, { once: true });
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
```

**Step 2: Run test to verify it fails**

Run: `node --test test/app.test.ts`
Expected: FAIL，新增 4 个用例中失败路径返回 500 而非预期的 500 / 502 / 504，超时用例挂起到测试超时

**Step 3: Write minimal implementation**

在路由内补全失败映射：

```ts
    const startedAt = Date.now();
    let systemPrompt: string;
    try {
      systemPrompt = await loadReviewPrompt(deps.promptPath);
    } catch (error) {
      // prompt 不可用是服务端配置问题，与评审失败区分开。
      res.status(500).json({ error: error instanceof Error ? error.message : "读取 prompt 失败" });
      return;
    }

    const signal = AbortSignal.timeout(deps.timeoutMs);
    try {
      const result = await deps.reviewer.review({ systemPrompt, code, context, signal });
      res.json({ review: result.text, model: result.model, duration_ms: Date.now() - startedAt });
    } catch (error) {
      // 超时判定只看信号状态：pi 在中断时抛出的错误类型不稳定，不能作为依据。
      if (signal.aborted) {
        res.status(504).json({ error: `评审超时（${deps.timeoutMs}ms）` });
        return;
      }
      res.status(502).json({ error: error instanceof Error ? error.message : "评审调用失败" });
    }
```

其中 `context` 为前面拼好的 `contextParts.join("\n\n") || undefined`。再补 404 与错误处理中间件：

```ts
  app.use((_req, res) => { res.status(404).json({ error: "未找到该路径" }); });
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return;
    // 请求体 JSON 解析失败与体积超限由 body-parser 以带 status 的错误抛出，沿用该状态码。
    const status = typeof (error as { status?: number })?.status === "number"
      && (error as { status: number }).status >= 400
      && (error as { status: number }).status < 500
      ? (error as { status: number }).status
      : 500;
    res.status(status).json({ error: error instanceof Error ? error.message : "服务器内部错误" });
  });
```

**Step 4: Run test to verify it passes**

Run: `node --test test/app.test.ts`
Expected: PASS（8 个用例）

自审：四条失败路径各有独立用例；超时判定依据有注释；未引入重试；错误体形状统一为 `{"error": string}`。

**Step 5: Commit**

```bash
git add src/app.ts test/app.test.ts
git commit -m "feat: map review failures to distinct status codes"
```

- [x] **Task backend-008: 进程入口、运行脚本与 README**

**Files:**
- Create: `src/server.ts`
- Modify: `package.json`
- Modify: `README.md`
- Test: `test/server.test.ts`

**Reasoning:**
- 监听逻辑必须与业务逻辑分离，否则无法在测试里用随机端口验证启动与关闭。
- README 与运行脚本要随「能跑起来」一起交付，单独拆成文档任务没有可验证增量。

**Depends on:** `backend-007`

**Interfaces:**
- Consumes: `AppConfig`、`loadConfig`、`Reviewer`、`createPiReviewer`、`createApp`
- Produces: `startServer(config, reviewer)`
- Contract checks: `startServer` 在随机端口返回已监听的 server，可正常关闭

**Step 1: Write the failing test**

```ts
// test/server.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { startServer } from "../src/server.ts";
import type { Reviewer } from "../src/reviewer.ts";

test("startServer 在随机端口监听并可关闭", async () => {
  const reviewer: Reviewer = { review: async () => ({ text: "ok", model: "m" }) };
  const server = await startServer(
    { port: 0, host: "127.0.0.1", promptPath: "prompts/review.md", timeoutMs: 1000 },
    reviewer,
  );
  const address = server.address();
  assert.equal(typeof address === "object" && address !== null && address.port > 0, true);
  await new Promise((resolve) => server.close(resolve));
});

test("startServer 端口被占用时拒绝", async () => {
  const reviewer: Reviewer = { review: async () => ({ text: "ok", model: "m" }) };
  const first = await startServer(
    { port: 0, host: "127.0.0.1", promptPath: "prompts/review.md", timeoutMs: 1000 },
    reviewer,
  );
  const taken = (first.address() as { port: number }).port;
  try {
    await assert.rejects(() =>
      startServer({ port: taken, host: "127.0.0.1", promptPath: "prompts/review.md", timeoutMs: 1000 }, reviewer),
    );
  } finally {
    await new Promise((resolve) => first.close(resolve));
  }
});
```

**Step 2: Run test to verify it fails**

Run: `node --test test/server.test.ts`
Expected: FAIL with `ERR_MODULE_NOT_FOUND`，因为 `src/server.ts` 尚不存在

**Step 3: Write minimal implementation**

```ts
// src/server.ts
import type { Server } from "node:http";
import { pathToFileURL } from "node:url";
import { createApp } from "./app.ts";
import { loadConfig, type AppConfig } from "./config.ts";
import { createPiReviewer, type Reviewer } from "./reviewer.ts";

/** 装配应用并监听端口。监听成功后才 resolve，端口占用等错误以 reject 抛出。 */
export function startServer(config: AppConfig, reviewer: Reviewer): Promise<Server> {
  const app = createApp({ reviewer, promptPath: config.promptPath, timeoutMs: config.timeoutMs });
  return new Promise((resolve, reject) => {
    const server = app.listen(config.port, config.host, () => resolve(server));
    server.on("error", reject);
  });
}

/** 仅在直接执行本文件时启动服务；被测试导入时不产生副作用。 */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = loadConfig();
  const server = await startServer(config, createPiReviewer());
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : config.port;
  console.log(`cr-pilot 正在监听 http://${config.host}:${port}/review/webhook`);
}
```

`package.json` 确认 `start` 脚本为 `node src/server.ts`。`README.md` 写入：项目用途、环境要求（Node.js 22.19 及以上）、安装步骤（`npm install`）、pi 模型凭证前置条件（由 pi 自身配置）、四个环境变量表、启动命令、`curl` 调用示例、五种状态码含义、`npm test` 与 `npm run typecheck` 说明，以及「GitLab 原生 webhook 不含代码，需在请求体附带 `code`」的限制。

**Step 4: Run test to verify it passes**

Run: `node --test test/server.test.ts`
Expected: PASS（2 个用例）

自审：直接执行判定有注释说明为何需要；README 的四项配置与 `loadConfig` 完全一致，没有多写或少写。

**Step 5: Commit**

```bash
git add src/server.ts package.json README.md test/server.test.ts
git commit -m "feat: add server entry, run scripts and usage docs"
```

