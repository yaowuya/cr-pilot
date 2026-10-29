/**
 * 后端返回结构的类型声明。
 *
 * 与后端接口契约一一对应（见 `design/backend.md#接口、权限与兼容边界`）。
 * 字段为 snake_case 的地方保留后端原样，避免前后端各用一套命名造成映射错误。
 */

/** 评审明细记录。`score` 为 null 表示未解析出分数，与 0 分不同。 */
export interface ReviewRecord {
  projectId: number;
  projectName: string;
  mrIid: number;
  committerName: string;
  changeCount: number;
  batchCount: number;
  score: number | null;
  durationMs: number;
  result: "success" | "failed";
  errorMessage: string | null;
  commentUrl: string | null;
  /** MR 的 GitLab web 地址，供页面点击跳转；历史记录可能为 null。 */
  mrUrl: string | null;
  startedAt: number;
  finishedAt: number;
}

/** 单维度聚合结果（按项目或按提交人）。 */
export interface DimensionStat {
  /** 分组键：项目全名或提交人姓名。 */
  name: string;
  /** 评审次数。 */
  count: number;
  /** 平均分；该组全部记录都没有分数时为 null（不是 0）。 */
  avgScore: number | null;
  /** 最低分；无带分数记录时为 null。 */
  minScore: number | null;
  /** 最高分；无带分数记录时为 null。 */
  maxScore: number | null;
}

/** 基础统计。`avgScore` 为 null 表示没有任何带分数的记录。 */
export interface ReviewStats {
  total: number;
  projectCount: number;
  committerCount: number;
  avgScore: number | null;
  daily: { date: string; count: number; avgScore: number | null }[];
  /** 按项目聚合，按评审次数降序。 */
  byProject: DimensionStat[];
  /** 按提交人聚合，按评审次数降序。 */
  byCommitter: DimensionStat[];
}

/** GitLab 合并接口支持的策略；不提供 rebase 等隐式降级方式。 */
export type AutoMergeMethod = "merge" | "squash";

/** 项目级自动合并策略。默认关闭，启用后仍受服务端固定安全门约束。 */
export interface ProjectAutoMergePolicy {
  enabled: boolean;
  /** 评审最低分，闭区间 1..100。 */
  minimumScore: number;
  /** 只做精确分支名匹配，不是 glob 或正则。 */
  targetBranches: string[];
  method: AutoMergeMethod;
  removeSourceBranch: boolean;
}

/** 项目名称级执行配置：同项目在不同 Prompt 中共享，不等同逐实例租户配置。 */
export interface ProjectReviewSetting {
  project: string;
  repositoryContextEnabled: boolean;
  /** 旧服务响应可缺省；前端按默认关闭处理。 */
  autoMergePolicy?: ProjectAutoMergePolicy;
}

/** prompt 列表摘要：不含正文。 */
export interface PromptSummary {
  id: number;
  repository: string;
  /** 关联的 GitLab 项目全名列表；任一命中即使用该 prompt。 */
  projects: string[];
  hasWecomWebhook: boolean;
  hasRepositoryStandards?: boolean;
  projectSettings?: ProjectReviewSetting[];
  wecomScoreThreshold?: number;
  /** 指定的 LLM 厂商 id；未设置时用全局默认。 */
  providerId?: number;
  /** 厂商展示名；厂商已被删除时为空。 */
  providerLabel?: string;
  model?: string;
  updatedAt: number;
}

/** prompt 完整记录（列表接口不返回正文，需按 id 单独拉取）。 */
export interface StoredPrompt {
  id: number;
  repository: string;
  projects: string[];
  systemPrompt: string;
  userPrompt: string;
  repositoryStandards?: string;
  projectSettings?: ProjectReviewSetting[];
  wecomWebhookUrl?: string;
  wecomScoreThreshold?: number;
  providerId?: number;
  model?: string;
  updatedAt: number;
}

/** prompt 页的下拉建议数据：已关联项目 + 可用厂商。 */
export interface PromptMeta {
  projects: string[];
  projectSettings?: ProjectReviewSetting[];
  providers: {
    id: number;
    label: string;
    name: string;
    models: string[];
    defaultModel?: string;
    isDefault: boolean;
  }[];
}

/** LLM 厂商协议类型。 */
export type LlmApiKind = "openai-responses" | "openai-completions" | "anthropic-messages";

/** 厂商列表项（密钥只回掩码）。 */
export interface LlmProviderSummary {
  id: number;
  name: string;
  label: string;
  kind: string;
  baseUrl: string;
  hasApiKey: boolean;
  apiKeyMasked?: string;
  api: LlmApiKind;
  models: string[];
  defaultModel?: string;
  isDefault: boolean;
  updatedAt: number;
}

/** 项目级厂商绑定。 */
export interface LlmProjectBinding {
  project: string;
  providerId: number;
  model?: string;
}

/** 厂商列表接口响应。 */
export interface LlmProvidersResponse {
  items: LlmProviderSummary[];
  bindings: LlmProjectBinding[];
}

/** 内置厂商模板（新建时预填）。 */
export interface LlmProviderTemplate {
  kind: string;
  label: string;
  baseUrl: string;
  api: LlmApiKind;
  models: string[];
}

/** 环境变量项。`masked` 为 true 时 `value` 已是掩码。 */
export interface ConfigItem {
  key: string;
  value: string;
  masked: boolean;
  restartRequired: boolean;
  overridden: boolean;
  /** 为 true 时页面只读展示（启动引导类键，如 DB_PATH）。 */
  readOnly: boolean;
  /** 中文名，如「监听端口」；未登记的键为空串。 */
  label: string;
  /** 用途说明。 */
  description: string;
  /** 生效默认值；空串表示默认未设置。 */
  defaultValue: string;
  /** 取值提示，如单位、可选值、格式示例。 */
  hint: string;
}

/** 管理员账号（不含任何密码字段）。 */
export interface AdminUser {
  id: number;
  username: string;
  /** 是否具备管理员权限（由后端按 ADMIN_USERNAME 计算，不存数据库）。 */
  isAdmin: boolean;
  createdAt: number;
}

/** 登录/校验登录态接口的响应。 */
export interface AuthResult {
  username: string;
  /** 是否管理员：前端据此隐藏「管理员」菜单并拦截路由。 */
  isAdmin: boolean;
}

/**
 * GitLab 账号到企微成员的映射。
 *
 * 页面只收已配置标记与中间掩码；明文 userid 留在服务端供正式通知解析。
 * `hasWecomUserId` 为 false 时通知只能显示 `@姓名`，不会真正提醒成员。
 */
export interface WecomContact {
  gitlabUsername: string;
  wecomName: string;
  hasWecomUserId: boolean;
  wecomUserIdMasked: string;
  updatedAt: number;
}

/**
 * 一组维度的采纳聚合。
 *
 * `rate` 为 0-1；分母为 0 时为 null，页面必须显示「—」而不是 0%——
 * 「没有可统计的数据」和「一条都没采纳」是两个完全不同的结论。
 */
export interface AdoptionDimensionRow {
  name: string;
  /** 仅项目维度返回，供采纳工作台按项目过滤。 */
  projectId?: number;
  /** 已完成判定、进入采纳率分母的建议数。 */
  tracked: number;
  adopted: number;
  /** 有代码行锚点、等待新提交或 MR 结束判定的建议数。 */
  pending: number;
  rate: number | null;
}

/** 采纳统计：可统计部分与不可统计部分分开呈现。 */
export interface AdoptionStats {
  total: { tracked: number; adopted: number; pending: number; rate: number | null };
  /** 不可统计条数：`fallback` 为降级并入汇总，`unknown` 为无法定位。 */
  untrackable: { fallback: number; unknown: number };
  byProject: AdoptionDimensionRow[];
  byCommitter: AdoptionDimensionRow[];
  bySeverity: AdoptionDimensionRow[];
}

/** 功能自检任务状态。 */
export type VerifyTaskStatus = "running" | "success" | "failed";

/** 功能自检任务结果。 */
export interface VerifyTask {
  id: string;
  /** 验证类型：AI 评审或企微推送。 */
  kind: "ai" | "wecom";
  status: VerifyTaskStatus;
  message: string;
  detail: string;
  durationMs: number;
  startedAt: number;
  finishedAt: number | null;
}

/**
 * 可选的企微机器人。
 *
 * 机器人身份就是规则文件里的 `wecom_webhook_url`；地址含密钥，后端只下发
 * 脱敏 key 与派生 id，前端永远拿不到原始地址。
 */
export interface WecomBot {
  id: string;
  maskedKey: string;
  repositories: string[];
}
