/**
 * 评审明细仓储：基于 `node:sqlite` 的同步实现。
 *
 * 单表存储，统计用 SQL 实时聚合（D-007）。同步 API 直接返回结果，
 * 调用方（Express 路由与评审管线）无需 Promise 包装。
 */
import type { DatabaseSync } from "node:sqlite";
import type {
  DimensionStat,
  ReviewListQuery,
  ReviewRecord,
  ReviewRecordRepository,
  ReviewStats,
} from "../../domain/review-record.ts";

/** 数据库行形状：列名与表定义一致（snake_case）。 */
interface ReviewRow {
  id: number;
  project_id: number;
  project_name: string;
  mr_iid: number;
  committer_name: string;
  change_count: number;
  batch_count: number;
  score: number | null;
  duration_ms: number;
  result: string;
  error_message: string | null;
  comment_url: string | null;
  mr_url: string | null;
  started_at: number;
  finished_at: number;
}

/** 行转领域对象：snake_case → camelCase，`score` 保持 null 语义。 */
function toRecord(row: ReviewRow): ReviewRecord {
  return {
    projectId: row.project_id,
    projectName: row.project_name,
    mrIid: row.mr_iid,
    committerName: row.committer_name,
    changeCount: row.change_count,
    batchCount: row.batch_count,
    score: row.score,
    durationMs: row.duration_ms,
    result: row.result === "failed" ? "failed" : "success",
    errorMessage: row.error_message,
    commentUrl: row.comment_url,
    mrUrl: row.mr_url,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

/** 创建评审明细仓储。全部方法为同步调用。 */
export function createReviewRecordRepository(db: DatabaseSync): ReviewRecordRepository {
  const insertStatement = db.prepare(`
    INSERT INTO review_records (
      project_id, project_name, mr_iid, committer_name, change_count, batch_count,
      score, duration_ms, result, error_message, comment_url, mr_url, started_at, finished_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  return {
    insert(record) {
      const result = insertStatement.run(
        record.projectId,
        record.projectName,
        record.mrIid,
        record.committerName,
        record.changeCount,
        record.batchCount,
        // node:sqlite 不接受 undefined：显式传 null 表达「无分数」。
        record.score ?? null,
        record.durationMs,
        record.result,
        record.errorMessage,
        record.commentUrl,
        record.mrUrl,
        record.startedAt,
        record.finishedAt,
      );
      // 返回自增 ID：评审建议明细以 record_id 外键关联本表，
      // 不返回 ID 会让建议明细永远无法建立关联（采纳追踪静默失效）。
      return Number(result.lastInsertRowid);
    },

    getList(query) {
      // 动态拼 WHERE：只把实际提供的筛选项加入条件，并同步收集绑定参数，
      // 避免为每种筛选组合准备四条语句。
      const conditions: string[] = [];
      const params: (string | number)[] = [];
      if (query.projectId !== undefined) {
        conditions.push("project_id = ?");
        params.push(query.projectId);
      }
      if (query.committer) {
        conditions.push("committer_name = ?");
        params.push(query.committer);
      }
      if (query.from !== undefined) {
        conditions.push("started_at >= ?");
        params.push(query.from);
      }
      if (query.to !== undefined) {
        conditions.push("started_at <= ?");
        params.push(query.to);
      }
      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

      const totalRow = db.prepare(`SELECT COUNT(*) AS n FROM review_records ${where}`).get(...params) as { n: number };
      const offset = (query.page - 1) * query.pageSize;
      const rows = db
        .prepare(`SELECT * FROM review_records ${where} ORDER BY started_at DESC, id DESC LIMIT ? OFFSET ?`)
        .all(...params, query.pageSize, offset) as unknown as ReviewRow[];
      return { items: rows.map(toRecord), total: totalRow.n };
    },

    getStats(query) {
      const conditions: string[] = [];
      const params: (string | number)[] = [];
      if (query.projectId !== undefined) {
        conditions.push("project_id = ?");
        params.push(query.projectId);
      }
      if (query.committer) {
        conditions.push("committer_name = ?");
        params.push(query.committer);
      }
      if (query.from !== undefined) {
        conditions.push("started_at >= ?");
        params.push(query.from);
      }
      if (query.to !== undefined) {
        conditions.push("started_at <= ?");
        params.push(query.to);
      }
      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

      // AVG 自动忽略 NULL，正是需要的语义：未解析出分数的记录不计入平均分。
      // 不要改成 COALESCE(score, 0)，那会把缺失分数当成 0 分拉低均值。
      const summary = db
        .prepare(
          `SELECT COUNT(*) AS total,
                  COUNT(DISTINCT project_id) AS project_count,
                  COUNT(DISTINCT committer_name) AS committer_count,
                  AVG(score) AS avg_score
           FROM review_records ${where}`,
        )
        .get(...params) as { total: number; project_count: number; committer_count: number; avg_score: number | null };

      // 按本地日期分组：started_at 是 Unix 毫秒，除 1000 后交给 SQLite 的
      // unixepoch 修饰符换算，'localtime' 让分组边界与运维看到的日历一致。
      const dailyRows = db
        .prepare(
          `SELECT date(started_at / 1000, 'unixepoch', 'localtime') AS day,
                  COUNT(*) AS count,
                  AVG(score) AS avg_score
           FROM review_records ${where}
           GROUP BY day ORDER BY day ASC`,
        )
        .all(...params) as unknown as { day: string; count: number; avg_score: number | null }[];

      return {
        total: summary.total,
        projectCount: summary.project_count,
        committerCount: summary.committer_count,
        avgScore: summary.avg_score,
        daily: dailyRows.map((row) => ({ date: row.day, count: row.count, avgScore: row.avg_score })),
        byProject: aggregateByDimension(db, "project_name", where, params),
        byCommitter: aggregateByDimension(db, "committer_name", where, params),
      } satisfies ReviewStats;
    },
  };
}

/** 分组聚合的原始行形状。 */
interface AggregateRow {
  name: string;
  count: number;
  avg_score: number | null;
  min_score: number | null;
  max_score: number | null;
}

/**
 * 按单个维度聚合评审记录。
 *
 * 列名直接拼进 SQL（GROUP BY 不能参数化），因此只接受白名单字面量，
 * 绝不能让外部输入流进来——那会变成注入面。
 *
 * `AVG`/`MIN`/`MAX` 都自动忽略 NULL，正是需要的语义：没有分数的记录
 * 不参与分数统计，但**计入次数**。不要改成 COALESCE(score, 0)——那会把
 * 「未解析出分数」当成 0 分，既拉低均值又制造虚假的 0 分最低值。
 *
 * 排序：次数降序（谁评审最多一目了然），次数相同再按名称升序，
 * 保证刷新时顺序稳定，不会因 SQLite 内部顺序变化而跳动。
 */
function aggregateByDimension(
  db: DatabaseSync,
  column: "project_name" | "committer_name",
  where: string,
  params: (string | number)[],
): DimensionStat[] {
  const rows = db
    .prepare(
      `SELECT ${column} AS name,
              COUNT(*) AS count,
              AVG(score) AS avg_score,
              MIN(score) AS min_score,
              MAX(score) AS max_score
       FROM review_records ${where}
       GROUP BY ${column}
       ORDER BY count DESC, name ASC`,
    )
    .all(...params) as unknown as AggregateRow[];

  return rows.map((row) => ({
    name: row.name,
    count: row.count,
    avgScore: row.avg_score,
    minScore: row.min_score,
    maxScore: row.max_score,
  }));
}
