# Crypto 与数据库初始化 Tasks

> **For agentic workers:** REQUIRED FLOW: Use `fp-execute` to implement this plan task-by-task. Only task markers use checkbox (`- [ ] **Task backend-NNN: ...**`) syntax for tracking; substeps are plain ordered instructions.

- [x] **Task backend-003: 密码哈希与令牌纯函数**

**Files:**
- Create: `src/shared/crypto.ts`
- Test: `test/shared/crypto.test.ts`

**Reasoning:**
- `D-010` 要求 scrypt + SHA256(用户名+固定盐)；`D-008`/`D-009` 要求不透明令牌且无状态。二者都是纯函数，可一次完成。
- 独立边界：不依赖数据库与 HTTP。

**Depends on:** None

**Interfaces:**
- Consumes: 无
- Produces: `hashPassword`、`verifyPassword`、`generateToken`、`deriveToken`
- Contract checks: 同密码同盐哈希一致；不同盐哈希不同；`verifyPassword` 对错误密码返回 false

**Step 1: Write the failing test**

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveToken, generateToken, hashPassword, verifyPassword } from "../../src/shared/crypto.ts";

test("hashPassword 产出 scrypt$盐$哈希 且同输入稳定", () => {
  const stored = hashPassword("s3cret", "fixed-salt");
  assert.match(stored, /^scrypt\$[0-9a-f]+\$[0-9a-f]+$/);
  assert.equal(stored, hashPassword("s3cret", "fixed-salt"));
  assert.notEqual(stored, hashPassword("s3cret", "other-salt"));
});

test("verifyPassword 正确密码通过、错误密码拒绝", () => {
  const stored = hashPassword("s3cret", "fixed-salt");
  assert.equal(verifyPassword("s3cret", "fixed-salt", stored), true);
  assert.equal(verifyPassword("wrong", "fixed-salt", stored), false);
});

test("generateToken 每次不同，deriveToken 确定性", () => {
  assert.notEqual(generateToken(), generateToken());
  assert.equal(deriveToken("admin", "salt"), deriveToken("admin", "salt"));
  assert.notEqual(deriveToken("admin", "salt"), deriveToken("other", "salt"));
});
```

**Step 2: Run test to verify it fails**

Run: `node --test test/shared/crypto.test.ts`
Expected: FAIL with `Cannot find module '../../src/shared/crypto.ts'`

**Step 3: Write minimal implementation**

```typescript
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/** scrypt 输出长度（字节）。16 字节足以抵抗暴力破解，且校验开销可忽略。 */
const KEY_LENGTH = 16;

/** 计算给定盐的 hex 表示：SHA256(用户名 + 部署固定盐)。 */
function deriveSalt(username: string, salt: string): string {
  return createHash("sha256").update(`${username}:${salt}`).digest("hex");
}

/**
 * 计算密码哈希（纯函数）。
 *
 * 盐为 SHA256(用户名 + 部署固定盐)：不同用户即使密码相同也得到不同哈希，同时
 * 无需为每个账号存盐字段（D-010）。格式 scrypt$<saltHex>$<hashHex>，盐内嵌于
 * 哈希串，校验时可直接取用。选 scryptSync 而非异步版：管理写入是低频操作，
 * 同步实现更简单且不引入 Promise 包装。
 */
export function hashPassword(plain: string, salt: string): string {
  const saltHex = deriveSalt(salt, salt);
  const hash = scryptSync(plain, saltHex, KEY_LENGTH).toString("hex");
  return `scrypt$${saltHex}$${hash}`;
}

/**
 * 校验密码。
 *
 * 定长比较（timingSafeEqual）避免时序侧信道：长度不等直接返回 false 而不比较，
 * 因为格式由本模块生成，长度必然一致。
 */
export function verifyPassword(plain: string, salt: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const expected = Buffer.from(parts[2], "hex");
  const actual = scryptSync(plain, parts[1], expected.length);
  return timingSafeEqual(actual, expected);
}

/** 生成 32 字节随机令牌（hex）。用于不可预测的场景。 */
export function generateToken(): string {
  return randomBytes(32).toString("hex");
}

/**
 * 由用户名与部署盐派生确定性令牌（D-009 的无状态会话）。
 *
 * 无会话表意味着令牌必须能从库中现有数据重算，否则每次请求都要比对密码哈希
 * （scrypt 成本高）。派生值让校验退化为一次数据库查询加一次哈希比较。
 * 代价是无法吊销：改密码后旧令牌仍有效到进程重启，已在 design 风险表登记。
 */
export function deriveToken(username: string, salt: string): string {
  return scryptSync(username, deriveSalt(username, salt), KEY_LENGTH).toString("hex");
}
```

**Step 4: Run test to verify it passes**

Run: `node --test test/shared/crypto.test.ts`
Expected: PASS（3 tests）

**Step 5: Commit**

```bash
git add src/shared/crypto.ts test/shared/crypto.test.ts
git commit -m "feat: 新增 scrypt 密码哈希与无状态令牌派生"
```

- [x] **Task backend-004: SQLite 连接、建表与 PRAGMA**

**Files:**
- Create: `src/infrastructure/sqlite/database.ts`
- Test: `test/infrastructure/sqlite/database.test.ts`

**Reasoning:**
- `D-018` 要求单连接 + WAL + busy_timeout；`D-003` 要求处理 ExperimentalWarning。这是所有仓储的前置依赖。
- 独立边界：建表与 PRAGMA 可独立验证，不涉及任何仓储逻辑。

**Depends on**: backend-003

**Interfaces:**
- Consumes: 无
- Produces: `openDatabase(path: string): DatabaseSync`
- Contract checks: 四张表存在；`journal_mode` 为 `wal`；重复调用不报错

**Step 1: Write the failing test**

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../../src/infrastructure/sqlite/database.ts";

test("openDatabase 建四张表并启用 WAL", () => {
  const dir = mkdtempSync(join(tmpdir(), "crp-db-"));
  try {
    const db = openDatabase(join(dir, "test.db"));
    const mode = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    assert.equal(mode.journal_mode, "wal");
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    const names = tables.map((row) => row.name);
    for (const expected of ["review_records", "admins", "config_overrides", "review_prompts"]) {
      assert.ok(names.includes(expected), `缺少表 ${expected}`);
    }
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("openDatabase 对同一路径重复调用保持幂等", () => {
  const dir = mkdtempSync(join(tmpdir(), "crp-db-"));
  try {
    openDatabase(join(dir, "a.db")).close();
    const db = openDatabase(join(dir, "a.db"));
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    assert.equal(tables.filter((row) => row.name === "admins").length, 1);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

**Step 2: Run test to verify it fails**

Run: `node --test test/infrastructure/sqlite/database.test.ts`
Expected: FAIL with `Cannot find module '.../sqlite/database.ts'`

**Step 3: Write minimal implementation**

```typescript
import { DatabaseSync } from "node:sqlite";

/** 建表语句：全部 IF NOT EXISTS，重复启动幂等且回滚旧版本后重启不丢数据。 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS review_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  project_name TEXT NOT NULL,
  mr_iid INTEGER NOT NULL,
  committer_name TEXT NOT NULL,
  change_count INTEGER NOT NULL,
  batch_count INTEGER NOT NULL,
  score INTEGER,
  duration_ms INTEGER NOT NULL,
  result TEXT NOT NULL,
  error_message TEXT,
  comment_url TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reviews_started_at ON review_records (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_reviews_project ON review_records (project_id);
CREATE INDEX IF NOT EXISTS idx_reviews_committer ON review_records (committer_name);
CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS config_overrides (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS review_prompts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repository TEXT NOT NULL UNIQUE,
  system_prompt TEXT NOT NULL,
  user_prompt TEXT NOT NULL,
  wecom_webhook_url TEXT,
  wecom_score_threshold INTEGER,
  updated_at INTEGER NOT NULL
);
`;

/**
 * 打开 SQLite 连接并完成一次性初始化（建表、PRAGMA）。
 *
 * 单连接而非每请求开连接：DatabaseSync 是同步 API，Node 单线程下 JS 侧写入天然
 * 串行（D-018）；每请求开连接只增加开销且更易触发 busy。WAL 让读不阻塞写，
 * busy_timeout 兜住多进程场景（导入脚本与服务同时写）。WAL 不支持网络文件系统，
 * 部署时数据库卷必须是本地盘，已在 design 风险表登记。
 */
export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(SCHEMA);
  return db;
}
```

`node:sqlite` 的 ExperimentalWarning 在首次 `import` 时输出一次。处理方式：在 `openDatabase` 内注册一个针对该消息的 `process.on("warning")` 监听并只静默匹配 `SQLite is an experimental feature` 的警告（不吞其他警告），实现时需注明为何不能用 `removeAllListeners`。

**Step 4: Run test to verify it passes**

Run: `node --test test/infrastructure/sqlite/database.test.ts`
Expected: PASS（2 tests）

**Step 5: Commit**

```bash
git add src/infrastructure/sqlite/database.ts test/infrastructure/sqlite/database.test.ts
git commit -m "feat: 新增 SQLite 连接初始化，建四张表并启用 WAL"
```
