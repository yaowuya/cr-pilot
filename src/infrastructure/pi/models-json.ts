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
import { mkdirSync, writeFileSync } from "node:fs";
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
 * 写入 models.json 并返回实际使用的默认模型 id。
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
  const content = buildModelsJson(options.providers);
  const path = join(options.agentDir, "models.json");
  if (!content) return { written: false, path };

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(content, null, 2)}\n`, "utf8");

  const defaultModel = options.defaultProvider?.defaultModel ?? options.defaultProvider?.models[0];
  if (defaultModel) {
    const settingsPath = join(options.agentDir, "settings.json");
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, `${JSON.stringify({ defaultModel }, null, 2)}\n`, "utf8");
  }
  return { written: true, path, defaultModel };
}
