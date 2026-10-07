# Persistence Tasks

> **For agentic workers:** REQUIRED FLOW: Use `fp-execute` to implement this plan task-by-task. Only task markers use checkbox (`- [ ] **Task backend-NNN: ...**`) syntax for tracking; substeps are plain ordered instructions.

- [ ] **Task backend-005: 评审明细仓储**

**Files:**
- Create: `src/domain/review-record.ts`
- Create: `src/infrastructure/sqlite/review-record-repo.ts`
- Test: `test/infrastructure/sqlite/review-record-repo.test.ts`

**Reasoning:**
- `D-007` 确认单张明细表 + 实时聚合。该仓储是评审记录读写与统计的唯一入口。

**Depends on**: backend-004

**Interfaces:**
- Consumes: `openDatabase(path): DatabaseSync`
- Produces: `createReviewRecordRepository(db)`，含 `insert`、`getList`、`getStats`；类型 `ReviewRecord`、`ReviewRecordRepository`
- Contract checks: `score: null` 与 `score: 0` 在统计中区分（null 不计入 avgScore）；失败记录带 error_message

**Step 1: Write the failing test**

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../../../src/infrastructure/sqlite/database.ts";
import { createReviewRecordRepository } from "../../../src/infrastructure/sqlite/review-record-repo.ts";

test("insert 后 getList 可按项目筛选，getStats 忽略 null 分数", () => {
  const db = openDatabase(":memory:");
  const repo = createReviewRecordRepository(db);
  repo.insert({ projectId: 1, projectName: "a/b", mrIid: 7, committerName: "alice", changeCount: 3, batchCount: 1, score: 90, durationMs: 1000, result: "success", errorMessage: null, commentUrl: null, startedAt: 1000, finishedAt: 2000 });
  repo.insert({ projectId: 2, projectName: "c/d", mrIid: 8, committerName: "bob", changeCount: 1, batchCount: 1, score: null, durationMs: 500, result: "failed", errorMessage: "boom", commentUrl: null, startedAt: 3000, finishedAt: 3500 });
  const list = repo.getList({ projectId: 1, page: 1, pageSize: 10 });
  assert.equal(list.total, 1);
  assert.equal(list.items[0].committerName, "alice");
  const stats = repo.getStats({});
  assert.equal(stats.total, 2);
  assert.equal(stats.projectCount, 2);
  assert.equal(stats.committerCount, 2);
  assert.equal(stats.avgScore, 90, "null 分数不得计入平均值");
});

test("getList 支持按提交人与时间范围筛选并按时间倒序", () => {
  const db = openDatabase(":memory:");
  const repo = createReviewRecordRepository(db);
  for (const [index, name] of ["alice", "bob", "alice"].entries()) {
    repo.insert({ projectId: 1, projectName: "a/b", mrIid: index, committerName: name, changeCount: 1, batchCount: 1, score: 80, durationMs: 100, result: "success", errorMessage: null, commentUrl: null, startedAt: 1000 + index, finishedAt: 1100 + index });
  }
  assert.equal(repo.getList({ committer: "alice", page: 1, pageSize: 10 }).total, 2);
  assert.equal(repo.getList({ from: 1001, page: 1, pageSize: 10 }).total, 2);
  const all = repo.getList({ page: 1, pageSize: 10 });
  assert.ok(all.items[0].startedAt >= all.items[1].startedAt, "默认按 startedAt 倒序");
});
```

**Step 2: Run test to verify it fails**

Run: `node --test test/infrastructure/sqlite/review-record-repo.test.ts`
Expected: FAIL with `Cannot find module '.../review-record-repo.ts'`

**Step 3: Write minimal implementation**

`src/domain/review-record.ts`：

```typescript
/** 评审明细记录。score 为 null 表示未解析出分数，与 0 分语义不同（D-007）。 */
export interface ReviewRecord {
  projectId: number;
  projectName: string;
  mrIid: number;
  committerName: string;
  changeCount: number;
  batchCount: number;
  /** null 表示 AI 未给出可解析的分数；统计时不得计入平均分。 */
  score: number | null;
  durationMs: number;
  result: "success" | "failed";
  errorMessage: string | null;
  commentUrl: string | null;
  /** Unix 毫秒。 */
  startedAt: number;
  finishedAt: number;
}

/** 评审明细的持久化端口。实现方为 infrastructure/sqlite。 */
export interface ReviewRecordRepository {
  insert(record: ReviewRecord): void;
  getList(query: {
    projectId?: number;
    committer?: string;
    from?: number;
    to?: number;
    page: number;
    pageSize: number;
  }): { items: ReviewRecord[]; total: number };
  getStats(query: { from?: number; to?: number }): {
    total: number;
    projectCount: number;
    committerCount: number;
    avgScore: number | null;
    daily: { date: string; count: number; avgScore: number | null }[];
  };
}
```

`review-record-repo.ts` 用 `DatabaseSync.prepare` 预编译语句。`getStats` 的 `avgScore` 用 `AVG(score)`（SQL 的 AVG 自动忽略 NULL，无需额外过滤）；`daily` 按 `started_at / 86400000` 分组并用 `date(started_at/1000, 'unixepoch')` 输出日期串。行映射函数需把 snake_case 列名转回驼峰。

**Step 4: Run test to verify it passes**

Run: `node --test test/infrastructure/sqlite/review-record-repo.test.ts`
Expected: PASS（2 tests）

自审：`getStats` 中 AVG 忽略 NULL 的行为依赖 SQL 语义而非应用层过滤，需在代码注释中说明，避免后续有人「修正」成 `COALESCE(score, 0)` 而拉低平均分。

**Step 5: Commit**

```bash
git add src/domain/review-record.ts src/infrastructure/sqlite/review-record-repo.ts test/infrastructure/sqlite/review-record-repo.test.ts
git commit -m "feat: 新增评审明细仓储，统计用 SQL 实时聚合且忽略空分数"
```

- [ ] **Task backend-006: 管理员仓储**

**Files:**
- Create: `src/domain/admin.ts`
- Create: `src/infrastructure/sqlite/admin-repo.ts`
- Test: `test/infrastructure/sqlite/admin-repo.test.ts`

**Reasoning:**
- `D-011` 需环境变量引导首个管理员；`D-010` 需哈希存储。该仓储是账号 CRUD 的唯一入口。

**Depends on:** backend-003, backend-004

**Interfaces:**
- Consumes: `openDatabase(path)`、`hashPassword(plain, salt)`
- Produces: `createAdminRepository(db, salt)`，含 `create`、`list`、`delete`、`findByUsername`、`ensureInitialAdmin`、`count`；类型 `AdminUser`、`AdminRepository`
- Contract checks: username 唯一冲突抛错；`list` 不返回 password_hash；`ensureInitialAdmin` 重复调用无副作用

**Step 1: Write the failing test**

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../../../src/infrastructure/sqlite/database.ts";
import { createAdminRepository } from "../../../src/infrastructure/sqlite/admin-repo.ts";

test("创建管理员后 list 不含密码哈希，重复用户名被拒", () => {
  const db = openDatabase(":memory:");
  const repo = createAdminRepository(db, "fixed-salt");
  repo.create("admin", "s3cret");
  const list = repo.list();
  assert.equal(list.length, 1);
  assert.equal("passwordHash" in list[0], false, "列表不得返回密码哈希");
  assert.throws(() => repo.create("admin", "other"), /已存在/);
});

test("ensureInitialAdmin 仅在无账号时创建", () => {
  const db = openDatabase(":memory:");
  const repo = createAdminRepository(db, "fixed-salt");
  repo.ensureInitialAdmin("root", "pw");
  repo.ensureInitialAdmin("other", "pw");
  assert.equal(repo.count(), 1);
  assert.ok(repo.findByUsername("root"), "首个账号必须创建");
});

test("delete 移除账号后 findByUsername 返回 undefined", () => {
  const db = openDatabase(":memory:");
  const repo = createAdminRepository(db, "fixed-salt");
  const created = repo.create("admin", "s3cret");
  repo.delete(created.id);
  assert.equal(repo.findByUsername("admin"), undefined);
});
```

**Step 2: Run test to verify it fails**

Run: `node --test test/infrastructure/sqlite/admin-repo.test.ts`
Expected: FAIL with `Cannot find module '.../admin-repo.ts'`

**Step 3: Write minimal implementation**

```typescript
/** 管理员账号（对外视图不含密码哈希）。 */
export interface AdminUser {
  id: number;
  username: string;
  /** Unix 毫秒。 */
  createdAt: number;
}

/** 管理员仓储端口。实现方为 infrastructure/sqlite。 */
export interface AdminRepository {
  /** 创建账号；用户名重复时抛错（消息含「已存在」供路由转 409）。 */
  create(username: string, password: string): AdminUser;
  list(): AdminUser[];
  delete(id: number): void;
  findByUsername(username: string): AdminUser | undefined;
  /** 仅在表为空时创建首个账号（D-011 的引导语义）；重复调用无副作用。 */
  ensureInitialAdmin(username: string, password: string): void;
  count(): number;
}
```

`create` 把 `SQLITE_CONSTRAINT_UNIQUE` 错误转换为带「已存在」的 `Error`，路由层据此返回 409；仓储不引入 HTTP 语义。

**Step 4: Run test to verify it passes**

Run: `node --test test/infrastructure/sqlite/admin-repo.test.ts`
Expected: PASS（3 tests）

**Step 5: Commit**

```bash
git add src/domain/admin.ts src/infrastructure/sqlite/admin-repo.ts test/infrastructure/sqlite/admin-repo.test.ts
git commit -m "feat: 新增管理员仓储与首个账号引导"
```

- [ ] **Task backend-007: 配置覆盖仓储**

**Files:**
- Create: `src/domain/runtime-config.ts`
- Create: `src/infrastructure/sqlite/config-repo.ts`
- Test: `test/infrastructure/sqlite/config-repo.test.ts`

**Reasoning:**
- `P-005` 确认 DB 覆盖值启动优先；`D-014` 确认保存即同步生效。该仓储是配置覆盖的唯一存储。

**Depends on**: backend-004

**Interfaces:**
- Consumes: `openDatabase(path): DatabaseSync`
- Produces: `createConfigRepository(db)`，含 `list`、`setAll`、`clear`；`RESTART_REQUIRED_KEYS: ReadonlySet<string>`
- Contract checks: 同键覆盖而非追加；`clear` 删除键；`list` 按键名排序

**Step 1: Write the failing test**

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../../../src/infrastructure/sqlite/database.ts";
import { createConfigRepository, RESTART_REQUIRED_KEYS } from "../../../src/infrastructure/sqlite/config-repo.ts";

test("setAll 同键覆盖而非追加，clear 删除键", () => {
  const db = openDatabase(":memory:");
  const repo = createConfigRepository(db);
  repo.setAll([{ key: "QUEUE_CONCURRENCY", value: "9" }]);
  assert.equal(repo.list()[0].value, "9");
  repo.setAll([{ key: "QUEUE_CONCURRENCY", value: "3" }]);
  assert.equal(repo.list().length, 1);
  repo.clear(["QUEUE_CONCURRENCY"]);
  assert.equal(repo.list().length, 0);
});

test("RESTART_REQUIRED_KEYS 含启动期与 pi 读取的键，不含日志级别", () => {
  assert.ok(RESTART_REQUIRED_KEYS.has("PORT"));
  assert.ok(RESTART_REQUIRED_KEYS.has("LLMGW_API_KEY"));
  assert.equal(RESTART_REQUIRED_KEYS.has("LOG_LEVEL"), false, "日志级别每次写入都读，可热更新");
});
```

**Step 2: Run test to verify it fails**

Run: `node --test test/infrastructure/sqlite/config-repo.test.ts`
Expected: FAIL with `Cannot find module '.../config-repo.ts'`

**Step 3: Write minimal implementation**

```typescript
/**
 * 需要重启容器才能生效的配置键。
 *
 * 依据 design/backend.md 的可热更新项清单：PORT/HOST/LOG_FILE 等在启动期一次性
 * 绑定，ADMIN_* 只在引导创建首个账号时读取，LLMGW_API_KEY 由 pi 进程读取——
 * 运行期改 process.env 对已存在的 pi 会话无效。其余键（如 REVIEW_TIMEOUT_MS、
 * QUEUE_CONCURRENCY、LOG_LEVEL）每次评审或每次写入时读取，可热更新。
 */
export const RESTART_REQUIRED_KEYS: ReadonlySet<string> = new Set([
  "PORT",
  "HOST",
  "LOG_FILE",
  "REVIEW_PROMPT_PATH",
  "REVIEW_RULES_DIR",
  "ADMIN_USERNAME",
  "ADMIN_PASSWORD",
  "LLMGW_API_KEY",
]);

/** 一条配置覆盖值。value 为空串表示清空覆盖、回落到环境变量。 */
export interface ConfigOverride {
  key: string;
  value: string;
  /** Unix 毫秒。 */
  updatedAt: number;
}

/** 配置覆盖端口。 */
export interface ConfigRepository {
  list(): ConfigOverride[];
  setAll(items: { key: string; value: string }[]): void;
  clear(keys: string[]): void;
}
```

**Step 4: Run test to verify it passes**

Run: `node --test test/infrastructure/sqlite/config-repo.test.ts`
Expected: PASS（2 tests）

**Step 5: Commit**

```bash
git add src/domain/runtime-config.ts src/infrastructure/sqlite/config-repo.ts test/infrastructure/sqlite/config-repo.test.ts
git commit -m "feat: 新增配置覆盖仓储与需重启键清单"
```

- [ ] **Task backend-008: 评审 prompt 仓储**

**Files:**
- Create: `src/domain/review-prompt.ts`
- Create: `src/infrastructure/sqlite/prompt-repo.ts`
- Test: `test/infrastructure/sqlite/prompt-repo.test.ts`

**Reasoning:**
- `P-015` 确认 prompt 全部入库；`D-016` 确认保存即生效；`D-015` 确认删除即删回落 default。该仓储是 prompt 读写的唯一入口。

**Depends on**: backend-004

**Interfaces:**
- Consumes: `openDatabase(path): DatabaseSync`、`normalizeRepositoryKey(value)`（现有 `src/domain/review-rules.ts`）
- Produces: `createPromptRepository(db)`，含 `resolve`、`list`、`get`、`create`、`update`、`remove`、`importFromDir`；类型 `StoredPrompt`、`PromptRepository`
- Contract checks: `resolve` 按「项目全名 → default」回落；`importFromDir` 跳过已存在的 repository；大小写不敏感匹配

**Step 1: Write the failing test**

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../../../src/infrastructure/sqlite/database.ts";
import { createPromptRepository } from "../../../src/infrastructure/sqlite/prompt-repo.ts";

test("resolve 优先命中项目，未命中回落 default", () => {
  const db = openDatabase(":memory:");
  const repo = createPromptRepository(db);
  repo.create({ repository: "default", systemPrompt: "sys-default", userPrompt: "u {diffs_text}", wecomWebhookUrl: undefined, wecomScoreThreshold: undefined });
  repo.create({ repository: "group/proj", systemPrompt: "sys-proj", userPrompt: "u {diffs_text}", wecomWebhookUrl: undefined, wecomScoreThreshold: undefined });
  assert.equal(repo.resolve("group/proj")?.systemPrompt, "sys-proj");
  assert.equal(repo.resolve("other/repo")?.systemPrompt, "sys-default");
});

test("resolve 大小写与空白不敏感", () => {
  const db = openDatabase(":memory:");
  const repo = createPromptRepository(db);
  repo.create({ repository: "group/proj", systemPrompt: "sys-proj", userPrompt: "u {diffs_text}", wecomWebhookUrl: undefined, wecomScoreThreshold: undefined });
  assert.equal(repo.resolve("  Group/Proj  ")?.systemPrompt, "sys-proj");
});

test("remove 后该仓库回落 default", () => {
  const db = openDatabase(":memory:");
  const repo = createPromptRepository(db);
  repo.create({ repository: "default", systemPrompt: "sys-default", userPrompt: "u", wecomWebhookUrl: undefined, wecomScoreThreshold: undefined });
  const created = repo.create({ repository: "g/p", systemPrompt: "sys-p", userPrompt: "u", wecomWebhookUrl: undefined, wecomScoreThreshold: undefined });
  repo.remove(created.id);
  assert.equal(repo.resolve("g/p")?.systemPrompt, "sys-default");
});
```

**Step 2: Run test to verify it fails**

Run: `node --test test/infrastructure/sqlite/prompt-repo.test.ts`
Expected: FAIL with `Cannot find module '.../prompt-repo.ts'`

**Step 3: Write minimal implementation**

```typescript
/** 数据库中的评审 prompt。repository 为 "default" 时是全局默认。 */
export interface StoredPrompt {
  id: number;
  repository: string;
  systemPrompt: string;
  userPrompt: string;
  wecomWebhookUrl?: string;
  wecomScoreThreshold?: number;
  /** Unix 毫秒。 */
  updatedAt: number;
}

/** prompt 仓储端口。resolve 供评审热路径调用（D-016 要求每次评审读库）。 */
export interface PromptRepository {
  /**
   * 按项目全名解析 prompt；未命中时回落 repository="default" 的记录。
   * 两者都没有时返回 undefined，由调用方继续回落 yaml 与 Markdown 兜底链。
   */
  resolve(repositoryFullName?: string): StoredPrompt | undefined;
  list(): StoredPrompt[];
  get(id: number): StoredPrompt | undefined;
  create(input: Omit<StoredPrompt, "id" | "updatedAt">): StoredPrompt;
  update(id: number, input: Omit<StoredPrompt, "id" | "repository" | "updatedAt">): StoredPrompt;
  remove(id: number): void;
  /** 从 prompts/rules 目录导入 yaml；已存在的 repository 跳过。 */
  importFromDir(dir: string): { imported: number; skipped: number };
}
```

`resolve` 复用现有 `normalizeRepositoryKey`（`src/domain/review-rules.ts`）做大小写与空白归一，保证与既有匹配语义一致。`importFromDir` 复用现有 `loadReviewRules` 的 yaml 解析逻辑或直接用 `yaml` 包的 `parse`，跳过无 `repository` 的文件（与现有 `review-rules.ts:66-69` 的告警跳过语义一致）。

**Step 4: Run test to verify it passes**

Run: `node --test test/infrastructure/sqlite/prompt-repo.test.ts`
Expected: PASS（3 tests）

**Step 5: Commit**

```bash
git add src/domain/review-prompt.ts src/infrastructure/sqlite/prompt-repo.ts test/infrastructure/sqlite/prompt-repo.test.ts
git commit -m "feat: 新增评审 prompt 仓储，支持按项目解析与 yaml 导入"
```
