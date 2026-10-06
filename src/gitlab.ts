/**
 * 判断请求体是否为 GitLab webhook payload。
 *
 * 依据是官方 payload 恒带 `object_kind` 字段，不依赖请求头，调用方不需要额外配置。
 */
export function isGitlabPayload(body: unknown): boolean {
  return isRecord(body) && typeof body.object_kind === "string" && body.object_kind.length > 0;
}

/**
 * 提取 GitLab payload 的评审上下文。
 *
 * GitLab webhook 不含代码 diff：push 事件的 `commits` 只有文件路径与提交信息，
 * merge_request 事件的 `object_attributes` 只有元数据。因此这里只产出上下文，
 * 代码仍必须由请求体提供。未知事件类型或缺失关键字段返回 null，交由调用方提示。
 */
export function extractGitlabContext(body: unknown): string | null {
  if (!isRecord(body)) return null;
  if (body.object_kind === "merge_request") return describeMergeRequest(body);
  if (body.object_kind === "push") return describePush(body);
  return null;
}

/** 判定非 null、非数组的对象，用于安全地读取未知 JSON 结构。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 读取字符串字段并去空白；非字符串一律按缺失处理。 */
function readString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  return typeof value === "string" ? value.trim() : "";
}

/** 读取 `project.path_with_namespace`，缺失时返回空串。 */
function readRepository(body: Record<string, unknown>): string {
  const project = isRecord(body.project) ? body.project : {};
  return readString(project, "path_with_namespace");
}

/** 把 merge_request 事件拼成可读上下文；连 iid 与标题都没有时视为不可用。 */
function describeMergeRequest(body: Record<string, unknown>): string | null {
  const attributes = isRecord(body.object_attributes) ? body.object_attributes : {};
  const iid = typeof attributes.iid === "number" || typeof attributes.iid === "string" ? String(attributes.iid) : "";
  const title = readString(attributes, "title");
  if (!iid && !title) return null;

  const action = readString(attributes, "action");
  const lines: string[] = [`GitLab Merge Request${iid ? ` !${iid}` : ""}${action ? `（${action}）` : ""}`];
  const repository = readRepository(body);
  if (repository) lines.push(`仓库：${repository}`);
  if (title) lines.push(`标题：${title}`);

  const source = readString(attributes, "source_branch");
  const target = readString(attributes, "target_branch");
  if (source || target) lines.push(`分支：${source || "未知"} → ${target || "未知"}`);

  const description = readString(attributes, "description");
  if (description) lines.push(`描述：${description}`);
  return lines.join("\n");
}

/** 把 push 事件拼成可读上下文；分支与提交都缺失时视为不可用。 */
function describePush(body: Record<string, unknown>): string | null {
  const commits = Array.isArray(body.commits) ? body.commits.filter(isRecord) : [];
  const branch = readString(body, "ref").replace(/^refs\/heads\//, "");
  if (!branch && commits.length === 0) return null;

  const lines: string[] = [`GitLab Push${branch ? `（${branch}）` : ""}`];
  const repository = readRepository(body);
  if (repository) lines.push(`仓库：${repository}`);
  if (commits.length === 0) return lines.join("\n");

  lines.push("提交：");
  for (const commit of commits) {
    const message = readString(commit, "message").split("\n")[0] ?? "";
    const files = readFileLists(commit);
    const fileText = files.length > 0 ? `｜变更文件：${files.join(", ")}` : "";
    lines.push(`- ${message || "（无提交信息）"}${fileText}`);
  }
  return lines.join("\n");
}

/** 合并 added / modified / removed 三个文件列表，保持 GitLab 给出的原始顺序。 */
function readFileLists(commit: Record<string, unknown>): string[] {
  const files: string[] = [];
  for (const key of ["added", "modified", "removed"]) {
    const value = commit[key];
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      if (typeof entry === "string" && entry.trim()) files.push(entry.trim());
    }
  }
  return files;
}
