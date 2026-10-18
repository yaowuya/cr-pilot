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

/** 基础统计。`avgScore` 为 null 表示没有任何带分数的记录。 */
export interface ReviewStats {
  total: number;
  projectCount: number;
  committerCount: number;
  avgScore: number | null;
  daily: { date: string; count: number; avgScore: number | null }[];
}

/** prompt 列表摘要：不含正文。 */
export interface PromptSummary {
  id: number;
  repository: string;
  /** 关联的 GitLab 项目全名列表；任一命中即使用该 prompt。 */
  projects: string[];
  hasWecomWebhook: boolean;
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
  wecomWebhookUrl?: string;
  wecomScoreThreshold?: number;
  providerId?: number;
  model?: string;
  updatedAt: number;
}

/** prompt 页的下拉建议数据：已关联项目 + 可用厂商。 */
export interface PromptMeta {
  projects: string[];
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
