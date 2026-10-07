<template>
  <div>
    <el-card>
      <template #header>
        <div class="card-header">
          <span>Prompt 管理</span>
          <div>
            <el-button :loading="importing" @click="onImport">从 yaml 导入</el-button>
            <el-button type="primary" @click="openCreate">新建</el-button>
          </div>
        </div>
      </template>

      <el-table v-loading="loading" :data="prompts" border>
        <el-table-column prop="repository" label="项目全名" min-width="220" show-overflow-tooltip />
        <el-table-column label="企微推送" width="110">
          <template #default="{ row }">
            <el-tag :type="row.hasWecomWebhook ? 'success' : 'info'" size="small">
              {{ row.hasWecomWebhook ? "已配置" : "未配置" }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="评分阈值" width="100">
          <template #default="{ row }">{{ row.wecomScoreThreshold ?? "—" }}</template>
        </el-table-column>
        <el-table-column label="更新时间" width="180">
          <template #default="{ row }">{{ formatTime(row.updatedAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="150">
          <template #default="{ row }">
            <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
            <el-popconfirm title="删除后该项目将回落到 default prompt，确认删除？" @confirm="onDelete(row)">
              <template #reference>
                <el-button link type="danger">删除</el-button>
              </template>
            </el-popconfirm>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty description="暂无 prompt，可先点「从 yaml 导入」" />
        </template>
      </el-table>
    </el-card>

    <el-dialog v-model="dialogVisible" :title="editingId ? `编辑 prompt：${form.repository}` : '新建 prompt'" width="800px">
      <el-form label-position="top">
        <el-form-item label="项目全名">
          <el-input
            v-model="form.repository"
            placeholder="项目全名，例如 group/project；留 default 表示全局默认"
            :disabled="editingId !== null"
          />
        </el-form-item>
        <el-form-item label="企微 Webhook（可选）">
          <el-input v-model="form.wecomWebhookUrl" placeholder="企业微信群机器人 Webhook URL" />
        </el-form-item>
        <el-form-item label="企微评分阈值（可选）">
          <el-input v-model="form.wecomScoreThreshold" placeholder="总分低于该值才推送，例如 70" />
        </el-form-item>
      </el-form>

      <PromptEditor v-model:system-prompt="form.systemPrompt" v-model:user-prompt="form.userPrompt" />

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
.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
</style>
