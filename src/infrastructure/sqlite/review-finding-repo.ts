/**
 * 评审建议采纳追踪仓储：基于 `node:sqlite` 的同步实现。
 *
 * 表设计要点（见 design/backend.md#数据模型）：
 * - `UNIQUE (head_sha, marker)`：同一版本同一建议只落一行，重跑评审不重复计数；
 * - `code_fingerprint` 为空串表示该建议降级并入汇总评论，没有行锚点、不可追踪；
 * - `outcome` 四态，`unknown` 不计入采纳率分母。
 */
import type { DatabaseSync } from "node:sqlite";
import type {
  AdoptionDimensionRow,
  AdoptionStats,
  AdoptionStatsQuery,
  FindingOutcome,
  ReviewFinding,
  ReviewFindingRepository,
} from "../../domain/review-finding.ts";

/** 数据库行形状（列名为 snake_case）。 */
interface FindingRow {
  id: number;
  record_id: number;
  project_id: number;
  mr_iid: number;
  marker: string;
  finding_id: string;
  severity: string;
  path: string;
  line: number;
  line_key: string;
  base_sha: string;
  head_sha: string;
  code_fingerprint: string;
  discussion_id: string | null;
  note_id: number | null;
  outcome: string;
  tracked_at: number | null;
  created_at: number;
}

/** 可统计的判定态；`pending` 与 `unknown` 都不计入分母。 */
const COUNTABLE_OUTCOMES = "('adopted','ignored','resolved-without-change')";

/** 行转领域对象。 */
function toFinding(row: FindingRow): ReviewFinding {
  return {
    id: row.id,
    recordId: row.record_id,
    projectId: row.project_id,
    mrIid: row.mr_iid,
    marker: row.marker,
    findingId: row.finding_id,
    severity: row.severity,
    path: row.path,
    line: row.line,
    lineKey: row.line_key === "old_line" ? "old_line" : "new_line",
    baseSha: row.base_sha,
    headSha: row.head_sha,
    codeFingerprint: row.code_fingerprint,
    discussionId: row.discussion_id,
    noteId: row.note_id,
    outcome: row.outcome as FindingOutcome,
    trackedAt: row.tracked_at,
    createdAt: row.created_at,
  };
}

/** 计算采纳率；分母为 0 时返回 null 而不是 0，避免把「无数据」显示成「全部未采纳」。 */
function rateOf(adopted: number, tracked: number): number | null {
  return tracked > 0 ? adopted / tracked : null;
}

/**
 * 构造统计查询的时间与项目过滤片段。
 *
 * `prefix` 用于联表场景区分列归属（如 `f.`），避免靠字符串替换猜表别名。
 */
function buildFilter(query: AdoptionStatsQuery, prefix = ""): { where: string; params: (string | number)[] } {
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  if (query.from !== undefined) {
    conditions.push(`${prefix}created_at >= ?`);
    params.push(query.from);
  }
  if (query.to !== undefined) {
    conditions.push(`${prefix}created_at <= ?`);
    params.push(query.to);
  }
  if (query.projectId !== undefined) {
    conditions.push(`${prefix}project_id = ?`);
    params.push(query.projectId);
  }
  return { where: conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "", params };
}

/** 聚合单维度。`nameExpression` 是分组列表达式，不接受外部输入。 */
function aggregateBy(
  db: DatabaseSync,
  nameExpression: string,
  where: string,
  params: (string | number)[],
): AdoptionDimensionRow[] {
  const rows = db
    .prepare(
      `SELECT ${nameExpression} AS name,
              COUNT(*) AS total,
              SUM(CASE WHEN outcome = 'adopted' THEN 1 ELSE 0 END) AS adopted,
              SUM(CASE WHEN outcome IN ${COUNTABLE_OUTCOMES} THEN 1 ELSE 0 END) AS tracked
       FROM review_findings ${where}
       GROUP BY name
       ORDER BY tracked DESC, name ASC`,
    )
    .all(...params) as unknown as { name: string; total: number; adopted: number; tracked: number }[];
  return rows.map((row) => {
    const tracked = Number(row.tracked ?? 0);
    const adopted = Number(row.adopted ?? 0);
    return { name: row.name, tracked, adopted, rate: rateOf(adopted, tracked) };
  });
}

/** 创建评审建议仓储。全部方法为同步调用。 */
export function createReviewFindingRepository(db: DatabaseSync): ReviewFindingRepository {
  const insertStatement = db.prepare(`
    INSERT INTO review_findings (
      record_id, project_id, mr_iid, marker, finding_id, severity, path, line, line_key,
      base_sha, head_sha, code_fingerprint, discussion_id, note_id, outcome, tracked_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(head_sha, marker) DO NOTHING
  `);

  /** 按条件查询建议；查询语句与排序固定，参数只走绑定。 */
  const query = (sql: string, params: (string | number)[]): ReviewFinding[] =>
    (db.prepare(sql).all(...params) as unknown as FindingRow[]).map(toFinding);

  return {
    insert(finding) {
      insertStatement.run(
        finding.recordId,
        finding.projectId,
        finding.mrIid,
        finding.marker,
        finding.findingId,
        finding.severity,
        finding.path,
        finding.line,
        finding.lineKey,
        finding.baseSha,
        finding.headSha,
        finding.codeFingerprint,
        finding.discussionId ?? null,
        finding.noteId ?? null,
        finding.outcome,
        finding.trackedAt ?? null,
        finding.createdAt,
      );
    },

    listByRecord(recordId) {
      return query("SELECT * FROM review_findings WHERE record_id = ? ORDER BY id ASC", [recordId]);
    },

    listByMr(projectId, mrIid) {
      return query("SELECT * FROM review_findings WHERE project_id = ? AND mr_iid = ? ORDER BY id ASC", [projectId, mrIid]);
    },

    listPendingTracking(limit) {
      // 只取有指纹且未判定的项：无指纹的降级项永远无法追踪，反复扫描只是浪费。
      return query(
        `SELECT * FROM review_findings
         WHERE outcome = 'pending' AND code_fingerprint <> ''
         ORDER BY created_at ASC, id ASC
         LIMIT ?`,
        [limit],
      );
    },

    updateOutcome(id, outcome, trackedAt) {
      db.prepare("UPDATE review_findings SET outcome = ?, tracked_at = ? WHERE id = ?").run(outcome, trackedAt, id);
    },

    getAdoptionStats(queryParams) {
      const { where, params } = buildFilter(queryParams);
      const totals = db
        .prepare(
          `SELECT
             SUM(CASE WHEN outcome IN ${COUNTABLE_OUTCOMES} THEN 1 ELSE 0 END) AS tracked,
             SUM(CASE WHEN outcome = 'adopted' THEN 1 ELSE 0 END) AS adopted,
             SUM(CASE WHEN code_fingerprint = '' THEN 1 ELSE 0 END) AS fallback,
             SUM(CASE WHEN outcome = 'unknown' THEN 1 ELSE 0 END) AS unknown
           FROM review_findings ${where}`,
        )
        .get(...params) as unknown as { tracked: number | null; adopted: number | null; fallback: number | null; unknown: number | null };

      const tracked = Number(totals.tracked ?? 0);
      const adopted = Number(totals.adopted ?? 0);
      // 提交人按评审记录反查：建议表本身不存姓名，避免姓名变更后历史数据不一致。
      const committerFilter = buildFilter(queryParams, "f.");
      const byCommitter = db
        .prepare(
          `SELECT COALESCE(r.committer_name, '') AS name,
                  SUM(CASE WHEN f.outcome IN ${COUNTABLE_OUTCOMES} THEN 1 ELSE 0 END) AS tracked,
                  SUM(CASE WHEN f.outcome = 'adopted' THEN 1 ELSE 0 END) AS adopted
           FROM review_findings f
           LEFT JOIN review_records r ON r.id = f.record_id
           ${committerFilter.where}
           GROUP BY name
           ORDER BY tracked DESC, name ASC`,
        )
        .all(...committerFilter.params) as unknown as { name: string; tracked: number; adopted: number }[];

      const toRow = (row: { name: string; tracked: number; adopted: number }): AdoptionDimensionRow => ({
        name: row.name,
        tracked: Number(row.tracked ?? 0),
        adopted: Number(row.adopted ?? 0),
        rate: rateOf(Number(row.adopted ?? 0), Number(row.tracked ?? 0)),
      });

      return {
        total: { tracked, adopted, rate: rateOf(adopted, tracked) },
        untrackable: { fallback: Number(totals.fallback ?? 0), unknown: Number(totals.unknown ?? 0) },
        byProject: aggregateBy(db, "CAST(project_id AS TEXT)", where, params),
        byCommitter: byCommitter.map(toRow),
        bySeverity: aggregateBy(db, "severity", where, params),
      };
    },
  };
}
