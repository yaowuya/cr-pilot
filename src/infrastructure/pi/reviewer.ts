import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai/compat";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createExtensionRuntime,
  type CreateAgentSessionOptions,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import { createSilentLogger, type Logger } from "../../shared/logger.ts";
import type { ReviewInput, ReviewResult, Reviewer } from "../../domain/review-task.ts";
import type { RepositoryReadAccess } from "../../domain/repository-context.ts";
import { createRepositoryTools } from "./repository-tools.ts";

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
  /** 请求中断并等当前模型/工具 idle；旧测试替身可省略，由 dispose 兜底。 */
  abort?(): Promise<void>;
  /** 释放会话。重复调用由实现方保证安全，本服务仍只调用一次。 */
  dispose(): void;
}

/** 创建一次评审所用的 pi 会话。默认实现接真实 SDK，测试注入假实现。 */
export type PiSessionFactory = (options: {
  systemPrompt: string;
  cwd: string;
  /** 已授权的只读能力与当前会话取消信号；仅新模式使用。 */
  repositoryContext?: RepositoryReadAccess;
  signal: AbortSignal;
  /** 目标模型；缺省时用 models.json 的默认配置。 */
  model?: string;
  /** 目标厂商的 provider key。 */
  provider?: string;
}) => Promise<PiSessionLike>;

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
 * 旧无上下文模式关闭上下文文件、skills 和 prompt 模板，并把 systemPrompt
 * 设为配置全文；不承诺关闭全局扩展/packages，仓库模式必须改用静态 loader。
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
 * 构造无资源发现的仓库模式选项。DefaultResourceLoader 即使 noExtensions 也可能
 * resolve/install packages，所以这里不调用它；只保留受信配置的模型选择字段。
 */
export function buildRepositorySessionOptions(input: {
  systemPrompt: string; cwd: string; agentDir: string;
  repositoryContext: RepositoryReadAccess; signal: AbortSignal;
  settings?: Record<string, unknown>;
}): CreateAgentSessionOptions {
  const runtime = createExtensionRuntime();
  const loader: ResourceLoader = {
    getExtensions: () => ({extensions:[],errors:[],runtime}),
    getSkills: () => ({skills:[],diagnostics:[]}),
    getPrompts: () => ({prompts:[],diagnostics:[]}),
    getThemes: () => ({themes:[],diagnostics:[]}),
    getAgentsFiles: () => ({agentsFiles:[]}),
    getSystemPrompt: () => input.systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
  const settings = input.settings ?? {};
  const thinking = settings.defaultThinkingLevel;
  const validThinking = ["off","minimal","low","medium","high","xhigh"] as const;
  const defaultThinkingLevel = validThinking.find(value => value === thinking);
  const modelThinkingLevels: Record<string, typeof validThinking[number]> = {};
  if (typeof settings.modelThinkingLevels === "object" && settings.modelThinkingLevels !== null) {
    for (const [key,value] of Object.entries(settings.modelThinkingLevels)) {
      const level = validThinking.find(item => item === value);
      if (level) modelThinkingLevels[key] = level;
    }
  }
  return {
    cwd: input.cwd,
    agentDir: input.agentDir,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(input.cwd),
    settingsManager: SettingsManager.inMemory({
      defaultProvider: typeof settings.defaultProvider === "string" ? settings.defaultProvider : undefined,
      defaultModel: typeof settings.defaultModel === "string" ? settings.defaultModel : undefined,
      defaultThinkingLevel, modelThinkingLevels,
      cacheWarming: "off",
    }),
    tools: ["repo_list","repo_read","repo_search"],
    excludeTools: ["mcp__*"],
    customTools: createRepositoryTools(input.repositoryContext, input.signal),
  };
}

/** 只读取服务端 agentDir 的模型默认值；仓库路径从不参与 settings 发现。 */
function readTrustedSettings(agentDir: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(readFileSync(join(agentDir,"settings.json"),"utf8"));
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string,unknown> : {};
  } catch { return {}; }
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
    async review({ systemPrompt, code, context, signal, provider, model, repositoryContext }) {
      if (signal.aborted) {
        logger.debug("评审在开始前已中断，不创建会话");
        throw signal.reason ?? new Error("评审在开始前已被中断");
      }
      const userMessage = buildUserMessage(code, context);
      logger.debug("创建 pi 会话", {
        工作目录: workspace,
        系统提示字数: systemPrompt.length,
        用户消息字数: userMessage.length,
        厂商: provider ?? "默认",
        模型: model ?? "默认",
      });
      const session = await sessionFactory({ systemPrompt, cwd: workspace, provider, model, repositoryContext, signal });
      let disposed = false;
      const disposeOnce = (): void => {
        if (disposed) return;
        disposed = true;
        session.dispose();
        logger.debug("pi 会话已释放");
      };
      let stopping: Promise<void> | undefined;
      const stopOnce = (): Promise<void> => {
        stopping ??= (async () => {
          if (session.abort) await session.abort();
          else disposeOnce();
        })().catch(() => { logger.warn("pi 会话中断等待失败，将释放会话"); });
        return stopping;
      };
      const onAbort = (): void => {
        logger.warn("评审被中断，等待 pi 会话停止");
        void stopOnce();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        // 工厂初始化可能经历异步 IO；必须复核期间发生的取消，不能漏过后继续 prompt。
        if (signal.aborted) throw new Error("评审已中断");
        logger.debug("送入 pi 评审", { 用户消息字数: userMessage.length });
        await session.prompt(userMessage);
        if (signal.aborted) {
          throw signal.reason ?? new Error("评审已中断");
        }
        const text = session.getLastAssistantText()?.trim() ?? "";
        if (!text) throw new EmptyReviewError("pi 返回了空评审文本");
        logger.debug("pi 已返回", { 评审字数: text.length, 模型: session.model?.id ?? "unknown" });
        return { text, model: session.model?.id ?? "unknown" };
      } finally {
        signal.removeEventListener("abort", onAbort);
        await stopOnce();
        disposeOnce();
      }
    },
  };
}

/** 默认会话工厂：按已核实的 SDK 签名装配一次隔离的 pi 会话。 */
async function createRealSession(options: Parameters<PiSessionFactory>[0]): Promise<PiSessionLike> {
  const agentDir = getAgentDir();
  if (options.repositoryContext) {
    const sessionOptions = buildRepositorySessionOptions({
      ...options, agentDir, repositoryContext: options.repositoryContext,
      settings: readTrustedSettings(agentDir),
    });
    const { session } = await createAgentSession({
      ...sessionOptions,
      model: await resolveModel(agentDir, options.provider, options.model),
    });
    return session;
  }
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
    // 按项目/全局配置选定模型（D-022）。解析失败时不传 model，退回 SDK 的
    // 默认选择（models.json 的 defaultModel），避免因为一条配置错误让评审直接失败。
    model: await resolveModel(agentDir, options.provider, options.model),
    // "all" 关闭内置、扩展与自定义工具；字符串枚举而非布尔值是 SDK 的实际签名。
    noTools: "all",
  });
  return session;
}

/**
 * 从 models.json 解析出具体的 Model 对象。
 *
 * SDK 的 `model` 选项要的是 Model 实例而不是字符串，因此需要先建 ModelRuntime
 * 读一遍 models.json，再用 `getModel(provider, modelId)` 取出。
 *
 * 只指定 model 不指定 provider 时，遍历所有 provider 找第一个匹配的模型：
 * 页面允许只填模型名（用户不关心 provider key），这种宽松匹配更符合直觉。
 */
async function resolveModel(
  agentDir: string,
  provider?: string,
  modelId?: string,
): Promise<Model<any> | undefined> {
  if (!modelId) return undefined;
  try {
    const runtime = await ModelRuntime.create({ modelsPath: join(agentDir, "models.json") });
    if (provider) {
      return runtime.getModel(provider, modelId) ?? undefined;
    }
    for (const item of runtime.getProviders()) {
      const found = runtime.getModel(item.id, modelId);
      if (found) return found;
    }
    return undefined;
  } catch {
    // models.json 缺失或格式异常：交给 SDK 的默认模型选择，不阻断评审。
    return undefined;
  }
}
