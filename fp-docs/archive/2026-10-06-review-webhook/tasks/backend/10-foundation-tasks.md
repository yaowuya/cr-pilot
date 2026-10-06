- [x] **Task backend-001: 项目骨架与配置读取**

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `src/config.ts`
- Test: `test/config.test.ts`

**Reasoning:**
- 后续每个任务都要能运行 `npm test` 与 `npm run typecheck`，因此骨架必须先落地。
- 配置非法值必须在启动时快速失败，而不是把 `NaN` 透传给 `listen` 或 `AbortSignal.timeout`。

**Depends on:** None

**Interfaces:**
- Consumes: 无
- Produces: `AppConfig`、`loadConfig(env?)`
- Contract checks: `loadConfig()` 无环境变量时返回四个默认值；`REVIEW_TIMEOUT_MS=abc` 时抛出包含变量名的 `Error`

**Step 1: Write the failing test**

```ts
// test/config.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.ts";

test("loadConfig 在无环境变量时返回默认值", () => {
  assert.deepEqual(loadConfig({}), {
    port: 3000,
    host: "127.0.0.1",
    promptPath: "prompts/review.md",
    timeoutMs: 120000,
  });
});

test("loadConfig 采用环境变量覆盖", () => {
  const config = loadConfig({ PORT: "8080", HOST: "0.0.0.0", REVIEW_PROMPT_PATH: "a.md", REVIEW_TIMEOUT_MS: "5000" });
  assert.equal(config.port, 8080);
  assert.equal(config.host, "0.0.0.0");
  assert.equal(config.promptPath, "a.md");
  assert.equal(config.timeoutMs, 5000);
});

test("loadConfig 对非法数值快速失败", () => {
  assert.throws(() => loadConfig({ REVIEW_TIMEOUT_MS: "abc" }), /REVIEW_TIMEOUT_MS/);
});
```

**Step 2: Run test to verify it fails**

Run: `node --test test/config.test.ts`
Expected: FAIL with `ERR_MODULE_NOT_FOUND`，因为 `src/config.ts` 尚不存在

**Step 3: Write minimal implementation**

先写 `package.json`（依赖 `express`、`@earendil-works/pi-coding-agent`，开发依赖 `typescript`、`@types/node`、`@types/express`，scripts 三条：`start` 为 `node src/server.ts`、`test` 为 `node --test test/`、`typecheck` 为 `tsc --noEmit`），写 `tsconfig.json`（`module`/`moduleResolution` 为 `nodenext`、`strict`、`noEmit`、`allowImportingTsExtensions`、`erasableSyntaxOnly`、`verbatimModuleSyntax`、`skipLibCheck`、`types` 含 `node`），写 `.gitignore`（`node_modules/` 与 `*.log`），然后：

```ts
// src/config.ts
/** 服务运行期配置。所有字段都有默认值，只有非法输入才会让启动失败。 */
export interface AppConfig {
  port: number;
  host: string;
  promptPath: string;
  timeoutMs: number;
}

/**
 * 读取服务配置。非法数值直接抛出，避免把 NaN 透传给监听端口或超时计时器后
 * 在运行期以难以定位的方式失败。
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    port: readPositiveInt(env, "PORT", 3000),
    host: env.HOST?.trim() || "127.0.0.1",
    promptPath: env.REVIEW_PROMPT_PATH?.trim() || "prompts/review.md",
    timeoutMs: readPositiveInt(env, "REVIEW_TIMEOUT_MS", 120000),
  };
}

function readPositiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`环境变量 ${name} 必须是正整数，实际收到 ${raw}`);
  }
  return value;
}
```

**Step 4: Run test to verify it passes**

Run: `node --test test/config.test.ts`
Expected: PASS（3 个用例）

自审：`loadConfig` 与 `readPositiveInt` 都有职责说明；非法值分支有原因注释；未引入任何未被本任务使用的配置项。

**Step 5: Commit**

```bash
git add package.json tsconfig.json .gitignore src/config.ts test/config.test.ts
git commit -m "feat: scaffold node service and config loading"
```

- [x] **Task backend-002: prompt 文件读取与默认 prompt**

**Files:**
- Create: `src/prompt.ts`
- Create: `prompts/review.md`
- Test: `test/prompt.test.ts`

**Reasoning:**
- prompt 是「读取自定义 prompt」这条已确认需求的唯一落点，必须独立可验证。
- 文件缺失与空文件必须转成可识别的错误类型，路由才能稳定映射成 500 而不是 502。

**Depends on:** `backend-001`

**Interfaces:**
- Consumes: `backend-001` 的测试运行方式
- Produces: `PromptFileError`、`loadReviewPrompt(path)`
- Contract checks: 正常文件返回去空白全文；不存在的路径与只含空白的文件都抛 `PromptFileError`

**Step 1: Write the failing test**

```ts
// test/prompt.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadReviewPrompt, PromptFileError } from "../src/prompt.ts";

test("loadReviewPrompt 返回去空白后的全文", async () => {
  const dir = await mkdtemp(join(tmpdir(), "crp-prompt-"));
  try {
    const file = join(dir, "review.md");
    await writeFile(file, "\n  请审查以下代码  \n", "utf8");
    assert.equal(await loadReviewPrompt(file), "请审查以下代码");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadReviewPrompt 对缺失文件抛 PromptFileError", async () => {
  await assert.rejects(() => loadReviewPrompt(join(tmpdir(), "crp-missing-prompt.md")), PromptFileError);
});

test("loadReviewPrompt 对空白文件抛 PromptFileError", async () => {
  const dir = await mkdtemp(join(tmpdir(), "crp-prompt-"));
  try {
    const file = join(dir, "empty.md");
    await writeFile(file, "   \n\n", "utf8");
    await assert.rejects(() => loadReviewPrompt(file), PromptFileError);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

**Step 2: Run test to verify it fails**

Run: `node --test test/prompt.test.ts`
Expected: FAIL with `ERR_MODULE_NOT_FOUND`，因为 `src/prompt.ts` 尚不存在

**Step 3: Write minimal implementation**

```ts
// src/prompt.ts
import { readFile } from "node:fs/promises";

/** prompt 文件不可用时抛出。与 pi 调用失败区分开，让路由能映射成 500 而不是 502。 */
export class PromptFileError extends Error {
  override readonly name = "PromptFileError";
}

/**
 * 读取评审 prompt 全文。每次请求都重新读取，这样改 prompt 不需要重启服务，
 * 也避免为一份小文件引入缓存失效逻辑。
 */
export async function loadReviewPrompt(path: string): Promise<string> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    throw new PromptFileError(`prompt 文件不可读：${path}`, { cause: error });
  }
  const prompt = raw.trim();
  if (!prompt) {
    throw new PromptFileError(`prompt 文件内容为空：${path}`);
  }
  return prompt;
}
```

`prompts/review.md` 写入默认评审 prompt：以资深工程师口吻审查代码变更，输出问题清单（按严重程度分级）、每条给出位置与理由、最后给一句总体结论；明确要求只基于给定代码判断，不臆测未提供的文件。

**Step 4: Run test to verify it passes**

Run: `node --test test/prompt.test.ts`
Expected: PASS（3 个用例）

自审：错误类型有职责说明；「每次请求重新读取」的取舍有原因注释；`prompts/review.md` 与 `P-004` 的「单个 Markdown 文件整体作为 system prompt」一致。

**Step 5: Commit**

```bash
git add src/prompt.ts prompts/review.md test/prompt.test.ts
git commit -m "feat: load custom review prompt from markdown file"
```

- [x] **Task backend-003: GitLab payload 识别与元数据提取**

**Files:**
- Create: `src/gitlab.ts`
- Test: `test/gitlab.test.ts`

**Reasoning:**
- 已核实 GitLab payload 不含代码 diff，因此本模块只提取上下文，且必须能对未知事件类型返回 `null` 而不是抛错。
- 独立的纯函数模块让 `D-004` 的边界可以被直接断言。

**Depends on:** `backend-002`

**Interfaces:**
- Consumes: 无
- Produces: `isGitlabPayload(body)`、`extractGitlabContext(body)`
- Contract checks: MR payload 含标题与分支；push payload 含提交信息与变更文件；未知 `object_kind` 与非对象输入返回 `null`

**Step 1: Write the failing test**

```ts
// test/gitlab.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractGitlabContext, isGitlabPayload } from "../src/gitlab.ts";

const mergeRequestPayload = {
  object_kind: "merge_request",
  project: { path_with_namespace: "team/app" },
  object_attributes: {
    iid: 12,
    title: "修复登录超时",
    description: "把超时时间调大",
    source_branch: "fix/login",
    target_branch: "main",
    action: "open",
  },
};

const pushPayload = {
  object_kind: "push",
  ref: "refs/heads/main",
  project: { path_with_namespace: "team/app" },
  commits: [
    { message: "修复登录超时\n\n补充说明", added: ["a.ts"], modified: ["b.ts"], removed: ["c.ts"] },
  ],
};

test("isGitlabPayload 只认带 object_kind 的对象", () => {
  assert.equal(isGitlabPayload(mergeRequestPayload), true);
  assert.equal(isGitlabPayload({ code: "x" }), false);
  assert.equal(isGitlabPayload(null), false);
});

test("extractGitlabContext 提取 merge_request 元数据", () => {
  const context = extractGitlabContext(mergeRequestPayload);
  assert.match(context ?? "", /!12/);
  assert.match(context ?? "", /修复登录超时/);
  assert.match(context ?? "", /fix\/login/);
  assert.match(context ?? "", /team\/app/);
});

test("extractGitlabContext 提取 push 提交与变更文件", () => {
  const context = extractGitlabContext(pushPayload);
  assert.match(context ?? "", /main/);
  assert.match(context ?? "", /修复登录超时/);
  assert.match(context ?? "", /a\.ts/);
  assert.match(context ?? "", /c\.ts/);
});

test("extractGitlabContext 对未知类型与非对象返回 null", () => {
  assert.equal(extractGitlabContext({ object_kind: "issue" }), null);
  assert.equal(extractGitlabContext("raw code"), null);
});
```

**Step 2: Run test to verify it fails**

Run: `node --test test/gitlab.test.ts`
Expected: FAIL with `ERR_MODULE_NOT_FOUND`，因为 `src/gitlab.ts` 尚不存在

**Step 3: Write minimal implementation**

```ts
// src/gitlab.ts

/**
 * 判断请求体是否为 GitLab webhook payload。
 * 依据是官方 payload 恒带 object_kind 字段，不依赖请求头，简化调用方接入。
 */
export function isGitlabPayload(body: unknown): boolean {
  return isRecord(body) && typeof body.object_kind === "string" && body.object_kind.length > 0;
}

/**
 * 提取 GitLab payload 的评审上下文。
 *
 * GitLab webhook 不含代码 diff：push 事件的 commits 只有文件路径，MR 事件的
 * object_attributes 只有元数据，因此这里只产上下文，代码仍由请求体提供。
 * 未知事件类型返回 null，交由调用方决定如何提示。
 */
export function extractGitlabContext(body: unknown): string | null {
  if (!isRecord(body)) return null;
  if (body.object_kind === "merge_request") return describeMergeRequest(body);
  if (body.object_kind === "push") return describePush(body);
  return null;
}
```

辅助函数：`isRecord` 判定非 null 对象；`describeMergeRequest` 从 `object_attributes` 取 `iid`、`title`、`source_branch`、`target_branch`、`action`，从 `project.path_with_namespace` 取仓库，逐行拼接并跳过空字段；`describePush` 取 `ref` 去掉 `refs/heads/` 前缀作为分支，逐条提交取 `message` 首行与 `added`/`modified`/`removed` 合并后的文件列表。

**Step 4: Run test to verify it passes**

Run: `node --test test/gitlab.test.ts`
Expected: PASS（4 个用例）

自审：注释写明「payload 不含 diff」这一非显然约束及其依据；未引入未声明字段；对缺失关键字段的 payload 返回 `null` 而不是抛错。

**Step 5: Commit**

```bash
git add src/gitlab.ts test/gitlab.test.ts
git commit -m "feat: extract gitlab webhook metadata as review context"
```

