/**
 * LLM 厂商与模型的领域模型及持久化端口。
 *
 * 背景（D-021）：原来模型配置写死在 `pi-agent/models.json`，只有 llmgw 一个厂商。
 * 现在改为数据库管理：页面可增删改多个厂商（chatgpt / deepseek / 自建网关等），
 * 每个厂商带自己的 baseUrl、apiKey、api 协议与模型清单。
 *
 * 落盘策略：保存后由 infrastructure 生成 `pi-agent/models.json`，pi SDK 启动/刷新时
 * 读该文件生效。选文件而不是纯内存注入，是因为 SDK 的 provider 组合链路
 * （ModelRuntime → models.json → 内置 catalog）以文件为首要来源，写文件能同时
 * 让 `pi` CLI 与评审服务看到同一份配置。
 */

/** 厂商协议类型：决定 SDK 用哪种 API 适配器发起请求。 */
export type LlmApiKind = "openai-responses" | "openai-completions" | "anthropic-messages";

/** 支持的内置厂商模板：新建时据此预填 baseUrl 与 api。 */
export interface LlmProviderTemplate {
  /** 稳定标识，落库为 `llm_providers.kind`。 */
  kind: string;
  /** 页面展示名。 */
  label: string;
  baseUrl: string;
  api: LlmApiKind;
  /** 该厂商的常见模型，供新建时预填（用户仍可增删）。 */
  models: string[];
}

/** 一个 LLM 厂商配置。 */
export interface LlmProvider {
  id: number;
  /** 唯一标识，同时作为 models.json 里的 provider key。 */
  name: string;
  /** 页面展示名。 */
  label: string;
  /** 厂商类型，对应 `LlmProviderTemplate.kind`。 */
  kind: string;
  /** API 基地址，例如 `https://api.deepseek.com/v1`。 */
  baseUrl: string;
  /** API 密钥；读取接口掩码回显。 */
  apiKey?: string;
  /** 协议类型。 */
  api: LlmApiKind;
  /** 该厂商可用的模型 id 列表。 */
  models: string[];
  /** 该厂商的默认模型；为空时取 models[0]。 */
  defaultModel?: string;
  /** 是否为全局默认厂商；全局至多一个。 */
  isDefault: boolean;
  createdAt: number;
  updatedAt: number;
}

/** 厂商列表摘要：不含 apiKey。 */
export interface LlmProviderSummary {
  id: number;
  name: string;
  label: string;
  kind: string;
  baseUrl: string;
  /** 是否已配置 apiKey（不回传明文）。 */
  hasApiKey: boolean;
  /** apiKey 的掩码形式，供页面回显。 */
  apiKeyMasked?: string;
  api: LlmApiKind;
  models: string[];
  defaultModel?: string;
  isDefault: boolean;
  updatedAt: number;
}

/** 项目级厂商绑定：让某个 GitLab 项目用指定厂商/模型评审（D-022）。 */
export interface LlmProjectBinding {
  project: string;
  providerId: number;
  model?: string;
}

/** 创建/更新厂商的入参。 */
export interface LlmProviderInput {
  name: string;
  label: string;
  kind: string;
  baseUrl: string;
  apiKey?: string;
  api: LlmApiKind;
  models: string[];
  defaultModel?: string;
  isDefault: boolean;
}

/** 一次评审实际使用的模型选择结果。 */
export interface ResolvedLlmTarget {
  provider: LlmProvider;
  model: string;
}

/** LLM 厂商仓储端口。实现方为 infrastructure/sqlite。 */
export interface LlmProviderRepository {
  list(): LlmProviderSummary[];
  get(id: number): LlmProvider | undefined;
  findByName(name: string): LlmProvider | undefined;
  /** 创建；name 重复时抛错，错误消息含「已存在」供路由转 409。 */
  create(input: LlmProviderInput): LlmProvider;
  update(id: number, input: LlmProviderInput): LlmProvider;
  remove(id: number): void;
  /** 取全局默认厂商；没有显式标记时回退第一条。 */
  getDefault(): LlmProvider | undefined;
  /** 把某厂商设为唯一默认（其余取消标记）。 */
  setDefault(id: number): void;
  /** 项目级绑定：设置/覆盖某项目的厂商选择。 */
  bindProject(project: string, providerId: number, model?: string): void;
  unbindProject(project: string): void;
  listProjectBindings(): LlmProjectBinding[];
  /**
   * 解析一次评审应使用的厂商与模型。
   *
   * 优先级：项目绑定 > 全局默认。都未配置时返回 undefined，由调用方
   * 回落到 models.json 里的既有配置（保证老部署升级后仍能跑）。
   */
  resolveTarget(project?: string): ResolvedLlmTarget | undefined;
}
