<template>
  <div class="page-container">
    <header class="page-header">
      <div>
        <h1 class="page-header__title">AI 厂商</h1>
        <p class="page-header__desc">配置多个 LLM 厂商与模型，可按项目指定使用哪一个；保存后写入 models.json，下一次评审即生效</p>
      </div>
      <div class="page-header__actions">
        <el-button :loading="loading" @click="load">
          <el-icon><Refresh /></el-icon>
          刷新
        </el-button>
        <el-button type="primary" @click="openCreate">
          <el-icon><Plus /></el-icon>
          新增厂商
        </el-button>
      </div>
    </header>

    <el-alert type="info" :closable="false" show-icon>
      <template #title>
        密钥只以掩码回显，留空表示不修改。未指定厂商的项目使用「全局默认」厂商。
      </template>
    </el-alert>

    <!-- 厂商卡片：一厂商一卡，比表格更适合展示 URL/模型/密钥这类多字段信息 -->
    <div v-if="providers.length === 0 && !loading" class="empty-wrap">
      <el-empty description="尚未配置任何厂商，评审将使用 pi-agent/models.json 里的既有配置">
        <el-button type="primary" @click="openCreate">立即新增</el-button>
      </el-empty>
    </div>

    <div v-else class="provider-grid">
      <article v-for="provider in providers" :key="provider.id" class="provider-card">
        <header class="provider-card__head">
          <div class="provider-card__title">
            <span class="provider-card__avatar" :style="{ backgroundColor: kindColor(provider.kind).bg, color: kindColor(provider.kind).fg }">
              {{ provider.label.charAt(0).toUpperCase() }}
            </span>
            <div class="provider-card__meta">
              <div class="provider-card__name">
                {{ provider.label }}
                <el-tag v-if="provider.isDefault" type="success" size="small" effect="light">全局默认</el-tag>
              </div>
              <span class="provider-card__kind">{{ provider.name }} · {{ apiLabel(provider.api) }}</span>
            </div>
          </div>
          <el-dropdown trigger="click" @command="(cmd: string) => onCommand(cmd, provider)">
            <button class="icon-button" title="更多操作">
              <el-icon><MoreFilled /></el-icon>
            </button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item v-if="!provider.isDefault" command="default">
                  <el-icon><Star /></el-icon>
                  设为全局默认
                </el-dropdown-item>
                <el-dropdown-item command="edit">
                  <el-icon><Edit /></el-icon>
                  编辑
                </el-dropdown-item>
                <el-dropdown-item command="delete" divided>
                  <el-icon><Delete /></el-icon>
                  删除
                </el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </header>

        <dl class="provider-card__body">
          <div class="field">
            <dt>API 地址</dt>
            <dd class="mono">{{ provider.baseUrl }}</dd>
          </div>
          <div class="field">
            <dt>API Key</dt>
            <dd>
              <span v-if="provider.hasApiKey" class="mono">{{ provider.apiKeyMasked }}</span>
              <span v-else class="cell-muted">未配置</span>
            </dd>
          </div>
          <div class="field">
            <dt>模型</dt>
            <dd>
              <div class="model-tags">
                <el-tag
                  v-for="model in provider.models"
                  :key="model"
                  size="small"
                  :type="model === provider.defaultModel ? 'primary' : 'info'"
                  effect="plain"
                >
                  {{ model }}
                </el-tag>
              </div>
            </dd>
          </div>
        </dl>
      </article>
    </div>

    <!-- 项目绑定：把某个项目钉到指定厂商 -->
    <el-card>
      <template #header>
        <div class="card-header">
          <span>项目级模型绑定</span>
          <el-button size="small" @click="openBinding">新增绑定</el-button>
        </div>
      </template>
      <el-table :data="bindings" size="small">
        <el-table-column prop="project" label="项目全名" min-width="240" />
        <el-table-column label="使用厂商" min-width="180">
          <template #default="{ row }">
            <span v-if="providerLabel(row.providerId)">{{ providerLabel(row.providerId) }}</span>
            <span v-else class="cell-muted">厂商已删除</span>
          </template>
        </el-table-column>
        <el-table-column label="模型" width="180">
          <template #default="{ row }">
            <span v-if="row.model" class="mono">{{ row.model }}</span>
            <span v-else class="cell-muted">跟随厂商默认</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="90">
          <template #default="{ row }">
            <el-popconfirm title="解除该项目的厂商绑定？" @confirm="onUnbind(row.project)">
              <template #reference>
                <el-button link type="danger">解除</el-button>
              </template>
            </el-popconfirm>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty description="暂无项目绑定，所有项目使用全局默认厂商" :image-size="80" />
        </template>
      </el-table>
    </el-card>

    <!-- 新增/编辑厂商 -->
    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑厂商' : '新增厂商'" width="680px" top="6vh" destroy-on-close>
      <el-form label-position="top">
        <el-form-item label="厂商模板">
          <div class="template-row">
            <el-button
              v-for="template in templates"
              :key="template.kind"
              size="small"
              :type="form.kind === template.kind ? 'primary' : 'default'"
              @click="applyTemplate(template)"
            >
              {{ template.label }}
            </el-button>
          </div>
        </el-form-item>

        <el-row :gutter="16">
          <el-col :span="12">
            <el-form-item label="展示名">
              <el-input v-model="form.label" placeholder="例如 DeepSeek" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="标识（models.json 的 provider key）">
              <el-input v-model="form.name" placeholder="小写字母/数字/下划线，如 deepseek" :disabled="editingId !== null" />
            </el-form-item>
          </el-col>
        </el-row>

        <el-form-item label="API 地址">
          <el-input v-model="form.baseUrl" placeholder="https://api.deepseek.com/v1" />
        </el-form-item>

        <el-form-item label="API Key">
          <el-input v-model="form.apiKey" type="password" show-password :placeholder="keyPlaceholder" />
        </el-form-item>

        <el-form-item label="协议类型">
          <el-select v-model="form.api" class="full-width">
            <el-option label="OpenAI Responses（/responses）" value="openai-responses" />
            <el-option label="OpenAI Completions（/chat/completions）" value="openai-completions" />
            <el-option label="Anthropic Messages" value="anthropic-messages" />
          </el-select>
        </el-form-item>

        <el-form-item label="模型清单（输入后回车添加，标签 × 删减）">
          <el-select
            v-model="form.models"
            multiple
            filterable
            allow-create
            default-first-option
            :reserve-keyword="false"
            placeholder="输入模型 id 后回车，如 deepseek-chat"
            class="full-width"
          >
            <el-option v-for="model in form.models" :key="model" :label="model" :value="model" />
          </el-select>
        </el-form-item>

        <el-row :gutter="16">
          <el-col :span="12">
            <el-form-item label="默认模型">
              <el-select v-model="form.defaultModel" clearable placeholder="不选则用清单第一个" class="full-width">
                <el-option v-for="model in form.models" :key="model" :label="model" :value="model" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="设为全局默认">
              <el-switch v-model="form.isDefault" />
              <span class="switch-hint">开启后其他厂商的默认标记会被取消</span>
            </el-form-item>
          </el-col>
        </el-row>
      </el-form>

      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="onSave">保存</el-button>
      </template>
    </el-dialog>

    <!-- 新增项目绑定 -->
    <el-dialog v-model="bindingVisible" title="新增项目绑定" width="520px" destroy-on-close>
      <el-form label-position="top">
        <el-form-item label="项目全名">
          <el-input v-model="bindingForm.project" placeholder="例如 group/project" />
        </el-form-item>
        <el-form-item label="使用厂商">
          <el-select v-model="bindingForm.providerId" class="full-width" placeholder="选择厂商">
            <el-option v-for="provider in providers" :key="provider.id" :label="provider.label" :value="provider.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="模型（可选）">
          <el-select v-model="bindingForm.model" clearable class="full-width" placeholder="跟随厂商默认模型">
            <el-option v-for="model in bindingModelOptions" :key="model" :label="model" :value="model" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="bindingVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="onBind">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
/**
 * AI 厂商管理页（D-021 / D-022）。
 *
 * 管理多个 LLM 厂商：每个厂商有自己的 baseUrl、apiKey、协议与模型清单。
 * 保存后后端把全部厂商写进 `pi-agent/models.json` 并把密钥导出到环境变量，
 * 下一次评审即按「项目绑定 > 全局默认」选用。
 *
 * 密钥三态：页面只拿到掩码；留空或提交掩码都表示「不修改原密钥」，
 * 由后端判定（见 providers.ts 的 looksMasked），避免掩码被当成新密钥写回。
 */
import { computed, onMounted, reactive, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { Delete, Edit, MoreFilled, Plus, Refresh, Star } from "@element-plus/icons-vue";
import { api, isApiError } from "../api/client.ts";
import type {
  LlmApiKind,
  LlmProjectBinding,
  LlmProviderSummary,
  LlmProviderTemplate,
  LlmProvidersResponse,
} from "../types.ts";

const loading = ref(false);
const saving = ref(false);
const providers = ref<LlmProviderSummary[]>([]);
const bindings = ref<LlmProjectBinding[]>([]);
const templates = ref<LlmProviderTemplate[]>([]);
const dialogVisible = ref(false);
const editingId = ref<number | null>(null);
const bindingVisible = ref(false);

const form = reactive<{
  name: string;
  label: string;
  kind: string;
  baseUrl: string;
  apiKey: string;
  api: LlmApiKind;
  models: string[];
  defaultModel: string;
  isDefault: boolean;
}>({
  name: "",
  label: "",
  kind: "custom",
  baseUrl: "",
  apiKey: "",
  api: "openai-completions",
  models: [],
  defaultModel: "",
  isDefault: false,
});

const bindingForm = reactive<{ project: string; providerId: number | undefined; model: string }>({
  project: "",
  providerId: undefined,
  model: "",
});

/** 编辑时提示用户：留空即保持原密钥。 */
const keyPlaceholder = computed(() =>
  editingId.value ? "留空表示不修改现有密钥" : "粘贴厂商 API Key",
);

/** 绑定弹窗里可选的模型：跟随所选厂商的清单。 */
const bindingModelOptions = computed(() => {
  const provider = providers.value.find((item) => item.id === bindingForm.providerId);
  return provider?.models ?? [];
});

/** 厂商类型配色：让卡片一眼区分不同厂商，色值集中在此便于统一调整。 */
function kindColor(kind: string): { bg: string; fg: string } {
  const palette: Record<string, { bg: string; fg: string }> = {
    openai: { bg: "rgb(16 185 129 / 12%)", fg: "#10b981" },
    deepseek: { bg: "rgb(59 130 246 / 12%)", fg: "#3b82f6" },
    anthropic: { bg: "rgb(245 158 11 / 12%)", fg: "#f59e0b" },
    qwen: { bg: "rgb(139 92 246 / 12%)", fg: "#8b5cf6" },
    zhipu: { bg: "rgb(236 72 153 / 12%)", fg: "#ec4899" },
    moonshot: { bg: "rgb(14 165 233 / 12%)", fg: "#0ea5e9" },
  };
  return palette[kind] ?? { bg: "rgb(100 116 139 / 12%)", fg: "#64748b" };
}

/** 协议类型的展示名。 */
function apiLabel(api: LlmApiKind): string {
  const labels: Record<LlmApiKind, string> = {
    "openai-responses": "OpenAI Responses",
    "openai-completions": "OpenAI 兼容",
    "anthropic-messages": "Anthropic Messages",
  };
  return labels[api] ?? api;
}

/** 厂商 id → 展示名，供绑定表格使用。 */
function providerLabel(providerId: number): string | undefined {
  return providers.value.find((item) => item.id === providerId)?.label;
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    const result = await api.get<LlmProvidersResponse>("/api/providers");
    providers.value = result.items;
    bindings.value = result.bindings;
  } catch (error) {
    ElMessage.error(isApiError(error) ? error.message : "加载厂商列表失败");
  } finally {
    loading.value = false;
  }
}

async function loadTemplates(): Promise<void> {
  try {
    templates.value = await api.get<LlmProviderTemplate[]>("/api/providers/templates");
  } catch {
    // 模板只是预填便利，失败不阻断新建。
  }
}

/** 套用模板：预填 baseUrl、协议与常见模型；name 也给出建议值。 */
function applyTemplate(template: LlmProviderTemplate): void {
  form.kind = template.kind;
  form.label = template.label;
  form.api = template.api;
  form.baseUrl = template.baseUrl;
  form.models = [...template.models];
  form.defaultModel = template.models[0] ?? "";
  // name 是 models.json 的 key，必须稳定可预测；编辑时不允许改。
  if (editingId.value === null) {
    form.name = template.kind;
  }
}

function resetForm(): void {
  form.name = "";
  form.label = "";
  form.kind = "custom";
  form.baseUrl = "";
  form.apiKey = "";
  form.api = "openai-completions";
  form.models = [];
  form.defaultModel = "";
  form.isDefault = false;
}

function openCreate(): void {
  editingId.value = null;
  resetForm();
  dialogVisible.value = true;
}

function openEdit(provider: LlmProviderSummary): void {
  editingId.value = provider.id;
  form.name = provider.name;
  form.label = provider.label;
  form.kind = provider.kind;
  form.baseUrl = provider.baseUrl;
  // 密钥不回显明文：留空即不修改。
  form.apiKey = "";
  form.api = provider.api;
  form.models = [...provider.models];
  form.defaultModel = provider.defaultModel ?? "";
  form.isDefault = provider.isDefault;
  dialogVisible.value = true;
}

async function onSave(): Promise<void> {
  if (!form.label.trim()) {
    ElMessage.warning("请填写展示名");
    return;
  }
  if (!form.name.trim()) {
    ElMessage.warning("请填写标识");
    return;
  }
  if (!form.baseUrl.trim()) {
    ElMessage.warning("请填写 API 地址");
    return;
  }
  if (form.models.length === 0) {
    ElMessage.warning("至少配置一个模型");
    return;
  }
  const payload = {
    name: form.name.trim(),
    label: form.label.trim(),
    kind: form.kind,
    base_url: form.baseUrl.trim(),
    api_key: form.apiKey || undefined,
    api: form.api,
    models: form.models,
    default_model: form.defaultModel || undefined,
    is_default: form.isDefault,
  };
  saving.value = true;
  try {
    if (editingId.value === null) {
      await api.post("/api/providers", payload);
      ElMessage.success("已新增厂商，models.json 已同步");
    } else {
      await api.put(`/api/providers/${editingId.value}`, payload);
      ElMessage.success("已保存，models.json 已同步");
    }
    dialogVisible.value = false;
    await load();
  } catch (error) {
    ElMessage.error(isApiError(error) ? error.message : "保存失败");
  } finally {
    saving.value = false;
  }
}

/** 下拉菜单命令分发。 */
async function onCommand(command: string, provider: LlmProviderSummary): Promise<void> {
  if (command === "edit") {
    openEdit(provider);
    return;
  }
  if (command === "default") {
    try {
      await api.post(`/api/providers/${provider.id}/default`);
      ElMessage.success(`已将 ${provider.label} 设为全局默认厂商`);
      await load();
    } catch (error) {
      ElMessage.error(isApiError(error) ? error.message : "设置失败");
    }
    return;
  }
  if (command === "delete") {
    try {
      await ElMessageBox.confirm(
        `删除厂商「${provider.label}」后，引用它的 prompt 与项目绑定将回落到全局默认厂商。确认删除？`,
        "删除厂商",
        { type: "warning", confirmButtonText: "删除", cancelButtonText: "取消" },
      );
    } catch {
      return; // 用户取消
    }
    try {
      await api.delete(`/api/providers/${provider.id}`);
      ElMessage.success("已删除");
      await load();
    } catch (error) {
      ElMessage.error(isApiError(error) ? error.message : "删除失败");
    }
  }
}

function openBinding(): void {
  bindingForm.project = "";
  bindingForm.providerId = undefined;
  bindingForm.model = "";
  bindingVisible.value = true;
}

async function onBind(): Promise<void> {
  if (!bindingForm.project.trim()) {
    ElMessage.warning("请填写项目全名");
    return;
  }
  if (!bindingForm.providerId) {
    ElMessage.warning("请选择厂商");
    return;
  }
  saving.value = true;
  try {
    await api.put(`/api/providers/bindings/${encodeURIComponent(bindingForm.project.trim())}`, {
      provider_id: bindingForm.providerId,
      model: bindingForm.model || undefined,
    });
    ElMessage.success("已绑定");
    bindingVisible.value = false;
    await load();
  } catch (error) {
    ElMessage.error(isApiError(error) ? error.message : "绑定失败");
  } finally {
    saving.value = false;
  }
}

async function onUnbind(project: string): Promise<void> {
  try {
    await api.delete(`/api/providers/bindings/${encodeURIComponent(project)}`);
    ElMessage.success("已解除绑定");
    await load();
  } catch (error) {
    ElMessage.error(isApiError(error) ? error.message : "解除失败");
  }
}

onMounted(() => {
  void Promise.all([load(), loadTemplates()]);
});
</script>

<style scoped>
.cell-muted {
  color: var(--el-text-color-secondary);
}

/* 等宽字体：URL、密钥掩码、模型 id 都是标识符，等宽更易比对 */
.mono {
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  font-size: 12px;
  word-break: break-all;
}

.empty-wrap {
  padding: 24px;
  background-color: var(--el-bg-color);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: var(--el-border-radius-base);
}

/* 厂商卡片网格：自适应列宽，窄屏自动减少列数 */
.provider-grid {
  display: grid;
  gap: 16px;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
}

.provider-card {
  display: flex;
  flex-direction: column;
  padding: 18px;
  background-color: var(--el-bg-color);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: var(--el-border-radius-base);
  transition:
    box-shadow var(--app-transition) ease,
    transform var(--app-transition) ease;
}

.provider-card:hover {
  box-shadow: var(--app-shadow);
  transform: translateY(-1px);
}

.provider-card__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  margin-bottom: 16px;
}

.provider-card__title {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.provider-card__avatar {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: 38px;
  font-size: 15px;
  font-weight: 600;
  border-radius: 10px;
}

.provider-card__meta {
  min-width: 0;
}

.provider-card__name {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 15px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.provider-card__kind {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.provider-card__body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin: 0;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.field dt {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.field dd {
  margin: 0;
  font-size: 13px;
  color: var(--el-text-color-primary);
}

.model-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

/* 顶栏图标按钮（与布局页保持一致的观感） */
.icon-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  font-size: 15px;
  color: var(--el-text-color-secondary);
  cursor: pointer;
  background: transparent;
  border: none;
  border-radius: 7px;
  transition: background-color var(--app-transition) ease;
}

.icon-button:hover {
  color: var(--el-text-color-primary);
  background-color: var(--el-fill-color-light);
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

/* 模板按钮横向排布，空间不足自动换行 */
.template-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.full-width {
  width: 100%;
}

.full-width :deep(.el-select__tags) {
  max-height: 96px;
  overflow-y: auto;
}

.switch-hint {
  margin-left: 10px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
</style>
