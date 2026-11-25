import { mkdir, mkdtemp, open, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseDiffLines, readDiffLine } from "../../domain/inline-comment.ts";
import type { LlmApiKind, ResolvedLlmTarget } from "../../domain/llm-provider.ts";
import type { OcrFinding, OcrReviewer, OcrReviewResult } from "../../domain/ocr-review.ts";
import { isGitObjectId, validateRepositoryUrl, type RepositoryReviewSnapshot } from "../../domain/repository-context.ts";
import type { TokenUsage } from "../../domain/review-record.ts";
import type { Change } from "../../domain/review-task.ts";
import { buildGitEnvironment, createGitRunner, GitProcessError, type GitRunner } from "../git/git-runner.ts";

const MAX_REPORT_BYTES = 8 * 1024 * 1024;
const MAX_WORKSPACE_BYTES = 512 * 1024 * 1024;
const GIT_FETCH_DEPTHS = [32, 128, 512, 2048];
const SEVERITIES = new Set(["critical", "high", "medium", "low"]);
const EXPECTED_EXCLUSIONS = new Set(["binary", "secret", "user_rule", "extension", "default_path", "deleted"]);
const MODEL_ENV = ["OCR_LLM_URL", "OCR_LLM_TOKEN", "OCR_LLM_MODEL", "OCR_LLM_PROTOCOL", "OCR_LLM_AUTH_HEADER", "OCR_LLM_TIMEOUT"] as const;
const PROVIDER_PROTOCOLS = new Map([
  ["openai-completions", { protocol: "openai", suffix: "/chat/completions" }],
  ["openai-responses", { protocol: "openai-responses", suffix: "/responses" }],
  ["anthropic-messages", { protocol: "anthropic", suffix: "/v1/messages" }],
] satisfies Array<[LlmApiKind, { protocol: string; suffix: string }]>);

interface OcrReviewerOptions {
  env?: NodeJS.ProcessEnv;
  gitRunner?: GitRunner;
  ocrRunner?: GitRunner;
  insecureTls?: boolean;
}

/** 版本和覆盖率只从运行器的 manifest 与 GitLab 快照判定，不信任评论正文。 */
export function parseOcrReview(json: string, snapshot: RepositoryReviewSnapshot): OcrReviewResult {
  let data: unknown;
  try { data = JSON.parse(json); }
  catch { throw new Error("OCR 输出不是有效 JSON"); }
  const root = asObject(data);
  if ((!Array.isArray(root.comments) && root.comments !== null) || typeof root.status !== "string") {
    throw new Error("OCR 输出缺少评审结果");
  }
  // OCR 对未添加任何建议的 collector 可能将空 Go slice 编码为 null。
  const comments = root.comments ?? [];

  const manifest = asObject(root.manifest);
  const input = asObject(manifest.input);
  const sameBase = input.resolved_base === snapshot.refs.baseSha.toLowerCase();
  const sameHead = input.resolved_head === snapshot.refs.headSha.toLowerCase();
  if ((input.resolved_base !== undefined && !sameBase) || (input.resolved_head !== undefined && !sameHead)) {
    throw new Error("OCR 结果与 GitLab MR 版本不一致");
  }

  const changedPaths = new Set(snapshot.changes.map(({ newPath, oldPath }) => newPath === "/dev/null" ? oldPath : newPath));
  const changesByPath = new Map<string, Change | undefined>();
  for (const change of snapshot.changes) {
    for (const path of new Set([change.oldPath, change.newPath])) {
      if (path !== "/dev/null") changesByPath.set(path, changesByPath.has(path) ? undefined : change);
    }
  }
  const coverage = asObject(manifest.coverage);
  const selected = coveragePaths(coverage.selected);
  const completed = coveragePaths(coverage.completed);
  const excluded = new Map<string, string>();
  for (const item of asArray(coverage.excluded).map(asObject)) {
    if (typeof item.path === "string" && typeof item.exclude_reason === "string") excluded.set(item.path, item.exclude_reason);
  }

  const findings = comments.map(asObject).map((raw) => toFinding(raw, changesByPath))
    .filter((finding): finding is OcrFinding => finding !== undefined);
  const unreviewedPaths = [...changedPaths].filter((path) => !completed.has(path));
  const summary = asObject(root.summary);
  const filesReviewed = [...completed].filter((path) => changedPaths.has(path)).length;
  const completeRun = root.status === "complete" && manifest.terminal_state === "complete" && manifest.operation === "review" &&
    manifest.schema_version === "ocr.run-manifest/v1" && input.mode === "range" && sameBase && sameHead &&
    !manifest.run_failure && summary.budget_exceeded !== true;
  const noUnsettledFiles = [coverage.failed, coverage.reused, coverage.waived].every((items) => Array.isArray(items) && items.length === 0);
  const completeCoverage = filesReviewed > 0 && summary.files_reviewed === filesReviewed && noUnsettledFiles &&
    asArray(coverage.selected).length === filesReviewed && asArray(coverage.completed).length === filesReviewed &&
    selected.size === filesReviewed && [...selected].every((path) => completed.has(path)) &&
    unreviewedPaths.every((path) => EXPECTED_EXCLUSIONS.has(excluded.get(path) ?? ""));
  const completeFindings = comments.length === findings.length && findings.every(({ path }) => changesByPath.has(path));
  const complete = completeRun && completeCoverage && completeFindings;

  const tokenUsage = readTokenUsage(summary);
  return { findings, complete, filesReviewed, unreviewedPaths, ...(tokenUsage ? { tokenUsage } : {}) };
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function coveragePaths(value: unknown): Set<string> {
  const paths = asArray(value).map((item) => asObject(item).path).filter((path): path is string => typeof path === "string");
  return new Set(paths);
}

function toFinding(raw: Record<string, unknown>, changesByPath: ReadonlyMap<string, Change | undefined>): OcrFinding | undefined {
  if (typeof raw.path !== "string" || !raw.path.trim() || typeof raw.content !== "string" || !raw.content.trim()) return undefined;
  const severity = typeof raw.severity === "string" ? raw.severity.trim().toLowerCase() : "";
  const line = readNaturalNumber(raw.start_line) ?? 0;
  const diff = changesByPath.get(raw.path)?.diff;
  const lineKey = verifyLineSide(diff, raw.existing_code, line, readNaturalNumber(raw.end_line));
  return {
    path: raw.path,
    body: raw.content.trim(),
    line,
    severity: SEVERITIES.has(severity) ? severity : "",
    ...(lineKey ? { lineKey } : {}),
    ...(typeof raw.category === "string" && raw.category ? { category: raw.category } : {}),
    ...(typeof raw.suggestion_code === "string" && raw.suggestion_code ? { suggestionCode: raw.suggestion_code } : {}),
  };
}

/** OCR 的行号可能来自任一侧，必须用该版本 diff 的原文分辨，无法唯一确认时进入汇总。 */
function verifyLineSide(diff: string | undefined, existing: unknown, start: number, end: number | undefined): OcrFinding["lineKey"] {
  if (!diff || !start || typeof existing !== "string" || !existing.trim()) return undefined;
  const lines = existing.trim().split(/\r?\n/).map((line) => line.trim());
  if (end !== undefined && end - start + 1 !== lines.length) return undefined;
  const matches = (side: "new_line" | "old_line") =>
    lines.every((text, offset) => readDiffLine(diff, side, start + offset)?.trim() === text);
  const newMatch = matches("new_line");
  const oldMatch = matches("old_line");
  if (newMatch === oldMatch) return undefined;
  const { added, removed } = parseDiffLines(diff);
  if (newMatch && added.has(start)) return "new_line";
  if (oldMatch && removed.has(start)) return "old_line";
  return undefined;
}

function readNaturalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function readTokenUsage(summary: Record<string, unknown>): TokenUsage | undefined {
  const input = readNaturalNumber(summary.input_tokens);
  const output = readNaturalNumber(summary.output_tokens);
  const cacheRead = readNaturalNumber(summary.cache_read_tokens ?? 0);
  const cacheWrite = readNaturalNumber(summary.cache_write_tokens ?? 0);
  const total = readNaturalNumber(summary.total_tokens);
  // OCR 输入包含已命中的缓存 token。按 cr-pilot 的互斥字段归一化，避免重复统计。
  if (input === undefined || output === undefined || cacheRead === undefined || cacheWrite === undefined ||
      total === undefined || input < cacheRead + cacheWrite || total !== input + output) return undefined;
  return { input: input - cacheRead - cacheWrite, output, cacheRead, cacheWrite, totalTokens: total };
}

/** 已选厂商完整决定模型请求。独立部署变量只用于还没有厂商配置的旧实例。 */
function buildModelEnvironment(target: ResolvedLlmTarget | undefined, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (!target) {
    if (!env.OCR_LLM_URL?.trim() || !env.OCR_LLM_TOKEN?.trim() || !env.OCR_LLM_MODEL?.trim()) {
      throw new Error("OCR 模型未配置，请在 AI 厂商中配置模型，或提供 OCR_LLM_URL、OCR_LLM_TOKEN 和 OCR_LLM_MODEL");
    }
    return Object.fromEntries(MODEL_ENV.map((name) => [name, env[name]]));
  }

  const { provider } = target;
  const api = PROVIDER_PROTOCOLS.get(provider.api);
  if (!api) throw new Error("OCR 不支持所选厂商的 API 协议，请在 AI 厂商中选择兼容协议");
  const token = provider.apiKey?.trim();
  if (!token || /[\u0000-\u001f\u007f]/.test(token)) throw new Error("OCR 所选厂商缺少有效的 API 密钥，请在 AI 厂商中填写");
  if (api.protocol === "anthropic" && (provider.name === "github-copilot" || token.includes("sk-ant-oat"))) {
    throw new Error("OCR 所选 Anthropic 厂商需要 API 密钥认证，请选择兼容的厂商配置");
  }
  const model = target.model.trim();
  if (!model || /[\u0000-\u001f\u007f]/.test(model)) throw new Error("OCR 所选厂商缺少有效的模型名称");

  const baseUrl = provider.baseUrl.trim();
  let url: URL;
  try { url = new URL(baseUrl); }
  catch { throw new Error("OCR 所选厂商的 API 地址无效"); }
  if (!/^https?:\/\/[^/]/i.test(baseUrl) || /[\s\\]/u.test(baseUrl) || url.username || url.password || /[?#]/.test(baseUrl)) {
    throw new Error("OCR 所选厂商的 API 地址必须为不带凭据、查询参数或片段的 HTTP(S) 地址");
  }
  const path = url.pathname.replace(/\/+$/, "");
  if (!path.endsWith(api.suffix)) {
    if (/\/(?:chat\/completions|responses|messages)$/.test(path)) throw new Error("OCR 所选厂商的 API 地址与所选协议不一致");
    // OCR 的 Anthropic SDK 固定拼接 /v1/messages。厂商已配置 /v1 时只需补 /messages。
    url.pathname = path + (api.protocol === "anthropic" && path.endsWith("/v1") ? "/messages" : api.suffix);
  } else {
    url.pathname = path;
  }
  return {
    OCR_LLM_URL: url.href,
    OCR_LLM_TOKEN: token,
    OCR_LLM_MODEL: model,
    OCR_LLM_PROTOCOL: api.protocol,
    ...(api.protocol === "anthropic" ? { OCR_LLM_AUTH_HEADER: "x-api-key" } : {}),
  };
}

/** OCR 工作目录内没有 checkout、仓库规则或凭据。Git 和 OCR 子进程分别获准访问所需的环境变量。 */
export function createOcrReviewer(options: OcrReviewerOptions = {}): OcrReviewer {
  const env = options.env ?? process.env;
  const gitRunner = options.gitRunner ?? createGitRunner();
  const ocrRunner = options.ocrRunner ?? createGitRunner({ executable: env.OCR_EXECUTABLE?.trim() || "ocr" });
  const rule = env.OCR_RULE_FILE?.trim();
  const ruleFile = rule ? resolve(rule) : undefined;
  return {
    async review({ snapshot, token, signal, llmTarget }) {
      signal.throwIfAborted();
      const modelEnv = buildModelEnvironment(llmTarget, env);
      const url = validateRepositoryUrl(snapshot.repositoryUrl, snapshot.gitlabUrl);
      if (!isGitObjectId(snapshot.refs.baseSha) || !isGitObjectId(snapshot.refs.headSha) ||
          snapshot.refs.baseSha.length !== snapshot.refs.headSha.length) throw new Error("OCR 评审的 MR 版本无效");
      const base = snapshot.refs.baseSha.toLowerCase();
      const head = snapshot.refs.headSha.toLowerCase();
      const root = await mkdtemp(join(tmpdir(), "cr-pilot-ocr-"));
      const workspace = monitorWorkspace(root);
      const reviewSignal = AbortSignal.any([signal, workspace.signal]);
      try {
        const cwd = join(root, "repo");
        await mkdir(cwd);
        const local = buildGitEnvironment({ root, inherited: env });
        const network = buildGitEnvironment({ root, inherited: env, repositoryUrl: url, token, insecureTls: options.insecureTls });
        const git = (args: string[], gitEnv = local) => gitRunner(args, { cwd, env: gitEnv, signal: reviewSignal, maxOutputBytes: 1024 * 1024 });
        await git(["init", "--quiet", `--object-format=${base.length === 64 ? "sha256" : "sha1"}`]);
        for (const depth of GIT_FETCH_DEPTHS) {
          await git(["fetch", "--no-tags", "--no-write-fetch-head", `--depth=${depth}`, "--", url, head], network);
          try {
            const mergeBase = (await git(["merge-base", base, head])).toString("utf8").trim();
            if (mergeBase !== base) throw new Error("OCR 的评审基线与 GitLab MR 快照不一致");
            break;
          } catch (error) {
            if (!(error instanceof GitProcessError) || error.code !== "failed") throw error;
            if (depth === GIT_FETCH_DEPTHS.at(-1)) throw new Error("无法获取 OCR 评审所需的 GitLab MR 基线");
          }
        }
        // OCR 在范围模式下按指定 SHA 读 Git 对象。设置 HEAD 让目录可被普通 Git 工具识别。
        await git(["update-ref", "--no-deref", "HEAD", head]);
        const output = join(root, "review.json");
        const childEnv: NodeJS.ProcessEnv = {
          ...local, ...modelEnv, TMPDIR: root, TEMP: root, TMP: root, OCR_ENABLE_TELEMETRY: "0", OCR_NO_UPDATE: "1",
          OCR_CONFIG_PATH: join(root, "ocr-config.json"),
        };
        const args = ["review", "--repo", cwd, "--from", base, "--to", head, "--audience", "agent", "--format", "json", "--output", output];
        if (ruleFile) args.push("--rule", ruleFile);

        let successfulExit = true;
        try {
          await ocrRunner(args, { cwd, env: childEnv, signal: reviewSignal, maxOutputBytes: MAX_REPORT_BYTES });
        } catch (error) {
          if (error instanceof GitProcessError) {
            if (error.code === "not-found") throw new Error("OCR 运行程序不可用，请检查部署环境");
            if (error.code === "output-limit") throw new Error("OCR 运行输出超过安全上限");
            if (error.code === "failed" || (error.code === "aborted" && signal.aborted && !workspace.signal.aborted)) successfulExit = false;
            else throw error;
          } else throw error;
        }
        // OCR 可能先写报告再退出。任务超时后仍保留已写入且经过校验的建议。
        const result = parseOcrReview(await readReport(output), snapshot);
        workspace.signal.throwIfAborted();
        return successfulExit && !signal.aborted ? result : { ...result, complete: false };
      } catch (error) {
        reviewSignal.throwIfAborted();
        throw error;
      } finally {
        await workspace.stop();
        await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      }
    },
  };
}

async function readReport(path: string): Promise<string> {
  const file = await open(path, "r").catch(() => { throw new Error("OCR 未生成可读取的评审结果"); });
  try {
    const { size } = await file.stat();
    if (size > MAX_REPORT_BYTES) throw new Error("OCR JSON 结果超过安全上限");
    return (await file.readFile()).toString("utf8");
  } finally {
    await file.close();
  }
}

function monitorWorkspace(root: string): { signal: AbortSignal; stop(): Promise<void> } {
  const abort = new AbortController();
  let pending: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (pending || abort.signal.aborted) return;
    pending = enforceDiskLimit(root).catch(() => abort.abort(new Error("OCR 工作目录超出磁盘上限或无法读取"))).finally(() => { pending = undefined; });
  }, 1000);
  timer.unref();
  return { signal: abort.signal, async stop() { clearInterval(timer); await pending; } };
}

async function enforceDiskLimit(root: string): Promise<void> {
  const directories = [root];
  let bytes = 0;
  while (directories.length > 0) {
    const directory = directories.pop()!;
    const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) directories.push(path);
      if (!entry.isFile()) continue;
      // Git fetch 可能在检查期间将临时文件原子重命名。
      bytes += await stat(path).then(({ size }) => size, (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return 0;
        throw error;
      });
      if (bytes > MAX_WORKSPACE_BYTES) throw new Error("OCR workspace exceeds disk limit");
    }
  }
}
