/**
 * 评审 prompt 仓储：基于 `node:sqlite` 的同步实现。
 *
 * yaml 导入复用 `infrastructure/rules` 的解析逻辑，保证「文件导入」与
 * 「启动时读目录」对同一份 yaml 得到完全一致的 prompt 与企微配置。
 */
import type { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeRepositoryKey } from "../../domain/review-rules.ts";
import type { PromptRepository, PromptSummary, StoredPrompt } from "../../domain/review-prompt.ts";
import { parseRuleFileContent } from "../rules/review-rules.ts";

/** 全局默认 prompt 的保留 repository 值，与 default.yaml 的语义对齐。 */
export const DEFAULT_PROMPT_REPOSITORY = "default";

interface PromptRow {
  id: number;
  repository: string;
  system_prompt: string;
  user_prompt: string;
  wecom_webhook_url: string | null;
  wecom_score_threshold: number | null;
  updated_at: number;
}

/** 行转完整记录；可空字段用 undefined 表达「未配置」而非空串。 */
function toPrompt(row: PromptRow): StoredPrompt {
  return {
    id: row.id,
    repository: row.repository,
    systemPrompt: row.system_prompt,
    userPrompt: row.user_prompt,
    wecomWebhookUrl: row.wecom_webhook_url ?? undefined,
    wecomScoreThreshold: row.wecom_score_threshold ?? undefined,
    updatedAt: row.updated_at,
  };
}

/** 行转列表摘要：不含正文。 */
function toSummary(row: PromptRow): PromptSummary {
  return {
    id: row.id,
    repository: row.repository,
    hasWecomWebhook: Boolean(row.wecom_webhook_url),
    wecomScoreThreshold: row.wecom_score_threshold ?? undefined,
    updatedAt: row.updated_at,
  };
}

/** 判断是否为 repository 唯一约束冲突。 */
function isUniqueViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /UNIQUE constraint failed: review_prompts\.repository/i.test(message);
}

/** 创建评审 prompt 仓储。 */
export function createPromptRepository(db: DatabaseSync): PromptRepository {
  /** 按 repository 精确查询（内部复用，避免重复拼 SQL）。 */
  const selectByRepository = (repository: string): StoredPrompt | undefined => {
    const row = db.prepare("SELECT * FROM review_prompts WHERE repository = ?").get(repository) as unknown as PromptRow | undefined;
    return row ? toPrompt(row) : undefined;
  };

  const insert = (input: {
    repository: string;
    systemPrompt: string;
    userPrompt: string;
    wecomWebhookUrl?: string;
    wecomScoreThreshold?: number;
  }): StoredPrompt => {
    const now = Date.now();
    const result = db
      .prepare(
        `INSERT INTO review_prompts
           (repository, system_prompt, user_prompt, wecom_webhook_url, wecom_score_threshold, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.repository,
        input.systemPrompt,
        input.userPrompt,
        input.wecomWebhookUrl ?? null,
        input.wecomScoreThreshold ?? null,
        now,
      );
    return {
      id: Number(result.lastInsertRowid),
      repository: input.repository,
      systemPrompt: input.systemPrompt,
      userPrompt: input.userPrompt,
      wecomWebhookUrl: input.wecomWebhookUrl,
      wecomScoreThreshold: input.wecomScoreThreshold,
      updatedAt: now,
    };
  };

  return {
    resolve(repositoryFullName) {
      if (repositoryFullName) {
        const normalized = normalizeRepositoryKey(repositoryFullName);
        // 逐行比较归一化后的键：库里存的是原始全名，归一化在读取侧完成，
        // 这样页面展示保留用户输入的大小写，而匹配仍然大小写不敏感。
        const rows = db.prepare("SELECT * FROM review_prompts").all() as unknown as PromptRow[];
        const matched = rows.find((row) => row.repository !== DEFAULT_PROMPT_REPOSITORY && normalizeRepositoryKey(row.repository) === normalized);
        if (matched) return toPrompt(matched);
      }
      return selectByRepository(DEFAULT_PROMPT_REPOSITORY);
    },

    list() {
      const rows = db.prepare("SELECT * FROM review_prompts ORDER BY repository ASC").all() as unknown as PromptRow[];
      return rows.map(toSummary);
    },

    get(id) {
      const row = db.prepare("SELECT * FROM review_prompts WHERE id = ?").get(id) as unknown as PromptRow | undefined;
      return row ? toPrompt(row) : undefined;
    },

    findByRepository(repository) {
      return selectByRepository(repository);
    },

    create(input) {
      const repository = input.repository.trim();
      try {
        return insert({ ...input, repository });
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new Error(`prompt ${repository} 已存在`);
        }
        throw error;
      }
    },

    update(id, input) {
      const now = Date.now();
      db.prepare(
        `UPDATE review_prompts
            SET system_prompt = ?, user_prompt = ?, wecom_webhook_url = ?, wecom_score_threshold = ?, updated_at = ?
          WHERE id = ?`,
      ).run(input.systemPrompt, input.userPrompt, input.wecomWebhookUrl ?? null, input.wecomScoreThreshold ?? null, now, id);
      const updated = this.get(id);
      if (!updated) throw new Error(`prompt ${id} 不存在`);
      return updated;
    },

    remove(id) {
      // 删除即删（D-015）：被删项目在 resolve 时自然回落到 default。
      db.prepare("DELETE FROM review_prompts WHERE id = ?").run(id);
    },

    importFromDir(dir) {
      // 用同步文件 API：本方法是同步签名，且导入是运维一次性动作，
      // 与仓储其余同步方法保持一致，避免在同步接口里塞 Promise。
      let entries: string[];
      try {
        entries = readdirSync(dir).filter((name) => name.endsWith(".yaml") || name.endsWith(".yml"));
      } catch {
        // 目录不存在或不可读：按「无可导入内容」处理，与启动时规则目录
        // 不可读的降级语义一致。
        return { imported: 0, skipped: 0 };
      }
      let imported = 0;
      let skipped = 0;
      for (const name of entries) {
        let content = "";
        try {
          content = readFileSync(join(dir, name), "utf8");
        } catch {
          skipped += 1;
          continue;
        }
        let parsed;
        try {
          // 单个文件的 YAML 非法只跳过该文件：readdirSync 顺序不定，若让解析
          // 异常向上抛，前面已成功导入的文件既无法回滚、{imported, skipped}
          // 也永远拿不到，接口只能返回 500 且不可重试。
          parsed = parseRuleFileContent(content, "professional");
        } catch {
          skipped += 1;
          continue;
        }
        if (!parsed) {
          skipped += 1;
          continue;
        }
        // default.yaml 映射为保留值 "default"，其余用文件里的 repository；
        // 缺少 repository 的非 default 文件按现有语义跳过。
        const repository = name.startsWith("default.") ? DEFAULT_PROMPT_REPOSITORY : parsed.repository;
        if (!repository) {
          skipped += 1;
          continue;
        }
        if (selectByRepository(repository)) {
          skipped += 1;
          continue;
        }
        insert({
          repository,
          systemPrompt: parsed.rule.systemPrompt,
          userPrompt: parsed.rule.userPrompt,
          wecomWebhookUrl: parsed.rule.wecomWebhookUrl,
          wecomScoreThreshold: parsed.rule.wecomScoreThreshold,
        });
        imported += 1;
      }
      return { imported, skipped };
    },
  };
}
