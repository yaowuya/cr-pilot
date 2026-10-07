/**
 * 评审 prompt 的领域模型与持久化端口。
 *
 * 语义（P-015 / D-015 / D-016）：prompt 以数据库为准，yaml 文件降级为
 * 初始导入源与兜底；每次评审按项目读取，因此页面保存后下一次评审即生效。
 */

/** 数据库中的评审 prompt。`repository` 为 `"default"` 时是全局默认。 */
export interface StoredPrompt {
  id: number;
  /** GitLab 项目全名，或保留值 `"default"`。 */
  repository: string;
  systemPrompt: string;
  /** 含 `{diffs_text}` / `{commits_text}` 占位符的模板。 */
  userPrompt: string;
  wecomWebhookUrl?: string;
  wecomScoreThreshold?: number;
  /** Unix 毫秒；页面据此展示最近修改时间。 */
  updatedAt: number;
}

/** prompt 列表摘要：刻意不含正文，避免一次拉取全部 prompt。 */
export interface PromptSummary {
  id: number;
  repository: string;
  hasWecomWebhook: boolean;
  wecomScoreThreshold?: number;
  updatedAt: number;
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
  create(input: {
    repository: string;
    systemPrompt: string;
    userPrompt: string;
    wecomWebhookUrl?: string;
    wecomScoreThreshold?: number;
  }): StoredPrompt;
  update(
    id: number,
    input: { systemPrompt: string; userPrompt: string; wecomWebhookUrl?: string; wecomScoreThreshold?: number },
  ): StoredPrompt;
  remove(id: number): void;
  /** 从规则目录导入 yaml；已存在的 repository 跳过。 */
  importFromDir(dir: string): { imported: number; skipped: number };
}
