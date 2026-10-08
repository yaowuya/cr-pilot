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
  hasWecomWebhook: boolean;
  wecomScoreThreshold?: number;
  updatedAt: number;
}

/** prompt 完整记录（列表接口不返回正文，需按 id 单独拉取）。 */
export interface StoredPrompt {
  id: number;
  repository: string;
  systemPrompt: string;
  userPrompt: string;
  wecomWebhookUrl?: string;
  wecomScoreThreshold?: number;
  updatedAt: number;
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
}

/** 管理员账号（不含任何密码字段）。 */
export interface AdminUser {
  id: number;
  username: string;
  createdAt: number;
}
