/**
 * 评审 prompt 管理路由。
 *
 * 列表只返回摘要，正文按需通过 `GET /api/prompts/:id` 拉取——避免一次把全部
 * prompt 正文（每个可达数万字符）传给前端。
 *
 * 多项目（D-020）：`projects` 是字符串数组，任一命中即使用该 prompt。
 * 全局默认 prompt（repository="default"）忽略 projects。
 */
import { Router } from "express";
import type { PromptRepository } from "../../../domain/review-prompt.ts";
import type { LlmProviderRepository } from "../../../domain/llm-provider.ts";

/** prompt 路由依赖。 */
export interface PromptsRouterDeps {
  prompts: PromptRepository;
  /**
   * LLM 厂商仓储，用于校验 provider_id 与提供下拉选项。
   *
   * 可选：只关心 prompt CRUD 的测试可以省略，此时厂商相关字段被忽略
   * （不接受写入 provider_id，避免存下无法校验的悬空引用）。
   */
  providers?: LlmProviderRepository;
  /** 规则目录，供一次性导入使用。 */
  rulesDir: string;
}

/** 校验 prompt 正文：两个字段都必填非空。 */
function readPromptBody(body: Record<string, unknown>): { systemPrompt: string; userPrompt: string; error?: string } {
  const systemPrompt = typeof body.system_prompt === "string" ? body.system_prompt.trim() : "";
  const userPrompt = typeof body.user_prompt === "string" ? body.user_prompt.trim() : "";
  if (!systemPrompt) return { systemPrompt, userPrompt, error: "system_prompt 不能为空" };
  if (!userPrompt) return { systemPrompt, userPrompt, error: "user_prompt 不能为空" };
  return { systemPrompt, userPrompt };
}

/** 读取可选的企微配置。 */
function readWecom(body: Record<string, unknown>): { wecomWebhookUrl?: string; wecomScoreThreshold?: number } {
  const url = typeof body.wecom_webhook_url === "string" ? body.wecom_webhook_url.trim() : "";
  const rawThreshold = body.wecom_score_threshold;
  const threshold =
    typeof rawThreshold === "number" && Number.isFinite(rawThreshold) && rawThreshold >= 0
      ? rawThreshold
      : typeof rawThreshold === "string" && rawThreshold.trim() !== "" && Number.isFinite(Number(rawThreshold))
        ? Number(rawThreshold)
        : undefined;
  return { wecomWebhookUrl: url || undefined, wecomScoreThreshold: threshold };
}

/**
 * 读取项目列表。
 *
 * 接受数组或逗号分隔字符串：数组是页面标准形态，逗号串兼容脚本/curl 调用。
 * 空字符串项被丢弃，避免页面误存出空标签。
 */
function readProjects(body: Record<string, unknown>): string[] {
  const raw = body.projects;
  if (Array.isArray(raw)) {
    return raw.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
  }
  if (typeof raw === "string") {
    return raw
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

/** 读取可选的厂商/模型绑定。 */
function readProviderBinding(
  body: Record<string, unknown>,
  providers?: LlmProviderRepository,
): { providerId?: number; model?: string; error?: string } {
  const raw = body.provider_id;
  if (raw === undefined || raw === null || raw === "") return {};
  // 没注入厂商仓储时不接受厂商绑定：存下无法校验的 id 只会在评审时静默回落。
  if (!providers) return { error: "当前未启用厂商配置，不能指定 provider_id" };
  const providerId = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(providerId) || providerId <= 0) {
    return { error: "provider_id 必须是正整数" };
  }
  if (!providers.get(providerId)) {
    return { error: `厂商 ${providerId} 不存在` };
  }
  const model = typeof body.model === "string" ? body.model.trim() : "";
  return { providerId, model: model || undefined };
}

/**
 * 创建 prompt 管理路由。
 *
 * 导入接口映射到 `PromptRepository.importFromDir`，已存在的 repository 跳过，
 * 因此可重复调用而不产生重复行。
 */
export function createPromptsRouter(deps: PromptsRouterDeps): Router {
  const router = Router();

  router.get("/", (_req, res) => {
    res.json(deps.prompts.list());
  });

  /** 已关联项目合集 + 厂商列表：供前端下拉建议。 */
  router.get("/meta", (_req, res) => {
    res.json({
      projects: deps.prompts.listKnownProjects(),
      providers: (deps.providers?.list() ?? []).map((item) => ({
        id: item.id,
        label: item.label,
        name: item.name,
        models: item.models,
        defaultModel: item.defaultModel,
        isDefault: item.isDefault,
      })),
    });
  });

  router.post("/import", (_req, res) => {
    res.json(deps.prompts.importFromDir(deps.rulesDir));
  });

  router.get("/:id", (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "prompt ID 非法" });
      return;
    }
    const prompt = deps.prompts.get(id);
    if (!prompt) {
      res.status(404).json({ error: "prompt 不存在" });
      return;
    }
    res.json(prompt);
  });

  router.post("/", (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const repository = typeof body.repository === "string" ? body.repository.trim() : "";
    if (!repository) {
      res.status(400).json({ error: "repository 不能为空" });
      return;
    }
    const { systemPrompt, userPrompt, error } = readPromptBody(body);
    if (error) {
      res.status(400).json({ error });
      return;
    }
    const binding = readProviderBinding(body, deps.providers);
    if (binding.error) {
      res.status(400).json({ error: binding.error });
      return;
    }
    try {
      const created = deps.prompts.create({
        repository,
        // default 是全局兜底，不绑定具体项目：即使页面传了也忽略，
        // 避免出现「默认 prompt 只对某几个项目生效」的误解。
        projects: repository === "default" ? [] : readProjects(body),
        systemPrompt,
        userPrompt,
        ...readWecom(body),
        providerId: binding.providerId,
        model: binding.model,
      });
      res.json(created);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      res.status(/已存在/.test(message) ? 409 : 500).json({ error: message });
    }
  });

  router.put("/:id", (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "prompt ID 非法" });
      return;
    }
    const existing = deps.prompts.get(id);
    if (!existing) {
      res.status(404).json({ error: "prompt 不存在" });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const { systemPrompt, userPrompt, error } = readPromptBody(body);
    if (error) {
      res.status(400).json({ error });
      return;
    }
    const binding = readProviderBinding(body, deps.providers);
    if (binding.error) {
      res.status(400).json({ error: binding.error });
      return;
    }
    // 保存即生效（D-016）：评审每次从库里读，无需重启。
    res.json(
      deps.prompts.update(id, {
        projects: existing.repository === "default" ? [] : readProjects(body),
        systemPrompt,
        userPrompt,
        ...readWecom(body),
        providerId: binding.providerId,
        model: binding.model,
      }),
    );
  });

  router.delete("/:id", (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "prompt ID 非法" });
      return;
    }
    deps.prompts.remove(id);
    res.json({ ok: true });
  });

  return router;
}
