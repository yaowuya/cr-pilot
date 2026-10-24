/** Prompt 草稿与请求转换：纯逻辑不持有 Vue 状态、网络或凭据。 */
import type { ProjectReviewSetting, StoredPrompt } from "../types.ts";

export const REPOSITORY_STANDARDS_MAX_LENGTH = 32_000;
export type PromptSection = "projects" | "prompt" | "standards" | "delivery";

export interface PromptDraft {
  repository: string;
  projects: string[];
  systemPrompt: string;
  userPrompt: string;
  repositoryStandards: string;
  wecomWebhookUrl: string;
  wecomScoreThreshold: string;
  providerId: number | undefined;
  model: string;
  /** undefined 是新关联尚未取得服务器状态，不能误当作 false 提交。 */
  projectStates: Record<string, boolean | undefined>;
  originalProjectStates: Record<string, boolean | undefined>;
}

/** 与后端名称级配置使用相同键：小写归一化，兼容存量短项目名。 */
export function projectKey(project: string): string { return project.trim().toLowerCase(); }

/**
 * 前端只做“能否提交”的轻校验，规则必须与后端一致：
 * 合法项目名或相对路径都可开启（含存量短名），只有非法字符才拦。
 * 前端的报错文案不能与后端不同，否则用户会看到一条实际不存在于后端的提示。
 */
export function canEnableRepositoryContext(project: string): boolean {
  const parts = project.trim().split("/");
  return parts.length > 0 && parts.every(part => /^[\p{L}\p{N}_][\p{L}\p{N}_.-]*$/u.test(part));
}

/** 旧响应缺少新增字段时采用空规范/全关；不会据此改写其他项目的状态。 */
export function createPromptDraft(detail?: StoredPrompt): PromptDraft {
  const draft: PromptDraft = {
    repository: detail?.repository ?? "",
    projects: [...(detail?.projects ?? [])],
    systemPrompt: detail?.systemPrompt ?? "",
    userPrompt: detail?.userPrompt ?? "",
    repositoryStandards: detail?.repositoryStandards ?? "",
    wecomWebhookUrl: detail?.wecomWebhookUrl ?? "",
    wecomScoreThreshold: detail?.wecomScoreThreshold === undefined ? "" : String(detail.wecomScoreThreshold),
    providerId: detail?.providerId,
    model: detail?.model ?? "",
    projectStates: {}, originalProjectStates: {},
  };
  const states = new Map((detail?.projectSettings ?? []).map(item => [projectKey(item.project), item.repositoryContextEnabled]));
  for (const project of draft.projects) {
    const key = projectKey(project);
    draft.projectStates[key] = states.get(key) ?? false;
    draft.originalProjectStates[key] = draft.projectStates[key];
  }
  return draft;
}

/**
 * 根据最终关联同步草稿。meta 仅初始化新关联/待加载项，不能覆盖用户已修改的开关；
 * 删除关联也删除其 dirty 状态，防止提交对已解绑项目的设置。
 */
export function synchronizeProjectSettings(draft: PromptDraft, metadata?: readonly ProjectReviewSetting[]): void {
  const seen = new Set<string>();
  draft.projects = draft.projects.map(project => project.trim()).filter(project => {
    const key = projectKey(project);
    if (!key || seen.has(key)) return false;
    seen.add(key); return true;
  });
  for (const key of Object.keys(draft.projectStates)) {
    if (!seen.has(key)) { delete draft.projectStates[key]; delete draft.originalProjectStates[key]; }
  }
  const known = metadata === undefined ? undefined : new Map(metadata.map(item => [projectKey(item.project), item.repositoryContextEnabled]));
  for (const project of draft.projects) {
    const key = projectKey(project);
    if (!(key in draft.projectStates) || draft.projectStates[key] === undefined) {
      draft.projectStates[key] = known ? known.get(key) ?? false : undefined;
      draft.originalProjectStates[key] = draft.projectStates[key];
    }
  }
}

/** 只提交实际改变的项目条目，避免旧草稿覆盖其他 Prompt 对同项目的更新。 */
export function buildPromptPayload(draft: PromptDraft) {
  const project_settings = draft.projects.flatMap(project => {
    const key = projectKey(project);
    const enabled = draft.projectStates[key];
    return enabled !== undefined && enabled !== draft.originalProjectStates[key]
      ? [{ project, repository_context_enabled: enabled }] : [];
  });
  return {
    repository: draft.repository.trim(),
    projects: draft.repository === "default" ? [] : [...draft.projects],
    system_prompt: draft.systemPrompt,
    user_prompt: draft.userPrompt,
    repository_standards: draft.repositoryStandards,
    project_settings: draft.repository === "default" ? [] : project_settings,
    wecom_webhook_url: draft.wecomWebhookUrl || undefined,
    wecom_score_threshold: draft.wecomScoreThreshold || undefined,
    provider_id: draft.providerId,
    model: draft.model || undefined,
  };
}

/** 返回可定位分组的校验错误，供表单在不可见标签内也能展示错误位置。 */
export function validatePromptDraft(draft: PromptDraft): { field: string; group: PromptSection; message: string }[] {
  const errors: { field: string; group: PromptSection; message: string }[] = [];
  if (!draft.repository.trim()) errors.push({field:"repository",group:"projects",message:"请填写名称"});
  if (draft.repository.trim().length > 200) errors.push({field:"repository",group:"projects",message:"名称不能超过 200 字符"});
  if (!draft.systemPrompt.trim()) errors.push({field:"systemPrompt",group:"prompt",message:"System Prompt 不能为空"});
  if (!draft.userPrompt.trim()) errors.push({field:"userPrompt",group:"prompt",message:"User Prompt 不能为空"});
  if (draft.repositoryStandards.length > REPOSITORY_STANDARDS_MAX_LENGTH) {
    errors.push({field:"repositoryStandards",group:"standards",message:`仓库规范不能超过 ${REPOSITORY_STANDARDS_MAX_LENGTH} 字符`});
  }
  for (const project of draft.projects) {
    if (draft.projectStates[projectKey(project)] === true && !canEnableRepositoryContext(project)) {
      errors.push({field:"projects",group:"projects",message:"项目名包含不允许的字符，无法开启仓库上下文"}); break;
    }
  }
  return errors;
}

/** 异步结果归属，不取消公共 client 请求；过期/关闭/卸载后的响应一律丢弃。 */
export function createRequestGeneration() {
  let generation = 0;
  return {
    start: () => ++generation,
    isCurrent: (request: number) => request === generation,
    invalidate: () => { generation += 1; },
  };
}
