- [x] **Task backend-001: 配置扩展与端口默认值**

**Files:**
- Modify: `src/config.ts`
- Modify: `package.json`
- Test: `test/config.test.ts`

**Reasoning:**
- 端口 5001 与七项 GitLab/分批/规则配置是后续所有模块的输入，必须先落地且可独立验证。
- `GITLAB_URL`/`GITLAB_TOKEN`/`GITLAB_WEBHOOK_SECRET` 缺一不可：不配置就直接运行会导致「启动成功但永远拉取失败」，启动快速失败更符合现有 `loadConfig` 语义。

**Depends on:** None

**Interfaces:**
- Consumes: 无
- Produces: `AppConfig` 新增字段、`loadConfig` 新语义
- Contract checks: 默认端口 5001；缺失必填 GitLab 配置时抛错；非法数值与非法布尔值快速失败

**Step 1: Write the failing test**

```ts
// test/config.test.ts（修改既有用例并新增）
test("loadConfig 默认端口为 5001", () => {
  assert.equal(loadConfig({ GITLAB_URL: "https://x", GITLAB_TOKEN: "t", GITLAB_WEBHOOK_SECRET: "s" }).port, 5001);
});

test("loadConfig 缺失必填 GitLab 配置时快速失败", () => {
  assert.throws(() => loadConfig({}), /GITLAB_URL/);
  assert.throws(() => loadConfig({ GITLAB_URL: "https://x" }), /GITLAB_TOKEN/);
});

test("loadConfig 解析 GitLab 与分批配置", () => {
  const config = loadConfig({
    GITLAB_URL: "https://gitlab.example.com",
    GITLAB_TOKEN: "t",
    GITLAB_WEBHOOK_SECRET: "s",
    GITLAB_INSECURE_TLS: "1",
    GITLAB_API_TIMEOUT: "20000",
    REVIEW_BATCH_MAX_TOKENS: "9000",
    REVIEW_RULES_DIR: "prompts/rules",
  });
  assert.equal(config.gitlabUrl, "https://gitlab.example.com");
  assert.equal(config.gitlabInsecureTls, true);
  assert.equal(config.gitlabApiTimeoutMs, 20000);
  assert.equal(config.batchMaxTokens, 9000);
  assert.equal(config.rulesDir, "prompts/rules");
});

test("loadConfig 对非法布尔值快速失败", () => {
  assert.throws(
    () => loadConfig({ GITLAB_URL: "x", GITLAB_TOKEN: "t", GITLAB_WEBHOOK_SECRET: "s", GITLAB_INSECURE_TLS: "maybe" }),
    /GITLAB_INSECURE_TLS/,
  );
});
```

**Step 2: Run test to verify it fails**

Run: `node --test test/config.test.ts`
Expected: FAIL —— 现有默认值用例期望 3000；新增用例报字段缺失或行为不符

**Step 3: Write minimal implementation**

`src/config.ts`：`DEFAULT_PORT` 改为 5001；新增 `gitlabUrl/gitlabToken/gitlabWebhookSecret/gitlabInsecureTls/gitlabApiTimeoutMs/batchMaxTokens/rulesDir` 字段。`loadConfig` 对 `GITLAB_URL`（去掉尾部 `/`）、`GITLAB_TOKEN`、`GITLAB_WEBHOOK_SECRET` 做非空校验；`GITLAB_INSECURE_TLS` 只接受 `0/1`；`GITLAB_API_TIMEOUT` 与 `REVIEW_BATCH_MAX_TOKENS` 复用 `readPositiveInt`；`REVIEW_RULES_DIR` 默认 `prompts/rules`。注释说明「缺失必填配置启动即失败」的理由。

`package.json`：新增 `"yaml": "^2.0.0"` 到 dependencies。

**Step 4: Run test to verify it passes**

Run: `node --test test/config.test.ts`
Expected: PASS（既有 4 个用例 + 新增 4 个用例）

自审：默认端口 5001 与 `P-001` 一致；新增字段各有职责注释；必填校验在实现附近说明原因。

**Step 5: Commit**

```bash
git add src/config.ts package.json test/config.test.ts package-lock.json
git commit -m "feat: extend config with gitlab, batching and rules settings"
```

- [x] **Task backend-002: 仓库规则加载与匹配**

**Files:**
- Create: `src/rules.ts`
- Create: `prompts/rules/default.yaml`
- Test: `test/rules.test.ts`

**Reasoning:**
- 仓库级 prompt 是 `P-003` 的核心交付，且是 pipeline 的输入，先于客户端与管线落地。
- 匹配优先级（仓库 > default > md 兜底）与占位符渲染必须用纯函数独立验证，不依赖 GitLab 或模型。

**Depends on:** `backend-001`

**Interfaces:**
- Consumes: `backend-001` 的 `AppConfig.rulesDir`
- Produces: `RuleSet`、`ReviewRules`、`renderUserPrompt`
- Contract checks: 仓库规则命中优先于 default；default 缺失时用 `prompts/review.md` 兜底（systemPrompt=md 全文，userPrompt 为内置默认）；占位符替换

**Step 1: Write the failing test**

```ts
// test/rules.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadReviewRules, renderUserPrompt } from "../src/rules.ts";

const DEFAULT_YAML = `
code_review_prompt:
  system_prompt: "默认系统提示"
  user_prompt: "请评审：{diffs_text}"
`;

async function withRulesDir(files: Record<string, string>, run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "crp-rules-"));
  try {
    for (const [name, content] of Object.entries(files)) {
      const path = join(dir, name);
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, content, "utf8");
    }
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("仓库规则命中时优先于 default", async () => {
  await withRulesDir({
    "default.yaml": DEFAULT_YAML,
    "team__app.yaml": "repository: team/app\ncode_review_prompt:\n  system_prompt: \"仓库系统提示\"\n  user_prompt: \"仓库用户提示 {diffs_text}\"\n",
  }, async (dir) => {
    const rules = await loadReviewRules(dir, "fallback");
    assert.equal(rules.resolve("team/app").systemPrompt, "仓库系统提示");
  });
});

test("无仓库规则时使用 default", async () => {
  await withRulesDir({ "default.yaml": DEFAULT_YAML }, async (dir) => {
    const rules = await loadReviewRules(dir, "fallback");
    assert.equal(rules.resolve("other/app").systemPrompt, "默认系统提示");
  });
});

test("无 YAML 规则时用 Markdown 兜底", async () => {
  await withRulesDir({}, async (dir) => {
    const rules = await loadReviewRules(dir, "## md 兜底内容");
    const set = rules.resolve("other/app");
    assert.equal(set.systemPrompt, "## md 兜底内容");
    assert.match(set.userPrompt, /{diffs_text}/);
  });
});

test("renderUserPrompt 替换占位符", () => {
  assert.equal(renderUserPrompt("评：{diffs_text}；提交：{commits_text}", { diffsText: "D", commitsText: "C" }), "评：D；提交：C");
});
```

**Step 2: Run test to verify it fails**

Run: `node --test test/rules.test.ts`
Expected: FAIL —— `src/rules.ts` 不存在（`ERR_MODULE_NOT_FOUND`）

**Step 3: Write minimal implementation**

`src/rules.ts`：用 `yaml` 包解析目录下所有 `.yaml`/`.yml`；`default.yaml` 为全局规则，其余文件必须含 `repository:` 字段（缺则跳过并记 warn）。`resolve(fullName)` 依次尝试 `path_with_namespace` 全名、去斜杠归一化后的键。仓库规则结构：`code_review_prompt.system_prompt` 与 `user_prompt`；缺失的规则回落到 default；default 也缺失时用兜底参数（`prompts/review.md` 全文作 systemPrompt，内置默认 userPrompt 含 `{diffs_text}`/`{commits_text}`）。`renderUserPrompt` 做占位符替换。所有公开对象带 TSDoc。

`prompts/rules/default.yaml`：写入与现有 `prompts/review.md` 等价的默认规则（system_prompt + user_prompt，含占位符）。

**Step 4: Run test to verify it passes**

Run: `node --test test/rules.test.ts`
Expected: PASS（4 个用例）

自审：匹配优先级注释与实际一致；跳过非法规则文件有 warn 日志；无 token 写入日志。

**Step 5: Commit**

```bash
git add src/rules.ts prompts/rules/default.yaml test/rules.test.ts
git commit -m "feat: per-repository review rules with yaml loader"
```

- [x] **Task backend-003: GitLab 客户端**

**Files:**
- Create: `src/gitlab-client.ts`
- Test: `test/gitlab-client.test.ts`

**Reasoning:**
- GitLab 三接口（changes/commits/notes）是 pipeline 的唯一外部依赖，必须可注入 fake fetch 独立测试，不碰真实网络。
- 参考项目在 changes 为空时重试 3 次（`webhook_handler.py:82-110`），这是真实 GitLab 的时序特性，客户端要内建。

**Depends on:** `backend-001`

**Interfaces:**
- Consumes: `AppConfig` 的 GitLab 字段、`Logger`
- Produces: `GitlabClient`、`createGitlabClient`、`GitlabApiError`、`Change`、`Commit`
- Contract checks: 三个接口的 URL 拼接、`PRIVATE-TOKEN` 头、changes 空结果重试、非 2xx 抛 `GitlabApiError`

**Step 1: Write the failing test**

```ts
// test/gitlab-client.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createGitlabClient, GitlabApiError } from "../src/gitlab-client.ts";
import { createSilentLogger } from "../src/logger.ts";

function jsonResponse(status: number, body: unknown) {
  return { status, ok: status >= 200 && status < 300, json: async () => body } as Response;
}

function trackFetch() {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return jsonResponse(200, {});
  };
  return { calls, fetchFn };
}

test("getMergeRequestChanges 拼接 URL 与认证头", async () => {
  const { calls, fetchFn } = trackFetch();
  const client = createGitlabClient({ url: "https://gitlab.example.com", token: "TOKEN", timeoutMs: 1000, insecureTls: false, logger: createSilentLogger(), fetchFn });
  await client.getMergeRequestChanges(42, 7);
  assert.equal(calls[0].url, "https://gitlab.example.com/api/v4/projects/42/merge_requests/7/changes?access_raw_diffs=true");
  assert.equal((calls[0].init.headers as Record<string, string>)["PRIVATE-TOKEN"], "TOKEN");
});

test("changes 为空时重试", async () => {
  const calls: unknown[][] = [];
  let attempts = 0;
  const fetchFn = async () => {
    attempts += 1;
    return jsonResponse(200, { changes: attempts >= 3 ? [{ diff: "d", new_path: "a.ts", old_path: "a.ts" }] : [] });
  };
  // 缩短重试间隔：createGitlabClient 接受 retryDelayMs 便于测试
  const client = createGitlabClient({ url: "https://x", token: "t", timeoutMs: 1000, insecureTls: false, logger: createSilentLogger(), fetchFn, retryDelayMs: 0 });
  const changes = await client.getMergeRequestChanges(1, 1);
  assert.equal(attempts, 3);
  assert.equal(changes.length, 1);
});

test("非 2xx 抛 GitlabApiError 并带状态码", async () => {
  const fetchFn = async () => jsonResponse(401, { message: "unauthorized" });
  const client = createGitlabClient({ url: "https://x", token: "t", timeoutMs: 1000, insecureTls: false, logger: createSilentLogger(), fetchFn });
  await assert.rejects(() => client.getMergeRequestChanges(1, 1), (error: unknown) => {
    assert.ok(error instanceof GitlabApiError);
    assert.equal(error.status, 401);
    return true;
  });
});

test("postMergeRequestNote 发送 body 字段", async () => {
  const { calls, fetchFn } = trackFetch();
  const client = createGitlabClient({ url: "https://gitlab.example.com", token: "TOKEN", timeoutMs: 1000, insecureTls: false, logger: createSilentLogger(), fetchFn });
  await client.postMergeRequestNote(42, 7, "评论正文");
  assert.equal(calls[0].url, "https://gitlab.example.com/api/v4/projects/42/merge_requests/7/notes");
  assert.equal(JSON.parse(String(calls[0].init.body)).body, "评论正文");
});
```

**Step 2: Run test to verify it fails**

Run: `node --test test/gitlab-client.test.ts`
Expected: FAIL —— `src/gitlab-client.ts` 不存在

**Step 3: Write minimal implementation**

`src/gitlab-client.ts`：`createGitlabClient` 接收 `{ url, token, timeoutMs, insecureTls, logger, fetchFn = fetch, retryDelayMs = 10000 }`。URL 拼接统一 `url.replace(/\/$/, "") + /api/v4/...`。请求带 `PRIVATE-TOKEN` 头与 `AbortSignal.timeout(timeoutMs)`。`insecureTls` 为真时用 undici 的 dispatcher 关闭证书校验（从 `node:undici` 导入 `Agent`？否——undici 未提升为直接依赖，实现时用全局 `fetch` + `process.env.NODE_TLS_REJECT_UNAUTHORIZED` 不可取；改用 `undici` 包内 `Agent` 需先确认可导入）。若 `node:undici` 无法直接导入，fallback 是动态 `import("undici")`（传递依赖可解析）。实现时验证并记录采用路径。

重试逻辑只用于 changes 空结果：最多 3 次，间隔 `retryDelayMs`。非 2xx 抛 `GitlabApiError(status, message)`。每个公开对象带 TSDoc，注明「日志不打 token 与正文」。

**Step 4: Run test to verify it passes**

Run: `node --test test/gitlab-client.test.ts`
Expected: PASS（4 个用例）

自审：TLS 开关的实现路径有注释说明；重试只针对空结果、非 2xx 立即抛；URL 拼接无尾部斜杠问题。

**Step 5: Commit**

```bash
git add src/gitlab-client.ts test/gitlab-client.test.ts
git commit -m "feat: gitlab api client with retry and note posting"
```
