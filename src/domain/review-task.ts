/**
 * 评审领域核心模型与端口。
 *
 * 本文件是领域层（domain）的根：任务、变更、提交等业务模型，以及对外部世界
 * 的端口（port）。领域层不依赖任何外层（HTTP / 应用 / 基础设施），所有实现
 * 由 infrastructure 层注入，编排由 application 层完成。
 */
import type { DiscussionPosition } from "./inline-comment.ts";

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

/** MR 最新 diff version 的三个 SHA。GitLab position 必需，缺任一项评论无法定位。 */
export interface DiffRefs {
  baseSha: string;
  startSha: string;
  headSha: string;
}

/** Discussions API 的行内讨论；notes[].position 用于发布后回读校验。 */
export interface Discussion {
  id: string;
  notes: { id: number; body: string; position?: Record<string, unknown> }[];
}

/** 一个待处理的 MR 任务：webhook 分派后进入队列。 */
export interface MergeRequestTask {
  projectId: number;
  iid: number;
  fullName: string;
  sourceBranch: string;
  targetBranch: string;
  /** 该事件来源的 GitLab 实例地址（webhook 派生）；缺省时客户端回落到全局配置。 */
  gitlabUrl?: string;
  /** 该事件携带的 GitLab 访问令牌（webhook 请求头 X-Gitlab-Token）。 */
  gitlabToken?: string;
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
 *
 * `gitlabUrl` 与 `gitlabToken` 参数是任务级实例信息（来自 webhook），实现方应
 * 优先使用它们；为空时回落到构造时的全局配置。
 */
export interface GitlabClient {
  getMergeRequestChanges(projectId: number, iid: number, gitlabUrl?: string, gitlabToken?: string): Promise<Change[]>;
  getMergeRequestCommits(projectId: number, iid: number, gitlabUrl?: string, gitlabToken?: string): Promise<Commit[]>;
  postMergeRequestNote(projectId: number, iid: number, body: string, gitlabUrl?: string, gitlabToken?: string): Promise<void>;
  /**
   * 取 MR 最新 diff version 的三个 SHA。
   *
   * GitLab 行内评论的 position 必须携带这三个值，而它们属于版本信息、不应由模型输出，
   * 因此由服务端拉取（对齐参考实现 `gitlab_mr_review.py:131-142`）。
   */
  getMergeRequestVersions(projectId: number, iid: number, gitlabUrl?: string, gitlabToken?: string): Promise<DiffRefs>;
  /** 发布一条行内讨论（带 position）。 */
  postDiscussion(
    projectId: number,
    iid: number,
    body: string,
    position: DiscussionPosition,
    gitlabUrl?: string,
    gitlabToken?: string,
  ): Promise<Discussion>;
  /** 拉取该 MR 的全部讨论，用于幂等判重与发布后校验。 */
  getDiscussions(projectId: number, iid: number, gitlabUrl?: string, gitlabToken?: string): Promise<Discussion[]>;
}

/**
 * 企业微信通知端口：把 Markdown 消息发到群机器人。
 * 由 infrastructure/wecom 实现；webhookUrl 由规则集按仓库解析后由调用方注入。
 */
export interface WecomNotifier {
  send(webhookUrl: string, markdown: string): Promise<void>;
}

/**
 * 从 webhook 派生 GitLab 实例地址（纯函数，domain 层）。
 *
 * 优先级：`X-Gitlab-Instance` 请求头 > payload `repository.homepage` 的 origin
 * 部分。都缺失时返回空串——现代 GitLab 的 webhook 一定带 `X-Gitlab-Instance`，
 * 这里只取 origin（scheme://host[:port]），丢弃路径部分。
 */
export function deriveGitlabInstanceUrl(
  instanceHeader: string | undefined,
  homepage: string | undefined,
): string {
  const candidate = instanceHeader?.trim() || homepage?.trim() || "";
  try {
    const url = new URL(candidate);
    return url.origin;
  } catch {
    return "";
  }
}
