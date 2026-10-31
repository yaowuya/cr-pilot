/**
 * SQLite 连接初始化与 schema 定义。
 *
 * 用 Node 22 内置的 `node:sqlite`（DatabaseSync），不引入外部数据库依赖或 ORM。
 * 该模块是全部仓储的唯一入口，负责打开连接、设置 PRAGMA 与建表。
 */
import { DatabaseSync } from "node:sqlite";

/**
 * 建表语句：全部 IF NOT EXISTS。
 *
 * 重复启动幂等；回滚到旧版本代码后重新启动不会丢数据（旧代码忽略新表即可）。
 * 索引按 design 的查询模式映射建立：列表默认按 started_at 倒序，另两种筛选
 * 各用单列索引；统计走全表聚合，不额外建索引。
 */
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
  mr_url TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER NOT NULL,
  -- token 用量全部可空：历史记录与未返回 usage 的模型无法补采，NULL 表示「无数据」，
  -- 与真实的 0 消耗必须区分，统计页据此显示「—」。
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  total_tokens INTEGER
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
  repository_standards TEXT NOT NULL DEFAULT '',
  wecom_webhook_url TEXT,
  wecom_score_threshold INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS prompt_projects (
  prompt_id INTEGER NOT NULL,
  project TEXT NOT NULL,
  PRIMARY KEY (prompt_id, project),
  FOREIGN KEY (prompt_id) REFERENCES review_prompts (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_prompt_projects_project ON prompt_projects (project);
CREATE TABLE IF NOT EXISTS project_review_settings (
  project TEXT PRIMARY KEY NOT NULL,
  repository_context_enabled INTEGER NOT NULL DEFAULT 0 CHECK (repository_context_enabled IN (0, 1)),
  auto_merge_enabled INTEGER NOT NULL DEFAULT 0 CHECK (auto_merge_enabled IN (0, 1)),
  auto_merge_minimum_score INTEGER NOT NULL DEFAULT 100 CHECK (auto_merge_minimum_score BETWEEN 1 AND 100),
  auto_merge_target_mode TEXT NOT NULL DEFAULT 'default' CHECK (auto_merge_target_mode IN ('default', 'specified', 'any')),
  auto_merge_target_branches TEXT NOT NULL DEFAULT '[]',
  auto_merge_method TEXT NOT NULL DEFAULT 'merge' CHECK (auto_merge_method IN ('merge', 'squash')),
  auto_merge_remove_source_branch INTEGER NOT NULL DEFAULT 0 CHECK (auto_merge_remove_source_branch IN (0, 1)),
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS llm_providers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  kind TEXT NOT NULL,
  base_url TEXT NOT NULL,
  api_key TEXT,
  api TEXT NOT NULL,
  models TEXT NOT NULL,
  default_model TEXT,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS llm_project_bindings (
  project TEXT PRIMARY KEY,
  provider_id INTEGER NOT NULL,
  model TEXT,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (provider_id) REFERENCES llm_providers (id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS wecom_contacts (
  gitlab_username TEXT PRIMARY KEY COLLATE NOCASE,
  wecom_name TEXT NOT NULL,
  wecom_userid TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS review_findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  record_id INTEGER NOT NULL,
  project_id INTEGER NOT NULL,
  mr_iid INTEGER NOT NULL,
  marker TEXT NOT NULL,
  finding_id TEXT NOT NULL,
  severity TEXT NOT NULL,
  path TEXT NOT NULL,
  line INTEGER NOT NULL,
  line_key TEXT NOT NULL,
  base_sha TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  code_fingerprint TEXT NOT NULL DEFAULT '',
  discussion_id TEXT,
  note_id INTEGER,
  outcome TEXT NOT NULL DEFAULT 'pending',
  tracked_at INTEGER,
  created_at INTEGER NOT NULL,
  -- 追踪是脱离请求的定时任务，拿不到 webhook 请求头的任务级凭据，
  -- 因此在写入建议时把实例地址与访问令牌一并留存（令牌为密文）。
  gitlab_url TEXT NOT NULL DEFAULT '',
  gitlab_token_sealed TEXT NOT NULL DEFAULT '',
  UNIQUE (head_sha, marker),
  FOREIGN KEY (record_id) REFERENCES review_records (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_findings_tracking ON review_findings (outcome, tracked_at);
CREATE INDEX IF NOT EXISTS idx_findings_record ON review_findings (record_id);
CREATE INDEX IF NOT EXISTS idx_findings_project ON review_findings (project_id, created_at DESC);
`;

/** 已注册过实验特性静默处理器，避免重复注册监听。 */
let warningSuppressed = false;

/**
 * SQLite 实验特性警告的处理结论：**不拦截**。
 *
 * `node:sqlite` 在首次导入时输出 `ExperimentalWarning`，而该警告由 Node 在导入
 * 阶段直接写入 stderr：注册 `process.on("warning")` 监听无法阻止它（实测仍打印，
 * 反而会多打一行）。唯一能静默的方式是覆盖 `process.emitWarning`，但那会连带
 * 影响其他模块的警告，代价大于收益。
 *
 * 因此保留警告，并按 `D-003` 登记的验证要求执行：升级 Node 前单独验证
 * `DatabaseSync` 行为，而不是把警告藏起来。
 *
 * 这里保留一个常量记录该结论，避免后人重复尝试拦截。
 */
const SQLITE_EXPERIMENTAL_NOTE = "node:sqlite 为实验特性：升级 Node 前需验证 DatabaseSync 行为";

export { SQLITE_EXPERIMENTAL_NOTE };

/**
 * 打开 SQLite 连接并完成一次性初始化（PRAGMA 与建表）。
 *
 * 单连接而非每请求开连接：DatabaseSync 是同步 API，Node 单线程下 JS 侧写入天然
 * 串行（D-018）；每请求开连接只增加开销且更易触发 busy。
 *
 * `journal_mode = WAL` 让读不阻塞写；`busy_timeout` 兜住多进程场景（如导入脚本
 * 与服务同时写）。WAL 不支持网络文件系统，因此数据库文件必须落在本地盘，
 * 已由部署文档约束。
 */
export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  // SQLite 默认关闭外键约束，必须显式打开，否则 ON DELETE CASCADE 不生效
  // （删 prompt 时关联的 prompt_projects 行会残留）。
  db.exec("PRAGMA foreign_keys = ON");
  // 建表与补列必须是一次原子升级；IMMEDIATE 也避免两个启动进程同时探测缺列。
  // 新配置不从历史 Prompt 推测启用，旧库升级后仍保持原有 diff-only 行为。
  try {
    db.exec("BEGIN IMMEDIATE");
    db.exec(SCHEMA);
    migrate(db);
    db.exec("COMMIT");
    return db;
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    db.close();
    throw error;
  }
}

/**
 * 增量迁移：为已存在的旧库补齐新增列。
 *
 * `CREATE TABLE IF NOT EXISTS` 只对「表不存在」生效，不会给已有表加列。
 * 老部署升级到带新字段的版本时，如果不补这一步，任何读该表的查询都会报
 * `no such column`，服务直接不可用。
 *
 * 用 `PRAGMA table_info` 探测而不是 try/catch ALTER：SQLite 的
 * `ALTER TABLE ... ADD COLUMN` 在列已存在时抛错，靠异常判断会把真正的
 * 失败（如磁盘只读）也一起吞掉。
 */
function migrate(db: DatabaseSync): void {
  addColumnIfMissing(db, "review_prompts", "repository_standards", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "review_prompts", "provider_id", "INTEGER");
  addColumnIfMissing(db, "review_prompts", "model", "TEXT");
  addColumnIfMissing(db, "review_records", "mr_url", "TEXT");
  // token 用量统计：只追加可空列，历史记录保持 NULL（不可回填），旧版本代码
  // 会忽略这些列，因此回退无需删列。五列必须整组存在，统计查询才能安全聚合。
  addColumnIfMissing(db, "review_records", "input_tokens", "INTEGER");
  addColumnIfMissing(db, "review_records", "output_tokens", "INTEGER");
  addColumnIfMissing(db, "review_records", "cache_read_tokens", "INTEGER");
  addColumnIfMissing(db, "review_records", "cache_write_tokens", "INTEGER");
  addColumnIfMissing(db, "review_records", "total_tokens", "INTEGER");
  // 自动合并升级必须安全关闭；老库只补默认值，不能从既有 Prompt 推断启用。
  // 迁移仅追加带默认值的列、不重写旧数据：回滚旧版本时旧代码会忽略这些列，
  // 因而无需危险的逆向删列；若要永久降级 schema，应先备份再按 SQLite 规则重建表。
  addColumnIfMissing(db, "project_review_settings", "auto_merge_enabled", "INTEGER NOT NULL DEFAULT 0 CHECK (auto_merge_enabled IN (0, 1))");
  addColumnIfMissing(db, "project_review_settings", "auto_merge_minimum_score", "INTEGER NOT NULL DEFAULT 100 CHECK (auto_merge_minimum_score BETWEEN 1 AND 100)");
  addColumnIfMissing(db, "project_review_settings", "auto_merge_target_branches", "TEXT NOT NULL DEFAULT '[]'");
  // 旧版本只支持 allowlist，ALTER 默认 specified 才不会把已启用策略扩大为 default/any。
  // 仅本次补列时把“关闭且空列表”归为新安全默认；重复启动不得改写用户显式选择。
  const targetModeAdded = addColumnIfMissing(
    db,
    "project_review_settings",
    "auto_merge_target_mode",
    "TEXT NOT NULL DEFAULT 'specified' CHECK (auto_merge_target_mode IN ('default', 'specified', 'any'))",
  );
  if (targetModeAdded) {
    db.prepare(`UPDATE project_review_settings SET auto_merge_target_mode = 'default'
      WHERE auto_merge_enabled = 0 AND auto_merge_target_branches = '[]'`).run();
  }
  addColumnIfMissing(db, "project_review_settings", "auto_merge_method", "TEXT NOT NULL DEFAULT 'merge' CHECK (auto_merge_method IN ('merge', 'squash'))");
  addColumnIfMissing(db, "project_review_settings", "auto_merge_remove_source_branch", "INTEGER NOT NULL DEFAULT 0 CHECK (auto_merge_remove_source_branch IN (0, 1))");
  // 采纳追踪需要任务级实例与凭据；老库补列后历史建议为空，追踪会按「无凭据」
  // 降级为不可统计，而不是用错误的全局实例去请求。
  addColumnIfMissing(db, "review_findings", "gitlab_url", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "review_findings", "gitlab_token_sealed", "TEXT NOT NULL DEFAULT ''");
}

/** 给表补一列；仅实际执行 ALTER 时返回 true，供一次性数据归一化使用。 */
function addColumnIfMissing(db: DatabaseSync, table: string, column: string, definition: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>;
  if (columns.length === 0) return false; // 表还不存在，SCHEMA 建表时已带该列
  if (columns.some((item) => item.name === column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  return true;
}
