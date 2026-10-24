/**
 * 每任务无工作树浅克隆：从固定 commit 的 tree/blob 提供有界读取。
 * 不 checkout，因此仓库 hooks、filters、符号链接和子模块都没有执行/越界机会。
 */
import { mkdtemp, mkdir, readdir, lstat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isGitObjectId, validateRepositoryUrl,
  type RepositoryProvider, type RepositoryReadAccess, type RepositoryReadResult,
} from "../../domain/repository-context.ts";
import { createSilentLogger, type Logger } from "../../shared/logger.ts";
import { buildGitEnvironment, createGitRunner, type GitRunner } from "./git-runner.ts";

/** 初始安全边界，不是性能承诺；测试只覆盖注入值，不改变生产协议允许列表。 */
export const REPOSITORY_LIMITS = {
  maxRepositoryBytes: 512 * 1024 * 1024,
  maxFiles: 50_000,
  indexBytes: 16 * 1024 * 1024,
  fileBytes: 256 * 1024,
  listEntries: 200,
  readLines: 200,
  outputChars: 16_000,
  searchFiles: 200,
  searchBytes: 4 * 1024 * 1024,
  searchHits: 50,
};
type RepositoryLimits = typeof REPOSITORY_LIMITS;
interface TrackedBlob { path: string; oid: string; size: number }

const blockedDirectories = new Set([".git", ".pi", ".ssh", ".aws", ".azure", ".gnupg", "node_modules", "vendor", "dist", "build", "coverage"]);
const blockedNames = new Set([".npmrc", ".netrc", "_netrc", ".pypirc", "credentials", "credentials.json", "credentials.yml", "credentials.yaml", "secrets.json", "secrets.yml", "secrets.yaml", "secret.json", "auth.json"]);

/** 所有模型路径都经过同一个相对路径判定；不会交给 shell 或文件系统读取。 */
function safePath(path: string, prefix = false): boolean {
  const value = prefix && path.endsWith("/") ? path.slice(0, -1) : path;
  if (!value || /[\\:\u0000-\u001f\u007f]/.test(value) || value.startsWith("/")) return false;
  return value.split("/").every(part => part !== "" && part !== "." && part !== "..");
}

/** 文件名过滤只覆盖常见秘密，不声称能发现任意源码内硬编码的凭据。 */
function allowedPath(path: string): boolean {
  if (!safePath(path)) return false;
  const parts = path.toLowerCase().split("/");
  if (parts.some(part => blockedDirectories.has(part))) return false;
  const name = parts.at(-1)!;
  return !blockedNames.has(name) && name !== ".env" && !name.startsWith(".env.") &&
    !/^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$)/.test(name) && !/\.(?:pem|key|p12|pfx|jks|keystore)$/.test(name);
}

/** Git check-ref-format 的必要限制先在进程外检查，避免参数歧义和控制字符。 */
function validBranch(branch: string): boolean {
  return Boolean(branch) && branch !== "@" && !branch.startsWith("-") &&
    !/[\u0000-\u0020\u007f~^:?*\[\\]/.test(branch) && !branch.includes("..") && !branch.includes("@{") &&
    branch.split("/").every(part => Boolean(part) && !part.startsWith(".") && !part.endsWith(".") && !part.endsWith(".lock"));
}

/** 不跟随链接，监测自身临时目录；采样有短暂超量窗口，不等同操作系统磁盘配额。 */
async function checkDisk(root: string, maximum: number): Promise<void> {
  const pending = [root];
  let bytes = 0;
  let entries = 0;
  while (pending.length) {
    const directory = pending.pop()!;
    let children;
    try { children = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    for (const child of children) {
      if (++entries > 200_000) throw new Error("仓库目录条目超过安全上限");
      const path = join(directory, child.name);
      if (child.isSymbolicLink()) continue;
      if (child.isDirectory()) pending.push(path);
      else if (child.isFile()) {
        try { bytes += (await lstat(path)).size; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        if (bytes > maximum) throw new Error("仓库体积超过安全上限");
      }
    }
  }
}

function cursorValue(value: number | undefined): number {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("仓库查询游标必须为非负整数");
  return value;
}

function prefixValue(value: string | undefined): string {
  if (value === undefined || value === "") return "";
  if (!safePath(value, true)) throw new Error("仓库查询路径非法");
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function matchesPrefix(path: string, prefix: string): boolean {
  return !prefix || path === prefix || path.startsWith(`${prefix}/`);
}

function queryValue(query: string): string {
  if (typeof query !== "string" || query.length === 0 || query.length > 200 || /[\u0000\r\n]/.test(query)) {
    throw new Error("仓库搜索 query 必须为 1～200 字符的单行字面量");
  }
  return query;
}

/** 限制最终输出而非仅限制文件字节；截断状态独立于文字传递给模型工具。 */
function boundedResult(text: string, truncated: boolean, maximum: number, nextCursor?: number): RepositoryReadResult {
  return { text: text.slice(0, maximum), truncated: truncated || text.length > maximum, ...(nextCursor === undefined ? {} : { nextCursor }) };
}

/** 创建可注入 Git runner 的准备适配器；注入用于离线 transport 测试，不放宽生产 URL 校验。 */
export function createRepositoryProvider(options: {
  runner?: GitRunner;
  tempRoot?: string;
  timeoutMs?: number;
  insecureTls?: boolean;
  limits?: Partial<RepositoryLimits>;
  logger?: Logger;
} = {}): RepositoryProvider {
  const runner = options.runner ?? createGitRunner();
  const limits: RepositoryLimits = { ...REPOSITORY_LIMITS, ...options.limits };
  const logger = options.logger ?? createSilentLogger();
  const timeoutMs = options.timeoutMs ?? 120_000;
  for (const value of [...Object.values(limits), timeoutMs]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error("仓库安全限额必须为正整数");
  }
  return {
    async prepare(input) {
      const repositoryUrl = validateRepositoryUrl(input.repositoryUrl, input.gitlabUrl);
      if (!validBranch(input.sourceBranch)) throw new Error("仓库源分支名称非法");
      if (!isGitObjectId(input.headSha)) throw new Error("仓库提交版本必须是完整 SHA");
      if (!input.token.trim() || /[\u0000\r\n]/.test(input.token)) throw new Error("仓库准备缺少有效任务凭据");
      if (input.signal.aborted) throw new Error("仓库准备已中断");
      const root = await mkdtemp(join(options.tempRoot ?? tmpdir(), "cr-pilot-repo-"));
      const repository = join(root, "repository");
      const preparation = new AbortController();
      const lifetime = new AbortController();
      const signal = AbortSignal.any([input.signal, preparation.signal]);
      const deadline = setTimeout(() => preparation.abort(), timeoutMs);
      let monitoring = true;
      let monitorTimer: ReturnType<typeof setTimeout> | undefined;
      let monitorTask: Promise<void> = Promise.resolve();
      let monitorFailure: Error | undefined;
      const monitor = async (): Promise<void> => {
        try { await checkDisk(root, limits.maxRepositoryBytes); }
        catch (error) {
          monitorFailure = new Error(error instanceof Error && /超过安全上限/.test(error.message) ? error.message : "仓库磁盘检查失败");
          preparation.abort();
        }
        if (monitoring && !signal.aborted) monitorTimer = setTimeout(() => { monitorTask = monitor(); }, 250);
      };
      const stopMonitor = async (): Promise<void> => {
        monitoring = false;
        clearTimeout(deadline);
        if (monitorTimer) clearTimeout(monitorTimer);
        await monitorTask;
      };
      const cleanup = async (): Promise<void> => {
        try { await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
        catch { throw new Error("仓库临时目录清理失败"); }
      };
      try {
        await Promise.all([mkdir(join(root, "empty-template")), mkdir(join(root, "empty-hooks"))]);
        const localEnv = buildGitEnvironment({ root });
        const networkEnv = buildGitEnvironment({ root, repositoryUrl, token: input.token, insecureTls: options.insecureTls });
        monitorTask = monitor();
        await runner(["clone", "--progress", "--single-branch", "--depth=1", "--no-tags", "--no-checkout", `--branch=${input.sourceBranch}`, "--", repositoryUrl, repository],
          { cwd: root, env: networkEnv, signal, maxOutputBytes: 1024 * 1024 });
        await checkDisk(root, limits.maxRepositoryBytes);
        const localGit = (args: string[], maximum = limits.indexBytes, operationSignal = signal) =>
          runner(args, { cwd: repository, env: localEnv, signal: operationSignal, maxOutputBytes: maximum });
        const head = (await localGit(["rev-parse", "--verify", "HEAD"], 256)).toString("utf8").trim();
        if (head.toLowerCase() !== input.headSha.toLowerCase()) {
          // 分支推进不等于本次快照失效：只尝试一次精确浅 fetch，绝不回退到新的 HEAD。
          await runner(["fetch", "--depth=1", "--no-tags", "--", repositoryUrl, input.headSha],
            { cwd: repository, env: networkEnv, signal, maxOutputBytes: 1024 * 1024 });
        }
        const verified = (await localGit(["rev-parse", "--verify", `${input.headSha}^{commit}`], 256)).toString("utf8").trim();
        if (verified.toLowerCase() !== input.headSha.toLowerCase()) throw new Error("仓库提交版本不一致");
        await checkDisk(root, limits.maxRepositoryBytes);
        const tree = new TextDecoder("utf-8", { fatal: true }).decode(await localGit(["ls-tree", "-r", "-l", "-z", verified]));
        const files: TrackedBlob[] = [];
        let fileCount = 0;
        for (const record of tree.split("\0")) {
          if (!record) continue;
          const match = /^(\d{6}) (blob|commit) ([a-f0-9]{40,64})\s+(\d+|-)\t([\s\S]+)$/.exec(record);
          if (!match) throw new Error("仓库文件索引格式非法");
          if (++fileCount > limits.maxFiles) throw new Error("仓库文件数量超过安全上限");
          const [, mode, type, oid, sizeText, path] = match;
          if ((mode !== "100644" && mode !== "100755") || type !== "blob" || !isGitObjectId(oid) || !allowedPath(path)) continue;
          const size = Number(sizeText);
          if (!Number.isSafeInteger(size) || size < 0) throw new Error("仓库文件大小非法");
          files.push({ path, oid, size });
        }
        files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
        const byPath = new Map(files.map(file => [file.path, file]));
        if (signal.aborted) throw monitorFailure ?? new Error("仓库准备已中断或超时");
        await stopMonitor();
        if (monitorFailure) throw monitorFailure;
        // 等磁盘采样停止也会 await，覆盖这段间隙发生的任务取消。
        if (signal.aborted) throw new Error("仓库准备已中断或超时");
        const active = new Set<Promise<unknown>>();
        let closed = false;
        let disposing: Promise<void> | undefined;
        const operation = <T>(requestedSignal: AbortSignal | undefined, action: (signal: AbortSignal) => Promise<T>): Promise<T> => {
          if (closed) return Promise.reject(new Error("仓库上下文已释放"));
          const operationSignal = requestedSignal ? AbortSignal.any([requestedSignal, lifetime.signal]) : lifetime.signal;
          if (operationSignal.aborted) return Promise.reject(new Error("仓库读取已中断"));
          const promise = action(operationSignal);
          active.add(promise);
          void promise.then(() => active.delete(promise), () => active.delete(promise));
          return promise;
        };
        const readBlob = async (file: TrackedBlob, operationSignal: AbortSignal): Promise<string> => {
          if (operationSignal.aborted) throw new Error("仓库读取已中断");
          if (file.size > limits.fileBytes) throw new Error("仓库文件超过读取上限");
          const bytes = await localGit(["cat-file", "blob", file.oid], limits.fileBytes + 1, operationSignal);
          if (bytes.length !== file.size || bytes.includes(0)) throw new Error("仓库文件不是可读取的 UTF-8 文本");
          let text: string;
          try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
          catch { throw new Error("仓库文件不是可读取的 UTF-8 文本"); }
          if (text.startsWith("version https://git-lfs.github.com/spec/v1")) throw new Error("仓库文件为 LFS 指针，不自动下载外部对象");
          return text;
        };
        const access: RepositoryReadAccess = {
          headSha: verified,
          list: (query, requestedSignal) => operation(requestedSignal, async () => {
            const prefix = prefixValue(query.prefix);
            const term = query.query === undefined ? "" : queryValue(query.query);
            const candidates = files.filter(file => file.size <= limits.fileBytes && matchesPrefix(file.path, prefix) && file.path.includes(term));
            const cursor = cursorValue(query.cursor);
            if (cursor > candidates.length) throw new Error("仓库查询游标超出范围");
            const lines: string[] = [];
            let offset = cursor;
            let length = 0;
            while (offset < candidates.length && lines.length < limits.listEntries) {
              const line = candidates[offset].path;
              if (lines.length && length + line.length + 1 > limits.outputChars) break;
              lines.push(line); length += line.length + 1; offset += 1;
            }
            return boundedResult(lines.join("\n"), offset < candidates.length, limits.outputChars, offset < candidates.length ? offset : undefined);
          }),
          read: (query, requestedSignal) => operation(requestedSignal, async (operationSignal) => {
            if (typeof query.path !== "string" || !allowedPath(query.path)) throw new Error("仓库读取路径未获许可");
            const file = byPath.get(query.path);
            if (!file) throw new Error("仓库文件不存在或未获读取许可");
            const startLine = query.startLine ?? 1;
            const count = query.limit ?? limits.readLines;
            if (!Number.isSafeInteger(startLine) || startLine < 1 || !Number.isSafeInteger(count) || count < 1 || count > limits.readLines) {
              throw new Error("读取起始行或行数超出允许范围");
            }
            const lines = (await readBlob(file, operationSignal)).split(/\r?\n/);
            const end = Math.min(lines.length, startLine - 1 + count);
            const text = lines.slice(startLine - 1, end).map((line, index) => `${startLine + index}: ${line}`).join("\n");
            return boundedResult(text, end < lines.length, limits.outputChars, end < lines.length ? end + 1 : undefined);
          }),
          search: (query, requestedSignal) => operation(requestedSignal, async (operationSignal) => {
            const term = queryValue(query.query);
            const prefix = prefixValue(query.prefix);
            const candidates = files.filter(file => file.size <= limits.fileBytes && matchesPrefix(file.path, prefix));
            let offset = cursorValue(query.cursor);
            if (offset > candidates.length) throw new Error("仓库搜索游标超出范围");
            let scanned = 0;
            let bytes = 0;
            let outputLength = 0;
            const hits: string[] = [];
            let capped = false;
            for (; offset < candidates.length; offset += 1) {
              if (operationSignal.aborted) throw new Error("仓库搜索已中断");
              const file = candidates[offset];
              if (scanned >= limits.searchFiles || bytes + file.size > limits.searchBytes) break;
              scanned += 1; bytes += file.size;
              let text: string;
              try { text = await readBlob(file, operationSignal); }
              catch (error) {
                if (operationSignal.aborted) throw new Error("仓库搜索已中断");
                if (error instanceof Error && /不是可读取|LFS 指针/.test(error.message)) continue;
                throw error;
              }
              const lines = text.split(/\r?\n/);
              for (const [index, line] of lines.entries()) {
                if (!line.includes(term)) continue;
                const hit = `${file.path}:${index + 1}: ${line}`;
                if (hits.length >= limits.searchHits || outputLength + hit.length + 1 > limits.outputChars) { capped = true; break; }
                hits.push(hit); outputLength += hit.length + 1;
              }
              if (capped) { offset += 1; break; }
            }
            const truncated = capped || offset < candidates.length;
            return boundedResult(hits.join("\n"), truncated, limits.outputChars, offset < candidates.length ? offset : undefined);
          }),
        };
        return {
          access,
          dispose: () => {
            disposing ??= (async () => {
              closed = true;
              lifetime.abort();
              await Promise.allSettled([...active]);
              await cleanup();
            })();
            return disposing;
          },
        };
      } catch (error) {
        preparation.abort();
        await stopMonitor();
        try { await cleanup(); } catch { logger.warn("失败任务的仓库临时目录未能清理"); }
        if (monitorFailure) throw monitorFailure;
        if (input.signal.aborted) throw new Error("仓库准备已中断或超时");
        throw error;
      }
    },
  };
}
