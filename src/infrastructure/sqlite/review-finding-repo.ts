/**
 * 评审建议采纳追踪仓储：基于 `node:sqlite` 的同步实现。
 *
 * 表设计要点（见 design/backend.md#数据模型）：
 * - `UNIQUE (head_sha, marker)`：同一版本同一建议只落一行，重跑评审不重复计数；
 * - `code_fingerprint` 为空串表示该建议降级并入汇总评论，没有行锚点、不可追踪；
 * - `outcome` 区分等待、采纳、忽略、仅解决与未知；pending/unknown 不计入分母。
 */
import type { DatabaseSync } from "node:sqlite";
import {
  ADOPTION_EXCLUDED_SCORE_AT_LEAST,
  type AdoptionDimensionRow,
  type AdoptionStats,
  type AdoptionStatsQuery,
  type FindingOutcome,
  type ReviewFinding,
  type ReviewFindingRepository,
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
  gitlab_url: string;
  gitlab_token_sealed: string;
}

/** 可统计的判定态；`pending` 与 `unknown` 都不计入分母。 */
const COUNTABLE_OUTCOMES = "('adopted','ignored','resolved-without-change')";
/** 只有带代码行指纹的 pending 才是在等待判定；空指纹项属于永久不可追踪。 */
const TRACKABLE_PENDING = "outcome = 'pending' AND code_fingerprint <> ''";

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
    gitlabUrl: row.gitlab_url,
    gitlabTokenSealed: row.gitlab_token_sealed,
  };
}

/** 计算采纳率；分母为 0 时返回 null 而不是 0，避免把「无数据」显示成「全部未采纳」。 */
function rateOf(adopted: number, tracked: number): number | null {
  return tracked > 0 ? adopted / tracked : null;
}

/**
 * 构造采纳统计的条件片段（时间与项目）。
 *
 * `prefix` 区分列归属（如 `f.`）。所有调用方都联表 `review_records`，因此
 * 必须显式传前缀：裸列名在两表同名字段上会变成歧义列。
 *
 * 返回 `conditions` 数组而不是拼好的 `WHERE` 字符串：高分排除等附加条件
 * 需要按顺序追加绑定参数，翻解析 SQL 文本既脆弱又易错配。
 */
function buildFilter(query: AdoptionStatsQuery, prefix: string): { conditions: string[]; params: (string | number)[] } {
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
  return { conditions, params };
}

/**
 * 高分评审记录的排除条件（记录侧）。
 *
 * 用 `COALESCE(score, -1) < 阈值` 而不是 `score < 阈值`：SQLite 里 NULL 参与
 * 比较结果为 NULL（视为不成立），直接写 `score < 95` 会把**没有分数**的记录
 * 一起排除掉。缺分不代表高分，必须仍然计入。
 */
const HIGH_SCORE_KEPT = `COALESCE(r.score, -1) < ${ADOPTION_EXCLUDED_SCORE_AT_LEAST}`;

/** 把条件数组拼成 WHERE 子句；空数组返回空串，避免调用方各自三元判断。 */
function whereOf(conditions: readonly string[]): string {
  return conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
}

/** 单维度聚合。`nameExpression` 是分组列表达式，不接受外部输入。 */
function aggregateBy(
  db: DatabaseSync,
  nameExpression: string,
  query: AdoptionStatsQuery,
): AdoptionDimensionRow[] {
  // 必须用 f. 前缀：与 review_records 联表后，裸列名在两张表都存在的
  // （如 project_id）会变成歧义列，SQLite 直接报错。
  const filter = buildFilter(query, "f.");
  const where = whereOf([...filter.conditions, HIGH_SCORE_KEPT]);
  const rows = db
    .prepare(
      `SELECT ${nameExpression} AS name,
              COUNT(*) AS total,
              SUM(CASE WHEN outcome = 'adopted' THEN 1 ELSE 0 END) AS adopted,
              SUM(CASE WHEN ${TRACKABLE_PENDING} THEN 1 ELSE 0 END) AS pending,
              SUM(CASE WHEN outcome IN ${COUNTABLE_OUTCOMES} THEN 1 ELSE 0 END) AS tracked
       FROM review_findings f
       LEFT JOIN review_records r ON r.id = f.record_id
       ${where}
       GROUP BY name
       ORDER BY tracked DESC, name ASC`,
    )
    .all(...filter.params) as unknown as { name: string; total: number; adopted: number; pending: number; tracked: number }[];
  return rows.map((row) => {
    const tracked = Number(row.tracked ?? 0);
    const adopted = Number(row.adopted ?? 0);
    return { name: row.name, tracked, adopted, pending: Number(row.pending ?? 0), rate: rateOf(adopted, tracked) };
  });
}

/** 项目名/提交人存于评审记录，通过 record_id 联表聚合；列名仅允许内部固定枚举。 */
function aggregateByRecordDimension(
  db: DatabaseSync,
  column: "project_name" | "committer_name",
  query: AdoptionStatsQuery,
): AdoptionDimensionRow[] {
  const filter = buildFilter(query, "f.");
  const isProject = column === "project_name";
  const nameExpression = isProject
    ? "COALESCE(NULLIF(TRIM(r.project_name), ''), '项目 ' || f.project_id)"
    : "COALESCE(r.committer_name, '')";
  // 联表维度可以同时使用建议侧筛选（f.）与记录侧高分排除（r.）。
  const where = whereOf([...filter.conditions, HIGH_SCORE_KEPT]);
  const rows = db.prepare(
    `SELECT ${nameExpression} AS name,
            ${isProject ? "f.project_id" : "NULL"} AS project_id,
            SUM(CASE WHEN f.outcome IN ${COUNTABLE_OUTCOMES} THEN 1 ELSE 0 END) AS tracked,
            SUM(CASE WHEN f.outcome = 'adopted' THEN 1 ELSE 0 END) AS adopted,
            SUM(CASE WHEN f.outcome = 'pending' AND f.code_fingerprint <> '' THEN 1 ELSE 0 END) AS pending
     FROM review_findings f
     LEFT JOIN review_records r ON r.id = f.record_id
     ${where}
     GROUP BY ${isProject ? "f.project_id, " : ""}name
     ORDER BY tracked DESC, name ASC`,
  ).all(...filter.params) as unknown as Array<{ name: string; project_id: number | null; tracked: number; adopted: number; pending: number }>;
  return rows.map((row) => {
    const tracked = Number(row.tracked ?? 0);
    const adopted = Number(row.adopted ?? 0);
    return {
      name: row.name,
      ...(row.project_id === null ? {} : { projectId: Number(row.project_id) }),
      tracked,
      adopted,
      pending: Number(row.pending ?? 0),
      rate: rateOf(adopted, tracked),
    };
  });
}

/** 创建评审建议仓储。全部方法为同步调用。 */
export function createReviewFindingRepository(db: DatabaseSync): ReviewFindingRepository {
  const insertStatement = db.prepare(`
    INSERT INTO review_findings (
      record_id, project_id, mr_iid, marker, finding_id, severity, path, line, line_key,
      base_sha, head_sha, code_fingerprint, discussion_id, note_id, outcome, tracked_at, created_at,
      gitlab_url, gitlab_token_sealed
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(head_sha, marker) DO NOTHING
  `);

  /** 按条件查询建议；查询语句与排序固定，参数只走绑定。 */
  const query = (sql: string, params: (string | number)[]): ReviewFinding[] =>
    (db.prepare(sql).all(...params) as unknown as FindingRow[]).map(toFinding);
  // 已判定行需长期复查新 head，不能删除；内存游标让有界批次在候选全集中轮转。
  let trackingCursor = 0;

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
        finding.gitlabUrl,
        finding.gitlabTokenSealed,
      );
    },

    listByRecord(recordId) {
      return query("SELECT * FROM review_findings WHERE record_id = ? ORDER BY id ASC", [recordId]);
    },

    listByMr(projectId, mrIid) {
      return query("SELECT * FROM review_findings WHERE project_id = ? AND mr_iid = ? ORDER BY id ASC", [projectId, mrIid]);
    },

    listPendingTracking(limit) {
      // 候选包含 pending 与已判定项：后者需在新 head 出现时重评。用 id 游标轮转，
      // 避免前 200 条同-head 历史记录每轮占满批次，令后排 pending 永久饥饿。
      if (!Number.isSafeInteger(limit) || limit <= 0) return [];
      const predicate = `code_fingerprint <> '' AND (outcome = 'pending' OR tracked_at IS NOT NULL)`;
      const result = query(
        `SELECT * FROM review_findings WHERE ${predicate} AND id > ? ORDER BY id ASC LIMIT ?`,
        [trackingCursor, limit],
      );
      if (result.length < limit && trackingCursor > 0) {
        result.push(...query(
          `SELECT * FROM review_findings WHERE ${predicate} AND id <= ? ORDER BY id ASC LIMIT ?`,
          [trackingCursor, limit - result.length],
        ));
      }
      if (result.length > 0) trackingCursor = result[result.length - 1].id;
      return result;
    },

    updateOutcome(id, outcome, trackedAt, evaluatedHeadSha) {
      db.prepare("UPDATE review_findings SET outcome = ?, tracked_at = ?, head_sha = ? WHERE id = ?").run(
        outcome,
        trackedAt,
        evaluatedHeadSha,
        id,
      );
    },

    refreshTrackingCredentials(projectId, mrIid, gitlabUrl, gitlabTokenSealed) {
      const result = db.prepare(`UPDATE review_findings
        SET gitlab_url = ?, gitlab_token_sealed = ?
        WHERE project_id = ? AND mr_iid = ? AND gitlab_url = ?
          AND outcome = 'pending' AND code_fingerprint <> ''`)
        .run(gitlabUrl, gitlabTokenSealed, projectId, mrIid, gitlabUrl);
      return Number(result.changes);
    },

    countUntrackable() {
      const row = db
        .prepare(
          `SELECT
             SUM(CASE WHEN code_fingerprint = '' THEN 1 ELSE 0 END) AS fallback,
             SUM(CASE WHEN outcome = 'unknown' THEN 1 ELSE 0 END) AS unknown
           FROM review_findings`,
        )
        .get() as unknown as { fallback: number | null; unknown: number | null };
      const fallback = Number(row.fallback ?? 0);
      const unknown = Number(row.unknown ?? 0);
      return { fallback, unknown, total: fallback + unknown };
    },

    getAdoptionStats(queryParams) {
      const filter = buildFilter(queryParams, "f.");
      // 采纳率相关列与维度聚合使用同一高分排除条件，保证总计与分组口径一致。
      const where = whereOf([...filter.conditions, HIGH_SCORE_KEPT]);
      const totals = db
        .prepare(
          `SELECT
             SUM(CASE WHEN outcome IN ${COUNTABLE_OUTCOMES} THEN 1 ELSE 0 END) AS tracked,
             SUM(CASE WHEN outcome = 'adopted' THEN 1 ELSE 0 END) AS adopted,
             SUM(CASE WHEN ${TRACKABLE_PENDING} THEN 1 ELSE 0 END) AS pending
           FROM review_findings f
           LEFT JOIN review_records r ON r.id = f.record_id
           ${where}`,
        )
        .get(...filter.params) as unknown as { tracked: number | null; adopted: number | null; pending: number | null };

      // 不可追踪项**不能**套高分排除：它们本来就不进采纳率分母，排除与否对
      // 采纳率没有影响；若一并过滤，这些建议会既不在 untrackable 也不在
      // excluded，页面的「建议总量」就会少于实际落库条数（静默丢数）。
      const untrackableRow = db
        .prepare(
          `SELECT
             SUM(CASE WHEN code_fingerprint = '' THEN 1 ELSE 0 END) AS fallback,
             SUM(CASE WHEN outcome = 'unknown' THEN 1 ELSE 0 END) AS unknown
           FROM review_findings f
           LEFT JOIN review_records r ON r.id = f.record_id
           ${whereOf(filter.conditions)}`,
        )
        .get(...filter.params) as unknown as { fallback: number | null; unknown: number | null };

      // 被排除条数单独统计：只纳入「本来会进采纳率分母」的可统计建议，
      // 加上尚未判定的可追踪建议——它们若判完也会被排除，用户在等一个
      // 永远不会出现在分母里的数。
      // 条件数组直接复用，避免翻解析已拼好的 SQL（顺序变化会静默错配参数）。
      const excludedConditions = [
        ...filter.conditions,
        "r.score >= ?",
        `(f.outcome IN ${COUNTABLE_OUTCOMES} OR (f.outcome = 'pending' AND f.code_fingerprint <> ''))`,
      ];
      const excludedRow = db
        .prepare(
          `SELECT COUNT(*) AS n
           FROM review_findings f
           LEFT JOIN review_records r ON r.id = f.record_id
           ${whereOf(excludedConditions)}`,
        )
        .get(...filter.params, ADOPTION_EXCLUDED_SCORE_AT_LEAST) as unknown as { n: number } | undefined;

      const tracked = Number(totals.tracked ?? 0);
      const adopted = Number(totals.adopted ?? 0);
      const pending = Number(totals.pending ?? 0);
      return {
        total: { tracked, adopted, pending, rate: rateOf(adopted, tracked) },
        untrackable: { fallback: Number(untrackableRow.fallback ?? 0), unknown: Number(untrackableRow.unknown ?? 0) },
        excluded: { highScore: Number(excludedRow?.n ?? 0) },
        // 名称取评审发生时写入 review_records 的历史快照；Prompt 后续改名/解绑不重写历史统计。
        byProject: aggregateByRecordDimension(db, "project_name", queryParams),
        byCommitter: aggregateByRecordDimension(db, "committer_name", queryParams),
        bySeverity: aggregateBy(db, "severity", queryParams),
      };
    },
  };
}
