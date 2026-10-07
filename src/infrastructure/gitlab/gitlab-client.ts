import { createSilentLogger, type Logger } from "../../shared/logger.ts";
import type { Change, Commit, GitlabClient } from "../../domain/review-task.ts";

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
  /** GitLab 实例地址，允许带尾部斜杠（内部会规范化）。 */
  url: string;
  /** 访问令牌，只放进请求头，绝不写日志。 */
  token: string;
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

  const request = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const response = await fetchFn(
      `${baseUrl}${path}`,
      {
        ...init,
        headers: { "PRIVATE-TOKEN": options.token, ...(init.headers ?? {}) },
        signal: AbortSignal.timeout(options.timeoutMs),
      },
    );
    if (!response.ok) {
      throw new GitlabApiError(`GitLab API ${path} 返回 ${response.status}`, response.status);
    }
    return (await response.json()) as T;
  };

  return {
    async getMergeRequestChanges(projectId, iid) {
      const path = `/api/v4/projects/${projectId}/merge_requests/${iid}/changes?access_raw_diffs=true`;
      for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
        const payload = await request<{ changes?: Array<{ diff?: string; new_path?: string; old_path?: string }> }>(path);
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
          logger.warn("GitLab changes 为空，稍后重试", { attempt, projectId, iid });
          await delay(retryDelayMs);
        }
      }
      logger.warn("GitLab changes 重试后仍为空", { projectId, iid });
      return [];
    },

    async getMergeRequestCommits(projectId, iid) {
      const path = `/api/v4/projects/${projectId}/merge_requests/${iid}/commits`;
      const payload = await request<Array<{ id?: string; message?: string }>>(path);
      return payload
        .filter((commit) => typeof commit.id === "string")
        .map((commit) => ({ id: commit.id ?? "", message: commit.message ?? "" }));
    },

    async postMergeRequestNote(projectId, iid, body) {
      const path = `/api/v4/projects/${projectId}/merge_requests/${iid}/notes`;
      await request(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      });
      logger.info("评论已回写 GitLab", { projectId, iid });
    },
  };
}

/** 可中断的延迟；实际超时由请求的 AbortSignal 负责，这里只是重试间隔。 */
function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
