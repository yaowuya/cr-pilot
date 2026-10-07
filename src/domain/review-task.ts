/**
 * 评审领域核心模型与端口。
 *
 * 本文件是领域层（domain）的根：任务、变更、提交等业务模型，以及对外部世界
 * 的端口（port）。领域层不依赖任何外层（HTTP / 应用 / 基础设施），所有实现
 * 由 infrastructure 层注入，编排由 application 层完成。
 */

/** GitLab API 返回的单个文件变更。字段名与 GitLab `/changes` 响应一致。 */
export interface Change {
  /** 变更后的文件路径。 */
  newPath: string;
  /** 变更前的文件路径。 */
  oldPath: string;
  /** 该文件的 unified diff 文本。 */
  diff: string;
}

/** GitLab API 返回的单条提交摘要。 */
export interface Commit {
  id: string;
  message: string;
}

/** 一个待处理的 MR 任务：webhook 分派后进入队列。 */
export interface MergeRequestTask {
  projectId: number;
  iid: number;
  fullName: string;
  sourceBranch: string;
  targetBranch: string;
}

/** 一次评审的输入。systemPrompt 是 prompt 文件全文，code 是待评审内容。 */
export interface ReviewInput {
  systemPrompt: string;
  code: string;
  context?: string;
  signal: AbortSignal;
}

/** 评审结果。model 取自实际会话，便于调用方确认真正生效的模型。 */
export interface ReviewResult {
  text: string;
  model: string;
}

/**
 * 评审执行者端口。实现方（infrastructure/pi）负责创建与释放 pi 会话；
 * 超时由调用方按信号状态判定。测试可注入假实现。
 */
export interface Reviewer {
  review(input: ReviewInput): Promise<ReviewResult>;
}

/**
 * GitLab 集成端口：拉取 MR 变更与提交、回写评论。
 * 由 infrastructure/gitlab 实现；application 层只依赖本端口。
 */
export interface GitlabClient {
  getMergeRequestChanges(projectId: number, iid: number): Promise<Change[]>;
  getMergeRequestCommits(projectId: number, iid: number): Promise<Commit[]>;
  postMergeRequestNote(projectId: number, iid: number, body: string): Promise<void>;
}
