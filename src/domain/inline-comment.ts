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

/**
 * 按 `lineKey` 与行号从 diff 中取出被评论行的文本（零 IO 纯函数）。
 *
 * 采纳追踪需要为「AI 评论的那一行」建指纹，而行内评论的锚点只是行号。
 * 从 diff 里还原该行文本比再调一次文件接口更省事，也不会因评审期间的新提交
 * 而取到不同内容。取不到时返回 `null`，由调用方把指纹留空（计为不可追踪）。
 */
export function readDiffLine(diff: string, lineKey: "new_line" | "old_line", line: number): string | null {
  let oldLine: number | undefined;
  let newLine: number | undefined;
  for (const raw of diff.split("\n")) {
    const hunk = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      continue;
    }
    if (oldLine === undefined || newLine === undefined) continue;
    if (raw.startsWith("+++") || raw.startsWith("---")) continue;
    const isAdded = raw.startsWith("+");
    const isRemoved = raw.startsWith("-");
    // 目标侧匹配：新增行看新行号，删除行看旧行号，context 行两侧都可命中。
    if (!isRemoved && lineKey === "new_line" && newLine === line) return raw.slice(1);
    if (!isAdded && lineKey === "old_line" && oldLine === line) return raw.slice(1);
    if (isAdded) newLine += 1;
    else if (isRemoved) oldLine += 1;
    else {
      oldLine += 1;
      newLine += 1;
    }
  }
  return null;
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

/**
 * 从纯 Markdown 评审正文里反推可定位的 findings（零 IO 纯函数）。
 *
 * 为什么需要这条兜底：行内评论依赖模型输出结构化 JSON 块，而那个要求写在
 * prompt 里。仓库级 prompt 是运维各自维护的（且 gitignored），很容易漏掉
 * 「行内评论定位块」这段——一旦漏了，模型只输出 Markdown，行内评论全部
 * 降级进汇总评论，功能等于失效。
 *
 * 因此这里从 Markdown 里再解析一次：评审正文的问题条目本来就要写
 * `位置：文件路径:行号`，信息是齐的，只是格式不固定。
 *
 * 只作为 JSON 解析失败时的补充，不做替代：JSON 是显式契约、字段更可靠；
 * 正则是启发式，能捞多少算多少，捞不到的仍然留在汇总评论里不丢失。
 *
 * 识别的形态（对齐 prompt 对「位置」的要求）：
 * - `- 位置： apps/x/y.py:429-434`（列表项 + 全角冒号 + 反引号可选）
 * - `**位置**： \`apps/x/y.py:22\``
 * - `位置: app.py:10`（半角冒号）
 */
export function parseFindingsFromMarkdown(
  text: string,
  options: { headSha?: string } = {},
): ParsedReview | null {
  const lines = text.split("\n");
  const findings: ParsedFinding[] = [];
  // severity 从问题标题里取：`P0：xxx` / `### P1: xxx` / `**P2**：xxx`
  let currentSeverity = "medium";
  // 最近一次出现的「位置」所属的问题标题，用于给 finding 起可读的 body。
  let currentTitle = "";
  const usedIds = new Set<string>();

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index] ?? "";
    const line = rawLine.trim();

    // 标题/条目行：更新当前问题标题与严重级别。
    const heading = /^(?:#{1,6}\s*)?(?:[-*]\s+)?\*{0,2}P([0-3])\*{0,2}\s*[:：]\s*(.+)$/i.exec(line);
    if (heading) {
      currentSeverity = severityFromLevel(Number(heading[1]));
      currentTitle = heading[2].trim();
      continue;
    }
    // 没有 P 级标记但像标题的行（### xxx），也记下来便于 body 可读。
    const plainHeading = /^#{1,6}\s+(.+)$/.exec(line);
    if (plainHeading) {
      currentTitle = plainHeading[1].trim();
      continue;
    }

    const location = parseLocation(line);
    if (!location) continue;

    // 同一位置只取第一条：正文里常先出现在摘要、再出现在详情，重复没意义。
    const key = `${location.path}:${location.lineKey}:${location.line}`;
    if (usedIds.has(key)) continue;
    usedIds.add(key);

    // id 用位置派生：同一位置重跑得到同一 marker，发布幂等。
    const id = `md_${hashKey(key)}`;
    findings.push({
      id,
      severity: currentSeverity,
      path: location.path,
      body: buildMarkdownFindingBody(currentTitle, lines, index),
      lineKey: location.lineKey,
      line: location.line,
    });
  }

  if (findings.length === 0) return null;
  return {
    // head_sha 由调用方注入（Markdown 里没有这个信息），用于幂等 marker。
    reviewedHeadSha: options.headSha ?? "",
    summaryBody: "",
    findings,
  };
}

/** 把 P0~P3 映射到 schema 的 severity 枚举。 */
function severityFromLevel(level: number): string {
  // schema 只有 critical/high/medium/low/info 五档，此外一律 medium。
  if (level === 0) return "critical";
  if (level === 1) return "high";
  if (level === 2) return "medium";
  return "low";
}

/**
 * 从一行里解析「位置」。
 *
 * 行号支持 `:10` 与 `:429-434`（区间取起始行，因为 GitLab 的 position 只要锚点）。
 * 删除行用 old_line 的语义在这里无法从文本判断，统一按新增行处理——
 * 校验阶段会检查该行是否落在 diff 的新增行集合里，不满足就降级，不会误发。
 */
function parseLocation(line: string): { path: string; line: number; lineKey: "new_line" | "old_line" } | null {
  // 匹配 `位置`（可带加粗/冒号变体）后跟 路径:行号，路径可被反引号包裹
  const match = /(?:^|[-*]\s*)\*{0,2}位置\*{0,2}\s*[:：]\s*`?([^\s`]+?):(\d+)(?:-(\d+))?`?\s*$/i.exec(line);
  if (!match) return null;
  const path = match[1] ?? "";
  const lineNo = Number(match[2]);
  // 只接受看起来像文件路径的值：排除「函数/类名」这类非路径写法
  if (!path || !path.includes("/") && !path.includes(".")) return null;
  if (!Number.isInteger(lineNo) || lineNo <= 0) return null;
  return { path, line: lineNo, lineKey: "new_line" };
}

/** 用问题标题作为 finding 正文，后接问题描述的前几行，便于在行内评论里读懂。 */
function buildMarkdownFindingBody(title: string, lines: string[], locationIndex: number): string {
  const parts: string[] = [];
  if (title) parts.push(`**${title}**`);
  // 取「位置」之后、下一个分隔符之前的若干行作为说明（跳过列表标记与空行）。
  const collected: string[] = [];
  for (let i = locationIndex + 1; i < lines.length && collected.length < 12; i += 1) {
    const text = (lines[i] ?? "").trim();
    if (!text) {
      if (collected.length > 0) break;
      continue;
    }
    if (/^(?:---+|\*\*\*+)$/.test(text)) break;
    if (/^[-*]\s+\*{0,2}(?:位置|问题|建议)/.test(text)) break;
    collected.push(text);
  }
  if (collected.length > 0) parts.push(collected.join("\n"));
  return parts.join("\n\n") || "（详见汇总评论）";
}

/** 稳定的短哈希：同一位置每次得到相同 id，保证 marker 幂等。 */
function hashKey(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}
