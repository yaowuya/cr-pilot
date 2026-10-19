/**
 * 把数据库中的 LLM 厂商配置同步到 `pi-agent/models.json`。
 *
 * 为什么落文件而不是纯内存注入（D-021）：
 * - pi SDK 的 provider 组合链路以 models.json 为首要来源；写文件能让 `pi` CLI
 *   与评审服务读到同一份配置，避免两套来源分叉。
 * - 文件是 SDK 的稳定契约，而内存注入依赖内部 API，升级时更易碎。
 *
 * 密钥处理：models.json 里不写明文 apiKey，而是写 `$ENV_NAME` 形式的引用，
 * 由 SDK 在请求时从进程环境变量插值。密钥实际存于数据库，启动时导出到环境变量。
 * 这样即使 models.json 被误提交或读到，也不会泄露密钥。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { LlmProvider } from "../../domain/llm-provider.ts";

/** 生成的 models.json 里单个模型的形状（对齐 pi 的 ProviderChatModelConfig）。 */
interface ModelsJsonModel {
  id: string;
  name: string;
  input: string[];
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

/** 单个 provider 的形状。 */
interface ModelsJsonProvider {
  baseUrl: string;
  api: string;
  apiKey: string;
  models: ModelsJsonModel[];
}

/** models.json 整体形状。 */
export interface ModelsJson {
  providers: Record<string, ModelsJsonProvider>;
}

/** 厂商 apiKey 在环境变量里的名字：稳定可预测，便于启动时导出与排障。 */
export function apiKeyEnvName(providerName: string): string {
  return `LLM_KEY_${providerName.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

/** 模型默认参数：pi 要求这些字段齐全，缺省用保守值。 */
const MODEL_DEFAULTS = {
  input: ["text"],
  contextWindow: 128000,
  maxTokens: 8192,
  reasoning: false,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} as const;

/**
 * 由厂商列表构造 models.json 内容（纯函数，便于单测）。
 *
 * 空列表时返回 undefined——调用方据此决定「不覆盖已有文件」，
 * 避免数据库刚初始化就把用户手写的 models.json 清空。
 */
export function buildModelsJson(providers: readonly LlmProvider[]): ModelsJson | undefined {
  if (providers.length === 0) return undefined;
  const result: ModelsJson = { providers: {} };
  for (const provider of providers) {
    const models = provider.models.map<ModelsJsonModel>((id) => ({
      id,
      name: id,
      ...MODEL_DEFAULTS,
      input: [...MODEL_DEFAULTS.input],
      cost: { ...MODEL_DEFAULTS.cost },
    }));
    result.providers[provider.name] = {
      baseUrl: provider.baseUrl,
      api: provider.api,
      // 环境变量引用而非明文：密钥由 bootstrap 从库里导出到 process.env
      apiKey: `$${apiKeyEnvName(provider.name)}`,
      models,
    };
  }
  return result;
}

/**
 * 生成 `models.json`（运行时产物，不入库）。
 *
 * 文件布局（D-025）：
 * - `models.template.json` 入库，是首次部署的初始配置；
 * - `models.json` 由本函数生成，已在 `.gitignore`，不随仓库分发。
 *
 * 为什么这样拆：`models.json` 既是 SDK 的读取目标、又是数据库配置的导出产物。
 * 若它同时入库，页面上每改一次厂商就会把仓库工作区弄脏，且「文件内容」与
 * 「数据库内容」形成两个事实源。拆成模板 + 生成物后，数据库是唯一事实源，
 * 模板只在数据库为空时兜底。
 *
 * 合并语义：首次生成时以模板为底座，数据库厂商按 name 覆盖同名项；
 * 之后每次生成都从模板重建，不累积历史残留（删除的厂商会被正确移除）。
 *
 * `settings.json` 的 `defaultModel` 只接受裸模型 id（不含 provider 前缀），
 * 因此多个厂商存在同名模型时会冲突——这里优先用全局默认厂商的默认模型，
 * 评审链路另有显式 model 注入，不依赖这个兜底值。
 */
export function writeModelsJson(options: {
  agentDir: string;
  providers: readonly LlmProvider[];
  defaultProvider?: LlmProvider;
}): { written: boolean; path: string; defaultModel?: string } {
  const generated = buildModelsJson(options.providers);
  const path = join(options.agentDir, "models.json");

  // 数据库为空时仍要产出一个文件：SDK 读不到 models.json 会回落到内置 catalog，
  // 结果是「模型密钥未配置」而不是清晰报错。此时用模板兜底。
  const template = readExistingProviders(join(options.agentDir, TEMPLATE_FILENAME));
  if (!generated) {
    // 没有任何配置来源（数据库空 + 模板缺失）：不写文件，由启动日志告警提示。
    if (Object.keys(template).length === 0) return { written: false, path };
    return writeMerged(path, template, undefined);
  }

  // 以模板为底座，数据库厂商覆盖同名项。
  const merged: ModelsJson = { providers: { ...template, ...generated.providers } };
  return writeMerged(path, merged.providers, options.defaultProvider);
}

/** 入库的模板文件名：与生成物区分，避免被 `.gitignore` 一并忽略。 */
export const TEMPLATE_FILENAME = "models.template.json";

/** 落盘并返回结果；内容未变化时不重写，避免无意义的 mtime 抖动。 */
function writeMerged(
  path: string,
  providers: Record<string, ModelsJsonProvider>,
  defaultProvider?: LlmProvider,
): { written: boolean; path: string; defaultModel?: string } {
  const content = `${JSON.stringify({ providers }, null, 2)}\n`;
  mkdirSync(dirname(path), { recursive: true });
  const changed = readTextIfExists(path) !== content;
  if (changed) writeFileSync(path, content, "utf8");

  const defaultModel = defaultProvider?.defaultModel ?? defaultProvider?.models[0];
  if (defaultModel) {
    const settingsPath = join(dirname(path), "settings.json");
    const nextSettings = `${JSON.stringify({ defaultModel }, null, 2)}\n`;
    if (readTextIfExists(settingsPath) !== nextSettings) writeFileSync(settingsPath, nextSettings, "utf8");
  }
  return { written: changed, path, defaultModel };
}

/** 读文本文件；不存在或不可读时返回 undefined（用于「内容是否变化」判断）。 */
function readTextIfExists(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * 读取 models.json 里已有的 providers。
 *
 * 任何异常都返回空对象：这个函数的唯一职责是「尽量别丢手写配置」，
 * 读不到就当没有，绝不能让 models.json 的格式问题阻断服务启动。
 */
function readExistingProviders(path: string): Record<string, ModelsJsonProvider> {
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as { providers?: unknown };
    if (!parsed || typeof parsed.providers !== "object" || parsed.providers === null) return {};
    // 逐项校验形状：只保留看起来像 provider 的条目，避免把垃圾数据合并进新文件。
    const result: Record<string, ModelsJsonProvider> = {};
    for (const [name, value] of Object.entries(parsed.providers as Record<string, unknown>)) {
      const item = value as Partial<ModelsJsonProvider> | null;
      if (!item || typeof item !== "object") continue;
      if (typeof item.baseUrl !== "string" || !Array.isArray(item.models)) continue;
      result[name] = item as ModelsJsonProvider;
    }
    return result;
  } catch {
    return {};
  }
}
