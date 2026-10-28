<template>
  <div class="page-container wecom-page">
    <header class="page-header">
      <div>
        <h1 class="page-header__title">企微映射</h1>
        <p class="page-header__desc">维护 GitLab 账号到企微成员的通知映射，让评审消息准确提及提交人</p>
      </div>
      <div class="page-header__actions">
        <el-button type="primary" @click="openCreate">
          <el-icon><Plus /></el-icon>
          新增映射
        </el-button>
      </div>
    </header>

    <el-alert v-if="loadError" type="error" :closable="false" show-icon class="load-alert">
      <template #title>企微映射加载失败</template>
      {{ loadError }} <el-button link type="primary" :loading="loading" @click="load">重新加载</el-button>
    </el-alert>

    <!-- 概览只使用当前接口列表推导，不展示原型中的虚构通知或机器人统计。 -->
    <section v-if="loaded" v-loading="loading" class="mapping-overview" aria-label="企微映射概览">
      <div v-for="item in mappingOverview" :key="item.label" class="mapping-overview__item">
        <span class="mapping-overview__label">{{ item.label }}</span>
        <strong class="mapping-overview__value">{{ item.value }}</strong>
        <small class="mapping-overview__detail">{{ item.detail }}</small>
      </div>
    </section>

    <el-alert type="info" :closable="false" class="mapping-hint" show-icon>
      <template #title>
        只填「企微姓名」时，通知里显示 <strong>@中文名</strong> 但不会真正提醒；填写「企微 userid」后才是真实成员提醒。
      </template>
      <div class="mapping-hint__body">
        userid 由企微管理后台分配，可在「通讯录 → 成员 → 账号」查看，需由管理员提供。
      </div>
    </el-alert>

    <section v-if="loaded" class="mapping-panel">
      <header class="mapping-panel__header">
        <div>
          <h2 class="mapping-panel__title">账号映射</h2>
          <p class="mapping-panel__desc">完整 userid 不在列表或接口响应中回显；这里只显示安全掩码。</p>
        </div>
        <span class="mapping-panel__count">{{ contacts.length }} 条</span>
      </header>

      <div class="mapping-table">
        <el-table v-loading="loading" :data="contacts">
          <el-table-column label="GitLab 账号" min-width="190">
            <template #default="{ row }">
              <code class="username">{{ row.gitlabUsername }}</code>
            </template>
          </el-table-column>
          <el-table-column label="企微姓名" min-width="150">
            <template #default="{ row }">
              <span v-if="row.wecomName">{{ row.wecomName }}</span>
              <span v-else class="cell-muted">未填写</span>
            </template>
          </el-table-column>
          <el-table-column label="企微 userid" min-width="190">
            <template #default="{ row }">
              <div class="userid-cell">
                <code v-if="row.hasWecomUserId" class="userid-cell__masked">{{ row.wecomUserIdMasked }}</code>
                <span v-else class="cell-muted">未填写</span>
                <span :class="row.hasWecomUserId ? 'reminder-state--ready' : 'cell-muted'">
                  {{ row.hasWecomUserId ? "可真实提醒" : "仅姓名展示" }}
                </span>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="更新时间" min-width="170">
            <template #default="{ row }">
              <span class="cell-muted mapping-time">{{ formatTime(row.updatedAt) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="140" fixed="right">
            <template #default="{ row }">
              <div class="row-actions">
                <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
                <el-popconfirm
                  :title="deleteConfirmTitle(row)"
                  confirm-button-text="删除"
                  cancel-button-text="取消"
                  confirm-button-type="danger"
                  @confirm="onDelete(row)"
                >
                  <template #reference>
                    <el-button link type="danger" :loading="deletingUsername === row.gitlabUsername">删除</el-button>
                  </template>
                </el-popconfirm>
              </div>
            </template>
          </el-table-column>
          <template #empty>
            <el-empty description="还没有映射，新增后通知会优先使用企微姓名" :image-size="80" />
          </template>
        </el-table>
      </div>
    </section>

    <el-dialog
      v-model="dialogVisible"
      :title="editing ? '编辑映射' : '新增映射'"
      width="480px"
      destroy-on-close
    >
      <el-form ref="formRef" class="mapping-form" :model="form" :rules="rules" label-position="top">
        <el-form-item label="GitLab 账号" prop="gitlabUsername">
          <el-input
            v-model="form.gitlabUsername"
            :disabled="editing"
            placeholder="MR 作者的 GitLab 登录名，如 samxiao"
          />
          <p v-if="editing" class="form-help">账号是映射记录的唯一标识，编辑时不可修改。</p>
        </el-form-item>
        <el-form-item label="企微姓名" prop="wecomName">
          <el-input v-model="form.wecomName" placeholder="成员在企微里的姓名，如 王秦" />
        </el-form-item>
        <el-form-item label="企微 userid" prop="wecomUserId">
          <el-input
            v-model="form.wecomUserId"
            type="password"
            autocomplete="new-password"
            :disabled="form.clearWecomUserId"
            :placeholder="editing && editingHasUserId ? '留空保留已配置的 userid；输入新值则替换' : '选填；填写后才会真实提醒该成员'"
          />
          <p v-if="editing && editingHasUserId" class="form-help">
            已配置：<code class="userid-cell__masked">{{ editingMaskedUserId }}</code>。留空不会清除原值。
          </p>
        </el-form-item>
        <div v-if="editing && editingHasUserId" class="clear-userid">
          <el-checkbox
            v-model="form.clearWecomUserId"
            :disabled="Boolean(form.wecomUserId.trim())"
          >清除已配置的 userid</el-checkbox>
          <p class="form-help">只有明确勾选后才会清除；输入新 userid 时不能同时清除。</p>
        </div>
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
 * 企微映射页：维护 GitLab 账号到企微成员的对应关系。
 *
 * 前端即时校验账号与 userid 的字符集，并保留后端作为最终校验边界。接口只
 * 返回 userid 掩码；编辑时空输入保留原值，只有显式勾选才提交清除指令。
 */
import { computed, onMounted, reactive, ref } from "vue";
import { ElMessage, type FormInstance, type FormRules } from "element-plus";
import { Plus } from "@element-plus/icons-vue";
import { api, isApiError } from "../api/client.ts";
import type { WecomContact } from "../types.ts";

interface MappingOverviewItem {
  label: string;
  value: number;
  detail: string;
}

const loading = ref(false);
const loaded = ref(false);
const loadError = ref("");
const saving = ref(false);
const deletingUsername = ref("");
const contacts = ref<WecomContact[]>([]);
const dialogVisible = ref(false);
/** 编辑态账号不可改，避免改主键后遗留旧记录。 */
const editing = ref(false);
const editingHasUserId = ref(false);
const editingMaskedUserId = ref("");
const formRef = ref<FormInstance>();
const form = reactive({ gitlabUsername: "", wecomName: "", wecomUserId: "", clearWecomUserId: false });

/** 概览始终由已加载列表推导，真实零值也按零展示。 */
const mappingOverview = computed<MappingOverviewItem[]>(() => {
  const total = contacts.value.length;
  const withUserId = contacts.value.filter((row) => row.hasWecomUserId).length;
  const nameOnly = total - withUserId;
  return [
    { label: "映射总数", value: total, detail: `${withUserId} 个含 userid，${nameOnly} 个仅姓名` },
    { label: "真实提醒", value: withUserId, detail: "群消息可触发成员通知" },
    { label: "仅姓名展示", value: nameOnly, detail: "只显示 @姓名，不触发提醒" },
  ];
});

/** 与后端一致的 GitLab 账号字符集。 */
const GITLAB_USERNAME_PATTERN = /^[a-zA-Z0-9_.-]+$/;
/** 与后端一致的企微 userid 字符集。 */
const WECOM_USERID_PATTERN = /^[a-zA-Z0-9_.@-]+$/;

const rules: FormRules = {
  gitlabUsername: [
    { required: true, message: "请输入 GitLab 账号", trigger: "blur" },
    {
      validator: (_rule, value: string, callback) => {
        if (value && !GITLAB_USERNAME_PATTERN.test(value.trim())) {
          callback(new Error("只能包含字母、数字、下划线、点或连字符"));
          return;
        }
        callback();
      },
      trigger: "blur",
    },
  ],
  wecomName: [
    {
      validator: (_rule, value: string, callback) => {
        // 编辑时空 userid 默认保留旧值；显式清除后必须另有姓名或新 userid。
        const retained = editing.value && editingHasUserId.value && !form.clearWecomUserId;
        if (!value?.trim() && !form.wecomUserId.trim() && !retained) {
          callback(new Error("企微姓名与 userid 至少填写一项"));
          return;
        }
        callback();
      },
      trigger: "blur",
    },
  ],
  wecomUserId: [
    {
      validator: (_rule, value: string, callback) => {
        const trimmed = value?.trim() ?? "";
        if (trimmed && !WECOM_USERID_PATTERN.test(trimmed)) {
          callback(new Error("只能包含字母、数字、下划线、点、连字符或 @"));
          return;
        }
        callback();
      },
      trigger: "blur",
    },
  ],
};

async function load(): Promise<void> {
  loading.value = true;
  loadError.value = "";
  try {
    contacts.value = await api.get<WecomContact[]>("/api/wecom-contacts");
    loaded.value = true;
  } catch (error) {
    loadError.value = isApiError(error) ? error.message : "加载映射失败";
    ElMessage.error(loadError.value);
  } finally {
    loading.value = false;
  }
}

function resetForm(): void {
  form.gitlabUsername = "";
  form.wecomName = "";
  form.wecomUserId = "";
  form.clearWecomUserId = false;
  editingHasUserId.value = false;
  editingMaskedUserId.value = "";
  formRef.value?.clearValidate();
}

function openCreate(): void {
  editing.value = false;
  resetForm();
  dialogVisible.value = true;
}

function openEdit(row: WecomContact): void {
  editing.value = true;
  form.gitlabUsername = row.gitlabUsername;
  form.wecomName = row.wecomName;
  // API 不返回明文，掩码只能展示，绝不能回填为待保存的 userid。
  form.wecomUserId = "";
  form.clearWecomUserId = false;
  editingHasUserId.value = row.hasWecomUserId;
  editingMaskedUserId.value = row.wecomUserIdMasked;
  formRef.value?.clearValidate();
  dialogVisible.value = true;
}

async function onSave(): Promise<void> {
  if (saving.value) return;
  const valid = await formRef.value?.validate().catch(() => false);
  if (!valid) return;

  saving.value = true;
  try {
    const userId = form.wecomUserId.trim();
    await api.put("/api/wecom-contacts", {
      gitlabUsername: form.gitlabUsername.trim(),
      wecomName: form.wecomName.trim(),
      ...(userId ? { wecomUserId: userId } : {}),
      ...(form.clearWecomUserId ? { clearWecomUserId: true } : {}),
    });
    ElMessage.success(editing.value ? "已保存" : "已新增映射");
    dialogVisible.value = false;
    await load();
  } catch (error) {
    ElMessage.error(isApiError(error) ? error.message : "保存失败");
  } finally {
    saving.value = false;
  }
}

/** 删除确认明确包含账号，避免管理员误删相邻行。 */
function deleteConfirmTitle(row: WecomContact): string {
  return `确认删除 ${row.gitlabUsername} 的企微映射？`;
}

async function onDelete(row: WecomContact): Promise<void> {
  if (deletingUsername.value) return;
  deletingUsername.value = row.gitlabUsername;
  try {
    await api.delete(`/api/wecom-contacts/${encodeURIComponent(row.gitlabUsername)}`);
    ElMessage.success("已删除");
    await load();
  } catch (error) {
    ElMessage.error(isApiError(error) ? error.message : "删除失败");
  } finally {
    deletingUsername.value = "";
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
.wecom-page {
  gap: 18px;
}

.mapping-overview {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  min-width: 0;
  overflow: hidden;
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: var(--el-border-radius-base);
}

.mapping-overview__item {
  min-width: 0;
  padding: 16px 18px;
}

.mapping-overview__item + .mapping-overview__item {
  border-left: 1px solid var(--el-border-color-lighter);
}

.mapping-overview__label,
.mapping-overview__value,
.mapping-overview__detail {
  display: block;
}

.mapping-overview__label {
  font-size: 12px;
  line-height: 18px;
  color: var(--el-text-color-secondary);
}

.mapping-overview__value {
  margin-top: 4px;
  font-size: 26px;
  font-weight: 500;
  line-height: 34px;
  color: var(--el-text-color-primary);
  font-variant-numeric: tabular-nums;
}

.mapping-overview__detail {
  margin-top: 4px;
  overflow: hidden;
  font-size: 12px;
  line-height: 18px;
  color: var(--el-text-color-regular);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mapping-hint {
  border: 1px solid var(--el-border-color-lighter);
}

.mapping-hint__body {
  margin-top: 4px;
  font-size: 13px;
  color: var(--el-text-color-regular);
}

.mapping-panel {
  min-width: 0;
  overflow: hidden;
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: var(--el-border-radius-base);
}

.mapping-panel__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 16px 18px 14px;
  border-bottom: 1px solid var(--el-border-color-lighter);
}

.mapping-panel__header > div {
  min-width: 0;
}

.mapping-panel__title {
  margin: 0;
  font-size: 16px;
  line-height: 22px;
  color: var(--el-text-color-primary);
}

.mapping-panel__desc {
  margin: 4px 0 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--el-text-color-secondary);
}

.mapping-panel__count {
  flex: none;
  padding-top: 2px;
  font-size: 12px;
  line-height: 20px;
  color: var(--el-text-color-secondary);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.mapping-table {
  min-width: 0;
  overflow: hidden;
}

.mapping-table :deep(.el-table) {
  --el-table-header-bg-color: var(--el-fill-color-light);
  --el-table-border-color: var(--el-border-color-lighter);
}

.mapping-table :deep(.el-table__inner-wrapper::before) {
  display: none;
}

.username,
.userid-cell__masked {
  font-family: var(--el-font-family-mono, "SFMono-Regular", Consolas, monospace);
  font-size: 13px;
}

.username {
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.userid-cell {
  display: grid;
  gap: 3px;
  align-items: start;
}

.userid-cell__masked {
  color: var(--el-text-color-regular);
  letter-spacing: 0.04em;
}

.reminder-state--ready,
.cell-muted {
  font-size: 12px;
  line-height: 18px;
}

.reminder-state--ready {
  color: var(--el-color-success);
}

.cell-muted {
  color: var(--el-text-color-secondary);
}

.mapping-time {
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.row-actions {
  display: flex;
  align-items: center;
  white-space: nowrap;
}

.mapping-form :deep(.el-form-item) {
  margin-bottom: 20px;
}

.form-help {
  margin: 6px 0 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--el-text-color-secondary);
}

.clear-userid {
  padding: 12px 14px;
  background: var(--el-fill-color-light);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: var(--el-border-radius-base);
}

.clear-userid .form-help {
  margin-left: 24px;
}

@media (max-width: 900px) {
  .mapping-overview__item,
  .mapping-panel__header {
    padding-right: 14px;
    padding-left: 14px;
  }
}

@media (max-width: 680px) {
  .mapping-overview {
    grid-template-columns: 1fr;
  }

  .mapping-overview__item + .mapping-overview__item {
    border-top: 1px solid var(--el-border-color-lighter);
    border-left: 0;
  }

  .page-header {
    flex-direction: column;
  }
}
</style>
