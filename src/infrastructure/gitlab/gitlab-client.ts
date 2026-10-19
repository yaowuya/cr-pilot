import { createSilentLogger, type Logger } from "../../shared/logger.ts";
import type { Change, Commit, Discussion, DiscussionPosition, DiffRefs, GitlabClient } from "../../domain/review-task.ts";

export type { Change, Commit, GitlabClient };

/** GitLab API 调用失败。`status` 是 HTTP 状态码，调用方据此区分鉴权与网络问题。 */
export class GitlabApiError extends Error {
  override readonly name = "GitlabApiError";
  /** HTTP 状态码。 */
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

interface CreateGitlabClientOptions {
  /** GitLab 实例地址，允许带尾部斜杠（内部会规范化）。可为空串，任务级 URL 兜底。 */
  url: string;
  /** 单次请求超时毫秒数。 */
  timeoutMs: number;
  /** 为 true 时跳过 TLS 证书校验，仅用于内网自签名。 */
  insecureTls: boolean;
  logger: Logger;
  /** 可注入的 fetch，测试用。 */
  fetchFn?: typeof fetch;
  /** changes 为空时的重试间隔毫秒数，测试可缩短。 */
  retryDelayMs?: number;
}

/** changes 为空时的最大重试次数。GitLab 生成 diff 有延迟，空结果可能是时序问题。 */
const MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 10000;

/**
 * 创建 GitLab API 客户端（实现 domain 的 `GitlabClient` 端口）。
 *
 * 用全局 fetch（undici）而不是新增 HTTP 依赖。undici 是 pi SDK 的传递依赖，
 * 可解析但不提升为直接依赖。
 *
 * 访问令牌不在构造时固定：webhook 请求头的 X-Gitlab-Token 随事件携带，每个
 * 项目 token 独立，任务级 token 在每次调用时传入（对齐参考项目）。
 */
export function createGitlabClient(options: CreateGitlabClientOptions): GitlabClient {
  const { logger } = options;
  const baseUrl = options.url.replace(/\/+$/, "");
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const fetchFn = options.fetchFn ?? fetch;

  // Node 22 的全局 fetch 不接受第三方 undici Agent 实例作 dispatcher（instanceof
  // 检查失败，报 UND_ERR_INVALID_ARG），因此内网自签名的处理只能用进程级
  // NODE_TLS_REJECT_UNAUTHORIZED=0 环境变量。此处只告警提示，不再构造 dispatcher。
  if (options.insecureTls && process.env.NODE_TLS_REJECT_UNAUTHORIZED !== "0") {
    logger.warn(
      "GITLAB_INSECURE_TLS 已启用但未生效：Node 无法对单个请求关闭 TLS 校验。" +
        "如需信任自签名证书，请设置 NODE_TLS_REJECT_UNAUTHORIZED=0 或配置 NODE_EXTRA_CA_CERTS 后重启进程。",
    );
  }

  const request = async <T>(gitlabUrl: string, gitlabToken: string, path: string, init: RequestInit = {}): Promise<T> => {
    const base = (gitlabUrl || baseUrl).replace(/\/+$/, "");
    const response = await fetchFn(
      `${base}${path}`,
      {
        ...init,
        headers: { "PRIVATE-TOKEN": gitlabToken, ...(init.headers ?? {}) },
        signal: AbortSignal.timeout(options.timeoutMs),
      },
    );
    if (!response.ok) {
      // 把响应体带进错误消息：GitLab 的 403 往往在 body 里写明了拒绝原因
      // （如 token 无写权限、MR 状态不允许评论等），只看状态码无法定位。
      const detail = await response.text().catch(() => "");
      throw new GitlabApiError(
        `GitLab API ${path} 返回 ${response.status}${detail ? `：${detail.slice(0, 300)}` : ""}`,
        response.status,
      );
    }
    return (await response.json()) as T;
  };

  /**
   * 与 `request` 相同，但额外返回 `x-next-page` 头。
   *
   * 只有 discussions 需要翻页（同一 MR 的讨论可能跨页），单独提供而不是改造 `request`
   * 的返回形状，避免所有既有调用点跟着改。
   */
  const requestWithHeaders = async <T>(
    gitlabUrl: string,
    gitlabToken: string,
    path: string,
  ): Promise<{ payload: T; nextPage: string }> => {
    const base = (gitlabUrl || baseUrl).replace(/\/+$/, "");
    const response = await fetchFn(`${base}${path}`, {
      headers: { "PRIVATE-TOKEN": gitlabToken },
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new GitlabApiError(
        `GitLab API ${path} 返回 ${response.status}${detail ? `：${detail.slice(0, 300)}` : ""}`,
        response.status,
      );
    }
    return { payload: (await response.json()) as T, nextPage: response.headers.get("x-next-page") ?? "" };
  };

  return {
    async getMergeRequestChanges(projectId, iid, gitlabUrl = "", gitlabToken = "") {
      const path = `/api/v4/projects/${projectId}/merge_requests/${iid}/changes?access_raw_diffs=true`;
      for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
        const payload = await request<{ changes?: Array<{ diff?: string; new_path?: string; old_path?: string }> }>(gitlabUrl, gitlabToken, path);
        const changes = (payload.changes ?? [])
          .filter((change) => typeof change.diff === "string")
          .map((change) => ({
            newPath: change.new_path ?? "",
            oldPath: change.old_path ?? "",
            diff: change.diff ?? "",
          }));
        if (changes.length > 0) {
          return changes;
        }
        if (attempt < MAX_RETRIES) {
          logger.warn("GitLab changes 为空，稍后重试", { 重试次数: attempt, 项目ID: projectId, MR编号: iid });
          await delay(retryDelayMs);
        }
      }
      logger.warn("GitLab changes 重试后仍为空", { 项目ID: projectId, MR编号: iid });
      return [];
    },

    async getMergeRequestCommits(projectId, iid, gitlabUrl = "", gitlabToken = "") {
      const path = `/api/v4/projects/${projectId}/merge_requests/${iid}/commits`;
      const payload = await request<Array<{ id?: string; message?: string }>>(gitlabUrl, gitlabToken, path);
      return payload
        .filter((commit) => typeof commit.id === "string")
        .map((commit) => ({ id: commit.id ?? "", message: commit.message ?? "" }));
    },

    async postMergeRequestNote(projectId, iid, body, gitlabUrl = "", gitlabToken = "") {
      const path = `/api/v4/projects/${projectId}/merge_requests/${iid}/notes`;
      await request(gitlabUrl, gitlabToken, path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      });
      logger.info("评论已回写 GitLab", { 项目ID: projectId, MR编号: iid });
    },

    async getMergeRequestVersions(projectId, iid, gitlabUrl = "", gitlabToken = "") {
      const path = `/api/v4/projects/${projectId}/merge_requests/${iid}/versions`;
      const versions = await request<Array<{ base_commit_sha?: string; start_commit_sha?: string; head_commit_sha?: string }>>(
        gitlabUrl,
        gitlabToken,
        path,
      );
      // 取最新 diff version（数组首项）。没有版本信息时无法构造任何 position，
      // 早失败好过逐条评论降级——调用方据此把该 MR 的 findings 全部并入汇总。
      const latest = versions[0];
      if (!latest?.base_commit_sha || !latest.start_commit_sha || !latest.head_commit_sha) {
        throw new GitlabApiError(`MR !${iid} 没有 diff 版本，无法发布行内评论`, 200);
      }
      return {
        baseSha: latest.base_commit_sha,
        startSha: latest.start_commit_sha,
        headSha: latest.head_commit_sha,
      };
    },

    async postDiscussion(projectId, iid, body, position, gitlabUrl = "", gitlabToken = "") {
      const path = `/api/v4/projects/${projectId}/merge_requests/${iid}/discussions`;
      const created = await request<{ id?: string; notes?: Array<{ id?: number; body?: string; position?: Record<string, unknown> }> }>(
        gitlabUrl,
        gitlabToken,
        path,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ body, position }),
        },
      );
      return {
        id: String(created.id ?? ""),
        notes: (created.notes ?? []).map((note) => ({
          id: Number(note.id ?? 0),
          body: note.body ?? "",
          position: note.position,
        })),
      };
    },

    async getDiscussions(projectId, iid, gitlabUrl = "", gitlabToken = "") {
      const basePath = `/api/v4/projects/${projectId}/merge_requests/${iid}/discussions`;
      type RawDiscussion = { id?: string; notes?: Array<{ id?: number; body?: string; position?: Record<string, unknown> }> };
      const collected: Discussion[] = [];
      // 同一 MR 的讨论可能跨页：必须按 x-next-page 翻页合并，否则幂等判重会漏掉
      // 后续页上已发布的 marker，导致重复发评论。
      let page = 1;
      for (;;) {
        const separator = basePath.includes("?") ? "&" : "?";
        const { payload, nextPage } = await requestWithHeaders<RawDiscussion[]>(
          gitlabUrl,
          gitlabToken,
          `${basePath}${separator}per_page=100&page=${page}`,
        );
        for (const item of payload) {
          collected.push({
            id: String(item.id ?? ""),
            notes: (item.notes ?? []).map((note) => ({
              id: Number(note.id ?? 0),
              body: note.body ?? "",
              position: note.position,
            })),
          });
        }
        if (!nextPage || payload.length === 0) break;
        page = Number(nextPage);
        if (!Number.isInteger(page) || page < 2) break;
      }
      return collected;
    },
  };
}

/** 可中断的延迟；实际超时由请求的 AbortSignal 负责，这里只是重试间隔。 */
function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
