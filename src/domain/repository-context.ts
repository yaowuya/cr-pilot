/**
 * 仓库上下文的能力边界：应用层只接收固定版本与受限读取接口，
 * 不接触 Git 子进程、绝对目录或模型工具实现。每个任务独立持有并释放资源。
 */
import type { Change, Commit, DiffRefs } from "./review-task.ts";

/** 一次固定 MR diff version 的内容与源仓库；不能混入另一次 latest 查询。 */
export interface RepositoryReviewSnapshot {
  changes: Change[];
  commits: Commit[];
  refs: DiffRefs;
  sourceProjectId: number;
  sourceBranch: string;
  repositoryUrl: string;
  gitlabUrl: string;
}

/** 明确表示分页或输出截断；调用方不能将有界结果解释为已遍历全部文件。 */
export interface RepositoryReadResult {
  text: string;
  truncated: boolean;
  nextCursor?: number;
}

/** 只读固定提交能力；没有任意路径、命令、写入或凭据访问入口。 */
export interface RepositoryReadAccess {
  readonly headSha: string;
  list(input: { prefix?: string; query?: string; cursor?: number }, signal?: AbortSignal): Promise<RepositoryReadResult>;
  read(input: { path: string; startLine?: number; limit?: number }, signal?: AbortSignal): Promise<RepositoryReadResult>;
  search(input: { query: string; prefix?: string; cursor?: number }, signal?: AbortSignal): Promise<RepositoryReadResult>;
}

/** 临时仓库 handle；dispose 幂等，必须等活动进程/读取结束后再移除目录。 */
export interface RepositoryWorkspace {
  access: RepositoryReadAccess;
  dispose(): Promise<void>;
}

/** 准备输入只由可信任务/版本快照构造，不允许模型选择仓库地址或 token。 */
export interface RepositoryPrepareInput {
  repositoryUrl: string;
  gitlabUrl: string;
  sourceBranch: string;
  headSha: string;
  token: string;
  signal: AbortSignal;
}

/** 准备失败必须自行清理尚未交出的资源，调用方不能降级成无上下文评审。 */
export interface RepositoryProvider {
  prepare(input: RepositoryPrepareInput): Promise<RepositoryWorkspace>;
}

/** 完整 Git 对象 ID，而非可解释为选项、路径或任意 revision 的字符串。 */
export function isGitObjectId(value: unknown): value is string {
  return typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value);
}

/** 仅允许无凭据/查询参数的 HTTP(S) 地址；错误不包含可能带密钥的原始输入。 */
export function parseGitlabHttpUrl(value: string): URL {
  let url: URL;
  try {
    if (/[\u0000-\u0020\u007f]/.test(value)) throw new Error();
    url = new URL(value);
  } catch {
    throw new Error("GitLab 仓库地址格式非法");
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("GitLab 仓库地址必须为不带凭据或查询参数的 HTTP(S) URL");
  }
  return url;
}

/** 防止 API 返回其他实例的 clone URL 时，将当前任务 token 发送到其他 origin。 */
export function validateRepositoryUrl(repositoryUrl: string, gitlabUrl: string): string {
  const repository = parseGitlabHttpUrl(repositoryUrl);
  const instance = parseGitlabHttpUrl(gitlabUrl);
  if (repository.origin !== instance.origin || repository.pathname === "/") {
    throw new Error("仓库地址必须与当前 GitLab 实例同源且指向具体仓库");
  }
  return repository.href;
}
