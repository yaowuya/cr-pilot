import { createHash } from "node:crypto";
import type { ParsedFinding } from "../domain/inline-comment.ts";
import type { OcrReviewResult } from "../domain/ocr-review.ts";

const DEDUCTIONS = { critical: 10, high: 5, medium: 2, low: 1 } as const;
type Severity = keyof typeof DEDUCTIONS;

function isSeverity(value: string): value is Severity {
  return Object.hasOwn(DEDUCTIONS, value);
}

function deduction(severity: string): number {
  return isSeverity(severity) ? DEDUCTIONS[severity] : 0;
}

/** 文件名可以含反引号或换行，不能直接拼到 Markdown 代码片段。 */
export function renderReviewPath(path: string): string {
  const clean = path.replace(/[\r\n]/g, " ");
  const longestRun = [...clean.matchAll(/`+/g)].reduce((max, [run]) => Math.max(max, run.length), 0);
  if (longestRun === 0) return `\`${clean}\``;
  const fence = "`".repeat(longestRun + 1);
  return `${fence} ${clean} ${fence}`;
}

function renderSuggestion(code: string): string {
  const longestRun = [...code.matchAll(/`+/g)].reduce((max, [run]) => Math.max(max, run.length), 0);
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `\n\n修改建议\n\n${fence}\n${code}\n${fence}`;
}

/** 评分与输出只依赖结构化建议，避免从回写正文中重新提取分数。 */
export function buildOcrReport(result: OcrReviewResult) {
  const unique = new Map<string, ParsedFinding>();
  let unclassified = false;
  for (const finding of result.findings) {
    const severity = finding.severity.trim().toLowerCase();
    unclassified ||= !isSeverity(severity);
    const text = finding.body.trim();
    const id = createHash("sha256")
      .update(JSON.stringify([finding.path, finding.lineKey, finding.line, text.replace(/\s+/g, " ")]))
      .digest("hex");
    const previous = unique.get(id);
    // 重复项级别不一致时，保留扣分较高的一条，避免报告顺序影响分数。
    if (previous && deduction(previous.severity) >= deduction(severity)) continue;
    const category = finding.category?.trim().toLowerCase();
    // Markdown 链接、图片、HTML 和 GitLab 提及也可能来自待审代码。
    const plainText = text.replace(/[&\\`*_~\[\]<>]/g, "\\$&").replaceAll("@", "@\u200b");
    const description = finding.suggestionCode ? `${plainText}${renderSuggestion(finding.suggestionCode)}` : plainText;
    unique.set(id, {
      id,
      path: finding.path,
      line: finding.lineKey === undefined ? 0 : finding.line,
      lineKey: finding.lineKey ?? "new_line",
      severity: isSeverity(severity) ? severity : "未分类",
      ...((category && /^[a-z][a-z_]{0,31}$/.test(category)) ? { category } : {}),
      // OCR 文本源自待评审代码。引用每行，防止 MR 评论将其当成 GitLab 快捷操作。
      body: description.split(/\r\n|[\r\n]/).map((line) => line ? `> ${line}` : ">").join("\n"),
    });
  }

  const findings = [...unique.values()].sort((left, right) => deduction(right.severity) - deduction(left.severity));
  const counts: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const { severity } of findings) {
    if (isSeverity(severity)) counts[severity]++;
  }
  const points = findings.reduce((sum, finding) => sum + deduction(finding.severity), 0);
  const score = result.complete && result.filesReviewed > 0 && !unclassified ? Math.max(0, 100 - points) : null;
  const limitations = [
    ...(!result.complete ? ["部分文件未完成评审"] : []),
    ...(result.filesReviewed === 0 ? ["无已评审文件"] : []),
    ...(unclassified ? ["存在严重级别未知的建议"] : []),
  ];
  const lines = [
    "## Open Code Review",
    score === null ? `OCR 评分暂缺（${limitations.join("、")}）` : `OCR 评分 **${score}/100**`,
    `严重 ${counts.critical} · 高 ${counts.high} · 中 ${counts.medium} · 低 ${counts.low}`,
    `已评审 ${result.filesReviewed} 个文件`,
  ];
  if (result.unreviewedPaths.length > 0) {
    const paths = result.unreviewedPaths.slice(0, 20).map(renderReviewPath);
    lines.push(`未评审 ${result.unreviewedPaths.length} 个文件 · ${paths.join("、")}${result.unreviewedPaths.length > paths.length ? " 等" : ""}`);
  }
  return { summary: lines.join("\n\n"), findings, score };
}
