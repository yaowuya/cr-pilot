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

/** 一个 MR 快照的结果。已有建议可随不完整的评审报告一起返回。 */
export interface OcrReviewResult {
  findings: OcrFinding[];
  /** 仅 OCR 覆盖契约证明所有应审文件已完成，且结果与固定版本一致时为 true。 */
  complete: boolean;
  filesReviewed: number;
  /** 含规则排除和未完成的文件。complete 区分是否有未完成的应审文件。 */
  unreviewedPaths: string[];
  tokenUsage?: TokenUsage;
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
