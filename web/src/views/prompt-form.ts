/** Prompt 草稿与请求转换：纯逻辑不持有 Vue 状态、网络或凭据。 */
import type { AutoMergeMethod, ProjectAutoMergePolicy, ProjectReviewSetting, StoredPrompt } from "../types.ts";

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
  /** 策略对象始终存在供表单绑定；known=false 时只读且绝不进入 payload。 */
  autoMergePolicies: Record<string, ProjectAutoMergePolicy>;
  autoMergeKnown: Record<string, boolean>;
  /** undefined 表示尚未取得服务端基线，不得推断为默认关闭。 */
  originalAutoMergePolicies: Record<string, ProjectAutoMergePolicy | undefined>;
}

/** 与后端名称级配置使用相同键：小写归一化，兼容存量短项目名。 */
export function projectKey(project: string): string { return project.trim().toLowerCase(); }

/** 未配置项目的安全默认值；目标分支留空使策略无法在误开启后直接保存。 */
export function createDefaultAutoMergePolicy(): ProjectAutoMergePolicy {
  return { enabled: false, minimumScore: 100, targetBranches: [], method: "merge", removeSourceBranch: false };
}

function cloneAutoMergePolicy(policy?: ProjectAutoMergePolicy): ProjectAutoMergePolicy {
  const source = policy ?? createDefaultAutoMergePolicy();
  return {
    enabled: source.enabled === true,
    minimumScore: source.minimumScore,
    targetBranches: [...source.targetBranches],
    method: source.method,
    removeSourceBranch: source.removeSourceBranch === true,
  };
}

/** 分支按精确名称匹配；保存前只去首尾空白并稳定去重，不解释 glob。 */
export function normalizeTargetBranches(branches: readonly string[]): string[] {
  return [...new Set(branches.map(branch => branch.trim()).filter(Boolean))];
}

/** 与后端 `git check-ref-format --branch` 安全子集一致，避免保存后才收到格式错误。 */
export function canUseAutoMergeTargetBranch(value: string): boolean {
  const branch = value.trim();
  if (!branch) return false;
  const parts = branch.split("/");
  return !(branch.startsWith("-") || branch.startsWith("/") || branch.endsWith("/") ||
    branch.endsWith(".") || branch.includes("//") || branch.includes("..") || branch.includes("@{") ||
    /[\u0000-\u0020\u007f~^:?*\[\\]/u.test(branch) ||
    parts.some(part => part.startsWith(".") || part.endsWith(".lock")));
}

function sameAutoMergePolicy(left: ProjectAutoMergePolicy | undefined, right: ProjectAutoMergePolicy): boolean {
  if (!left) return false;
  return left.enabled === right.enabled
    && left.minimumScore === right.minimumScore
    && left.method === right.method
    && left.removeSourceBranch === right.removeSourceBranch
    && JSON.stringify(normalizeTargetBranches(left.targetBranches)) === JSON.stringify(normalizeTargetBranches(right.targetBranches));
}

/** 自动合并必须精确绑定完整 GitLab 路径，短名/后缀匹配只保留给仓库上下文。 */
export function canEnableAutoMerge(project: string): boolean {
  const parts = project.trim().split("/");
  return parts.length >= 2 && parts.every(part => /^[\p{L}\p{N}_][\p{L}\p{N}_.-]*$/u.test(part));
}

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
    autoMergePolicies: {}, autoMergeKnown: {}, originalAutoMergePolicies: {},
  };
  const settings = new Map((detail?.projectSettings ?? []).map(item => [projectKey(item.project), item]));
  for (const project of draft.projects) {
    const key = projectKey(project);
    const setting = settings.get(key);
    draft.projectStates[key] = setting?.repositoryContextEnabled ?? false;
    draft.originalProjectStates[key] = draft.projectStates[key];
    // 已加载详情是当前记录的完整快照；旧响应缺字段按后端默认关闭兼容。
    draft.autoMergePolicies[key] = cloneAutoMergePolicy(setting?.autoMergePolicy);
    draft.autoMergeKnown[key] = true;
    draft.originalAutoMergePolicies[key] = cloneAutoMergePolicy(draft.autoMergePolicies[key]);
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
    if (!seen.has(key)) {
      delete draft.projectStates[key]; delete draft.originalProjectStates[key];
      delete draft.autoMergePolicies[key]; delete draft.autoMergeKnown[key]; delete draft.originalAutoMergePolicies[key];
    }
  }
  const known = metadata === undefined ? undefined : new Map(metadata.map(item => [projectKey(item.project), item]));
  for (const project of draft.projects) {
    const key = projectKey(project);
    if (!(key in draft.projectStates) || draft.projectStates[key] === undefined) {
      draft.projectStates[key] = known ? known.get(key)?.repositoryContextEnabled ?? false : undefined;
      draft.originalProjectStates[key] = draft.projectStates[key];
    }
    if (!(key in draft.autoMergePolicies)) draft.autoMergePolicies[key] = createDefaultAutoMergePolicy();
    if (draft.autoMergeKnown[key] !== true) {
      const setting = known?.get(key);
      if (known) {
        draft.autoMergePolicies[key] = cloneAutoMergePolicy(setting?.autoMergePolicy);
        draft.autoMergeKnown[key] = true;
        draft.originalAutoMergePolicies[key] = cloneAutoMergePolicy(draft.autoMergePolicies[key]);
      } else {
        draft.autoMergeKnown[key] = false;
        draft.originalAutoMergePolicies[key] = undefined;
      }
    }
  }
}

interface ProjectSettingPayload {
  project: string;
  repository_context_enabled?: boolean;
  auto_merge_policy?: {
    enabled: boolean;
    minimum_score: number;
    target_branches: string[];
    method: AutoMergeMethod;
    remove_source_branch: boolean;
  };
}

/** 两种项目配置独立判脏，但同项目合并成一个 partial patch。 */
export function buildPromptPayload(draft: PromptDraft) {
  const project_settings = draft.projects.flatMap<ProjectSettingPayload>(project => {
    const key = projectKey(project);
    const patch: ProjectSettingPayload = { project };
    const repositoryEnabled = draft.projectStates[key];
    if (repositoryEnabled !== undefined && repositoryEnabled !== draft.originalProjectStates[key]) {
      patch.repository_context_enabled = repositoryEnabled;
    }
    const policy = draft.autoMergePolicies[key];
    const original = draft.originalAutoMergePolicies[key];
    if (draft.autoMergeKnown[key] === true && policy && !sameAutoMergePolicy(original, policy)) {
      patch.auto_merge_policy = {
        enabled: policy.enabled,
        minimum_score: policy.minimumScore,
        target_branches: normalizeTargetBranches(policy.targetBranches),
        method: policy.method,
        remove_source_branch: policy.removeSourceBranch,
      };
    }
    return patch.repository_context_enabled === undefined && patch.auto_merge_policy === undefined ? [] : [patch];
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
  const hasEnabledAutoMerge = draft.repository !== "default" && draft.projects.some((project) =>
    draft.autoMergePolicies[projectKey(project)]?.enabled === true);
  if (hasEnabledAutoMerge && !draft.userPrompt.includes("{diffs_text}")) {
    errors.push({
      field: "userPrompt",
      group: "prompt",
      message: "启用自动合并时 User Prompt 必须包含 {diffs_text} 占位符",
    });
  }
  if (draft.repositoryStandards.length > REPOSITORY_STANDARDS_MAX_LENGTH) {
    errors.push({field:"repositoryStandards",group:"standards",message:`仓库规范不能超过 ${REPOSITORY_STANDARDS_MAX_LENGTH} 字符`});
  }
  for (const project of draft.projects) {
    const key = projectKey(project);
    if (draft.projectStates[key] === true && !canEnableRepositoryContext(project)) {
      errors.push({field:"projects",group:"projects",message:"项目名包含不允许的字符，无法开启仓库上下文"});
    }
    const policy = draft.autoMergePolicies[key];
    if (!policy?.enabled || draft.repository === "default") continue;
    if (!canEnableAutoMerge(project)) {
      errors.push({field:"projects",group:"projects",message:`${project} 必须使用完整的 namespace/project 才能开启自动合并`});
    }
    if (!Number.isInteger(policy.minimumScore) || policy.minimumScore < 1 || policy.minimumScore > 100) {
      errors.push({field:"projects",group:"projects",message:`${project} 的最低评分必须是 1 到 100 的整数`});
    }
    if (policy.targetBranches.some(branch => !branch.trim()) || normalizeTargetBranches(policy.targetBranches).length === 0) {
      errors.push({field:"projects",group:"projects",message:`${project} 开启自动合并时至少填写一个非空目标分支`});
    } else if (policy.targetBranches.some(branch => !canUseAutoMergeTargetBranch(branch))) {
      errors.push({field:"projects",group:"projects",message:`${project} 包含 GitLab 不接受的目标分支名`});
    }
    if (policy.method !== "merge" && policy.method !== "squash") {
      errors.push({field:"projects",group:"projects",message:`${project} 的合并方式无效`});
    }
  }
  return errors;
}

/** 保存前仅提示本次新增加的高影响能力，避免普通门槛调整反复打断用户。 */
export function summarizeAutoMergeConfirmation(draft: PromptDraft): {
  enabledProjects: string[];
  removeSourceBranchProjects: string[];
} {
  const enabledProjects: string[] = [];
  const removeSourceBranchProjects: string[] = [];
  if (draft.repository === "default") return { enabledProjects, removeSourceBranchProjects };
  for (const project of draft.projects) {
    const key = projectKey(project);
    if (draft.autoMergeKnown[key] !== true) continue;
    const policy = draft.autoMergePolicies[key];
    const original = draft.originalAutoMergePolicies[key];
    if (policy.enabled && original?.enabled !== true) enabledProjects.push(project);
    if (policy.enabled && policy.removeSourceBranch && original?.removeSourceBranch !== true) {
      removeSourceBranchProjects.push(project);
    }
  }
  return { enabledProjects, removeSourceBranchProjects };
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
