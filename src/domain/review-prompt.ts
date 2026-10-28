/**
 * 评审 prompt 的领域模型与持久化端口。
 *
 * 语义（P-015 / D-015 / D-016）：prompt 以数据库为准，yaml 文件降级为
 * 初始导入源与规则兜底，但不能授予未关联项目的评审资格；页面保存后下一次检查即生效。
 *
 * 多项目关联（D-020）：一条 prompt 可同时关联多个 GitLab 项目，任一项目命中即
 * 使用该 prompt。这样同一套评审规则不必为同组项目各存一份。`repository` 字段
 * 保留为「主键名」用于展示与唯一约束，实际匹配走 `projects` 列表。
 */

import { normalizeRepositoryKey } from "./review-rules.ts";

/** 仓库规范的字符上限；独立于整个 HTTP 请求的字节限制。 */
export const REPOSITORY_STANDARDS_MAX_LENGTH = 32_000;

/** GitLab 合并方式；不支持 rebase 等隐式降级。 */
export type AutoMergeMethod = "merge" | "squash";

/** 项目级自动合并策略；评分达到门槛且目标分支精确命中时才允许进入执行决策。 */
export interface ProjectAutoMergePolicy {
  enabled: boolean;
  /** 1..100 的整数；默认 100，避免启用后意外放宽质量门槛。 */
  minimumScore: number;
  /** GitLab 目标分支的大小写敏感精确列表，不做通配或后缀匹配。 */
  targetBranches: string[];
  method: AutoMergeMethod;
  removeSourceBranch: boolean;
}

/** 返回新的安全默认值，避免共享数组被调用方修改。 */
export function defaultProjectAutoMergePolicy(): ProjectAutoMergePolicy {
  return {
    enabled: false,
    minimumScore: 100,
    targetBranches: [],
    method: "merge",
    removeSourceBranch: false,
  };
}

/** 项目名称级的完整执行设置；同一完整项目在不同 Prompt 中共享此状态。 */
export interface ProjectReviewSetting {
  project: string;
  repositoryContextEnabled: boolean;
  autoMergePolicy: ProjectAutoMergePolicy;
}

/** 项目设置部分更新；省略的能力必须保留原值。 */
export interface ProjectReviewSettingPatch {
  project: string;
  repositoryContextEnabled?: boolean;
  autoMergePolicy?: ProjectAutoMergePolicy;
}

/** 可预期的配置错误，供 HTTP 层映射为 400，不能混同数据库故障。 */
export class PromptValidationError extends Error {
  override readonly name = "PromptValidationError";
}

/** 兼容现有项目短名或相对全名；这里只校验配置键，不据此构造 clone URL。 */
export function isRepositoryProjectKey(project: string): boolean {
  const parts = project.trim().split("/");
  return parts.every((part) => /^[\p{L}\p{N}_][\p{L}\p{N}_.-]*$/u.test(part));
}

/** 规范省略表示保留；空白表示清空。直接仓储调用也必须遵守类型和上限。 */
export function normalizeRepositoryStandards(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new PromptValidationError("repository_standards 必须是字符串");
  if (value.length > REPOSITORY_STANDARDS_MAX_LENGTH) {
    throw new PromptValidationError(`仓库规范不能超过 ${REPOSITORY_STANDARDS_MAX_LENGTH} 字符`);
  }
  return value.trim();
}

/** 完整项目必须至少包含 namespace/project 两段；自动合并不接受旧短名兼容匹配。 */
function isFullRepositoryProjectKey(project: string): boolean {
  return project.split("/").length >= 2 && isRepositoryProjectKey(project);
}

/**
 * 校验 Git 分支名的安全子集。
 *
 * 自动合并会把该值直接作为 GitLab 目标分支精确匹配，因此拒绝
 * `git check-ref-format --branch` 不接受的控制符与危险片段，不做通配或后缀解释。
 */
function normalizeTargetBranch(value: unknown): string {
  if (typeof value !== "string") throw new PromptValidationError("目标分支必须是字符串");
  const branch = value.trim();
  if (!branch) throw new PromptValidationError("目标分支必须非空");
  const parts = branch.split("/");
  const invalid = branch.startsWith("-") || branch.startsWith("/") || branch.endsWith("/") ||
    branch.endsWith(".") || branch.includes("//") || branch.includes("..") || branch.includes("@{") ||
    /[\u0000-\u0020\u007f~^:?*\[\\]/u.test(branch) ||
    parts.some((part) => part.startsWith(".") || part.endsWith(".lock"));
  if (invalid) throw new PromptValidationError(`目标分支格式非法：${branch}`);
  return branch;
}

/** 校验并复制完整自动合并策略，避免外部数组引用进入持久化模型。 */
function normalizeAutoMergePolicy(value: unknown, project: string): ProjectAutoMergePolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PromptValidationError("auto_merge_policy 必须是对象");
  }
  const policy = value as Record<string, unknown>;
  if (typeof policy.enabled !== "boolean") throw new PromptValidationError("自动合并 enabled 必须是布尔值");
  if (!Number.isInteger(policy.minimumScore)) throw new PromptValidationError("自动合并最低分必须是整数");
  const minimumScore = Number(policy.minimumScore);
  if (minimumScore < 1 || minimumScore > 100) throw new PromptValidationError("自动合并最低分必须在 1..100 之间");
  if (!Array.isArray(policy.targetBranches)) throw new PromptValidationError("自动合并目标分支必须是数组");
  const targetBranches = policy.targetBranches.map(normalizeTargetBranch);
  if (new Set(targetBranches).size !== targetBranches.length) throw new PromptValidationError("自动合并目标分支存在重复项");
  if (policy.enabled && targetBranches.length === 0) throw new PromptValidationError("启用自动合并时目标分支至少一项");
  if (policy.enabled && !isFullRepositoryProjectKey(project)) {
    throw new PromptValidationError("启用自动合并需要完整 namespace/project 项目路径");
  }
  if (policy.method !== "merge" && policy.method !== "squash") {
    throw new PromptValidationError("自动合并方式只能是 merge 或 squash");
  }
  if (typeof policy.removeSourceBranch !== "boolean") {
    throw new PromptValidationError("自动合并 remove_source_branch 必须是布尔值");
  }
  return {
    enabled: policy.enabled,
    minimumScore,
    targetBranches,
    method: policy.method,
    removeSourceBranch: policy.removeSourceBranch,
  };
}

/** 校验项目部分更新：只能修改最终关联中的项目，重复/冲突条目一并拒绝。 */
export function validateProjectSettings(
  settings: readonly ProjectReviewSettingPatch[] | undefined,
  projects: readonly string[],
  repository: string,
): ProjectReviewSettingPatch[] {
  if (settings === undefined) return [];
  if (!Array.isArray(settings)) throw new PromptValidationError("project_settings 必须是数组");
  if (repository === "default" && settings.length > 0) {
    throw new PromptValidationError("default 不允许配置项目执行设置");
  }
  const associated = new Set(projects.map(normalizeRepositoryKey));
  const seen = new Set<string>();
  return settings.map((entry) => {
    if (!entry || typeof entry !== "object" || typeof entry.project !== "string") {
      throw new PromptValidationError("项目设置必须包含 project 字符串");
    }
    const hasRepositoryContext = entry.repositoryContextEnabled !== undefined;
    const hasAutoMergePolicy = entry.autoMergePolicy !== undefined;
    if (!hasRepositoryContext && !hasAutoMergePolicy) {
      throw new PromptValidationError("项目设置至少包含一个执行配置");
    }
    if (hasRepositoryContext && typeof entry.repositoryContextEnabled !== "boolean") {
      throw new PromptValidationError("repository_context_enabled 必须是布尔值");
    }
    const project = normalizeRepositoryKey(entry.project);
    if (!project || !associated.has(project)) throw new PromptValidationError("项目设置必须属于当前关联项目");
    if (seen.has(project)) throw new PromptValidationError("项目设置存在重复条目");
    seen.add(project);
    if (entry.repositoryContextEnabled && !isRepositoryProjectKey(project)) {
      throw new PromptValidationError("开启仓库上下文需要合法的项目名或相对项目路径");
    }
    return {
      project,
      ...(hasRepositoryContext ? { repositoryContextEnabled: entry.repositoryContextEnabled } : {}),
      ...(hasAutoMergePolicy ? { autoMergePolicy: normalizeAutoMergePolicy(entry.autoMergePolicy, project) } : {}),
    };
  });
}

/** 保留名称：全局兜底不可改名，避免破坏 resolve 的兜底语义。 */
export const DEFAULT_PROMPT_REPOSITORY = "default";

/** 入口拒绝与排队任务复核共用固定文案，不能回显配置异常或任务凭据。 */
export const PROJECT_REVIEW_DENIED_MESSAGE = "项目未在 Prompt 管理中配置，拒绝评审";
/** 配置不可用与明确未关联分开处置，仍拒绝执行且不回显读取异常。 */
export const PROJECT_REVIEW_POLICY_UNAVAILABLE_MESSAGE = "读取项目评审白名单失败，拒绝评审";

/** 校验并规范化用户提交的 Prompt 名称；空值与超长拒绝。 */
export function normalizePromptName(value: unknown): string {
  if (typeof value !== "string") throw new PromptValidationError("名称必须是字符串");
  const name = value.trim();
  if (!name) throw new PromptValidationError("名称不能为空");
  if (name.length > 200) throw new PromptValidationError("名称不能超过 200 字符");
  return name;
}

/** 数据库中的评审 prompt。`repository` 为 `"default"` 时是全局默认。 */
export interface StoredPrompt {
  id: number;
  /** prompt 的名称/唯一键，也用于列表展示。 */
  repository: string;
  /**
   * 该 prompt 关联的 GitLab 项目全名列表；任一命中即使用本 prompt。
   *
   * 全局默认 prompt（`repository === "default"`）的 projects 为空数组——
   * 它不绑定具体项目，由 `resolve` 在无项目命中时兜底返回。
   */
  projects: string[];
  systemPrompt: string;
  /** 含 `{diffs_text}` / `{commits_text}` 占位符的模板。 */
  userPrompt: string;
  /** 独立共享规范；省略兼容旧调用方，仓储返回时规范化为空字符串。 */
  repositoryStandards?: string;
  /** 读取时为全部关联项目的完整执行设置。 */
  projectSettings?: ProjectReviewSetting[];
  wecomWebhookUrl?: string;
  wecomScoreThreshold?: number;
  /** 该 prompt 指定的 LLM 厂商 id；未设置时用全局默认厂商（D-022）。 */
  providerId?: number;
  /** 该 prompt 指定的模型 id；未设置时用厂商的 defaultModel。 */
  model?: string;
  /** Unix 毫秒；页面据此展示最近修改时间。 */
  updatedAt: number;
}

/** prompt 列表摘要：刻意不含正文，避免一次拉取全部 prompt。 */
export interface PromptSummary {
  id: number;
  repository: string;
  projects: string[];
  hasWecomWebhook: boolean;
  /** 列表不返回规范正文，仅返回存在性和项目状态。 */
  hasRepositoryStandards?: boolean;
  projectSettings?: ProjectReviewSetting[];
  wecomScoreThreshold?: number;
  providerId?: number;
  providerLabel?: string;
  model?: string;
  updatedAt: number;
}

/** 创建/更新 prompt 的入参。 */
export interface PromptInput {
  repository: string;
  /** 关联项目列表；省略时按空数组处理（仅 default 的常见情形）。 */
  projects?: string[];
  systemPrompt: string;
  userPrompt: string;
  /** 独立共享规范；省略兼容旧调用方，仓储返回时规范化为空字符串。 */
  repositoryStandards?: string;
  /** 创建/更新时为部分设置；省略能力表示保留原值。 */
  projectSettings?: ProjectReviewSettingPatch[];
  wecomWebhookUrl?: string;
  wecomScoreThreshold?: number;
  providerId?: number;
  model?: string;
}

/** prompt 仓储端口。实现方为 infrastructure/sqlite。 */
export interface PromptRepository {
  /**
   * 按项目全名解析 prompt；未命中时回落 `repository="default"` 的记录。
   * 两者都没有时返回 undefined，由调用方继续回落 yaml 与 Markdown 兜底链。
   */
  resolve(repositoryFullName?: string): StoredPrompt | undefined;
  /** 仅明确关联的非 default 项目可评审；匹配兼容 resolve，但不使用任何兜底配置授权。 */
  isProjectConfigured(repositoryFullName: string): boolean;
  list(): PromptSummary[];
  get(id: number): StoredPrompt | undefined;
  findByRepository(repository: string): StoredPrompt | undefined;
  /** 创建；`repository` 重复时抛错，错误消息含「已存在」供路由转 409。 */
  create(input: PromptInput): StoredPrompt;
  update(id: number, input: Omit<PromptInput, "repository"> & { repository?: string }): StoredPrompt;
  remove(id: number): void;
  /** 从规则目录导入 yaml；已存在的 repository 跳过。 */
  importFromDir(dir: string): { imported: number; skipped: number };
  /** 已关联到 prompt 的项目名合集，供前端下拉建议（去重排序）。 */
  listKnownProjects(): string[];
  /** 读取命中 Prompt 内最具体关联的开关，兼容旧短名；无有效关联/default 时关闭。 */
  isRepositoryContextEnabled?(repositoryFullName: string): boolean;
  /** 已知关联项目的名称级状态，供新增关联时展示，避免误用关闭默认值。 */
  listProjectSettings?(): ProjectReviewSetting[];
  /**
   * 精确读取完整 namespace/project 的执行设置。
   * 不接受短名/default/fallback，供自动合并等高风险动作使用。
   */
  resolveProjectSetting?(repositoryFullName: string): ProjectReviewSetting | undefined;
}
