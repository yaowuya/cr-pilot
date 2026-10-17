<template>
  <div class="page-container">
    <header class="page-header">
      <div>
        <h1 class="page-header__title">Prompt 管理</h1>
        <p class="page-header__desc">按项目维护评审 prompt，未配置的项目回落到 default</p>
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
        <el-table-column label="项目全名" min-width="240" show-overflow-tooltip>
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
        <el-table-column label="企微推送" width="120">
          <template #default="{ row }">
            <el-tag :type="row.hasWecomWebhook ? 'success' : 'info'" size="small" effect="light">
              {{ row.hasWecomWebhook ? "已配置" : "未配置" }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="评分阈值" width="110" align="right">
          <template #default="{ row }">
            <span :class="row.wecomScoreThreshold === undefined ? 'cell-muted' : 'cell-strong'">
              {{ row.wecomScoreThreshold ?? "—" }}
            </span>
          </template>
        </el-table-column>
        <el-table-column label="更新时间" width="180">
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
      width="860px"
      top="6vh"
      destroy-on-close
    >
      <el-form label-position="top">
        <el-row :gutter="16">
          <el-col :span="16">
            <el-form-item label="项目全名">
              <el-input
                v-model="form.repository"
                placeholder="例如 group/project；留 default 表示全局默认"
                :disabled="editingId !== null"
              />
            </el-form-item>
          </el-col>
          <el-col :span="8">
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
 */
import { onMounted, reactive, ref } from "vue";
import { ElMessage } from "element-plus";
import { Download, Edit, Folder, Plus } from "@element-plus/icons-vue";
import PromptEditor from "../components/PromptEditor.vue";
import { api, isApiError } from "../api/client.ts";
import type { PromptSummary, StoredPrompt } from "../types.ts";

const loading = ref(false);
const saving = ref(false);
const importing = ref(false);
const prompts = ref<PromptSummary[]>([]);
const dialogVisible = ref(false);
const editingId = ref<number | null>(null);

const form = reactive({
  repository: "",
  systemPrompt: "",
  userPrompt: "",
  wecomWebhookUrl: "",
  wecomScoreThreshold: "",
});

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

function resetForm(): void {
  form.repository = "";
  form.systemPrompt = "";
  form.userPrompt = "";
  form.wecomWebhookUrl = "";
  form.wecomScoreThreshold = "";
}

function openCreate(): void {
  editingId.value = null;
  resetForm();
  dialogVisible.value = true;
}

/** 打开编辑：按 id 拉完整记录（列表不含正文）。 */
async function openEdit(row: PromptSummary): Promise<void> {
  try {
    const detail = await api.get<StoredPrompt>(`/api/prompts/${row.id}`);
    editingId.value = detail.id;
    form.repository = detail.repository;
    form.systemPrompt = detail.systemPrompt;
    form.userPrompt = detail.userPrompt;
    form.wecomWebhookUrl = detail.wecomWebhookUrl ?? "";
    form.wecomScoreThreshold = detail.wecomScoreThreshold === undefined ? "" : String(detail.wecomScoreThreshold);
    dialogVisible.value = true;
  } catch (error) {
    ElMessage.error(isApiError(error) ? error.message : "加载 prompt 详情失败");
  }
}

async function onSave(): Promise<void> {
  if (!form.repository.trim()) {
    ElMessage.warning("请填写项目全名");
    return;
  }
  if (!form.systemPrompt.trim() || !form.userPrompt.trim()) {
    ElMessage.warning("system prompt 与 user prompt 都不能为空");
    return;
  }
  const payload = {
    system_prompt: form.systemPrompt,
    user_prompt: form.userPrompt,
    wecom_webhook_url: form.wecomWebhookUrl || undefined,
    wecom_score_threshold: form.wecomScoreThreshold || undefined,
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
  void load();
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

.form-grid {
  display: grid;
  gap: 0 16px;
  grid-template-columns: 2fr 1fr;
}

/* 网格单元里的 el-form-item 默认 width:100% 且 flex-shrink 受限，
   不显式放开 min-width 会让长标签把列撑破。 */
.form-grid :deep(.el-form-item) {
  min-width: 0;
}

/* 弹窗内的 prompt 编辑器：两个 textarea 之间留出间距，
   避免上下两块代码区视觉粘连。 */
.prompt-editor-gap {
  margin-top: 4px;
}

@media (max-width: 640px) {
  .form-grid {
    grid-template-columns: 1fr;
  }
}
</style>
