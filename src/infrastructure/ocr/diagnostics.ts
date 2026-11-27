import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { OcrDiagnostics } from "../../domain/ocr-review.ts";

const MAX_SESSION_BYTES = 8 * 1024 * 1024;
const MAX_SESSION_RECORDS = 20_000;
const MAX_REPOSITORY_DIRECTORIES = 16;
const MAX_COMPLETION_TEXTS = 3;
const MAX_COMPLETION_CHARS = 4000;
const SESSION_ID = /^(?:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}|fallback-\d{1,20})$/i;
const STATUS = new Set(["complete", "partial", "failed", "skipped", "success", "completed_with_errors", "completed_with_warnings"]);
const EXCLUSIONS = new Set(["binary", "secret", "user_rule", "extension", "default_path", "deleted", "too_large"]);
const WARNINGS = new Set([
  "subtask_error", "manifest_error", "token_budget_reached", "token_threshold_exceeded", "review_round_failed",
  "review_limit_reached", "task_done_with_unfiled_text",
]);

type SessionDiagnostics = Pick<OcrDiagnostics, "session" | "acceptedCodeCommentCalls" | "unsubmittedTextCompletions">;

/** 普通诊断返回固定枚举和计数。专用回调可接收完整会话里未提交建议的结束轮次正文。 */
export async function readOcrDiagnostics(
  report: Record<string, unknown>,
  workspace: string,
  onUnsubmittedCompletionText?: (text: string, truncated: boolean) => void,
  redactText?: (text: string) => string,
): Promise<OcrDiagnostics> {
  const tools = object(report.tool_calls);
  const coverage = object(object(report.manifest)?.coverage);
  const sessionId = report.session_id;
  const captured: string[] | undefined = onUnsubmittedCompletionText ? [] : undefined;
  const session = typeof sessionId === "string" && SESSION_ID.test(sessionId)
    ? await readSession(workspace, sessionId, captured).catch(() => unavailable("unavailable"))
    : unavailable("unavailable");
  if (session.session === "complete" && captured && onUnsubmittedCompletionText) {
    for (const content of captured) {
      try {
        // 对完整正文脱敏，避免截断处仅保留凭据的前半部分。
        const text = redactText ? redactText(content) : content;
        let end = Math.min(text.length, MAX_COMPLETION_CHARS);
        if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
        onUnsubmittedCompletionText(text.slice(0, end), end < text.length);
      } catch { /* 单条脱敏或交付失败时继续处理其余正文。 */ }
    }
  }
  return {
    status: typeof report.status === "string" && STATUS.has(report.status) ? report.status : null,
    returnedComments: Array.isArray(report.comments) ? report.comments.length : report.comments === null ? 0 : null,
    codeCommentCalls: codeCommentCount(tools?.by_tool),
    codeCommentFailures: codeCommentCount(tools?.failure_by_tool),
    warningCounts: countByCode(report.warnings, "type", WARNINGS),
    exclusionCounts: countByCode(coverage?.excluded, "exclude_reason", EXCLUSIONS),
    ...session,
  };
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function codeCommentCount(value: unknown): number | null {
  const counts = object(value);
  if (!counts) return null;
  const count = counts.code_comment;
  if (count === undefined) return 0;
  return typeof count === "number" && Number.isSafeInteger(count) && count >= 0 ? count : null;
}

function countByCode(items: unknown, field: string, allowed: ReadonlySet<string>): Record<string, number> {
  const counts: Record<string, number> = {};
  if (!Array.isArray(items)) return counts;
  for (const item of items) {
    const candidate = object(item)?.[field];
    const code = typeof candidate === "string" && allowed.has(candidate) ? candidate : "other";
    counts[code] = (counts[code] ?? 0) + 1;
  }
  return counts;
}

function unavailable(session: "incomplete" | "unavailable"): SessionDiagnostics {
  return { session, acceptedCodeCommentCalls: null, unsubmittedTextCompletions: null };
}

async function readSession(workspace: string, sessionId: string, captured?: string[]): Promise<SessionDiagnostics> {
  const home = await realpath(workspace);
  const ocrHome = join(home, ".opencodereview");
  const sessions = join(ocrHome, "sessions");
  // 两层目录都必须是真实目录，不能把 HOME 下的链接当成读取依据。
  if (!(await lstat(ocrHome)).isDirectory() || !(await lstat(sessions)).isDirectory()) return unavailable("unavailable");

  const directory = await opendir(sessions);
  try {
    for (let i = 0; i < MAX_REPOSITORY_DIRECTORIES; i++) {
      const entry = await directory.read();
      if (!entry) break;
      if (!entry.isDirectory()) continue;
      // OCR 使用平台相关的仓库路径编码。只在已知层级查找报告指定的 UUID 文件。
      const path = join(sessions, entry.name, `${sessionId}.jsonl`);
      const info = await lstat(path).catch(() => undefined);
      if (info?.isFile() && await realpath(path) === path) return await inspectSession(path, sessionId, captured);
    }
    return unavailable("unavailable");
  } finally {
    await directory.close();
  }
}

async function inspectSession(path: string, sessionId: string, captured?: string[]): Promise<SessionDiagnostics> {
  const flags = constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW);
  const file = await open(path, flags);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_SESSION_BYTES || info.size === 0) return unavailable("incomplete");
    const buffer = Buffer.allocUnsafe(info.size);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) return unavailable("incomplete");
      offset += bytesRead;
    }
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(buffer); }
    catch { return unavailable("incomplete"); }
    return countSessionEvents(text, sessionId, captured);
  } finally {
    await file.close();
  }
}

function countSessionEvents(text: string, sessionId: string, captured?: string[]): SessionDiagnostics {
  let acceptedCodeCommentCalls = 0;
  let unsubmittedTextCompletions = 0;
  let lastType: string | undefined;
  let start = 0;
  for (let records = 0; start < text.length && records < MAX_SESSION_RECORDS; records++) {
    const newline = text.indexOf("\n", start);
    if (newline < 0) return unavailable("incomplete");
    const line = text.slice(start, newline);
    start = newline + 1;

    let entry: Record<string, unknown> | undefined;
    try { entry = object(JSON.parse(line)); }
    catch { return unavailable("incomplete"); }
    if (!entry || entry.sessionId !== sessionId || typeof entry.type !== "string") return unavailable("incomplete");
    if ((records === 0) !== (entry.type === "session_start")) return unavailable("incomplete");
    if (entry.type === "session_end" && start !== text.length) return unavailable("incomplete");
    lastType = entry.type;
    if (entry.taskType !== "main_task") continue;

    if (entry.type === "tool_call" && entry.tool_name === "code_comment" && entry.ok === true) acceptedCodeCommentCalls++;
    if (entry.type === "llm_response" && typeof entry.content === "string" && /\S/u.test(entry.content) && Array.isArray(entry.tool_calls)) {
      const toolNames = entry.tool_calls.map((tool) => object(tool)?.name);
      // 只证明该轮完成时有可见文本且未同轮提交建议。该文本也可能是正常的零问题结论。
      if (toolNames.includes("task_done") && !toolNames.includes("code_comment")) {
        unsubmittedTextCompletions++;
        if (captured && captured.length < MAX_COMPLETION_TEXTS) captured.push(entry.content);
      }
    }
  }
  if (start !== text.length || lastType !== "session_end") return unavailable("incomplete");
  return { session: "complete", acceptedCodeCommentCalls, unsubmittedTextCompletions };
}
