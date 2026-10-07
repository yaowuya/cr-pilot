/**
 * 评审规则的领域模型与纯逻辑。
 *
 * `RuleSet` 是规则解析结果；`normalizeRepositoryKey` / `shortRepositoryName` /
 * `renderStyleTemplate` / `renderUserPrompt` / `stripMarkdownFences` 全部为纯函数，
 * 不触碰文件系统。规则目录的实际读取由 infrastructure/rules 完成。
 */

/** 一套可用的评审规则：system prompt 与带占位符的 user prompt 模板。 */
export interface RuleSet {
  /** 作为 pi system prompt 的全文。 */
  systemPrompt: string;
  /** 含 `{diffs_text}` / `{commits_text}` 占位符的模板。 */
  userPrompt: string;
  /** 企业微信群机器人 webhook URL；缺失表示该仓库不推送企微。 */
  wecomWebhookUrl?: string;
  /** 企微推送评分阈值：总分低于该值才推送；缺失表示不按分数过滤。 */
  wecomScoreThreshold?: number;
}

/** 目录级规则集：按 GitLab 项目全名匹配仓库规则，逐级回落到默认。 */
export interface ReviewRules {
  resolve(repositoryFullName?: string): RuleSet;
}

/**
 * 解析评审文本中的总分（纯函数）。
 *
 * 与参考项目 `parse_review_score` 对齐：匹配 `总分[:：]<空格><数字>分?` 的所有出现，
 * 取最小值（多批评审拼接后可能出现多个总分，最低分最保守）。无匹配返回 0，
 * 由调用方决定是否跳过按分数的推送。
 */
export function parseReviewScore(reviewText: string): number {
  const matches = reviewText.matchAll(/总分[:：]\s*(\d+)\s*分?/g);
  let lowest: number | undefined;
  for (const match of matches) {
    const score = Number(match[1]);
    if (lowest === undefined || score < lowest) lowest = score;
  }
  return lowest ?? 0;
}

/**
 * 按评分阈值决定是否推送企微消息（纯函数）。
 *
 * 语义与规则注释、参考项目一致：总分**低于**阈值才推送（低分提醒关注）；
 * 阈值为 undefined 时不按分数过滤（始终推送）。分数缺失（0）且配置了阈值时
 * 视为低分推送，保证「没解析出分数」不会被静默吞掉。
 */
export function shouldNotifyByScore(score: number, threshold: number | undefined): boolean {
  if (threshold === undefined) return true;
  return score < threshold;
}

/** 归一化仓库键：去空白并转小写，让斜杠路径与短项目名匹配都稳定。 */
export function normalizeRepositoryKey(value: string): string {
  return value.trim().toLowerCase();
}

/** 从项目全名取短项目名：`namespace/project` → `project`；无斜杠时原样返回。 */
export function shortRepositoryName(fullName: string): string {
  const index = fullName.lastIndexOf("/");
  return index >= 0 ? fullName.slice(index + 1) : fullName;
}

/**
 * 渲染规则模板里的最小 Jinja2 子集：`{{ style }}` 变量与
 * `{% if style == '...' %} / {% elif style == '...' %} / {% else %} / {% endif %}`
 * 风格分支。迁移自参考项目的规则模板只使用这两个构造，因此不引入完整模板引擎。
 */
export function renderStyleTemplate(template: string, style: string): string {
  const withVariable = template.replace(/\{\{\s*style\s*\}\}/g, style);
  return withVariable.replace(
    /\{%\s*if\s+style\s*==\s*['"]([^'"]+)['"]\s*%\}([\s\S]*?)\{%\s*endif\s*%\}/g,
    (_all, firstStyle: string, inner: string) => selectStyleBranch(inner, style, firstStyle),
  );
}

/** 在 if 分支体里选第一个命中的分支；`{% else %}` 或全部不命中时返回空串。 */
function selectStyleBranch(inner: string, style: string, firstStyle: string): string {
  // 按 elif 切段：奇数位是分支风格名，偶数位是分支内容（首段内容在 index 0）。
  const elifSplit = inner.split(/\{%\s*elif\s+style\s*==\s*['"]([^'"]+)['"]\s*%\}/);
  const segments: Array<{ expected: string; body: string }> = [
    { expected: firstStyle, body: elifSplit[0] },
  ];
  for (let i = 1; i < elifSplit.length; i += 2) {
    segments.push({ expected: elifSplit[i], body: elifSplit[i + 1] });
  }
  // 最后一段可能还带 {% else %}。
  const last = segments[segments.length - 1];
  const elseSplit = last.body.split(/\{%\s*else\s*%\}/);
  if (elseSplit.length > 1) {
    segments[segments.length - 1] = { expected: last.expected, body: elseSplit[0] };
    segments.push({ expected: "*", body: elseSplit.slice(1).join("") });
  }
  for (const segment of segments) {
    if (segment.expected === "*" || segment.expected.toLowerCase() === style.toLowerCase()) {
      return segment.body;
    }
  }
  return "";
}

/**
 * 渲染 user prompt 模板。
 *
 * 只替换 `{diffs_text}` 与 `{commits_text}` 两个占位符；未知占位符原样保留，
 * 让模板里的笔误在评审结果中可见而不是被静默吞掉。
 */
export function renderUserPrompt(
  template: string,
  vars: { diffsText: string; commitsText: string },
): string {
  return template
    .replaceAll("{diffs_text}", vars.diffsText)
    .replaceAll("{commits_text}", vars.commitsText);
}

/**
 * 去掉模型偶尔输出的 ```markdown / ``` 代码块包裹。
 *
 * GitLab 会把代码块包裹的正文渲染成代码块而不是 Markdown，参考项目的
 * `_strip_markdown` 有同样的清理逻辑。只有首尾成对出现围栏时才剥离；
 * 输出本身是纯 Markdown 时原样返回。
 */
export function stripMarkdownFences(text: string): string {
  const trimmed = text.trim();
  const opening = trimmed.match(/^```(?:markdown|md)?\s*(?:\r?\n|$)/);
  if (!opening) return trimmed;
  const inner = trimmed.slice(opening[0].length);
  const closing = inner.lastIndexOf("```");
  return closing >= 0 ? inner.slice(0, closing).trim() : inner.trim();
}
