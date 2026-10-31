/**
 * 评审明细的领域模型与持久化端口。
 *
 * 该端口是「评审记录」读写与统计的唯一入口，由 infrastructure/sqlite 实现。
 * domain 层零 IO：不引入数据库类型，只声明契约。
 */

/**
 * 一次评审消耗的模型 token。
 *
 * 取自 pi 会话实际返回的 usage，不做估算：估算值会让成本统计失真。
 *
 * **四个分量互斥**：pi 已把缓存命中/写入从 `input` 中剔除（见 SDK
 * `openai-completions` 的 `promptTokens - cacheRead - cacheWrite` 与
 * `calculateCost` 的 `input + cacheRead + cacheWrite`），因此
 * `totalTokens = input + output + cacheRead + cacheWrite`，四者可直接相加。
 * 把 `cacheRead` 当成 `input` 的子集会让命中率分母偏小、结果超过 100%。
 */
export interface TokenUsage {
  /** 未命中缓存的普通输入 token。 */
  input: number;
  /** 模型输出 token。 */
  output: number;
  /** 命中缓存的输入 token；与 `input` 互斥，不是它的子集。 */
  cacheRead: number;
  /** 写入缓存的输入 token；与 `input` 互斥，不是它的子集。 */
  cacheWrite: number;
  /** 总量；等于四者之和。 */
  totalTokens: number;
}

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
  /** MR 的 GitLab web 地址，供页面点击跳转；历史记录可能为 null。 */
  mrUrl: string | null;
  /** Unix 毫秒。 */
  startedAt: number;
  /** Unix 毫秒。 */
  finishedAt: number;
  /**
   * 本次评审累计消耗；`null` 表示没有可用的 usage 数据。
   *
   * 历史记录（功能上线前）与模型未返回 usage 时都是 null，统计必须显示「—」
   * 而不是 0——「没记录」与「零消耗」是两个不同结论。
   */
  tokenUsage: TokenUsage | null;
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

/**
 * 单维度聚合结果（按项目或按提交人）。
 *
 * 供统计页的图表与明细表共用：图表看分布趋势，表格看精确值。
 * 分数统计必须同时给 min/max：只看平均分会掩盖「有人被打了 20 分」这类信号。
 */
export interface DimensionStat {
  /** 分组键：项目全名或提交人姓名。 */
  name: string;
  /** 评审次数。 */
  count: number;
  /** 平均分；该组全部记录都没有分数时为 null（不是 0）。 */
  avgScore: number | null;
  /** 最低分；无带分数记录时为 null。 */
  minScore: number | null;
  /** 最高分；无带分数记录时为 null。 */
  maxScore: number | null;
  /**
   * 该组的 token 总量；该组没有任何 usage 数据时为 null（不是 0）。
   *
   * 只累计有 usage 的记录：把缺失当 0 会把「没采到」显示成「零消耗」。
   */
  totalTokens: number | null;
}

/**
 * 全局 token 用量汇总。
 *
 * `recordedReviews` 明确给出「有多少次评审带 usage」，让平均值分母可见：
 * 只有一部分记录有用量时，直接除以总次数会得到偏低的虚假平均值。
 */
export interface TokenTotals {
  /** 有 usage 数据的评审次数；为 0 时下方各项为 null。 */
  recordedReviews: number;
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  total: number | null;
  /** 每次评审平均总量；无 usage 时为 null。 */
  avgPerReview: number | null;
  /**
   * 缓存命中率 = cacheRead ÷ (input + cacheRead + cacheWrite)。
   *
   * 分母必须是**全部输入侧 token**：`input` 已被 SDK 剔除缓存部分，
   * 只用它作分母会把命中率算到 1 以上。输入总量为 0 时为 null。
   */
  cacheHitRate: number | null;
}

/** 统计查询条件；与列表共享过滤口径，但不包含分页。 */
export type ReviewStatsQuery = Omit<ReviewListQuery, "page" | "pageSize">;

/** 基础统计结果。`avgScore` 为 `null` 表示没有任何带分数的记录。 */
export interface ReviewStats {
  total: number;
  projectCount: number;
  committerCount: number;
  avgScore: number | null;
  daily: { date: string; count: number; avgScore: number | null }[];
  /** 按项目聚合，按评审次数降序。 */
  byProject: DimensionStat[];
  /** 按提交人聚合，按评审次数降序。 */
  byCommitter: DimensionStat[];
  /** 全局 token 用量；没有任何 usage 数据时除 `recordedReviews` 外均为 null。 */
  tokens: TokenTotals;
}

/** 评审明细持久化端口。实现方为 infrastructure/sqlite。 */
export interface ReviewRecordRepository {
  /**
   * 写入一条评审记录，返回数据库生成的自增 ID。
   *
   * 必须返回 ID：评审建议明细用 `record_id` 外键关联本表，拿不到 ID 就无法
   * 建立关联，采纳追踪会退化成「有评论但没有建议明细」。返回 `number | void`
   * 是为了兼容既有测试替身，但生产实现必须返回真实 ID。
   */
  insert(record: ReviewRecord): number | void;
  getList(query: ReviewListQuery): { items: ReviewRecord[]; total: number };
  getStats(query: ReviewStatsQuery): ReviewStats;
}
