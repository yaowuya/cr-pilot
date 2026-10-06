- [x] **Task backend-004: pi 会话隔离配置**

**Files:**
- Create: `src/reviewer.ts`
- Test: `test/reviewer.test.ts`

**Reasoning:**
- 这是 proposal 风险 ① 的直接对策，也是全设计风险最高的决策，必须能在不安装模型、不需要凭证的前提下被断言。
- 把「隔离工作目录」与「loader 选项」拆成纯函数，才能对 `D-002` 的每一项开关逐一断言。

**Depends on:** `backend-003`

**Interfaces:**
- Consumes: 无
- Produces: `PiSessionLike`、`PiSessionFactory`、`createIsolatedWorkspace()`、`buildLoaderOptions(input)`
- Contract checks: `buildLoaderOptions` 的三项 `no*` 为 `true`，`systemPromptOverride()` 返回 prompt，`appendSystemPromptOverride()` 返回空数组

**Step 1: Write the failing test**

```ts
// test/reviewer.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { buildLoaderOptions, createIsolatedWorkspace } from "../src/reviewer.ts";

test("createIsolatedWorkspace 返回已存在且为空的目录", () => {
  const dir = createIsolatedWorkspace();
  try {
    assert.equal(existsSync(dir), true);
    assert.deepEqual(readdirSync(dir), []);
    assert.notEqual(dir, createIsolatedWorkspace());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildLoaderOptions 关闭全部项目资源发现", () => {
  const options = buildLoaderOptions({ prompt: "PROMPT", cwd: "C:/tmp/x", agentDir: "C:/agent" });
  assert.equal(options.cwd, "C:/tmp/x");
  assert.equal(options.agentDir, "C:/agent");
  assert.equal(options.noContextFiles, true);
  assert.equal(options.noSkills, true);
  assert.equal(options.noPromptTemplates, true);
  assert.equal(options.systemPromptOverride?.("base"), "PROMPT");
  assert.deepEqual(options.appendSystemPromptOverride?.(["base"]), []);
});
```

**Step 2: Run test to verify it fails**

Run: `node --test test/reviewer.test.ts`
Expected: FAIL with `ERR_MODULE_NOT_FOUND`，因为 `src/reviewer.ts` 尚不存在

**Step 3: Write minimal implementation**

```ts
// src/reviewer.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DefaultResourceLoaderOptions } from "@earendil-works/pi-coding-agent";

/** pi 会话的最小可替换面。只声明本服务用到的成员，测试可注入假实现。 */
export interface PiSessionLike {
  prompt(text: string): Promise<void>;
  getLastAssistantText(): string | undefined;
  readonly model: { id: string } | undefined;
  dispose(): void;
}

/** 创建一次评审所用的 pi 会话。默认实现接真实 SDK，测试注入假实现。 */
export type PiSessionFactory = (options: { systemPrompt: string; cwd: string }) => Promise<PiSessionLike>;

/**
 * 创建一个空的隔离工作目录。
 *
 * pi 会按 cwd 发现项目设置、扩展与信任配置。评审对象来自请求体而不是本地仓库，
 * 因此把 cwd 指向空目录，一次性排除项目级发现。
 */
export function createIsolatedWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "cr-pilot-review-"));
}

/**
 * 构造 pi 的资源加载选项。
 *
 * 三个 no* 开关与双 prompt 覆盖共同保证评审上下文只有 prompt 文件与请求里的代码：
 * 关掉上下文文件、skills 与 prompt 模板，并用空数组覆盖追加式系统提示，
 * 否则 pi 会自动附加 APPEND_SYSTEM.md。
 */
export function buildLoaderOptions(input: {
  prompt: string;
  cwd: string;
  agentDir: string;
}): DefaultResourceLoaderOptions {
  return {
    cwd: input.cwd,
    agentDir: input.agentDir,
    noContextFiles: true,
    noSkills: true,
    noPromptTemplates: true,
    systemPromptOverride: () => input.prompt,
    appendSystemPromptOverride: () => [],
  };
}
```

**Step 4: Run test to verify it passes**

Run: `node --test test/reviewer.test.ts`
Expected: PASS（2 个用例）

自审：两个导出都有 TSDoc 说明职责与非显然约束；隔离原因写在实现附近而不是只写在设计文档里。

**Step 5: Commit**

```bash
git add src/reviewer.ts test/reviewer.test.ts
git commit -m "feat: isolate pi session from project resource discovery"
```

- [x] **Task backend-005: 评审编排、消息组装与中断释放**

**Files:**
- Modify: `src/reviewer.ts`
- Test: `test/reviewer.test.ts`

**Reasoning:**
- 超时路径的会话释放是全设计唯一的并发推理点，必须用假实现断言「只释放一次」与「中断时释放」。
- `Reviewer` 契约是 `app.ts` 与 `server.ts` 的输入，必须先于路由落地。

**Depends on:** `backend-004`

**Interfaces:**
- Consumes: `backend-004` 的 `PiSessionLike`、`PiSessionFactory`、`createIsolatedWorkspace()`、`buildLoaderOptions()`
- Produces: `ReviewInput`、`ReviewResult`、`Reviewer`、`EmptyReviewError`、`buildUserMessage(code, context?)`、`createPiReviewer(options?)`
- Contract checks: 正常路径返回文本与模型 id 并释放一次；空文本抛 `EmptyReviewError`；`AbortSignal` 已中断时仍释放一次

**Step 1: Write the failing test**

```ts
// test/reviewer.test.ts（追加）
import { buildUserMessage, createPiReviewer, EmptyReviewError, type PiSessionLike } from "../src/reviewer.ts";

function fakeSession(text: string | undefined) {
  let disposeCount = 0;
  const session: PiSessionLike = {
    prompt: async () => {},
    getLastAssistantText: () => text,
    model: { id: "test-model" },
    dispose: () => { disposeCount += 1; },
  };
  return { session, disposeCount: () => disposeCount };
}

test("buildUserMessage 有上下文时前置背景段", () => {
  assert.match(buildUserMessage("CODE", "CTX"), /CTX[\s\S]*CODE/);
  assert.equal(buildUserMessage("CODE"), "待评审的代码变更：\nCODE");
});

test("createPiReviewer 正常路径返回文本与模型并释放一次", async () => {
  const { session, disposeCount } = fakeSession("  评审结论  ");
  const reviewer = createPiReviewer({ sessionFactory: async () => session });
  const result = await reviewer.review({ systemPrompt: "P", code: "CODE", signal: AbortSignal.timeout(5000) });
  assert.equal(result.text, "评审结论");
  assert.equal(result.model, "test-model");
  assert.equal(disposeCount(), 1);
});

test("createPiReviewer 对空文本抛 EmptyReviewError 且仍释放", async () => {
  const { session, disposeCount } = fakeSession("   ");
  const reviewer = createPiReviewer({ sessionFactory: async () => session });
  await assert.rejects(
    () => reviewer.review({ systemPrompt: "P", code: "CODE", signal: AbortSignal.timeout(5000) }),
    EmptyReviewError,
  );
  assert.equal(disposeCount(), 1);
});

test("createPiReviewer 在信号已中断时释放且不发起评审", async () => {
  const { session, disposeCount } = fakeSession("x");
  let prompted = false;
  session.prompt = async () => { prompted = true; };
  const reviewer = createPiReviewer({ sessionFactory: async () => session });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => reviewer.review({ systemPrompt: "P", code: "CODE", signal: controller.signal }));
  assert.equal(disposeCount(), 1);
  assert.equal(prompted, false);
});
```

**Step 2: Run test to verify it fails**

Run: `node --test test/reviewer.test.ts`
Expected: FAIL with `SyntaxError: The requested module '../src/reviewer.ts' does not provide an export named 'createPiReviewer'`

**Step 3: Write minimal implementation**

在 `src/reviewer.ts` 追加：

```ts
/** 一次评审的输入。systemPrompt 是 prompt 文件全文，code 是待评审内容。 */
export interface ReviewInput {
  systemPrompt: string;
  code: string;
  context?: string;
  signal: AbortSignal;
}

/** 评审结果。model 取自实际会话，便于调用方确认真正生效的模型。 */
export interface ReviewResult {
  text: string;
  model: string;
}

/** pi 返回了空评审文本。与调用失败区分开，便于排查 prompt 或模型问题。 */
export class EmptyReviewError extends Error {
  override readonly name = "EmptyReviewError";
}

/** 评审执行者。实现方负责创建与释放 pi 会话；中断由调用方按信号判定为超时。 */
export interface Reviewer {
  review(input: ReviewInput): Promise<ReviewResult>;
}

/** 组装用户消息。不做代码围栏，避免 diff 里出现反引号时截断内容。 */
export function buildUserMessage(code: string, context?: string): string {
  const parts: string[] = [];
  if (context?.trim()) parts.push(`背景信息：\n${context.trim()}`);
  parts.push(`待评审的代码变更：\n${code}`);
  return parts.join("\n\n");
}

/**
 * 创建基于 pi SDK 的评审执行者。
 *
 * 隔离工作目录在构造时创建一次并在进程内复用，避免每个请求产生临时目录。
 * 会话释放在 finally 中用标志位保证只执行一次：信号触发与正常结束可能同时到达，
 * 重复释放会打断 pi 的清理流程。
 */
export function createPiReviewer(options: { sessionFactory?: PiSessionFactory } = {}): Reviewer {
  const workspace = createIsolatedWorkspace();
  const sessionFactory = options.sessionFactory ?? createRealSession;
  return {
    async review({ systemPrompt, code, context, signal }) {
      if (signal.aborted) throw signal.reason ?? new Error("评审在开始前已被中断");
      const session = await sessionFactory({ systemPrompt, cwd: workspace });
      let disposed = false;
      const disposeOnce = (): void => {
        if (disposed) return;
        disposed = true;
        session.dispose();
      };
      const onAbort = (): void => { disposeOnce(); };
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        await session.prompt(buildUserMessage(code, context));
        if (signal.aborted) throw signal.reason ?? new Error("评审已中断");
        const text = session.getLastAssistantText()?.trim() ?? "";
        if (!text) throw new EmptyReviewError("pi 返回了空评审文本");
        return { text, model: session.model?.id ?? "unknown" };
      } finally {
        signal.removeEventListener("abort", onAbort);
        disposeOnce();
      }
    },
  };
}
```

`createRealSession` 用已核实签名实现：`new DefaultResourceLoader(buildLoaderOptions({ prompt: systemPrompt, cwd, agentDir: getAgentDir() }))`，`await loader.reload()`，再 `createAgentSession({ resourceLoader: loader, sessionManager: SessionManager.inMemory(), noTools: "all", cwd })`，返回 `session`。

**Step 4: Run test to verify it passes**

Run: `node --test test/reviewer.test.ts`
Expected: PASS（6 个用例）

自审：`noTools` 使用字符串 `"all"` 而非布尔值；`session.model?.id` 与 `Model` 类型一致；释放顺序有原因注释；未引入重试或队列。

**Step 5: Commit**

```bash
git add src/reviewer.ts test/reviewer.test.ts
git commit -m "feat: orchestrate pi review with single-shot session disposal"
```

