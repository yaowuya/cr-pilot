import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DefaultResourceLoaderOptions } from "@earendil-works/pi-coding-agent";

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
}): DefaultResourceLoaderOptions {
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
