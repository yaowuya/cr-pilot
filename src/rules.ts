import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { createSilentLogger, type Logger } from "./logger.ts";

/** 一套可用的评审规则：system prompt 与带占位符的 user prompt 模板。 */
export interface RuleSet {
  /** 作为 pi system prompt 的全文。 */
  systemPrompt: string;
  /** 含 `{diffs_text}` / `{commits_text}` 占位符的模板。 */
  userPrompt: string;
}

/** 目录级规则集：按 GitLab 项目全名匹配仓库规则，逐级回落到默认。 */
export interface ReviewRules {
  resolve(repositoryFullName?: string): RuleSet;
}

/** 内置默认 user prompt 模板，用于连 default.yaml 都没有的场景。 */
const FALLBACK_USER_PROMPT = "请评审以下代码变更：\n{diffs_text}\n\n提交历史：\n{commits_text}";

/** 加载选项：日志器与评审风格。 */
interface LoadOptions {
  /** 日志记录器，缺省静默。 */
  logger?: Logger;
  /** 评审风格，注入规则模板的 `{{ style }}` 与风格分支。 */
  style?: string;
}

/**
 * 加载规则目录并构造匹配器。
 *
 * 规则目录下的 `default.yaml` 是全局默认；其余 `.yaml`/`.yml` 文件必须带
 * `repository:` 字段，支持逗号分隔多个仓库（每个键指向同一份规则）。匹配规则
 * 对齐参考项目：先按项目全名、再按短项目名（最后一个 `/` 之后的部分）查找，
 * 大小写不敏感。缺失 `repository:` 的文件被跳过并记 warn，避免一个笔误让整个
 * 目录不可用。匹配优先级：仓库规则 > default.yaml > Markdown 兜底。
 *
 * 规则文件里的 prompt 是 Jinja2 模板（`{{ style }}` 与 `{% if style == ... %}`
 * 风格分支），加载时按 `options.style` 渲染成纯文本。
 */
export async function loadReviewRules(
  dir: string,
  fallbackSystemPrompt: string,
  options: LoadOptions = {},
): Promise<ReviewRules> {
  const logger = options.logger ?? createSilentLogger();
  const style = options.style ?? "professional";
  const repositoryRules = new Map<string, RuleSet>();
  let defaultRule: RuleSet | undefined;
  try {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".yaml") && !entry.name.endsWith(".yml")) continue;
      const parsed = await loadRuleFile(join(dir, entry.name), style);
      if (!parsed) continue;
      if (entry.name.startsWith("default.")) {
        defaultRule = parsed.rule;
        continue;
      }
      if (!parsed.repository) {
        logger.warn("规则文件缺少 repository 字段，已跳过", { file: entry.name });
        continue;
      }
      for (const key of parsed.repository.split(",")) {
        const normalized = normalizeRepositoryKey(key);
        if (!normalized) continue;
        if (repositoryRules.has(normalized)) {
          logger.warn("规则文件存在重复的 repository 键，后加载者覆盖", { file: entry.name, key });
        }
        repositoryRules.set(normalized, parsed.rule);
      }
    }
  } catch {
    // 目录不存在或不可读：走兜底链，由调用方的 prompt 兜底继续工作。
    logger.warn("规则目录不可读，使用 Markdown 兜底 prompt", { dir });
  }

  return {
    resolve(repositoryFullName?: string): RuleSet {
      if (repositoryFullName) {
        const matched = repositoryRules.get(normalizeRepositoryKey(repositoryFullName))
          ?? repositoryRules.get(normalizeRepositoryKey(shortRepositoryName(repositoryFullName)));
        if (matched) return matched;
      }
      if (defaultRule) return defaultRule;
      return { systemPrompt: fallbackSystemPrompt, userPrompt: FALLBACK_USER_PROMPT };
    },
  };
}

/** 解析单个规则文件；结构非法或缺失 code_review_prompt 时返回 null。 */
async function loadRuleFile(
  path: string,
  style: string,
): Promise<{ repository?: string; rule: RuleSet } | null> {
  const parsed = parseYaml(await readFile(path, "utf8")) as unknown;
  if (typeof parsed !== "object" || parsed === null) return null;
  const root = parsed as Record<string, unknown>;
  const prompt = root.code_review_prompt;
  if (typeof prompt !== "object" || prompt === null) return null;
  const block = prompt as Record<string, unknown>;
  const systemPrompt = renderStyleTemplate(readString(block, "system_prompt"), style);
  const userPrompt = renderStyleTemplate(readString(block, "user_prompt"), style);
  if (!systemPrompt || !userPrompt) return null;
  return { repository: readString(root, "repository") || undefined, rule: { systemPrompt, userPrompt } };
}

/** 归一化仓库键：去空白并转小写，让斜杠路径与短项目名匹配都稳定。 */
function normalizeRepositoryKey(value: string): string {
  return value.trim().toLowerCase();
}

/** 从项目全名取短项目名：`namespace/project` → `project`；无斜杠时原样返回。 */
function shortRepositoryName(fullName: string): string {
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

/** 读取字符串字段并去空白；非字符串一律按缺失处理。 */
function readString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  return typeof value === "string" ? value.trim() : "";
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
