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
import {
  isRepositoryProjectKey,
  normalizePromptName,
  normalizeRepositoryStandards,
  validateProjectSettings,
  PromptValidationError,
  DEFAULT_PROMPT_REPOSITORY,
  type ProjectReviewSetting,
  type PromptInput,
  type PromptRepository,
  type PromptSummary,
  type StoredPrompt,
} from "../../domain/review-prompt.ts";
import { parseRuleFileContent } from "../rules/review-rules.ts";

export { DEFAULT_PROMPT_REPOSITORY };

interface PromptRow {
  id: number;
  repository: string;
  system_prompt: string;
  user_prompt: string;
  repository_standards: string;
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

/** 与既有 Prompt 选择共用匹配口径；这里只比较显式关联，不把 Prompt 名称当项目。 */
function matchesAssociatedProject(repositoryFullName: string, associatedProject: string): boolean {
  const normalized = normalizeRepositoryKey(repositoryFullName);
  const stored = normalizeRepositoryKey(associatedProject);
  return Boolean(normalized && stored) && (stored === normalized || stored.endsWith(`/${normalized}`) || normalized.endsWith(`/${stored}`));
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

  /** 多表配置一次提交；失败不能留下已变更正文或部分项目开关。 */
  const transaction = <T>(action: () => T): T => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw error;
    }
  };

  /** 仅保留仍关联到非 default Prompt 的合法配置键，包括存量短项目名。 */
  const activeProjectKeys = (): Set<string> => {
    const rows = db.prepare(`SELECT pp.project FROM prompt_projects pp
      JOIN review_prompts p ON p.id = pp.prompt_id WHERE p.repository <> 'default'`).all();
    return new Set(rows.map((row) => normalizeRepositoryKey(String(row.project))).filter(isRepositoryProjectKey));
  };

  const readEnabled = (project: string): boolean => isRepositoryProjectKey(project) &&
    db.prepare("SELECT repository_context_enabled FROM project_review_settings WHERE project = ?")
      .get(normalizeRepositoryKey(project))?.repository_context_enabled === 1;

  const readSettings = (projects: readonly string[]): ProjectReviewSetting[] => projects.map((project) => ({
    project,
    repositoryContextEnabled: readEnabled(project),
  }));

  /** 解绑和旧版本遗留的设置必须清理，避免重新关联时意外恢复开启。 */
  const removeOrphanSettings = (): void => {
    const active = activeProjectKeys();
    const remove = db.prepare("DELETE FROM project_review_settings WHERE project = ?");
    for (const row of db.prepare("SELECT project FROM project_review_settings").all()) {
      const project = String(row.project);
      if (!active.has(project)) remove.run(project);
    }
  };

  /** 只写显式提交的项目；普通保存或未操作的项目不能重置全局状态。 */
  const writeSettings = (settings: readonly ProjectReviewSetting[]): void => {
    const upsert = db.prepare(`INSERT INTO project_review_settings (project, repository_context_enabled, updated_at)
      VALUES (?, ?, ?) ON CONFLICT(project) DO UPDATE SET
      repository_context_enabled = excluded.repository_context_enabled, updated_at = excluded.updated_at
      WHERE project_review_settings.repository_context_enabled <> excluded.repository_context_enabled`);
    for (const setting of settings) {
      if (isRepositoryProjectKey(setting.project)) {
        upsert.run(setting.project, setting.repositoryContextEnabled ? 1 : 0, Date.now());
      }
    }
  };

  /** 覆盖式写入关联表；调用方事务内完成，项目开关保存在独立表而不会被重置。 */
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
    repositoryStandards: row.repository_standards,
    projectSettings: readSettings(readProjects(row.id)),
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
    hasRepositoryStandards: row.repository_standards.length > 0,
    projectSettings: readSettings(readProjects(row.id)),
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

  /** 导入与创建共用原子插入，缺少新增字段时不会推测开启仓库上下文。 */
  const insert = (input: PromptInput): StoredPrompt => transaction(() => {
    const projects = input.repository === DEFAULT_PROMPT_REPOSITORY ? [] : normalizeProjects(input.projects);
    const standards = normalizeRepositoryStandards(input.repositoryStandards) ?? "";
    const settings = validateProjectSettings(input.projectSettings, projects, input.repository);
    removeOrphanSettings();
    const result = db.prepare(`INSERT INTO review_prompts
      (repository, system_prompt, user_prompt, repository_standards, wecom_webhook_url,
       wecom_score_threshold, provider_id, model, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      input.repository, input.systemPrompt, input.userPrompt, standards,
      input.wecomWebhookUrl ?? null, input.wecomScoreThreshold ?? null,
      input.providerId ?? null, input.model ?? null, Date.now(),
    );
    const id = Number(result.lastInsertRowid);
    writeProjects(id, projects);
    writeSettings(settings);
    return selectByRepository(input.repository)!;
  });

  return {
    resolve(repositoryFullName) {
      if (repositoryFullName) {
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
        const loose = candidates.find((row) => matchesAssociatedProject(repositoryFullName, row.matched_project));
        if (loose) return toPrompt(loose);
      }
      return selectByRepository(DEFAULT_PROMPT_REPOSITORY);
    },

    isProjectConfigured(repositoryFullName) {
      // 不能拿 resolve 的非空结果当许可：它会回退 default；也不能只看首条命中，
      // 旧库的 default 关联可能遮蔽其他有效关联。每次读实时关联，读取异常交给调用方拒绝执行。
      const projects = db.prepare(`SELECT pp.project FROM prompt_projects pp
        JOIN review_prompts p ON p.id = pp.prompt_id WHERE p.repository <> 'default'`)
        .all() as unknown as Array<{ project: string }>;
      return projects.some((row) => matchesAssociatedProject(repositoryFullName, row.project));
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
      return transaction(() => {
        const existing = this.get(id);
        if (!existing) throw new Error(`prompt ${id} 不存在`);
        // 名称可改，但 default 是 resolve 的保留兜底键，不允许改名或改名成 default。
        const repository = input.repository === undefined
          ? existing.repository : normalizePromptName(input.repository);
        if (existing.repository === DEFAULT_PROMPT_REPOSITORY && repository !== DEFAULT_PROMPT_REPOSITORY) {
          throw new PromptValidationError("default 名称不可修改");
        }
        if (repository === DEFAULT_PROMPT_REPOSITORY && existing.repository !== DEFAULT_PROMPT_REPOSITORY) {
          throw new PromptValidationError("不能将其他 Prompt 改名为 default");
        }
        const projects = existing.repository === DEFAULT_PROMPT_REPOSITORY ? [] :
          input.projects === undefined ? existing.projects : normalizeProjects(input.projects);
        const standards = normalizeRepositoryStandards(input.repositoryStandards) ?? existing.repositoryStandards ?? "";
        const settings = validateProjectSettings(input.projectSettings, projects, repository);
        // 添加关联前先清理旧版本残留，防止孤立开启项在重关联时复活。
        removeOrphanSettings();
        try {
          db.prepare(`UPDATE review_prompts SET repository = ?, system_prompt = ?, user_prompt = ?,
            repository_standards = ?, wecom_webhook_url = ?, wecom_score_threshold = ?,
            provider_id = ?, model = ?, updated_at = ? WHERE id = ?`).run(
            repository, input.systemPrompt, input.userPrompt, standards,
            input.wecomWebhookUrl ?? null, input.wecomScoreThreshold ?? null,
            input.providerId ?? null, input.model ?? null, Date.now(), id,
          );
        } catch (error) {
          // 重名必须让整笔事务回滚，不能出现正文已改而名称未变。
          if (isUniqueViolation(error)) throw new Error(`prompt ${repository} 已存在`);
          throw error;
        }
        if (input.projects !== undefined || existing.repository === DEFAULT_PROMPT_REPOSITORY) {
          writeProjects(id, projects);
        }
        writeSettings(settings);
        removeOrphanSettings();
        return this.get(id)!;
      });
    },

    remove(id) {
      transaction(() => {
        // 关联由外键级联删除；只有最后一个完整关联消失时，项目开关才清除。
        db.prepare("DELETE FROM review_prompts WHERE id = ?").run(id);
        removeOrphanSettings();
      });
    },

    isRepositoryContextEnabled(repositoryFullName) {
      const project = normalizeRepositoryKey(repositoryFullName);
      if (!isRepositoryProjectKey(project)) return false;
      const prompt = this.resolve(project);
      if (!prompt || prompt.repository === DEFAULT_PROMPT_REPOSITORY) return false;
      // 旧配置按项目短名命中 Prompt；开关必须沿同一个 Prompt 的关联查找，
      // 不能因其他规则里同后缀的项目开启而跨规则继承。精确/较长关联优先，
      // 即使它没有设置（默认关闭）也不能再被宽泛短名的 true 覆盖。
      const matched = prompt.projects.map(normalizeRepositoryKey)
        .filter(key => isRepositoryProjectKey(key) && (key === project || project.endsWith(`/${key}`)))
        .sort((left, right) => right.length - left.length)[0];
      return matched !== undefined && readEnabled(matched);
    },

    listProjectSettings() {
      const projects = [...new Set(this.listKnownProjects().map(normalizeRepositoryKey))].sort();
      return readSettings(projects);
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
