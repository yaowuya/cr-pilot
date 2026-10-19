/**
 * 评审 prompt 仓储：基于 `node:sqlite` 的同步实现。
 *
 * yaml 导入复用 `infrastructure/rules` 的解析逻辑，保证「文件导入」与
 * 「启动时读目录」对同一份 yaml 得到完全一致的 prompt 与企微配置。
 *
 * 多项目关联（D-020）：`review_prompts` 存 prompt 本体，`prompt_projects` 存
 * 「prompt ↔ 项目」多对多关系。匹配时先查关联表，未命中再回落 default。
 */
import type { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeRepositoryKey } from "../../domain/review-rules.ts";
import type {
  PromptInput,
  PromptRepository,
  PromptSummary,
  StoredPrompt,
} from "../../domain/review-prompt.ts";
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
  provider_id: number | null;
  model: string | null;
  updated_at: number;
}

/** 把字符串数组规范化为去空、去重、保序的列表。 */
function normalizeProjects(projects: readonly string[] | undefined): string[] {
  if (!projects) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of projects) {
    const value = raw.trim();
    if (!value) continue;
    // 大小写不敏感去重：GitLab 项目名匹配本身不区分大小写，
    // 同一项目存成两种大小写只会让下拉出现重复项。
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

/** 判断是否为 repository 唯一约束冲突。 */
function isUniqueViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /UNIQUE constraint failed: review_prompts\.repository/i.test(message);
}

/** 创建评审 prompt 仓储。 */
export function createPromptRepository(db: DatabaseSync): PromptRepository {
  /** 读某 prompt 关联的项目列表。 */
  const readProjects = (promptId: number): string[] => {
    const rows = db
      .prepare("SELECT project FROM prompt_projects WHERE prompt_id = ? ORDER BY project ASC")
      .all(promptId) as unknown as Array<{ project: string }>;
    return rows.map((row) => row.project);
  };

  /** 覆盖式写入关联表：先删后插，保证与提交的列表完全一致。 */
  const writeProjects = (promptId: number, projects: readonly string[] | undefined): void => {
    db.prepare("DELETE FROM prompt_projects WHERE prompt_id = ?").run(promptId);
    const insert = db.prepare("INSERT INTO prompt_projects (prompt_id, project) VALUES (?, ?)");
    for (const project of normalizeProjects(projects)) {
      insert.run(promptId, project);
    }
  };

  /** 行转完整记录；可空字段用 undefined 表达「未配置」而非空串。 */
  const toPrompt = (row: PromptRow): StoredPrompt => ({
    id: row.id,
    repository: row.repository,
    projects: readProjects(row.id),
    systemPrompt: row.system_prompt,
    userPrompt: row.user_prompt,
    wecomWebhookUrl: row.wecom_webhook_url ?? undefined,
    wecomScoreThreshold: row.wecom_score_threshold ?? undefined,
    providerId: row.provider_id ?? undefined,
    model: row.model ?? undefined,
    updatedAt: row.updated_at,
  });

  /** 行转列表摘要：不含正文。 */
  const toSummary = (row: PromptRow): PromptSummary => ({
    id: row.id,
    repository: row.repository,
    projects: readProjects(row.id),
    hasWecomWebhook: Boolean(row.wecom_webhook_url),
    wecomScoreThreshold: row.wecom_score_threshold ?? undefined,
    providerId: row.provider_id ?? undefined,
    providerLabel: row.provider_id === null ? undefined : readProviderLabel(row.provider_id),
    model: row.model ?? undefined,
    updatedAt: row.updated_at,
  });

  /** 取厂商展示名；厂商已被删除时返回 undefined（页面显示「已删除」）。 */
  const readProviderLabel = (providerId: number): string | undefined => {
    const row = db.prepare("SELECT label FROM llm_providers WHERE id = ?").get(providerId) as
      | { label: string }
      | undefined;
    return row?.label;
  };

  /** 按 repository 精确查询（内部复用，避免重复拼 SQL）。 */
  const selectByRepository = (repository: string): StoredPrompt | undefined => {
    const row = db.prepare("SELECT * FROM review_prompts WHERE repository = ?").get(repository) as unknown as
      | PromptRow
      | undefined;
    return row ? toPrompt(row) : undefined;
  };

  /** 插入本体与关联项目，返回完整记录。 */
  const insert = (input: PromptInput): StoredPrompt => {
    const now = Date.now();
    const result = db
      .prepare(
        `INSERT INTO review_prompts
           (repository, system_prompt, user_prompt, wecom_webhook_url, wecom_score_threshold, provider_id, model, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.repository,
        input.systemPrompt,
        input.userPrompt,
        input.wecomWebhookUrl ?? null,
        input.wecomScoreThreshold ?? null,
        input.providerId ?? null,
        input.model ?? null,
        now,
      );
    const id = Number(result.lastInsertRowid);
    writeProjects(id, input.projects);
    return {
      id,
      repository: input.repository,
      projects: readProjects(id),
      systemPrompt: input.systemPrompt,
      userPrompt: input.userPrompt,
      wecomWebhookUrl: input.wecomWebhookUrl,
      wecomScoreThreshold: input.wecomScoreThreshold,
      providerId: input.providerId,
      model: input.model,
      updatedAt: now,
    };
  };

  return {
    resolve(repositoryFullName) {
      if (repositoryFullName) {
        const normalized = normalizeRepositoryKey(repositoryFullName);
        // 先按关联表匹配：多对多关系下一条 prompt 可能覆盖多个项目。
        // 归一化在读取侧完成，库里保留用户输入的大小写。
        const rows = db
          .prepare(
            `SELECT p.* FROM review_prompts p
               JOIN prompt_projects pp ON pp.prompt_id = p.id
              WHERE pp.project = ? COLLATE NOCASE
              LIMIT 1`,
          )
          .get(repositoryFullName.trim()) as unknown as PromptRow | undefined;
        if (rows) return toPrompt(rows);

        // 兼容旧数据与短项目名：`namespace/project` 与 `project` 都能命中。
        // 关联表按全名存储，这里再用归一化后的键做一次宽松匹配。
        const candidates = db
          .prepare(
            `SELECT p.*, pp.project AS matched_project FROM review_prompts p
               JOIN prompt_projects pp ON pp.prompt_id = p.id`,
          )
          .all() as unknown as Array<PromptRow & { matched_project: string }>;
        const loose = candidates.find((row) => {
          const stored = normalizeRepositoryKey(row.matched_project);
          return stored === normalized || stored.endsWith(`/${normalized}`) || normalized.endsWith(`/${stored}`);
        });
        if (loose) return toPrompt(loose);
      }
      return selectByRepository(DEFAULT_PROMPT_REPOSITORY);
    },

    list() {
      const rows = db.prepare("SELECT * FROM review_prompts ORDER BY repository ASC").all() as unknown as PromptRow[];
      return rows.map(toSummary);
    },

    get(id) {
      const row = db.prepare("SELECT * FROM review_prompts WHERE id = ?").get(id) as unknown as
        | PromptRow
        | undefined;
      return row ? toPrompt(row) : undefined;
    },

    findByRepository(repository) {
      return selectByRepository(repository);
    },

    create(input) {
      const repository = input.repository.trim();
      // projects 三态语义：
      // - 未传（undefined）→ 默认关联到同名项目，兼容「一个 prompt 就是一个项目」
      //   的老用法与直接调用仓储的脚本；
      // - 显式空数组 → 不关联任何项目（用户在页面上删光了）；
      // - default 是全局兜底，永远不关联项目。
      const projects =
        input.projects === undefined
          ? repository === DEFAULT_PROMPT_REPOSITORY
            ? []
            : [repository]
          : normalizeProjects(input.projects);
      try {
        return insert({ ...input, repository, projects });
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
            SET system_prompt = ?, user_prompt = ?, wecom_webhook_url = ?, wecom_score_threshold = ?,
                provider_id = ?, model = ?, updated_at = ?
          WHERE id = ?`,
      ).run(
        input.systemPrompt,
        input.userPrompt,
        input.wecomWebhookUrl ?? null,
        input.wecomScoreThreshold ?? null,
        input.providerId ?? null,
        input.model ?? null,
        now,
        id,
      );
      // projects 未传时保持原有关系不动（只改正文的调用方不该顺带清空项目）；
      // 显式传入（含空数组）才覆盖。
      if (input.projects !== undefined) {
        writeProjects(id, input.projects);
      }
      const updated = this.get(id);
      if (!updated) throw new Error(`prompt ${id} 不存在`);
      return updated;
    },

    remove(id) {
      // 删除即删（D-015）：被删项目在 resolve 时自然回落到 default。
      // 关联表由 ON DELETE CASCADE 清理（openDatabase 已开启 foreign_keys）。
      db.prepare("DELETE FROM review_prompts WHERE id = ?").run(id);
    },

    listKnownProjects() {
      const rows = db
        .prepare("SELECT DISTINCT project FROM prompt_projects ORDER BY project ASC")
        .all() as unknown as Array<{ project: string }>;
      return rows.map((row) => row.project);
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
        const isDefaultFile = name.startsWith("default.");
        const repository = isDefaultFile ? DEFAULT_PROMPT_REPOSITORY : parsed.repository;
        if (!repository) {
          skipped += 1;
          continue;
        }
        if (selectByRepository(repository)) {
          skipped += 1;
          continue;
        }
        // 导入时把 yaml 里的 repository 拆成项目列表：老 yaml 用逗号串表示
        // 「这套 prompt 覆盖这几个项目」（如 auto-ops,cw-auto-ops,...），
        // 直接整串当一个项目会让匹配全部失效。default 不绑定任何项目。
        const projects = isDefaultFile ? [] : repository.split(",").map((item) => item.trim()).filter(Boolean);
        insert({
          repository,
          projects,
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
