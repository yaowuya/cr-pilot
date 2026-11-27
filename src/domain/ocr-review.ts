import type { ResolvedLlmTarget } from "./llm-provider.ts";
import type { RepositoryReviewSnapshot } from "./repository-context.ts";
import type { TokenUsage } from "./review-record.ts";

/** OCR 的结构化建议。仅经固定 diff 验证位置的一侧可用于发布行内评论。 */
export interface OcrFinding {
  path: string;
  /** 从 1 开始的候选行号，0 表示 OCR 未提供定位。 */
  line: number;
  lineKey?: "new_line" | "old_line";
  body: string;
  severity: string;
  category?: string;
  suggestionCode?: string;
}

/** 可写入日志的 OCR 汇总证据。null 表示引擎没有提供足够信息。 */
export interface OcrDiagnostics {
  status: string | null;
  returnedComments: number | null;
  codeCommentCalls: number | null;
  codeCommentFailures: number | null;
  acceptedCodeCommentCalls: number | null;
  /** 结束轮次含可见正文但同轮没有提交建议，仅作为排查线索。 */
  unsubmittedTextCompletions: number | null;
  session: "complete" | "incomplete" | "unavailable";
  warningCounts: Record<string, number>;
  exclusionCounts: Record<string, number>;
}

/** 一个 MR 快照的结果。已有建议可随不完整的评审报告一起返回。 */
export interface OcrReviewResult {
  findings: OcrFinding[];
  /** 在时限内按固定版本完成全部应审文件时为 true，随后读取诊断不影响此状态。 */
  complete: boolean;
  filesReviewed: number;
  /** 含规则排除和未完成的文件。complete 区分是否有未完成的应审文件。 */
  unreviewedPaths: string[];
  tokenUsage?: TokenUsage;
  diagnostics?: OcrDiagnostics;
}

/** 对固定 GitLab MR 快照运行一次 OCR 并释放该任务的临时资源。 */
export interface OcrReviewer {
  review(input: {
    snapshot: RepositoryReviewSnapshot;
    /** GitLab 凭据只用于抓取，不交给 OCR 模型进程。 */
    token: string;
    /** 由评审任务控制的运行时限。 */
    signal: AbortSignal;
    llmTarget?: ResolvedLlmTarget;
  }): Promise<OcrReviewResult>;
}
