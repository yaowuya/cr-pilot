/**
 * Git 进程边界：不经过 shell、不继承服务密钥/任意 Git 配置，
 * 输出有界，取消后等待进程树与 pipe 关闭；错误只携带安全分类。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { parseGitlabHttpUrl } from "../../domain/repository-context.ts";

export type GitProcessErrorCode = "not-found" | "failed" | "aborted" | "output-limit";

/** 不附加 cause、argv 或 stderr，避免调用方日志化 Error 时泄漏授权头。 */
export class GitProcessError extends Error {
  override readonly name = "GitProcessError";
  readonly code: GitProcessErrorCode;
  constructor(code: GitProcessErrorCode) {
    const messages: Record<GitProcessErrorCode, string> = {
      "not-found": "Git 运行程序不可用，请检查部署环境",
      failed: "Git 操作失败，请检查仓库访问权限、版本和网络",
      aborted: "Git 操作已中断或超时",
      "output-limit": "Git 输出超过安全上限",
    };
    super(messages[code]);
    this.code = code;
  }
}

export interface GitRunOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  maxOutputBytes: number;
}

/** 可信基础设施调用者构造参数；模型不能直接取得此接口。 */
export type GitRunner = (args: readonly string[], options: GitRunOptions) => Promise<Buffer>;

/**
 * 每个任务的隔离 Git 环境。token 仅存在于网络子进程 URL 限定的环境头，
 * 不写文件或 argv；这不提供同一操作系统用户之间的进程环境隔离。
 */
export function buildGitEnvironment(input: {
  root: string;
  repositoryUrl?: string;
  token?: string;
  insecureTls?: boolean;
  inherited?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  const inherited = input.inherited ?? process.env;
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(inherited)) {
    if (/^(path|systemroot|windir|comspec|temp|tmp|tmpdir)$/i.test(key) && value !== undefined) env[key] = value;
  }
  Object.assign(env, {
    HOME: input.root,
    USERPROFILE: input.root,
    XDG_CONFIG_HOME: input.root,
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(input.root, "empty.gitconfig"),
    GIT_CONFIG_SYSTEM: join(input.root, "empty.gitconfig"),
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_LFS_SKIP_SMUDGE: "1",
  });
  const config: [string, string][] = [
    ["credential.helper", ""],
    ["http.followRedirects", "false"],
    ["http.sslVerify", input.insecureTls ? "false" : "true"],
    ["core.hooksPath", join(input.root, "empty-hooks")],
    ["init.templateDir", join(input.root, "empty-template")],
    ["core.fsmonitor", "false"],
    ["core.autocrlf", "false"],
    ["submodule.recurse", "false"],
    ["protocol.allow", "never"],
    ["protocol.http.allow", "always"],
    ["protocol.https.allow", "always"],
    ["gc.auto", "0"],
    ["maintenance.auto", "false"],
  ];
  if (input.token !== undefined) {
    if (!input.repositoryUrl || !input.token.trim() || /[\u0000\r\n]/.test(input.token)) {
      throw new Error("Git 网络调用缺少有效仓库地址或凭据");
    }
    const url = parseGitlabHttpUrl(input.repositoryUrl).href;
    config.push([`http.${url}.extraHeader`, `Authorization: Basic ${Buffer.from(`oauth2:${input.token}`).toString("base64")}`]);
  }
  env.GIT_CONFIG_COUNT = String(config.length);
  config.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return env;
}

/** 终止自身创建的进程树；Git HTTP helper 可能仍持有父进程的 stdout pipe。 */
async function terminateTree(child: ChildProcess): Promise<void> {
  if (!child.pid) return;
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
        ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore", shell: false });
      killer.once("error", () => { child.kill("SIGKILL"); resolve(); });
      killer.once("close", (code) => { if (code !== 0) child.kill("SIGKILL"); resolve(); });
    });
  } else {
    try { process.kill(-child.pid, "SIGKILL"); }
    catch { child.kill("SIGKILL"); }
  }
}

/** 创建无 shell 的 runner；executable 仅供可信启动配置和离线子进程测试注入。 */
export function createGitRunner(input: { executable?: string } = {}): GitRunner {
  const executable = input.executable ?? "git";
  return async (args, options) => {
    if (options.signal?.aborted) throw new GitProcessError("aborted");
    if (!Number.isSafeInteger(options.maxOutputBytes) || options.maxOutputBytes < 1) throw new Error("Git 输出上限必须为正整数");
    return await new Promise<Buffer>((resolve, reject) => {
      const output: Buffer[] = [];
      let outputBytes = 0;
      let errorBytes = 0;
      let failure: GitProcessError | undefined;
      let termination: Promise<void> | undefined;
      const child = spawn(executable, [...args], {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stop = (code: GitProcessErrorCode): void => {
        failure ??= new GitProcessError(code);
        termination ??= terminateTree(child);
      };
      const onAbort = (): void => stop("aborted");
      options.signal?.addEventListener("abort", onAbort, { once: true });
      // 覆盖 spawn 和监听注册之间发生的取消，不让已取消任务继续下载。
      if (options.signal?.aborted) onAbort();
      child.stdout.on("data", (chunk: Buffer) => {
        outputBytes += chunk.length;
        if (outputBytes > options.maxOutputBytes) stop("output-limit");
        else if (!failure) output.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        // --progress 可能连续输出；既不存储正文，也不允许无限进度流。
        errorBytes += chunk.length;
        if (errorBytes > Math.max(options.maxOutputBytes, 8192)) stop("output-limit");
      });
      child.once("error", (error: NodeJS.ErrnoException) => {
        failure ??= new GitProcessError(error.code === "ENOENT" ? "not-found" : "failed");
      });
      child.once("close", (code) => {
        options.signal?.removeEventListener("abort", onAbort);
        // close 表示所有 stdio 已关闭，仍需等待 Windows taskkill 自身退出。
        void (termination ?? Promise.resolve()).then(() => {
          if (failure) reject(failure);
          else if (code !== 0) reject(new GitProcessError("failed"));
          else resolve(Buffer.concat(output, outputBytes));
        });
      });
    });
  };
}
