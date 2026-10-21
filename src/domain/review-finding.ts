/**
 * 评审建议采纳追踪的领域模型与端口。
 *
 * 一条建议从「发布行内评论」走到「研发是否真的改了代码」，需要跨越多次提交。
 * 判定不能只靠评论是否被 resolve（人工动作可能漏点或误点），也不能只靠行号
 * （后续提交会插入/删除行，行号随之漂移）。因此记录被评论那一行的文本指纹，
 * 在后续版本中按文件路径与指纹重新定位同一处代码。
 */
import { createHash } from "node:crypto";

/**
 * 采纳判定的四态。
 *
 * - `pending`：尚未追踪（刚写入或等待新提交）。
 * - `adopted`：目标行文本已变化或被删除，说明代码确实改动了。
 * - `resolved-without-change`：讨论被标记已解决，但目标行未变，需要人工复核。
 * - `ignored`：讨论未解决且目标行未变。
 * - `unknown`：文件不存在或无法定位，不能猜测，且不计入采纳率分母。
 */
export type FindingOutcome = "pending" | "adopted" | "resolved-without-change" | "ignored" | "unknown";

/** 一条被评审的建议及其后续采纳判定。 */
export interface ReviewFinding {
  id: number;
  /** 关联的评审记录；降级进汇总的建议同样有记录。 */
  recordId: number;
  projectId: number;
  mrIid: number;
  /** 行内评论的幂等标记，形如 `<!-- marker:{head_sha}:{id} -->`。 */
  marker: string;
  /** 建议在当前批次中的编号，来自模型输出。 */
  findingId: string;
  severity: string;
  path: string;
  line: number;
  lineKey: "new_line" | "old_line";
  /** 评审时的版本坐标，用于判断是否已有新提交。 */
  baseSha: string;
  headSha: string;
  /**
   * 被评论行的规范化文本哈希；空串表示该建议未成功发布行内评论
   * （降级并入汇总），没有行锚点无法追踪。
   */
  codeFingerprint: string;
  /** GitLab 讨论与评论 ID，用于回查解决状态；未发布时为空。 */
  discussionId: string | null;
  noteId: number | null;
  outcome: FindingOutcome;
  /** 最近一次判定时间；未判定为 null。 */
  trackedAt: number | null;
  createdAt: number;
}

/** 一组维度的采纳聚合。`rate` 为 0-1，分母为 0 时为 null（不是 0）。 */
export interface AdoptionDimensionRow {
  name: string;
  /** 可统计建议数（不含 unknown 与不可追踪项）。 */
  tracked: number;
  adopted: number;
  rate: number | null;
}

/** 采纳统计结果：可统计部分与不可统计部分必须分开呈现。 */
export interface AdoptionStats {
  total: { tracked: number; adopted: number; rate: number | null };
  /** 不可统计条数：`fallback` 为降级并入汇总，`unknown` 为无法定位。 */
  untrackable: { fallback: number; unknown: number };
  byProject: AdoptionDimensionRow[];
  byCommitter: AdoptionDimensionRow[];
  bySeverity: AdoptionDimensionRow[];
}

/** 统计查询条件；未提供的字段不参与过滤。 */
export interface AdoptionStatsQuery {
  from?: number;
  to?: number;
  projectId?: number;
}

/** 建议明细持久化端口。实现方为 infrastructure/sqlite。 */
export interface ReviewFindingRepository {
  /** 写入一条建议；同一 `(head_sha, marker)` 已存在时不重复插入。 */
  insert(finding: Omit<ReviewFinding, "id">): void;
  listByRecord(recordId: number): ReviewFinding[];
  listByMr(projectId: number, mrIid: number): ReviewFinding[];
  /** 取待追踪建议：按创建时间升序，限制条数，避免一轮扫描过多。 */
  listPendingTracking(limit: number): ReviewFinding[];
  updateOutcome(id: number, outcome: FindingOutcome, trackedAt: number): void;
  getAdoptionStats(query: AdoptionStatsQuery): AdoptionStats;
}

/**
 * 计算单行代码指纹。
 *
 * 归一化去首尾空白并把内部连续空白压成单空格：缩进调整和多余空格不是
 * 语义变化，不应被判定为「代码已改」。空行返回空串，调用方据此跳过追踪。
 * 取 SHA-256 前 16 位：行文本可能含业务敏感内容，落库明文会扩大泄露面，
 * 短哈希既够抗碰撞又便于索引。
 */
export function fingerprintLine(line: string): string {
  const normalized = line.trim().replace(/\s+/g, " ");
  if (!normalized) return "";
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

/**
 * 从文件内容中按指纹重新定位目标行。
 *
 * 以评审时行号为中心取 ±`window` 行窗口：少量插入/删除会让目标行位移，
 * 但不会移出窗口。窗口内有多个相同指纹时取最接近原行号的一个；都不匹配时
 * 返回 `null`，由调用方记为 `unknown` 而不是猜测。
 */
export function locateFingerprintLine(
  content: string,
  originalLine: number,
  fingerprint: string,
  window = 3,
): { line: number; text: string } | null {
  if (!fingerprint) return null;
  const lines = content.split(/\r?\n/);
  // 行号是 1-based；转换为 0-based 数组下标后取闭区间。
  const center = originalLine - 1;
  const start = Math.max(0, center - window);
  const end = Math.min(lines.length - 1, center + window);
  let best: { line: number; text: string; distance: number } | null = null;
  for (let index = start; index <= end; index += 1) {
    const text = lines[index] ?? "";
    if (fingerprintLine(text) !== fingerprint) continue;
    const distance = Math.abs(index - center);
    if (!best || distance < best.distance) best = { line: index + 1, text, distance };
  }
  return best ? { line: best.line, text: best.text } : null;
}
