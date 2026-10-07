import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";
import { createSilentLogger, type Logger } from "../../shared/logger.ts";
import type { ReviewInput, ReviewResult, Reviewer } from "../../domain/review-task.ts";

// 领域端口类型由 domain 持有，这里重导出保持既有导入路径兼容。
export type { ReviewInput, ReviewResult, Reviewer };

/**
 * 资源加载选项类型。
 *
 * SDK 根入口只导出 `DefaultResourceLoader` 类而不导出其选项类型，因此从构造函数
 * 签名派生，避免维护一份会随 SDK 升级失配的本地副本。
 */
type LoaderOptions = ConstructorParameters<typeof DefaultResourceLoader>[0];

/** pi 会话的最小可替换面。只声明本服务用到的成员，测试可注入假实现。 */
export interface PiSessionLike {
  /** 送入一轮用户消息，resolve 表示该轮结束。 */
  prompt(text: string): Promise<void>;
  /** 取最近一条助手消息的文本；没有助手消息时返回 undefined。 */
  getLastAssistantText(): string | undefined;
  /** 当前生效模型；尚未选出模型时为 undefined。 */
  readonly model: { id: string } | undefined;
  /** 释放会话。重复调用由实现方保证安全，本服务仍只调用一次。 */
  dispose(): void;
}

/** 创建一次评审所用的 pi 会话。默认实现接真实 SDK，测试注入假实现。 */
export type PiSessionFactory = (options: { systemPrompt: string; cwd: string }) => Promise<PiSessionLike>;

/**
 * 创建一个空的隔离工作目录。
 *
 * pi 会按 `cwd` 发现项目设置、扩展与项目信任配置。本服务的评审对象来自请求体而不是
 * 本地仓库，因此把 `cwd` 指向空目录，一次性排除全部项目级发现；凭证仍由 `agentDir`
 * 指向的全局目录提供。目录在进程内复用，退出后由操作系统回收。
 */
export function createIsolatedWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "cr-pilot-review-"));
}

/**
 * 构造 pi 的资源加载选项。
 *
 * 三个 `no*` 开关与双 prompt 覆盖共同保证评审上下文只有 prompt 文件与请求里的代码：
 * 关掉上下文文件、skills 与 prompt 模板，并把 `systemPrompt` 设为 prompt 文件全文。
 * `appendSystemPromptOverride` 返回空数组是必需的，否则 pi 会自动附加
 * `~/.pi/agent` 或 `<cwd>/.pi` 下的 `APPEND_SYSTEM.md`。
 */
export function buildLoaderOptions(input: {
  prompt: string;
  cwd: string;
  agentDir: string;
}): LoaderOptions {
  return {
    cwd: input.cwd,
    agentDir: input.agentDir,
    noContextFiles: true,
    noSkills: true,
    noPromptTemplates: true,
    systemPromptOverride: () => input.prompt,
    appendSystemPromptOverride: () => [],
  };
}

/**
 * pi 返回了空评审文本。
 *
 * 与调用失败区分开：空文本通常指向 prompt 内容或模型配置问题，而不是 pi 崩溃。
 */
export class EmptyReviewError extends Error {
  override readonly name = "EmptyReviewError";
}

/** 组装用户消息。不使用代码围栏，避免 diff 里出现反引号时截断内容。 */
export function buildUserMessage(code: string, context?: string): string {
  const parts: string[] = [];
  const trimmedContext = context?.trim();
  if (trimmedContext) parts.push(`背景信息：\n${trimmedContext}`);
  parts.push(`待评审的代码变更：\n${code}`);
  return parts.join("\n\n");
}

/**
 * 创建基于 pi SDK 的评审执行者。
 *
 * 隔离工作目录在构造时创建一次并在进程内复用，避免每个请求产生临时目录。
 * 会话释放在 `finally` 中用标志位保证只执行一次：超时信号与正常结束可能同时到达，
 * 重复释放会打断 pi 自身的清理流程。信号在评审开始前就已中断时直接失败，
 * 不创建会话，避免为注定失败的请求分配资源。
 *
 * 日志只记录 prompt 与用户消息的长度，不记录正文：用户消息里是待评审的源代码。
 */
export function createPiReviewer(options: { sessionFactory?: PiSessionFactory; logger?: Logger } = {}): Reviewer {
  const workspace = createIsolatedWorkspace();
  const sessionFactory = options.sessionFactory ?? createRealSession;
  const logger = options.logger ?? createSilentLogger();
  logger.debug("已创建隔离工作目录", { cwd: workspace });
  return {
    async review({ systemPrompt, code, context, signal }) {
      if (signal.aborted) {
        logger.debug("评审在开始前已中断，不创建会话");
        throw signal.reason ?? new Error("评审在开始前已被中断");
      }
      const userMessage = buildUserMessage(code, context);
      logger.debug("创建 pi 会话", {
        cwd: workspace,
        systemPromptChars: systemPrompt.length,
        userMessageChars: userMessage.length,
      });
      const session = await sessionFactory({ systemPrompt, cwd: workspace });
      let disposed = false;
      const disposeOnce = (): void => {
        if (disposed) return;
        disposed = true;
        session.dispose();
        logger.debug("pi 会话已释放");
      };
      const onAbort = (): void => {
        logger.warn("评审被中断，释放 pi 会话");
        disposeOnce();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        logger.debug("送入 pi 评审", { userMessageChars: userMessage.length });
        await session.prompt(userMessage);
        if (signal.aborted) {
          throw signal.reason ?? new Error("评审已中断");
        }
        const text = session.getLastAssistantText()?.trim() ?? "";
        if (!text) throw new EmptyReviewError("pi 返回了空评审文本");
        logger.debug("pi 已返回", { reviewChars: text.length, model: session.model?.id ?? "unknown" });
        return { text, model: session.model?.id ?? "unknown" };
      } finally {
        signal.removeEventListener("abort", onAbort);
        disposeOnce();
      }
    },
  };
}

/** 默认会话工厂：按已核实的 SDK 签名装配一次隔离的 pi 会话。 */
async function createRealSession(options: { systemPrompt: string; cwd: string }): Promise<PiSessionLike> {
  const agentDir = getAgentDir();
  const loader = new DefaultResourceLoader(
    buildLoaderOptions({ prompt: options.systemPrompt, cwd: options.cwd, agentDir }),
  );
  await loader.reload();
  // agentDir 必须显式传给 createAgentSession：SDK 只有拿到 agentDir 才会读取该
  // 目录的 models.json / auth.json（否则走内置 catalog，容器的 $LLMGW_API_KEY
  // 插值配置不生效，评审报 No API key found）。
  const { session } = await createAgentSession({
    cwd: options.cwd,
    agentDir,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(),
    // "all" 关闭内置、扩展与自定义工具；字符串枚举而非布尔值是 SDK 的实际签名。
    noTools: "all",
  });
  return session;
}
