/**
 * 评审 prompt 管理路由。
 *
 * 列表只返回摘要，正文按需通过 `GET /api/prompts/:id` 拉取——避免一次把全部
 * prompt 正文（每个可达数万字符）传给前端。
 *
 * 多项目（D-020）：`projects` 是字符串数组，任一命中即使用该 prompt。
 * 全局默认 prompt（repository="default"）忽略 projects。
 */
import { Router, type ErrorRequestHandler } from "express";
import {
  normalizePromptName,
  normalizeRepositoryStandards,
  validateProjectSettings,
  PromptValidationError,
  type ProjectAutoMergePolicy,
  type ProjectReviewSettingPatch,
  type PromptRepository,
} from "../../../domain/review-prompt.ts";
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

/** 读取可选的企微配置。分数阈值对外始终是整数，避免字符串混入库与响应。 */
function readWecom(body: Record<string, unknown>): { wecomWebhookUrl?: string; wecomScoreThreshold?: number } {
  const url = typeof body.wecom_webhook_url === "string" ? body.wecom_webhook_url.trim() : "";
  const rawThreshold = body.wecom_score_threshold;
  const asNumber = typeof rawThreshold === "number" || typeof rawThreshold === "string"
    ? Number(rawThreshold)
    : Number.NaN;
  // 空白字符串与 undefined 都视为“未配置”；其余必须是可解析的非负整数。
  const absent = rawThreshold === undefined || rawThreshold === null || (typeof rawThreshold === "string" && rawThreshold.trim() === "");
  if (!absent && (!Number.isFinite(asNumber) || asNumber < 0 || !Number.isInteger(asNumber))) {
    throw new PromptValidationError("企微评分阈值必须是非负整数");
  }
  const threshold = absent ? undefined : asNumber;
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

/** 判断请求是否显式尝试修改高风险自动合并策略；只有这种写入要求管理员。 */
function containsAutoMergePolicy(body: Record<string, unknown>): boolean {
  return Array.isArray(body.project_settings) && body.project_settings.some((item) =>
    typeof item === "object" && item !== null && !Array.isArray(item) &&
    Object.prototype.hasOwnProperty.call(item, "auto_merge_policy"));
}

/** 把 HTTP snake_case 策略映射为领域结构；业务边界由领域校验统一处理。 */
function readAutoMergePolicy(value: unknown): ProjectAutoMergePolicy {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PromptValidationError("auto_merge_policy 必须是对象");
  }
  const policy = value as Record<string, unknown>;
  return {
    enabled: policy.enabled as boolean,
    minimumScore: policy.minimum_score as number,
    targetBranches: policy.target_branches as string[],
    method: policy.method as ProjectAutoMergePolicy["method"],
    removeSourceBranch: policy.remove_source_branch as boolean,
  };
}

/** 新增配置采用严格类型和部分更新；省略不能变成清空或关闭。 */
function readRepositoryConfig(body: Record<string, unknown>, projects: string[], repository: string): {
  repositoryStandards?: string;
  projectSettings?: ProjectReviewSettingPatch[];
} {
  const repositoryStandards = normalizeRepositoryStandards(body.repository_standards);
  let projectSettings: ProjectReviewSettingPatch[] | undefined;
  if (body.project_settings !== undefined) {
    if (!Array.isArray(body.project_settings)) throw new PromptValidationError("project_settings 必须是数组");
    const settings = body.project_settings.map((item: unknown): ProjectReviewSettingPatch => {
      if (typeof item !== "object" || item === null || Array.isArray(item) ||
        !("project" in item) || typeof item.project !== "string") {
        throw new PromptValidationError("项目设置必须包含 project 字符串");
      }
      const entry = item as Record<string, unknown> & { project: string };
      const hasContext = Object.prototype.hasOwnProperty.call(entry, "repository_context_enabled");
      const hasAutoMerge = Object.prototype.hasOwnProperty.call(entry, "auto_merge_policy");
      if (hasContext && typeof entry.repository_context_enabled !== "boolean") {
        throw new PromptValidationError("repository_context_enabled 必须是布尔值");
      }
      return {
        project: entry.project,
        ...(hasContext ? { repositoryContextEnabled: entry.repository_context_enabled as boolean } : {}),
        ...(hasAutoMerge ? { autoMergePolicy: readAutoMergePolicy(entry.auto_merge_policy) } : {}),
      };
    });
    projectSettings = validateProjectSettings(settings, projects, repository);
  }
  return { repositoryStandards, projectSettings };
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

  /** 高风险保护按精确项目设置判定，不能复用 Prompt 的短名/default 回退。 */
  const hasEnabledAutoMerge = (projects: readonly string[]): boolean => projects.some((project) =>
    deps.prompts.resolveProjectSetting?.(project)?.autoMergePolicy.enabled === true);
  const anyAutoMergeEnabled = (): boolean =>
    deps.prompts.listProjectSettings?.().some((setting) => setting.autoMergePolicy.enabled) === true;

  router.get("/", (_req, res) => {
    res.json(deps.prompts.list());
  });

  /** 已关联项目合集 + 厂商列表：供前端下拉建议。 */
  router.get("/meta", (_req, res) => {
    res.json({
      projects: deps.prompts.listKnownProjects(),
      projectSettings: deps.prompts.listProjectSettings?.() ?? [],
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
    // 导入会批量生成 Prompt；存在任一启用策略时仅管理员可执行，避免竞争关联改变评分规则。
    if (res.locals.isAdmin !== true && anyAutoMergeEnabled()) {
      res.status(403).json({ error: "存在已启用自动合并的项目，导入 Prompt 需要管理员权限" });
      return;
    }
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
    if (containsAutoMergePolicy(body) && res.locals.isAdmin !== true) {
      res.status(403).json({ error: "修改自动合并策略需要管理员权限" });
      return;
    }
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
      const projects = repository === "default" ? [] : readProjects(body);
      if (res.locals.isAdmin !== true && hasEnabledAutoMerge(projects)) {
        res.status(403).json({ error: "已启用自动合并的项目仅允许管理员维护 Prompt" });
        return;
      }
      const created = deps.prompts.create({
        repository,
        // default 是全局兜底，不绑定具体项目：即使页面传了也忽略，
        // 避免出现「默认 prompt 只对某几个项目生效」的误解。
        projects,
        ...readRepositoryConfig(body, projects, repository),
        systemPrompt,
        userPrompt,
        ...readWecom(body),
        providerId: binding.providerId,
        model: binding.model,
      });
      res.json(created);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      res.status(caught instanceof PromptValidationError ? 400 : /已存在/.test(message) ? 409 : 500).json({ error: message });
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
    if (containsAutoMergePolicy(body) && res.locals.isAdmin !== true) {
      res.status(403).json({ error: "修改自动合并策略需要管理员权限" });
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
    // 缺少 projects 是旧客户端只改正文；显式 [] 才解绑，不能连带清除仓库开关。
    const projects = existing.repository === "default" ? [] :
      body.projects === undefined ? undefined : readProjects(body);
    const finalProjects = projects ?? existing.projects;
    // 旧关联和最终关联都要检查：不能先解绑/换规则来绕过保护。
    if (res.locals.isAdmin !== true && hasEnabledAutoMerge([...existing.projects, ...finalProjects])) {
      res.status(403).json({ error: "已启用自动合并的项目仅允许管理员维护 Prompt" });
      return;
    }
    // 名称可改（default 除外）；省略时保留原名，兼容只改正文的旧客户端。
    const repository = body.repository === undefined ? undefined : normalizePromptName(body.repository);
    if (existing.repository === "default" && repository !== undefined && repository !== "default") {
      res.status(400).json({ error: "default 名称不可修改" });
      return;
    }
    // 保存即生效（D-016）：评审每次从库里读，无需重启。
    try {
      res.json(
        deps.prompts.update(id, {
          ...(repository === undefined ? {} : { repository }),
          projects,
          ...readRepositoryConfig(body, finalProjects, existing.repository),
          systemPrompt,
          userPrompt,
          ...readWecom(body),
          providerId: binding.providerId,
          model: binding.model,
        }),
      );
    } catch (caught) {
      // 新名称撞上已有 Prompt 时按创建语义返回 409，便于页面提示。
      if (/已存在/.test(caught instanceof Error ? caught.message : "")) {
        res.status(409).json({ error: caught instanceof Error ? caught.message : "名称已存在" });
        return;
      }
      throw caught;
    }
  });

  router.delete("/:id", (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "prompt ID 非法" });
      return;
    }
    const existing = deps.prompts.get(id);
    if (existing && res.locals.isAdmin !== true && hasEnabledAutoMerge(existing.projects)) {
      res.status(403).json({ error: "已启用自动合并的项目仅允许管理员维护 Prompt" });
      return;
    }
    deps.prompts.remove(id);
    res.json({ ok: true });
  });

  // 新配置的业务校验统一 400；数据库/IO 故障仍交全局错误处理，不能假装输入错误。
  const validationErrors: ErrorRequestHandler = (error: unknown, _req, res, next) => {
    if (error instanceof PromptValidationError) {
      res.status(400).json({ error: error.message });
      return;
    }
    next(error);
  };
  router.use(validationErrors);
  return router;
}
