/**
 * 评审领域核心模型与端口。
 *
 * 本文件是领域层（domain）的根：任务、变更、提交等业务模型，以及对外部世界
 * 的端口（port）。领域层不依赖任何外层（HTTP / 应用 / 基础设施），所有实现
 * 由 infrastructure 层注入，编排由 application 层完成。
 */
import type { DiscussionPosition } from "./inline-comment.ts";
import type { RepositoryReadAccess, RepositoryReviewSnapshot } from "./repository-context.ts";

export type { DiscussionPosition };

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
  notes: {
    id: number;
    body: string;
    position?: Record<string, unknown>;
    /** 该条评论是否可被标记解决（只有行内评论为 true）。 */
    resolvable?: boolean;
    /** 是否已被标记解决；采纳追踪的辅助信号。缺失按 false 处理。 */
    resolved?: boolean;
  }[];
}

/** 一个待处理的 MR 任务：webhook 分派后进入队列。 */
export interface MergeRequestTask {
  projectId: number;
  iid: number;
  fullName: string;
  sourceBranch: string;
  targetBranch: string;
  /**
   * MR 作者的 GitLab 用户 ID，取自 `object_attributes.author_id`。
   *
   * 与 `triggerUserName` 严格区分：一次 MR 会产生多次 webhook（创建、更新、
   * 评论、打标签、CI 状态变化），每次触发者可能不同，但 MR 作者始终是同一人。
   * 评审记录要统计「谁提交的 MR」，必须用这个字段而不是触发者。
   *
   * payload 里只有作者 ID、没有名字，名字需另外调 GitLab API 解析。
   */
  authorId?: number;
  /**
   * 事件触发者的显示名，取自 webhook payload 的 `user.name`。
   *
   * 仅作为作者名解析失败时的兜底：查用户接口可能因 token 无 read_user 权限
   * 而返回 403，此时至少还能记下「是谁触发了这次评审」。
   */
  triggerUserName?: string;
  /** 该事件来源的 GitLab 实例地址（webhook 派生）；缺省时客户端回落到全局配置。 */
  gitlabUrl?: string;
  /** 该事件携带的 GitLab 访问令牌（webhook 请求头 X-Gitlab-Token）。 */
  gitlabToken?: string;
  /**
   * 本次事件的用途：触发完整评审，还是只为采纳追踪登记一次「有新提交」。
   *
   * `update` 事件且带 `oldrev` 表示 MR 有新提交：此时只需重新判定已有建议的
   * 采纳状态，不该再跑一次完整评审——重复评审会浪费模型算力，也会重复发评论
   * （虽然 marker 会去重，但结果与耗时都无意义）。
   *
   * 缺省视为 `review`，保证既有调用方与测试行为不变。
   */
  eventKind?: "review" | "tracking";
}

/**
 * 一次评审的输入。systemPrompt 是 prompt 文件全文，code 是待评审内容。
 *
 * `provider` / `model` 为可选的模型选择（D-022）：未指定时评审执行者使用
 * `pi-agent/models.json` 里的既有默认配置，保证老部署与未配置厂商时仍可运行。
 */
export interface ReviewInput {
  /** 可选的固定仓库只读能力；不能用任意本地目录替代。 */
  repositoryContext?: RepositoryReadAccess;
  systemPrompt: string;
  code: string;
  context?: string;
  signal: AbortSignal;
  /** 目标厂商在 models.json 里的 provider key。 */
  provider?: string;
  /** 目标模型 id。 */
  model?: string;
  /** 该厂商的 apiKey（运行时注入，不落 models.json 明文）。 */
  apiKey?: string;
  /** 该厂商的 API 基地址；与 models.json 里的配置一致时可不传。 */
  baseUrl?: string;
  /** 该厂商的协议类型。 */
  api?: string;
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
  /** 开启仓库上下文时使用固定 diff version 与源项目；旧调用方不必实现。 */
  getRepositoryReviewSnapshot?(projectId: number, iid: number, gitlabUrl?: string, gitlabToken?: string): Promise<RepositoryReviewSnapshot>;
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
  /**
   * 取该 MR 当前最新的 head sha。
   *
   * 采纳追踪用它判断「评审之后有没有新提交」：与建议记录里的 head_sha 相同
   * 说明目标行不可能变化，可以直接跳过，省掉逐条文件读取。
   */
  getLatestHeadSha(projectId: number, iid: number, gitlabUrl?: string, gitlabToken?: string): Promise<string>;
  /**
   * 读取某文件在指定 head 下的原始内容。
   *
   * 追踪判定需要「评审后这一行现在长什么样」，diff 无法还原完整文件上下文，
   * 因此取 raw 文件。文件在该版本不存在时应抛出异常，由调用方记为 unknown，
   * 不要返回空串——空串会被误判为「整行被删除」。
   */
  getFileRaw(
    projectId: number,
    iid: number,
    path: string,
    headSha: string,
    gitlabUrl?: string,
    gitlabToken?: string,
  ): Promise<string>;
  /**
   * 按用户 ID 查 GitLab 用户，用于把 MR 作者 ID 解析成显示名。
   *
   * 为什么需要单独查：MR webhook 的 `object_attributes` 只带 `author_id`
   * （数字），不带作者名字。要正确统计「谁提交的 MR」就必须多调这一次接口。
   *
   * 实现方在失败时应抛出异常，由调用方决定降级——不要在这里吞掉错误，
   * 否则调用方无法区分「用户不存在」与「网络抖动」。
   */
  getUser(userId: number, gitlabUrl?: string, gitlabToken?: string): Promise<GitlabUser>;
}

/** GitLab 用户的对外可见信息（只取展示需要的字段）。 */
export interface GitlabUser {
  /** 数字用户 ID。 */
  id: number;
  /** 显示名，如「郭豪[guohao]」；可能为空串。 */
  name: string;
  /** 登录名，如 `guohao`；name 为空时用它兜底。 */
  username: string;
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
