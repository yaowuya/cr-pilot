import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { createSilentLogger, type Logger } from "../../shared/logger.ts";
import {
  normalizeRepositoryKey,
  renderStyleTemplate,
  shortRepositoryName,
  type ReviewRules,
  type RuleSet,
} from "../../domain/review-rules.ts";

// 领域纯逻辑与类型由 domain 持有，这里重导出保持既有导入路径兼容。
export {
  normalizeRepositoryKey,
  renderStyleTemplate,
  renderUserPrompt,
  shortRepositoryName,
  stripMarkdownFences,
  type ReviewRules,
  type RuleSet,
} from "../../domain/review-rules.ts";

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
 * 加载规则目录并构造匹配器（基础设施实现：负责文件系统 IO）。
 *
 * 规则目录下的 `default.yaml` 是全局默认；其余 `.yaml`/`.yml` 文件必须带
 * `repository:` 字段，支持逗号分隔多个仓库（每个键指向同一份规则）。匹配规则
 * 对齐参考项目：先按项目全名、再按短项目名（最后一个 `/` 之后的部分）查找，
 * 大小写不敏感。缺失 `repository:` 的文件被跳过并记 warn，避免一个笔误让整个
 * 目录不可用。匹配优先级：仓库规则 > default.yaml > Markdown 兜底。
 *
 * 规则文件里的 prompt 是 Jinja2 模板（`{{ style }}` 与 `{% if style == ... %}`
 * 风格分支），加载时按 `options.style` 渲染成纯文本（渲染逻辑在 domain）。
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
        if (matched) {
          // wecom 字段逐级继承：仓库规则缺失时回落到 default（与参考项目一致）。
          return {
            ...matched,
            wecomWebhookUrl: matched.wecomWebhookUrl ?? defaultRule?.wecomWebhookUrl,
            wecomScoreThreshold: matched.wecomScoreThreshold ?? defaultRule?.wecomScoreThreshold,
          };
        }
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
  return parseRuleFileContent(await readFile(path, "utf8"), style);
}

/**
 * 解析规则文件内容（导出给 prompt 导入复用）。
 *
 * 抽成内容级函数而不是文件级：数据库导入需要同时支持文件与内存内容，
 * 且两处必须用同一套解析与渲染逻辑，否则导入结果会与启动时读目录不一致。
 * `style` 用于渲染 Jinja 风格分支；导入时用默认风格，因为数据库存的是渲染后的
 * 最终文本，风格切换不会重跑（见 `review-rules.ts` 的渲染说明）。
 */
export function parseRuleFileContent(
  content: string,
  style: string,
): { repository?: string; rule: RuleSet } | null {
  const parsed = parseYaml(content) as unknown;
  if (typeof parsed !== "object" || parsed === null) return null;
  const root = parsed as Record<string, unknown>;
  const prompt = root.code_review_prompt;
  if (typeof prompt !== "object" || prompt === null) return null;
  const block = prompt as Record<string, unknown>;
  const systemPrompt = renderStyleTemplate(readString(block, "system_prompt"), style);
  const userPrompt = renderStyleTemplate(readString(block, "user_prompt"), style);
  if (!systemPrompt || !userPrompt) return null;
  return {
    repository: readString(root, "repository") || undefined,
    rule: {
      systemPrompt,
      userPrompt,
      wecomWebhookUrl: readString(root, "wecom_webhook_url") || undefined,
      wecomScoreThreshold: readNumber(root, "wecom_score_threshold"),
    },
  };
}

/** 读取非负整数；缺失或非法返回 undefined（调用方按「未配置」处理）。 */
function readNumber(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key];
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return undefined;
}

/** 读取字符串字段并去空白；非字符串一律按缺失处理。 */
function readString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  return typeof value === "string" ? value.trim() : "";
}
