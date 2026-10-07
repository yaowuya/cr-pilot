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

/** 已注册过实验特性静默处理器，避免重复注册监听。 */
let warningSuppressed = false;

/**
 * 静默 `node:sqlite` 的实验特性警告。
 *
 * 该警告由 Node 在首次导入模块时输出，内容固定。只拦截这一条而不是清空全部
 * warning 监听：清空会连内存泄漏、弃用 API 等真正需要关注的警告一起吞掉。
 */
function suppressSqliteExperimentalWarning(): void {
  if (warningSuppressed) return;
  warningSuppressed = true;
  process.on("warning", (warning) => {
    if (warning.name === "ExperimentalWarning" && /SQLite is an experimental feature/.test(warning.message)) {
      return;
    }
    // 其他警告交回默认行为：写入 stderr，保持原有可见性。
    process.stderr.write(`${warning.name}: ${warning.message}\n`);
  });
}

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
  suppressSqliteExperimentalWarning();
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(SCHEMA);
  return db;
}
