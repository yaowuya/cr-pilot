/**
 * 评审 prompt 的领域模型与持久化端口。
 *
 * 语义（P-015 / D-015 / D-016）：prompt 以数据库为准，yaml 文件降级为
 * 初始导入源与兜底；每次评审按项目读取，因此页面保存后下一次评审即生效。
 *
 * 多项目关联（D-020）：一条 prompt 可同时关联多个 GitLab 项目，任一项目命中即
 * 使用该 prompt。这样同一套评审规则不必为同组项目各存一份。`repository` 字段
 * 保留为「主键名」用于展示与唯一约束，实际匹配走 `projects` 列表。
 */

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
  list(): PromptSummary[];
  get(id: number): StoredPrompt | undefined;
  findByRepository(repository: string): StoredPrompt | undefined;
  /** 创建；`repository` 重复时抛错，错误消息含「已存在」供路由转 409。 */
  create(input: PromptInput): StoredPrompt;
  update(id: number, input: Omit<PromptInput, "repository">): StoredPrompt;
  remove(id: number): void;
  /** 从规则目录导入 yaml；已存在的 repository 跳过。 */
  importFromDir(dir: string): { imported: number; skipped: number };
  /** 已关联到 prompt 的项目名合集，供前端下拉建议（去重排序）。 */
  listKnownProjects(): string[];
}
