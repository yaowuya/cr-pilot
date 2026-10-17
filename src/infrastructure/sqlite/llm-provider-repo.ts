/**
 * LLM 厂商仓储：基于 `node:sqlite` 的同步实现。
 *
 * 设计要点（D-021 / D-022）：
 * - `models` 以 JSON 数组存一列，避免为「模型清单」再开一张表——模型只是
 *   字符串列表，没有独立生命周期，拆表只会增加联表成本。
 * - 全局默认厂商至多一个，`setDefault` 在同一事务语义下先清零再置位。
 * - 项目绑定单独一张表，支持「某项目专用某厂商」，未绑定则回落全局默认。
 */
import type { DatabaseSync } from "node:sqlite";
import type {
  LlmApiKind,
  LlmProjectBinding,
  LlmProvider,
  LlmProviderInput,
  LlmProviderRepository,
  LlmProviderSummary,
  ResolvedLlmTarget,
} from "../../domain/llm-provider.ts";

interface ProviderRow {
  id: number;
  name: string;
  label: string;
  kind: string;
  base_url: string;
  api_key: string | null;
  api: string;
  models: string;
  default_model: string | null;
  is_default: number;
  created_at: number;
  updated_at: number;
}

/** 解析 models 列的 JSON；损坏时返回空数组而不是抛错（单行坏数据不该拖垮列表）。 */
function parseModels(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string" && item.trim() !== "");
  } catch {
    return [];
  }
}

/** 密钥掩码：长度 > 8 时留前 4 后 4，否则全掩码。与配置页规则保持一致。 */
export function maskApiKey(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.length <= 8) return "****";
  return `${value.slice(0, 4)}****${value.slice(-4)}`;
}

/** 行转完整记录。 */
function toProvider(row: ProviderRow): LlmProvider {
  return {
    id: row.id,
    name: row.name,
    label: row.label,
    kind: row.kind,
    baseUrl: row.base_url,
    apiKey: row.api_key ?? undefined,
    api: row.api as LlmApiKind,
    models: parseModels(row.models),
    defaultModel: row.default_model ?? undefined,
    isDefault: row.is_default === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 行转摘要：apiKey 只回掩码。 */
function toSummary(row: ProviderRow): LlmProviderSummary {
  const apiKey = row.api_key ?? undefined;
  return {
    id: row.id,
    name: row.name,
    label: row.label,
    kind: row.kind,
    baseUrl: row.base_url,
    hasApiKey: Boolean(apiKey),
    apiKeyMasked: maskApiKey(apiKey),
    api: row.api as LlmApiKind,
    models: parseModels(row.models),
    defaultModel: row.default_model ?? undefined,
    isDefault: row.is_default === 1,
    updatedAt: row.updated_at,
  };
}

/** 判断是否为 name 唯一约束冲突。 */
function isUniqueViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /UNIQUE constraint failed: llm_providers\.name/i.test(message);
}

/** 创建 LLM 厂商仓储。 */
export function createLlmProviderRepository(db: DatabaseSync): LlmProviderRepository {
  const selectById = (id: number): LlmProvider | undefined => {
    const row = db.prepare("SELECT * FROM llm_providers WHERE id = ?").get(id) as unknown as ProviderRow | undefined;
    return row ? toProvider(row) : undefined;
  };

  /** 写入时统一规范化：模型去空去重，默认模型必须在清单内。 */
  const normalizeInput = (input: LlmProviderInput): LlmProviderInput => {
    const models = [...new Set(input.models.map((item) => item.trim()).filter(Boolean))];
    // 默认模型不在清单里时回退到第一个，避免页面存下一个永远选不中的模型。
    const defaultModel = input.defaultModel?.trim() && models.includes(input.defaultModel.trim())
      ? input.defaultModel.trim()
      : models[0];
    return { ...input, models, defaultModel };
  };

  const insertRow = (input: LlmProviderInput): number => {
    const now = Date.now();
    const result = db
      .prepare(
        `INSERT INTO llm_providers
           (name, label, kind, base_url, api_key, api, models, default_model, is_default, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.name,
        input.label,
        input.kind,
        input.baseUrl,
        input.apiKey ?? null,
        input.api,
        JSON.stringify(input.models),
        input.defaultModel ?? null,
        input.isDefault ? 1 : 0,
        now,
        now,
      );
    return Number(result.lastInsertRowid);
  };

  /** 清掉其余厂商的默认标记，保证全局唯一。 */
  const clearOtherDefaults = (exceptId: number): void => {
    db.prepare("UPDATE llm_providers SET is_default = 0 WHERE id <> ?").run(exceptId);
  };

  return {
    list() {
      const rows = db
        .prepare("SELECT * FROM llm_providers ORDER BY is_default DESC, name ASC")
        .all() as unknown as ProviderRow[];
      return rows.map(toSummary);
    },

    get(id) {
      return selectById(id);
    },

    findByName(name) {
      const row = db.prepare("SELECT * FROM llm_providers WHERE name = ?").get(name) as unknown as
        | ProviderRow
        | undefined;
      return row ? toProvider(row) : undefined;
    },

    create(rawInput) {
      const input = normalizeInput(rawInput);
      try {
        const id = insertRow(input);
        if (input.isDefault) clearOtherDefaults(id);
        const created = selectById(id);
        if (!created) throw new Error("厂商创建后读取失败");
        return created;
      } catch (error) {
        if (isUniqueViolation(error)) throw new Error(`厂商 ${input.name} 已存在`);
        throw error;
      }
    },

    update(id, rawInput) {
      if (!selectById(id)) throw new Error(`厂商 ${id} 不存在`);
      const input = normalizeInput(rawInput);
      db.prepare(
        `UPDATE llm_providers
            SET name = ?, label = ?, kind = ?, base_url = ?, api_key = ?, api = ?,
                models = ?, default_model = ?, is_default = ?, updated_at = ?
          WHERE id = ?`,
      ).run(
        input.name,
        input.label,
        input.kind,
        input.baseUrl,
        input.apiKey ?? null,
        input.api,
        JSON.stringify(input.models),
        input.defaultModel ?? null,
        input.isDefault ? 1 : 0,
        Date.now(),
        id,
      );
      if (input.isDefault) clearOtherDefaults(id);
      const updated = selectById(id);
      if (!updated) throw new Error(`厂商 ${id} 更新后读取失败`);
      return updated;
    },

    remove(id) {
      // 关联的项目绑定由 ON DELETE CASCADE 清理；prompt 上的 provider_id 不做
      // 级联删除——保留引用让页面显示「厂商已删除」，比静默清空更可追溯。
      db.prepare("DELETE FROM llm_providers WHERE id = ?").run(id);
    },

    getDefault() {
      const row = db.prepare("SELECT * FROM llm_providers WHERE is_default = 1 LIMIT 1").get() as unknown as
        | ProviderRow
        | undefined;
      if (row) return toProvider(row);
      // 没有显式默认时取第一条：老部署升级后只有一条厂商，不该因为缺标记就失效。
      const first = db.prepare("SELECT * FROM llm_providers ORDER BY id ASC LIMIT 1").get() as unknown as
        | ProviderRow
        | undefined;
      return first ? toProvider(first) : undefined;
    },

    setDefault(id) {
      db.prepare("UPDATE llm_providers SET is_default = CASE WHEN id = ? THEN 1 ELSE 0 END").run(id);
    },

    bindProject(project, providerId, model) {
      const key = project.trim();
      if (!key) return;
      db.prepare(
        `INSERT INTO llm_project_bindings (project, provider_id, model, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(project) DO UPDATE SET provider_id = excluded.provider_id,
                                            model = excluded.model,
                                            updated_at = excluded.updated_at`,
      ).run(key, providerId, model?.trim() || null, Date.now());
    },

    unbindProject(project) {
      db.prepare("DELETE FROM llm_project_bindings WHERE project = ?").run(project.trim());
    },

    listProjectBindings() {
      const rows = db
        .prepare("SELECT project, provider_id, model FROM llm_project_bindings ORDER BY project ASC")
        .all() as unknown as Array<{ project: string; provider_id: number; model: string | null }>;
      return rows.map((row) => ({
        project: row.project,
        providerId: row.provider_id,
        model: row.model ?? undefined,
      }));
    },

    resolveTarget(project) {
      /** 把厂商与模型配成最终目标；模型缺省时取厂商默认。 */
      const build = (provider: LlmProvider, model?: string): ResolvedLlmTarget | undefined => {
        const finalModel = model?.trim() || provider.defaultModel || provider.models[0];
        return finalModel ? { provider, model: finalModel } : undefined;
      };

      // 项目绑定优先级最高（D-022）。
      if (project?.trim()) {
        const binding = db
          .prepare("SELECT provider_id, model FROM llm_project_bindings WHERE project = ? COLLATE NOCASE LIMIT 1")
          .get(project.trim()) as unknown as { provider_id: number; model: string | null } | undefined;
        if (binding) {
          const provider = selectById(binding.provider_id);
          if (provider) {
            const target = build(provider, binding.model ?? undefined);
            if (target) return target;
          }
        }
      }

      const fallback = this.getDefault();
      return fallback ? build(fallback) : undefined;
    },
  };
}
