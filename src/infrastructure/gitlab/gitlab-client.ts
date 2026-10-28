import { createHash } from "node:crypto";
import { STATUS_CODES } from "node:http";
import { createSilentLogger, type Logger } from "../../shared/logger.ts";
import type { Change, Commit, Discussion, DiscussionPosition, DiffRefs, GitlabClient } from "../../domain/review-task.ts";
import { isGitObjectId, parseGitlabHttpUrl, validateRepositoryUrl } from "../../domain/repository-context.ts";

export type { Change, Commit, GitlabClient };

/** 响应格式不是权限结论；只有明确的 HTML 拦截页标题才标为 waf。 */
type GitlabErrorResponseKind = "json" | "waf" | "html" | "unknown";

/** GitLab HTTP 调用失败。保留状态码，并区分 API JSON 与前置网关的错误页。 */
export class GitlabApiError extends Error {
  override readonly name = "GitlabApiError";
  /** HTTP 状态码。 */
  readonly status: number;
  /** 响应证据类别，不据此推断请求是否已经写入或是否可安全重试。 */
  readonly responseKind: GitlabErrorResponseKind;
  constructor(message: string, status: number, responseKind: GitlabErrorResponseKind = "unknown") {
    super(message);
    this.status = status;
    this.responseKind = responseKind;
  }
}

/** 仅定位诊断用标题：按顺序跳过注释、原始文本和嵌套模板，不渲染页面或执行脚本。 */
function findPageTitle(detail: string): string {
  // 整个属性值作为一个 token 消费，避免把 content="<title>示例</title>" 当成标签。
  const tags = /<!--[\s\S]*?(?:-->|$)|<![^>]*>|<(\/?)([a-z][a-z0-9:-]*)\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi;
  let templateDepth = 0;
  for (let tag = tags.exec(detail); tag; tag = tags.exec(detail)) {
    const name = tag[2]?.toLowerCase();
    if (!name) continue;
    const closing = tag[1] === "/";
    if (name === "template") {
      templateDepth = Math.max(0, templateDepth + (closing ? -1 : 1));
      continue;
    }
    if (!closing && /^(title|script|style|textarea)$/.test(name)) {
      // 原始文本中的 <!--、<template> 等没有外层语义，必须直接跳到对应结束标签。
      const end = new RegExp(`</${name}\\s*>`, "gi");
      end.lastIndex = tags.lastIndex;
      const match = end.exec(detail);
      if (!match) return "";
      const text = detail.slice(tags.lastIndex, match.index);
      tags.lastIndex = end.lastIndex;
      if (name === "title" && templateDepth === 0) return text;
    }
  }
  return "";
}

/** 优先解析 JSON，避免把 API message 中引用的 HTML/WAF 示例误判成拦截页。 */
function describeErrorBody(detail: string, contentType: string | undefined): { kind: GitlabErrorResponseKind; message?: string } {
  try {
    const payload: unknown = JSON.parse(detail);
    const message = typeof payload === "object" && payload !== null && "message" in payload && typeof payload.message === "string"
      ? payload.message : undefined;
    return { kind: "json", message };
  } catch {
    const html = contentType === "text/html" || contentType === "application/xhtml+xml" || /^\s*(?:<!doctype\s+html\b|<html\b)/i.test(detail);
    if (!html) return { kind: "unknown" };
    // 只消费固定标题特征，不回显任意页面文本；普通登录/错误页不能冒称 WAF。
    const title = findPageTitle(detail);
    return { kind: /^\s*WAF\s*(?:拦截页面|拦截页|blocked|block\s+page)\s*$/i.test(title) ? "waf" : "html" };
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

/** 新快照接口严格解包；错误文案不回显服务器响应或任务凭据。 */
function snapshotObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("GitLab 仓库快照元数据不完整");
  }
  return value as Record<string, unknown>;
}

function positiveId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
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

  /** 三种读取方式共用失败诊断；只留白名单字段，错误页和任意响应字段不进入日志/记录。 */
  const responseError = async (response: Response, method: string, path: string, gitlabToken: string, requestBody?: string): Promise<GitlabApiError> => {
    const detail = await response.text().catch(() => "");
    let comment: string | undefined;
    try {
      const payload: unknown = JSON.parse(requestBody ?? "");
      if (typeof payload === "object" && payload !== null && "body" in payload && typeof payload.body === "string") comment = payload.body;
    } catch { /* 无请求体的 GET 不需要正文脱敏值。 */ }
    const privateValues = [gitlabToken, requestBody, comment].filter((value): value is string => Boolean(value));
    const containsPrivateValue = (value: string): boolean => privateValues.some((secret) => value.includes(secret));
    const redact = (value: string): string => privateValues.reduce((safe, secret) => safe.replaceAll(secret, "[REDACTED]"), value);
    const contentTypeValue = response.headers?.get("content-type")?.split(";")[0].trim().toLowerCase() ?? "";
    const contentType = contentTypeValue.length <= 128 && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(contentTypeValue) && !containsPrivateValue(contentTypeValue)
      ? contentTypeValue : undefined;
    // Header 是不可信输入：不枚举 X-WAF-*，也不记录 Cookie、Location 或认证头。
    const safeHeader = (name: string, maxLength: number, pattern: RegExp): string | undefined => {
      const value = response.headers?.get(name) ?? "";
      return value.length > 0 && value.length <= maxLength && pattern.test(value) && !containsPrivateValue(value) ? value : undefined;
    };
    const requestId = safeHeader("x-request-id", 128, /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
    const server = safeHeader("server", 80, /^[a-zA-Z0-9][a-zA-Z0-9 ._/()-]*$/);
    const { kind, message } = describeErrorBody(detail, contentType);
    // 自由文本 message 可能编码、截断或拼接私有评论，无法靠精确替换可靠脱敏。
    // 只回显与固定 HTTP 状态短语完全匹配的摘要，其余内容不进入日志和失败记录。
    const reason = STATUS_CODES[response.status];
    const apiMessage = reason && message && [reason, `${response.status} ${reason}`].some((value) => value.toLowerCase() === message.trim().toLowerCase())
      && !containsPrivateValue(reason) ? `${response.status} ${reason}` : undefined;
    const category = { json: "JSON 错误响应", waf: "WAF 拦截页，具体规则需查网关记录", html: "HTML 错误页，来源待确认", unknown: "响应来源待确认" }[kind];
    const safePath = redact(path.split("?")[0]);
    logger.warn("GitLab API 请求失败", {
      方法: method, 路径: safePath, 状态码: response.status, 响应类别: kind,
      响应ContentType: contentType, 请求ID: requestId, 服务标识: server,
    });
    return new GitlabApiError(
      `GitLab API ${safePath} 返回 ${response.status}（${category}）${apiMessage ? `：${apiMessage}` : ""}${requestId ? `；请求ID=${requestId}` : ""}`,
      response.status,
      kind,
    );
  };

  const request = async <T>(gitlabUrl: string, gitlabToken: string, path: string, init: RequestInit = {}): Promise<T> => {
    const base = (gitlabUrl || baseUrl).replace(/\/+$/, "");
    if ((init.method === "POST" || init.method === "PUT") && typeof init.body === "string") {
      // 指纹取最终序列化的 HTTP 请求体，不是模型刚生成的汇总；只记长度和哈希，不记正文/凭据。
      logger.info("GitLab 写入请求", {
        方法: init.method, 路径: path.split("?")[0], 请求体字节数: Buffer.byteLength(init.body, "utf8"),
        请求体SHA256: createHash("sha256").update(init.body, "utf8").digest("hex"),
      });
    }
    const response = await fetchFn(
      `${base}${path}`,
      {
        ...init,
        headers: { "PRIVATE-TOKEN": gitlabToken, ...(init.headers ?? {}) },
        signal: AbortSignal.timeout(options.timeoutMs),
      },
    );
    if (!response.ok) {
      throw await responseError(response, init.method ?? "GET", path, gitlabToken, typeof init.body === "string" ? init.body : undefined);
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
      throw await responseError(response, "GET", path, gitlabToken);
    }
    return { payload: (await response.json()) as T, nextPage: response.headers.get("x-next-page") ?? "" };
  };

  /**
   * 读取纯文本响应。
   *
   * 仓库 raw 文件接口返回的不是 JSON，`request` 里的 `response.json()` 会直接失败，
   * 因此单独抽一个最小实现，不做通用化抽象——目前只有 `getFileRaw` 需要。
   */
  const requestText = async (gitlabUrl: string, gitlabToken: string, path: string): Promise<string> => {
    const base = (gitlabUrl || baseUrl).replace(/\/+$/, "");
    const response = await fetchFn(`${base}${path}`, {
      headers: { "PRIVATE-TOKEN": gitlabToken },
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    if (!response.ok) {
      throw await responseError(response, "GET", path, gitlabToken);
    }
    return response.text();
  };

  type RawMergeRequest = {
    state?: string;
    sha?: string;
    target_branch?: string;
    diff_refs?: { base_sha?: string; start_sha?: string; head_sha?: string };
  };

  /** 读取权威 MR 详情；追踪兼容映射与自动合并严格映射在各自 seam 完成。 */
  const readMergeRequest = async (projectId: number, iid: number, gitlabUrl: string, gitlabToken: string): Promise<RawMergeRequest> =>
    request<RawMergeRequest>(gitlabUrl, gitlabToken, `/api/v4/projects/${projectId}/merge_requests/${iid}`);

  const stateFields = (payload: RawMergeRequest) => ({
    headSha: payload.sha ?? payload.diff_refs?.head_sha ?? "",
    ...(typeof payload.target_branch === "string" && payload.target_branch ? { targetBranch: payload.target_branch } : {}),
  });

  /** 采纳追踪保留历史行为：未知生命周期按 opened，不提前终结建议。 */
  const readTrackingState = async (projectId: number, iid: number, gitlabUrl: string, gitlabToken: string) => {
    const payload = await readMergeRequest(projectId, iid, gitlabUrl, gitlabToken);
    const state: "opened" | "closed" | "merged" = payload.state === "merged" || payload.state === "closed" ? payload.state : "opened";
    return { ...stateFields(payload), state };
  };

  /** 自动合并只接受 GitLab 明确返回 opened；locked/未知/缺失状态一律 other。 */
  const readAutoMergeState = async (projectId: number, iid: number, gitlabUrl: string, gitlabToken: string) => {
    const payload = await readMergeRequest(projectId, iid, gitlabUrl, gitlabToken);
    const state: "opened" | "closed" | "merged" | "other" =
      payload.state === "opened" || payload.state === "closed" || payload.state === "merged" ? payload.state : "other";
    const refs = payload.diff_refs;
    const completeRefs = refs && isGitObjectId(refs.base_sha) && isGitObjectId(refs.start_sha) && isGitObjectId(refs.head_sha)
      ? { baseSha: refs.base_sha, startSha: refs.start_sha, headSha: refs.head_sha }
      : undefined;
    return { ...stateFields(payload), state, ...(completeRefs ? { refs: completeRefs } : {}) };
  };

  return {
    /**
     * 固定任务开始时的 MR 版本，diff、commits 和 refs 均取自版本详情。
     * GitLab 的 latest /changes 与 /versions 分开请求存在竞态，不能拼成一个快照。
     * 版本协议：https://docs.gitlab.com/api/merge_requests/#retrieve-a-merge-request-diff-version
     */
    async getRepositoryReviewSnapshot(projectId, iid, gitlabUrl = "", gitlabToken = "") {
      if (!positiveId(projectId) || !positiveId(iid)) throw new Error("仓库快照的项目或 MR 元数据非法");
      if (!gitlabToken.trim() || /[\r\n\u0000]/.test(gitlabToken)) throw new Error("仓库快照缺少有效任务凭据");
      const instance = parseGitlabHttpUrl((gitlabUrl || baseUrl).trim()).href.replace(/\/+$/, "");
      const mrPath = `/api/v4/projects/${projectId}/merge_requests/${iid}`;
      // 只对新能力收紧跳转与错误回显，不改变旧集成端点的异常兼容行为。
      const readSnapshot = async (path: string): Promise<unknown> => {
        try {
          return await request<unknown>(instance, gitlabToken, path, { redirect: "error" });
        } catch (error) {
          const status = error instanceof GitlabApiError ? error.status : 0;
          throw new GitlabApiError(status ? `GitLab 仓库快照获取失败（HTTP ${status}）` : "GitLab 仓库快照网络请求失败或超时", status);
        }
      };
      const mr = snapshotObject(await readSnapshot(mrPath));
      const mrRefs = snapshotObject(mr.diff_refs);
      if (mr.project_id !== projectId || mr.iid !== iid || !positiveId(mr.id) ||
        !positiveId(mr.source_project_id) || typeof mr.source_branch !== "string" || !mr.source_branch.trim() ||
        typeof mr.target_branch !== "string" || !mr.target_branch.trim() ||
        !isGitObjectId(mr.sha) || mrRefs.head_sha !== mr.sha ||
        !isGitObjectId(mrRefs.base_sha) || !isGitObjectId(mrRefs.start_sha)) {
        throw new Error("MR 源项目或版本元数据不完整");
      }
      const versions = await readSnapshot(`${mrPath}/versions?per_page=100`);
      if (!Array.isArray(versions)) throw new Error("MR 版本列表不完整");
      const selected = versions.map(snapshotObject).find((item) => item.head_commit_sha === mr.sha &&
        item.base_commit_sha === mrRefs.base_sha && item.start_commit_sha === mrRefs.start_sha);
      if (!selected || !positiveId(selected.id)) throw new Error("未找到与 MR 当前快照一致的 diff 版本");
      const version = snapshotObject(await readSnapshot(`${mrPath}/versions/${selected.id}`));
      if (version.id !== selected.id || version.merge_request_id !== mr.id || version.head_commit_sha !== mr.sha ||
        version.base_commit_sha !== mrRefs.base_sha || version.start_commit_sha !== mrRefs.start_sha ||
        version.state !== "collected" || version.overflow === true || !Array.isArray(version.diffs) ||
        typeof version.real_size !== "string" || !/^\d+$/.test(version.real_size) ||
        Number(version.real_size) !== version.diffs.length) {
        throw new Error("MR diff 版本不一致或内容不完整（可能超出 GitLab diff 限额）");
      }
      const changes = version.diffs.map((raw): Change => {
        const diff = snapshotObject(raw);
        if (diff.too_large === true || diff.collapsed === true || typeof diff.diff !== "string" ||
          typeof diff.old_path !== "string" || !diff.old_path || typeof diff.new_path !== "string" || !diff.new_path) {
          throw new Error("MR 版本包含不完整的文件 diff");
        }
        return { oldPath: diff.old_path, newPath: diff.new_path, diff: diff.diff };
      });
      if (!Array.isArray(version.commits)) throw new Error("MR 版本缺少提交摘要");
      const commits = version.commits.map((raw): Commit => {
        const commit = snapshotObject(raw);
        if (!isGitObjectId(commit.id) || typeof commit.message !== "string") throw new Error("MR 版本提交摘要不完整");
        return { id: commit.id, message: commit.message };
      });
      const source = snapshotObject(await readSnapshot(`/api/v4/projects/${mr.source_project_id}`));
      if (source.id !== mr.source_project_id || typeof source.http_url_to_repo !== "string") {
        throw new Error("源项目仓库元数据不完整");
      }
      const repositoryUrl = validateRepositoryUrl(source.http_url_to_repo, instance);
      const finalMr = snapshotObject(await readSnapshot(mrPath));
      const finalRefs = snapshotObject(finalMr.diff_refs);
      if (finalMr.id !== mr.id || finalMr.project_id !== projectId || finalMr.iid !== iid ||
        finalMr.sha !== mr.sha || finalMr.source_project_id !== mr.source_project_id ||
        finalMr.source_branch !== mr.source_branch || finalMr.target_branch !== mr.target_branch ||
        finalRefs.head_sha !== mrRefs.head_sha || finalRefs.base_sha !== mrRefs.base_sha || finalRefs.start_sha !== mrRefs.start_sha) {
        throw new Error("MR 在准备快照期间发生变化，请对新版本重新触发评审");
      }
      return {
        changes, commits,
        refs: { headSha: mr.sha, baseSha: mrRefs.base_sha, startSha: mrRefs.start_sha },
        sourceProjectId: mr.source_project_id,
        sourceBranch: mr.source_branch,
        targetBranch: mr.target_branch,
        repositoryUrl,
        gitlabUrl: instance,
      };
    },

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
      type RawNote = { id?: number; body?: string; position?: Record<string, unknown>; resolvable?: boolean; resolved?: boolean };
      type RawDiscussion = { id?: string; notes?: RawNote[] };
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
              // 采纳追踪需要解决状态：GitLab 返回该字段，历史实现丢弃了它。
              // 缺失时按 false：不能把「接口没给」当成「已解决」。
              resolvable: note.resolvable === true,
              resolved: note.resolved === true,
            })),
          });
        }
        if (!nextPage || payload.length === 0) break;
        page = Number(nextPage);
        if (!Number.isInteger(page) || page < 2) break;
      }
      return collected;
    },

    async getLatestHeadSha(projectId, iid, gitlabUrl = "", gitlabToken = "") {
      // 直接读 versions 而不复用对象方法：`getFileRaw`/`getLatestHeadSha` 可能在
      // 解构后单独传递（追踪器只依赖这两个方法），此时 `this` 不可靠。
      const payload = await request<{ head_commit_sha?: string }>(
        gitlabUrl,
        gitlabToken,
        `/api/v4/projects/${projectId}/merge_requests/${iid}/versions`,
      );
      return payload.head_commit_sha ?? "";
    },

    async getMergeRequestTrackingState(projectId, iid, gitlabUrl = "", gitlabToken = "") {
      return readTrackingState(projectId, iid, gitlabUrl, gitlabToken);
    },

    async getMergeRequestAutoMergeState(projectId, iid, gitlabUrl = "", gitlabToken = "") {
      return readAutoMergeState(projectId, iid, gitlabUrl, gitlabToken);
    },

    async mergeMergeRequest(projectId, iid, command, gitlabUrl = "", gitlabToken = "") {
      const path = `/api/v4/projects/${projectId}/merge_requests/${iid}/merge`;
      try {
        const result = await request<RawMergeRequest>(gitlabUrl, gitlabToken, path, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sha: command.sha,
            squash: command.method === "squash",
            should_remove_source_branch: command.removeSourceBranch,
          }),
        });
        if (result.state !== "merged" || (result.sha && result.sha !== command.sha)) {
          throw new Error("GitLab 合并响应未确认同一 head 已 merged");
        }
        logger.info("MR 已自动合并", { 项目ID: projectId, MR编号: iid, 合并方式: command.method });
      } catch (error) {
        // 401/403 是明确拒绝，不再发起对账；其余异常可能发生在 GitLab 已提交写入但响应丢失之后。
        if (error instanceof GitlabApiError && (error.status === 401 || error.status === 403)) throw error;
        try {
          const current = await readTrackingState(projectId, iid, gitlabUrl, gitlabToken);
          if (current.state === "merged" && current.headSha === command.sha) {
            logger.info("自动合并响应未知，但状态对账确认已合并", { 项目ID: projectId, MR编号: iid });
            return;
          }
        } catch (reconcileError) {
          logger.warn("自动合并失败后状态对账也失败", {
            项目ID: projectId,
            MR编号: iid,
            错误: reconcileError instanceof Error ? reconcileError.message : String(reconcileError),
          });
        }
        throw error;
      }
    },

    async getFileRaw(projectId, iid, path, headSha, gitlabUrl = "", gitlabToken = "") {
      // 用 ref 取该提交下的文件快照：采纳追踪要比较「评审之后这行变成什么样」，
      // 直接读分支当前内容会受未提交到该 MR 的改动干扰。
      // 路径必须整体编码，否则 `src/a/b.ts` 的斜杠会被当成路径分隔而 404。
      const encoded = encodeURIComponent(path);
      return requestText(gitlabUrl, gitlabToken, `/api/v4/projects/${projectId}/repository/files/${encoded}/raw?ref=${encodeURIComponent(headSha)}`);
    },

    async getUser(userId, gitlabUrl = "", gitlabToken = "") {
      // MR webhook 的 object_attributes 只带 author_id（数字），作者名必须另外查。
      // 用 /api/v4/users/:id 而不是 /projects/:id/members/:id：
      // 后者要求目标用户仍是该项目成员，而 MR 作者可能已经离开项目。
      type RawUser = { id?: number; name?: string; username?: string };
      const payload = await request<RawUser>(gitlabUrl, gitlabToken, `/api/v4/users/${userId}`);
      return {
        id: Number(payload.id ?? userId),
        name: payload.name ?? "",
        username: payload.username ?? "",
      };
    },
  };
}

/** 可中断的延迟；实际超时由请求的 AbortSignal 负责，这里只是重试间隔。 */
function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
