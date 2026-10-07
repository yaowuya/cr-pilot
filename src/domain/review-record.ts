/**
 * 评审明细的领域模型与持久化端口。
 *
 * 该端口是「评审记录」读写与统计的唯一入口，由 infrastructure/sqlite 实现。
 * domain 层零 IO：不引入数据库类型，只声明契约。
 */

/** 评审明细记录。 */
export interface ReviewRecord {
  projectId: number;
  projectName: string;
  mrIid: number;
  committerName: string;
  changeCount: number;
  batchCount: number;
  /**
   * AI 给出的总分；`null` 表示未解析出分数。
   *
   * 必须与真实的 0 分区分：`parseReviewScore` 无匹配时返回 0（见
   * `src/domain/review-rules.ts`），把「未解析出分数」直接存 0 会把平均值拉低。
   */
  score: number | null;
  durationMs: number;
  result: "success" | "failed";
  /** 仅 `result === "failed"` 时有值。 */
  errorMessage: string | null;
  commentUrl: string | null;
  /** Unix 毫秒。 */
  startedAt: number;
  /** Unix 毫秒。 */
  finishedAt: number;
}

/** 评审列表查询条件；未提供的字段不参与过滤。 */
export interface ReviewListQuery {
  projectId?: number;
  committer?: string;
  from?: number;
  to?: number;
  page: number;
  pageSize: number;
}

/** 基础统计结果。`avgScore` 为 `null` 表示没有任何带分数的记录。 */
export interface ReviewStats {
  total: number;
  projectCount: number;
  committerCount: number;
  avgScore: number | null;
  daily: { date: string; count: number; avgScore: number | null }[];
}

/** 评审明细持久化端口。实现方为 infrastructure/sqlite。 */
export interface ReviewRecordRepository {
  insert(record: ReviewRecord): void;
  getList(query: ReviewListQuery): { items: ReviewRecord[]; total: number };
  getStats(query: { from?: number; to?: number }): ReviewStats;
}
