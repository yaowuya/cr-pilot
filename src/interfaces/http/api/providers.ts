/**
 * LLM 厂商管理路由。
 *
 * 提供厂商 CRUD、默认厂商设置与项目级绑定。厂商配置变更后会重建
 * `pi-agent/models.json`（由 `onChanged` 回调完成），下一次评审即生效。
 *
 * 密钥处理（D-021）：读取接口只回掩码，不回明文；写入时若前端提交的是
 * 掩码形式或空串，视为「不修改原密钥」——否则页面每次保存都会把掩码
 * 当成新密钥写回，导致密钥被 `****` 覆盖。
 */
import { Router } from "express";
import type { LlmApiKind, LlmProviderRepository } from "../../../domain/llm-provider.ts";
import { LLM_PROVIDER_TEMPLATES } from "../../../domain/llm-provider-templates.ts";

/** 厂商路由依赖。 */
export interface ProvidersRouterDeps {
  providers: LlmProviderRepository;
  /** 配置变更后的副作用：重建 models.json 并导出密钥到环境变量。 */
  onChanged?: () => void;
}

/** 支持的协议类型白名单。 */
const API_KINDS: ReadonlySet<string> = new Set<LlmApiKind>([
  "openai-responses",
  "openai-completions",
  "anthropic-messages",
]);

/** 判断一个字符串是否是本服务生成的掩码（`abcd****wxyz` 或 `****`）。 */
function looksMasked(value: string): boolean {
  return /^.{0,4}\*{4}.{0,4}$/.test(value);
}

/** 读取模型清单：数组或逗号串，去空去重。 */
function readModels(body: Record<string, unknown>): string[] {
  const raw = body.models;
  let list: string[] = [];
  if (Array.isArray(raw)) {
    list = raw.filter((item): item is string => typeof item === "string");
  } else if (typeof raw === "string") {
    list = raw.split(",");
  }
  return [...new Set(list.map((item) => item.trim()).filter(Boolean))];
}

/** 校验并构造厂商入参。 */
function readProviderInput(
  body: Record<string, unknown>,
  existingApiKey?: string,
): { input?: Parameters<LlmProviderRepository["create"]>[0]; error?: string } {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const label = typeof body.label === "string" ? body.label.trim() : "";
  const kind = typeof body.kind === "string" ? body.kind.trim() : "";
  const baseUrl = typeof body.base_url === "string" ? body.base_url.trim() : "";
  const api = typeof body.api === "string" ? body.api.trim() : "";

  if (!name) return { error: "name 不能为空" };
  // name 会成为 models.json 的 provider key 与环境变量名，限制字符集避免生成非法键。
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) return { error: "name 只能包含字母、数字、下划线与短横线" };
  if (!label) return { error: "label 不能为空" };
  if (!baseUrl) return { error: "base_url 不能为空" };
  if (!/^https?:\/\//.test(baseUrl)) return { error: "base_url 必须以 http:// 或 https:// 开头" };
  if (!API_KINDS.has(api)) {
    return { error: `api 必须是 ${[...API_KINDS].join(" / ")} 之一` };
  }
  const models = readModels(body);
  if (models.length === 0) return { error: "至少需要配置一个模型" };

  // 密钥三态：未提交/空串/掩码 → 保留原值；否则视为新密钥。
  const rawKey = typeof body.api_key === "string" ? body.api_key.trim() : "";
  const apiKey = rawKey && !looksMasked(rawKey) ? rawKey : existingApiKey;

  const rawDefault = typeof body.default_model === "string" ? body.default_model.trim() : "";
  const defaultModel = rawDefault && models.includes(rawDefault) ? rawDefault : models[0];

  return {
    input: {
      name,
      label,
      kind: kind || "custom",
      baseUrl,
      apiKey,
      api: api as LlmApiKind,
      models,
      defaultModel,
      isDefault: body.is_default === true || body.is_default === 1 || body.is_default === "1",
    },
  };
}

/** 创建厂商管理路由。 */
export function createProvidersRouter(deps: ProvidersRouterDeps): Router {
  const router = Router();

  /** 内置厂商模板：新建时页面据此预填 baseUrl 与常见模型。 */
  router.get("/templates", (_req, res) => {
    res.json(LLM_PROVIDER_TEMPLATES);
  });

  router.get("/", (_req, res) => {
    res.json({
      items: deps.providers.list(),
      bindings: deps.providers.listProjectBindings(),
    });
  });

  router.get("/:id", (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "厂商 ID 非法" });
      return;
    }
    const provider = deps.providers.get(id);
    if (!provider) {
      res.status(404).json({ error: "厂商不存在" });
      return;
    }
    // 不回传明文密钥：连详情接口也只给掩码。
    const { apiKey, ...rest } = provider;
    res.json({
      ...rest,
      hasApiKey: Boolean(apiKey),
      apiKeyMasked: apiKey ? `${apiKey.slice(0, 4)}****${apiKey.slice(-4)}` : undefined,
    });
  });

  router.post("/", (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const { input, error } = readProviderInput(body);
    if (error || !input) {
      res.status(400).json({ error: error ?? "参数非法" });
      return;
    }
    try {
      const created = deps.providers.create(input);
      deps.onChanged?.();
      res.json({ id: created.id, name: created.name });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      res.status(/已存在/.test(message) ? 409 : 500).json({ error: message });
    }
  });

  router.put("/:id", (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "厂商 ID 非法" });
      return;
    }
    const existing = deps.providers.get(id);
    if (!existing) {
      res.status(404).json({ error: "厂商不存在" });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const { input, error } = readProviderInput(body, existing.apiKey);
    if (error || !input) {
      res.status(400).json({ error: error ?? "参数非法" });
      return;
    }
    try {
      deps.providers.update(id, input);
      deps.onChanged?.();
      res.json({ ok: true });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      res.status(/已存在/.test(message) ? 409 : 500).json({ error: message });
    }
  });

  router.delete("/:id", (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "厂商 ID 非法" });
      return;
    }
    deps.providers.remove(id);
    deps.onChanged?.();
    res.json({ ok: true });
  });

  /** 设为全局默认厂商。 */
  router.post("/:id/default", (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "厂商 ID 非法" });
      return;
    }
    if (!deps.providers.get(id)) {
      res.status(404).json({ error: "厂商不存在" });
      return;
    }
    deps.providers.setDefault(id);
    deps.onChanged?.();
    res.json({ ok: true });
  });

  /** 项目级厂商绑定：设置或删除。 */
  router.put("/bindings/:project", (req, res) => {
    const project = decodeURIComponent(req.params.project ?? "").trim();
    if (!project) {
      res.status(400).json({ error: "项目名不能为空" });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const providerId = typeof body.provider_id === "number" ? body.provider_id : Number(body.provider_id);
    if (!Number.isInteger(providerId) || providerId <= 0) {
      res.status(400).json({ error: "provider_id 必须是正整数" });
      return;
    }
    if (!deps.providers.get(providerId)) {
      res.status(404).json({ error: "厂商不存在" });
      return;
    }
    const model = typeof body.model === "string" ? body.model.trim() : "";
    deps.providers.bindProject(project, providerId, model || undefined);
    res.json({ ok: true });
  });

  router.delete("/bindings/:project", (req, res) => {
    const project = decodeURIComponent(req.params.project ?? "").trim();
    deps.providers.unbindProject(project);
    res.json({ ok: true });
  });

  return router;
}
