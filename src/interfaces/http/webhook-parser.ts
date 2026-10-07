import type { MergeRequestTask } from "../../domain/review-task.ts";
import { deriveGitlabInstanceUrl } from "../../domain/review-task.ts";

/**
 * 从 GitLab merge_request webhook payload 提取任务字段（HTTP 层 DTO 映射）。
 *
 * 纯函数，不依赖 Express：便于独立测试 payload 各种缺失/异常形态。
 * `project_id` 优先取顶层，缺失回退 `project.id`；任一关键字段缺失返回 null。
 * `gitlabUrl` 从 `X-Gitlab-Instance` 请求头与 payload `repository.homepage` 派生
 * （纯函数在 domain），供 GitLab 客户端在任务级使用。
 */
export function parseMergeRequestTask(
  payload: Record<string, unknown>,
  instanceHeader?: string,
): MergeRequestTask | null {
  const project = isRecord(payload.project) ? payload.project : {};
  const attributes = isRecord(payload.object_attributes) ? payload.object_attributes : {};

  const projectId = readNumber(payload.project_id) ?? readNumber(project.id);
  const iid = readNumber(attributes.iid);
  const fullName = readString(project, "path_with_namespace");
  if (projectId === undefined || iid === undefined || !fullName) return null;

  const repository = isRecord(payload.repository) ? payload.repository : {};
  return {
    projectId,
    iid,
    fullName,
    sourceBranch: readString(attributes, "source_branch"),
    targetBranch: readString(attributes, "target_branch"),
    gitlabUrl: deriveGitlabInstanceUrl(instanceHeader, readString(repository, "homepage")),
  };
}

/** 判定非 null、非数组的对象，用于安全读取未知 JSON 结构。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 读取数字字段；非数字按缺失处理。 */
function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** 读取字符串字段并去空白；非字符串一律按缺失处理。 */
function readString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  return typeof value === "string" ? value.trim() : "";
}
