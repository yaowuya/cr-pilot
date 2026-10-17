<template>
  <div class="page-container">
    <header class="page-header">
      <div>
        <h1 class="page-header__title">Prompt 管理</h1>
        <p class="page-header__desc">一条 prompt 可关联多个项目，任一项目命中即生效；未配置的项目回落到 default</p>
      </div>
      <div class="page-header__actions">
        <el-button :loading="importing" @click="onImport">
          <el-icon><Download /></el-icon>
          从 yaml 导入
        </el-button>
        <el-button type="primary" @click="openCreate">
          <el-icon><Plus /></el-icon>
          新建
        </el-button>
      </div>
    </header>

    <el-card>
      <el-table v-loading="loading" :data="prompts">
        <el-table-column label="名称" min-width="160" show-overflow-tooltip>
          <template #default="{ row }">
            <div class="repo-cell">
              <span class="repo-cell__icon">
                <el-icon><Folder /></el-icon>
              </span>
              <span class="cell-strong">{{ row.repository }}</span>
              <el-tag v-if="row.repository === 'default'" size="small" type="warning" effect="plain">默认</el-tag>
            </div>
          </template>
        </el-table-column>

        <!-- 项目列：多项目以标签平铺，超过 3 个折叠成 +N，避免撑破表格 -->
        <el-table-column label="关联项目" min-width="260">
          <template #default="{ row }">
            <span v-if="row.repository === 'default'" class="cell-muted">全局兜底，不绑定项目</span>
            <span v-else-if="row.projects.length === 0" class="cell-muted">未关联项目</span>
            <div v-else class="project-tags">
              <el-tag v-for="project in row.projects.slice(0, 3)" :key="project" size="small" effect="plain">
                {{ project }}
              </el-tag>
              <el-tooltip v-if="row.projects.length > 3" :content="row.projects.slice(3).join('、')" placement="top">
                <el-tag size="small" type="info" effect="plain">+{{ row.projects.length - 3 }}</el-tag>
              </el-tooltip>
            </div>
          </template>
        </el-table-column>

        <el-table-column label="模型" width="180" show-overflow-tooltip>
          <template #default="{ row }">
            <span v-if="!row.providerId" class="cell-muted">跟随全局默认</span>
            <span v-else-if="!row.providerLabel" class="cell-muted">厂商已删除</span>
            <span v-else class="cell-strong">{{ row.providerLabel }} / {{ row.model ?? "默认模型" }}</span>
          </template>
        </el-table-column>

        <el-table-column label="企微推送" width="110">
          <template #default="{ row }">
            <el-tag :type="row.hasWecomWebhook ? 'success' : 'info'" size="small" effect="light">
              {{ row.hasWecomWebhook ? "已配置" : "未配置" }}
            </el-tag>
          </template>
        </el-table-column>

        <el-table-column label="更新时间" width="170">
          <template #default="{ row }">
            <span class="cell-muted">{{ formatTime(row.updatedAt) }}</span>
          </template>
        </el-table-column>

        <el-table-column label="操作" width="140" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="openEdit(row)">
              <el-icon><Edit /></el-icon>
              编辑
            </el-button>
            <el-popconfirm title="删除后该项目将回落到 default prompt，确认删除？" @confirm="onDelete(row)">
              <template #reference>
                <el-button link type="danger">删除</el-button>
              </template>
            </el-popconfirm>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty description="暂无 prompt，可先点「从 yaml 导入」" :image-size="90" />
        </template>
      </el-table>
    </el-card>

    <el-dialog
      v-model="dialogVisible"
      :title="editingId ? `编辑 prompt：${form.repository}` : '新建 prompt'"
      width="900px"
      top="5vh"
      destroy-on-close
    >
      <el-form label-position="top">
        <el-row :gutter="16">
          <el-col :span="10">
            <el-form-item label="名称">
              <el-input
                v-model="form.repository"
                placeholder="例如 group/project 或「通用评审」"
                :disabled="editingId !== null"
              />
            </el-form-item>
          </el-col>
          <el-col :span="14">
            <el-form-item label="关联项目（可多选、可删减）">
              <!--
                可创建标签的远程搜索下拉：既能从已有项目里挑，也能直接输入新项目回车添加。
                这正是「支持删减 + 下拉框」的实现：标签自带关闭按钮即可删减。
              -->
              <el-select
                v-model="form.projects"
                multiple
                filterable
                allow-create
                default-first-option
                :reserve-keyword="false"
                :disabled="form.repository === 'default'"
                placeholder="选择或输入 GitLab 项目全名后回车"
                class="full-width"
              >
                <el-option v-for="project in projectOptions" :key="project" :label="project" :value="project" />
              </el-select>
            </el-form-item>
          </el-col>
        </el-row>

        <el-alert
          v-if="form.repository === 'default'"
          type="info"
          :closable="false"
          show-icon
          class="default-hint"
          title="default 是全局兜底 prompt，不绑定具体项目"
        />

        <el-row :gutter="16">
          <el-col :span="10">
            <el-form-item label="LLM 厂商（可选）">
              <el-select
                v-model="form.providerId"
                clearable
                placeholder="不选则跟随全局默认厂商"
                class="full-width"
                @change="onProviderChange"
              >
                <el-option
                  v-for="provider in providerOptions"
                  :key="provider.id"
                  :label="provider.isDefault ? `${provider.label}（全局默认）` : provider.label"
                  :value="provider.id"
                />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="7">
            <el-form-item label="模型（可选）">
              <el-select v-model="form.model" clearable :disabled="!form.providerId" placeholder="跟随厂商默认" class="full-width">
                <el-option v-for="model in modelOptions" :key="model" :label="model" :value="model" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="7">
            <el-form-item label="企微评分阈值（可选）">
              <el-input v-model="form.wecomScoreThreshold" placeholder="低于该值才推送，如 70" />
            </el-form-item>
          </el-col>
        </el-row>

        <el-form-item label="企微 Webhook（可选）">
          <el-input v-model="form.wecomWebhookUrl" placeholder="企业微信群机器人 Webhook URL" />
        </el-form-item>

        <!-- PromptEditor 内部是 el-form-item，必须在 el-form 之内，
             否则 label-position 等上下文继承不到，标签会与输入框错位。 -->
        <PromptEditor v-model:system-prompt="form.systemPrompt" v-model:user-prompt="form.userPrompt" />
      </el-form>

      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="onSave">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
/**
 * prompt 管理页。
 *
 * 列表接口刻意不返回正文：正文可达数万字符，一次拉全部会明显拖慢页面。
 * 编辑时按 id 单独拉完整记录再展示（见 design 的 API 契约）。
 *
 * 项目字段（D-020）：一条 prompt 可关联多个项目，用可创建标签的多选框编辑——
 * 已有项目从下拉选，新项目直接输入回车添加，标签上的 × 即删减。
 * 这解决了原来「项目名是逗号串、编辑时改不了」的问题。
 */
import { computed, onMounted, reactive, ref } from "vue";
import { ElMessage } from "element-plus";
import { Download, Edit, Folder, Plus } from "@element-plus/icons-vue";
import PromptEditor from "../components/PromptEditor.vue";
import { api, isApiError } from "../api/client.ts";
import type { PromptMeta, PromptSummary, StoredPrompt } from "../types.ts";

const loading = ref(false);
const saving = ref(false);
const importing = ref(false);
const prompts = ref<PromptSummary[]>([]);
const dialogVisible = ref(false);
const editingId = ref<number | null>(null);
/** 下拉建议：已关联项目 + 可用厂商。 */
const meta = ref<PromptMeta>({ projects: [], providers: [] });

const form = reactive<{
  repository: string;
  projects: string[];
  systemPrompt: string;
  userPrompt: string;
  wecomWebhookUrl: string;
  wecomScoreThreshold: string;
  providerId: number | undefined;
  model: string;
}>({
  repository: "",
  projects: [],
  systemPrompt: "",
  userPrompt: "",
  wecomWebhookUrl: "",
  wecomScoreThreshold: "",
  providerId: undefined,
  model: "",
});

/** 项目下拉候选：已关联项目合集。allow-create 让用户还能输入新项目。 */
const projectOptions = computed(() => meta.value.projects);

/** 厂商下拉候选。 */
const providerOptions = computed(() => meta.value.providers);

/** 当前选中厂商的模型清单，用于模型下拉。 */
const modelOptions = computed(() => {
  const provider = meta.value.providers.find((item) => item.id === form.providerId);
  return provider?.models ?? [];
});

/** 切换厂商时清空模型：不同厂商的模型名不通用，留着旧值会存成无效引用。 */
function onProviderChange(): void {
  form.model = "";
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    prompts.value = await api.get<PromptSummary[]>("/api/prompts");
  } catch (error) {
    ElMessage.error(isApiError(error) ? error.message : "加载 prompt 列表失败");
  } finally {
    loading.value = false;
  }
}

async function loadMeta(): Promise<void> {
  try {
    meta.value = await api.get<PromptMeta>("/api/prompts/meta");
  } catch (error) {
    // meta 只是下拉建议，失败不影响主流程，不弹错打断用户。
    console.warn("加载下拉建议失败", error);
  }
}

function resetForm(): void {
  form.repository = "";
  form.projects = [];
  form.systemPrompt = "";
  form.userPrompt = "";
  form.wecomWebhookUrl = "";
  form.wecomScoreThreshold = "";
  form.providerId = undefined;
  form.model = "";
}

async function openCreate(): Promise<void> {
  editingId.value = null;
  resetForm();
  await loadMeta();
  dialogVisible.value = true;
}

/** 打开编辑：按 id 拉完整记录（列表不含正文）。 */
async function openEdit(row: PromptSummary): Promise<void> {
  try {
    await loadMeta();
    const detail = await api.get<StoredPrompt>(`/api/prompts/${row.id}`);
    editingId.value = detail.id;
    form.repository = detail.repository;
    form.projects = [...detail.projects];
    form.systemPrompt = detail.systemPrompt;
    form.userPrompt = detail.userPrompt;
    form.wecomWebhookUrl = detail.wecomWebhookUrl ?? "";
    form.wecomScoreThreshold = detail.wecomScoreThreshold === undefined ? "" : String(detail.wecomScoreThreshold);
    form.providerId = detail.providerId;
    form.model = detail.model ?? "";
    dialogVisible.value = true;
  } catch (error) {
    ElMessage.error(isApiError(error) ? error.message : "加载 prompt 详情失败");
  }
}

async function onSave(): Promise<void> {
  if (!form.repository.trim()) {
    ElMessage.warning("请填写名称");
    return;
  }
  if (!form.systemPrompt.trim() || !form.userPrompt.trim()) {
    ElMessage.warning("system prompt 与 user prompt 都不能为空");
    return;
  }
  const payload = {
    projects: form.projects,
    system_prompt: form.systemPrompt,
    user_prompt: form.userPrompt,
    wecom_webhook_url: form.wecomWebhookUrl || undefined,
    wecom_score_threshold: form.wecomScoreThreshold || undefined,
    provider_id: form.providerId ?? undefined,
    model: form.model || undefined,
  };
  saving.value = true;
  try {
    if (editingId.value === null) {
      await api.post("/api/prompts", { repository: form.repository.trim(), ...payload });
      ElMessage.success("已创建，下一次评审即使用新 prompt");
    } else {
      await api.put(`/api/prompts/${editingId.value}`, payload);
      ElMessage.success("已保存，下一次评审即使用新 prompt");
    }
    dialogVisible.value = false;
    await load();
  } catch (error) {
    ElMessage.error(isApiError(error) ? error.message : "保存失败");
  } finally {
    saving.value = false;
  }
}

async function onDelete(row: PromptSummary): Promise<void> {
  try {
    await api.delete(`/api/prompts/${row.id}`);
    ElMessage.success("已删除，该项目回落到 default prompt");
    await load();
  } catch (error) {
    ElMessage.error(isApiError(error) ? error.message : "删除失败");
  }
}

async function onImport(): Promise<void> {
  importing.value = true;
  try {
    const result = await api.post<{ imported: number; skipped: number }>("/api/prompts/import");
    ElMessage.success(`导入完成：新增 ${result.imported} 条，跳过 ${result.skipped} 条`);
    await load();
  } catch (error) {
    ElMessage.error(isApiError(error) ? error.message : "导入失败");
  } finally {
    importing.value = false;
  }
}

function formatTime(value: number): string {
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

onMounted(() => {
  void Promise.all([load(), loadMeta()]);
});
</script>

<style scoped>
.cell-strong {
  font-weight: 500;
  color: var(--el-text-color-primary);
}

.cell-muted {
  color: var(--el-text-color-secondary);
}

/* 项目名前的文件夹图标：让长列表里的一列文本有视觉锚点 */
.repo-cell {
  display: flex;
  align-items: center;
  gap: 8px;
}

.repo-cell__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  font-size: 13px;
  color: var(--el-color-primary);
  background-color: var(--el-color-primary-light-9);
  border-radius: 7px;
}

/* 多项目标签平铺，换行不撑破单元格 */
.project-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.full-width {
  width: 100%;
}

/* 标签过多时自身滚动，而不是把弹窗撑高 */
.full-width :deep(.el-select__tags) {
  max-height: 96px;
  overflow-y: auto;
}

.default-hint {
  margin-bottom: 18px;
}
</style>
