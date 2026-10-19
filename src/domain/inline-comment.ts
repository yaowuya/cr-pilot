/**
 * 行内评论的领域纯逻辑：diff 行号解析、评审 JSON 解析、position 构造与幂等 marker。
 *
 * 本模块零 IO，不依赖 HTTP、数据库或文件系统。所有 GitLab 通信由
 * infrastructure/gitlab 完成，本模块只产出/校验数据。
 */
import type { DiffRefs } from "./review-task.ts";

/** 单个变更文件的合法锚点行号集合。added/removed 用于校验 finding，visible* 用于诊断。 */
export interface DiffLineSets {
  added: Set<number>;
  removed: Set<number>;
  visibleNew: Set<number>;
  visibleOld: Set<number>;
}

/**
 * 解析 unified diff，算出各 hunk 的合法锚点行号（零 IO 纯函数）。
 *
 * 只有落在 added 或 removed 的行才能作为 GitLab 行内评论的锚点：GitLab 会拒绝
 * 指向未变更行的 position。逐行跟踪 `@@` 的 old/new 起始计数，遇到 `+`/`-` 归入
 * 对应集合并递增该侧计数，context 行同时计入 visible 两侧。
 * `+++`/`---` 文件头必须排除，否则会被误判为变更行（它们以 `+`/`-` 开头）。
 */
export function parseDiffLines(diff: string): DiffLineSets {
  const added = new Set<number>();
  const removed = new Set<number>();
  const visibleNew = new Set<number>();
  const visibleOld = new Set<number>();
  let oldLine: number | undefined;
  let newLine: number | undefined;
  for (const raw of diff.split("\n")) {
    const hunk = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      continue;
    }
    // hunk 头之前的内容（含文件头）不属于任何行号空间，直接跳过。
    if (oldLine === undefined || newLine === undefined) continue;
    if (raw.startsWith("+++") || raw.startsWith("---")) continue;
    if (raw.startsWith("+")) {
      added.add(newLine);
      visibleNew.add(newLine);
      newLine += 1;
    } else if (raw.startsWith("-")) {
      removed.add(oldLine);
      visibleOld.add(oldLine);
      oldLine += 1;
    } else {
      visibleOld.add(oldLine);
      visibleNew.add(newLine);
      oldLine += 1;
      newLine += 1;
    }
  }
  return { added, removed, visibleNew, visibleOld };
}

/** 单条 finding 的定位信息。lineKey 决定发 new_line 还是 old_line。 */
export interface ParsedFinding {
  id: string;
  severity: string;
  path: string;
  body: string;
  lineKey: "new_line" | "old_line";
  line: number;
}

/** AI 输出的结构化评审结果。 */
export interface ParsedReview {
  reviewedHeadSha: string;
  summaryBody: string;
  findings: ParsedFinding[];
}

/** GitLab Discussions API 的 position 对象：new_line 与 old_line 互斥。 */
export type DiscussionPosition = {
  position_type: "text";
  base_sha: string;
  start_sha: string;
  head_sha: string;
  old_path: string;
  new_path: string;
} & ({ new_line: number } | { old_line: number });

/** 合法 severity 取值，与参考实现 review.schema.json 的 enum 一致。 */
const VALID_SEVERITIES = new Set(["critical", "high", "medium", "low", "info"]);

/**
 * 解析 AI 输出的 JSON 评审结果（零 IO 纯函数）。
 *
 * schema 对齐参考实现 `references/review.schema.json`：reviewed_head_sha 必须是
 * 40 位 hex；findings 中 new_line 与 old_line 必须恰好出现一个——GitLab 的
 * position 只接受其中一个，同时给出说明模型无法确定锚点在哪一侧，此时判为非法
 * 而非猜一个。任一校验失败返回 null，由调用方把该批次整体降级进汇总评论，
 * 而不是丢弃内容。
 */
export function parseReviewJson(text: string): ParsedReview | null {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof root !== "object" || root === null || Array.isArray(root)) return null;
  const record = root as Record<string, unknown>;

  const reviewedHeadSha = record.reviewed_head_sha;
  if (typeof reviewedHeadSha !== "string" || !/^[0-9a-f]{40}$/.test(reviewedHeadSha)) return null;

  const summary = record.summary;
  if (typeof summary !== "object" || summary === null) return null;
  const summaryBody = (summary as Record<string, unknown>).body;
  if (typeof summaryBody !== "string" || summaryBody.trim() === "") return null;

  const rawFindings = record.findings;
  if (!Array.isArray(rawFindings)) return null;

  const findings: ParsedFinding[] = [];
  const seenIds = new Set<string>();
  for (const item of rawFindings) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return null;
    const finding = item as Record<string, unknown>;

    const id = typeof finding.id === "string" ? finding.id.trim() : "";
    if (!id || !/^[A-Za-z0-9._-]+$/.test(id)) return null;
    // 重复 id 会让 marker 冲突、幂等判断失效，必须拒绝整批而不是去重。
    if (seenIds.has(id)) return null;
    seenIds.add(id);

    const severity = typeof finding.severity === "string" ? finding.severity.toLowerCase() : "";
    if (!VALID_SEVERITIES.has(severity)) return null;

    const path = typeof finding.path === "string" ? finding.path.trim() : "";
    const body = typeof finding.body === "string" ? finding.body.trim() : "";
    if (!path || !body) return null;

    const hasNewLine = finding.new_line !== undefined && finding.new_line !== null;
    const hasOldLine = finding.old_line !== undefined && finding.old_line !== null;
    // 互斥是硬要求：两个都给说明模型不确定锚点侧，一个都不给则无法定位。
    if (hasNewLine === hasOldLine) return null;
    const lineKey = hasNewLine ? "new_line" : "old_line";
    const rawLine = finding[lineKey];
    if (typeof rawLine !== "number" || !Number.isInteger(rawLine) || rawLine < 1) return null;

    findings.push({ id, severity, path, body, lineKey, line: rawLine });
  }

  return { reviewedHeadSha, summaryBody, findings };
}

/**
 * 生成幂等 marker：以 head_sha 为前缀。
 *
 * MR 产生新提交后 head 变化，marker 随之变化，历史评论不会被误判为已发布，
 * 与参考实现 `gitlab_mr_review.py:269-270` 语义一致。
 */
export function buildMarker(headSha: string, itemId: string): string {
  return `<!-- marker:${headSha}:${itemId} -->`;
}

/** 构造 GitLab 行内评论的 position 对象；lineKey 决定用 new_line 还是 old_line。 */
export function buildPosition(input: {
  refs: DiffRefs;
  oldPath: string;
  newPath: string;
  lineKey: "new_line" | "old_line";
  line: number;
}): DiscussionPosition {
  const base = {
    position_type: "text" as const,
    base_sha: input.refs.baseSha,
    start_sha: input.refs.startSha,
    head_sha: input.refs.headSha,
    old_path: input.oldPath,
    new_path: input.newPath,
  };
  return input.lineKey === "new_line" ? { ...base, new_line: input.line } : { ...base, old_line: input.line };
}
