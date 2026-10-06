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

/** 需要读取的默认 Markdown prompt（无 YAML 规则时的最后兜底）。 */
interface LoadOptions {
  /** 规则目录路径。 */
  dir: string;
  /** 兜底 system prompt 全文（通常是 prompts/review.md）。 */
  fallbackSystemPrompt: string;
  /** 日志记录器，缺省静默。 */
  logger?: Logger;
}

/**
 * 加载规则目录并构造匹配器。
 *
 * 规则目录下的 `default.yaml` 是全局默认；其余 `.yaml`/`.yml` 文件必须带
 * `repository:` 字段（GitLab 项目全名），缺失的文件被跳过并记 warn，避免一个
 * 笔误让整个目录不可用。匹配优先级：仓库规则 > default.yaml > Markdown 兜底。
 */
export async function loadReviewRules(
  dir: string,
  fallbackSystemPrompt: string,
  logger: Logger = createSilentLogger(),
): Promise<ReviewRules> {
  const repositoryRules = new Map<string, RuleSet>();
  let defaultRule: RuleSet | undefined;
  try {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".yaml") && !entry.name.endsWith(".yml")) continue;
      const parsed = await loadRuleFile(join(dir, entry.name));
      if (!parsed) continue;
      if (entry.name.startsWith("default.")) {
        defaultRule = parsed.rule;
        continue;
      }
      if (!parsed.repository) {
        logger.warn("规则文件缺少 repository 字段，已跳过", { file: entry.name });
        continue;
      }
      repositoryRules.set(normalizeRepositoryKey(parsed.repository), parsed.rule);
    }
  } catch {
    // 目录不存在或不可读：走兜底链，由调用方的 prompt 兜底继续工作。
    logger.warn("规则目录不可读，使用 Markdown 兜底 prompt", { dir });
  }

  return {
    resolve(repositoryFullName?: string): RuleSet {
      if (repositoryFullName) {
        const matched = repositoryRules.get(normalizeRepositoryKey(repositoryFullName));
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
): Promise<{ repository?: string; rule: RuleSet } | null> {
  const parsed = parseYaml(await readFile(path, "utf8")) as unknown;
  if (typeof parsed !== "object" || parsed === null) return null;
  const root = parsed as Record<string, unknown>;
  const prompt = root.code_review_prompt;
  if (typeof prompt !== "object" || prompt === null) return null;
  const block = prompt as Record<string, unknown>;
  const systemPrompt = readString(block, "system_prompt");
  const userPrompt = readString(block, "user_prompt");
  if (!systemPrompt || !userPrompt) return null;
  return { repository: readString(root, "repository") || undefined, rule: { systemPrompt, userPrompt } };
}

/** 归一化仓库键：去掉首尾空白与大小写差异，让斜杠路径匹配稳定。 */
function normalizeRepositoryKey(value: string): string {
  return value.trim();
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
