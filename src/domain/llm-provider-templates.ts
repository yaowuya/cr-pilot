/**
 * 内置 LLM 厂商模板。
 *
 * 新建厂商时页面据此预填 baseUrl、协议与常见模型，用户仍可全部改掉。
 * 这些是「已知厂商的合理默认值」，不是硬编码限制——任何 OpenAI 兼容的
 * 自建网关都可以用 custom 模板 + 自定义 baseUrl 接入。
 *
 * `api` 的取值来自 pi SDK 支持的协议适配器：
 * - `openai-responses`：OpenAI 新一代 /responses 接口（本团队 llmgw 用的就是它）
 * - `openai-completions`：标准 /chat/completions，绝大多数兼容网关（DeepSeek 等）
 * - `anthropic-messages`：Anthropic 原生 messages 接口
 */
import type { LlmProviderTemplate } from "./llm-provider.ts";

export const LLM_PROVIDER_TEMPLATES: readonly LlmProviderTemplate[] = [
  {
    kind: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    api: "openai-responses",
    models: ["gpt-4o", "gpt-4o-mini", "o3-mini"],
  },
  {
    kind: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    api: "openai-completions",
    models: ["deepseek-chat", "deepseek-reasoner"],
  },
  {
    kind: "anthropic",
    label: "Anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    api: "anthropic-messages",
    models: ["claude-sonnet-4-5", "claude-opus-4-5", "claude-haiku-4-5"],
  },
  {
    kind: "qwen",
    label: "通义千问",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    api: "openai-completions",
    models: ["qwen-max", "qwen-plus", "qwen-turbo"],
  },
  {
    kind: "zhipu",
    label: "智谱 GLM",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    api: "openai-completions",
    models: ["glm-4-plus", "glm-4-air", "glm-4-flash"],
  },
  {
    kind: "moonshot",
    label: "月之暗面 Kimi",
    baseUrl: "https://api.moonshot.cn/v1",
    api: "openai-completions",
    models: ["moonshot-v1-128k", "moonshot-v1-32k"],
  },
  {
    kind: "custom",
    label: "自定义（OpenAI 兼容）",
    baseUrl: "",
    api: "openai-completions",
    models: [],
  },
];
