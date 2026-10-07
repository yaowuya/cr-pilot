/**
 * 评审 prompt 管理路由。
 *
 * 列表只返回摘要，正文按需通过 `GET /api/prompts/:id` 拉取——避免一次把全部
 * prompt 正文（每个可达数万字符）传给前端。
 */
import { Router } from "express";
import type { PromptRepository } from "../../../domain/review-prompt.ts";

/** prompt 路由依赖。 */
export interface PromptsRouterDeps {
  prompts: PromptRepository;
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
    try {
      const created = deps.prompts.create({ repository, systemPrompt, userPrompt, ...readWecom(body) });
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
    if (!deps.prompts.get(id)) {
      res.status(404).json({ error: "prompt 不存在" });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const { systemPrompt, userPrompt, error } = readPromptBody(body);
    if (error) {
      res.status(400).json({ error });
      return;
    }
    // 保存即生效（D-016）：评审每次从库里读，无需重启。
    res.json(deps.prompts.update(id, { systemPrompt, userPrompt, ...readWecom(body) }));
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
