<template>
  <div class="page-container">
    <header class="page-header">
      <div>
        <h1 class="page-header__title">企微映射</h1>
        <p class="page-header__desc">把 GitLab 账号对应到企微成员，评审提醒才能 @ 到正确的人</p>
      </div>
      <div class="page-header__actions">
        <el-button type="primary" @click="openCreate">
          <el-icon><Plus /></el-icon>
          新增映射
        </el-button>
      </div>
    </header>

    <el-alert type="info" :closable="false" class="hint" show-icon>
      <template #title>
        只填「企微姓名」时，通知里显示 <strong>@中文名</strong> 但不会真正提醒；填写「企微 userid」后才是真实成员提醒。
      </template>
      <div class="hint__body">
        userid 由企微管理后台分配，可在「通讯录 → 成员 → 账号」查看，需由管理员提供。
      </div>
    </el-alert>

    <el-card>
      <el-table v-loading="loading" :data="contacts">
        <el-table-column label="GitLab 账号" min-width="200">
          <template #default="{ row }">
            <code class="username">{{ row.gitlabUsername }}</code>
          </template>
        </el-table-column>
        <el-table-column label="企微姓名" min-width="160">
          <template #default="{ row }">
            <span v-if="row.wecomName">{{ row.wecomName }}</span>
            <span v-else class="cell-muted">未填写</span>
          </template>
        </el-table-column>
        <el-table-column label="企微 userid" min-width="200">
          <template #default="{ row }">
            <span v-if="row.hasWecomUserId" class="mono">{{ row.wecomUserIdMasked }}</span>
            <span v-else class="cell-muted">未填写（不会真实提醒）</span>
          </template>
        </el-table-column>
        <el-table-column label="更新时间" min-width="180">
          <template #default="{ row }">
            <span class="cell-muted">{{ formatTime(row.updatedAt) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="150" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
            <el-popconfirm title="确认删除该映射？" @confirm="onDelete(row)">
              <template #reference>
                <el-button link type="danger">删除</el-button>
              </template>
            </el-popconfirm>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty description="还没有映射，新增后通知会优先使用企微姓名" :image-size="90" />
        </template>
      </el-table>
    </el-card>

    <el-dialog v-model="dialogVisible" :title="editing ? '编辑映射' : '新增映射'" width="480px" destroy-on-close>
      <el-form ref="formRef" :model="form" :rules="rules" label-position="top">
        <el-form-item label="GitLab 账号" prop="gitlabUsername">
          <el-input
            v-model="form.gitlabUsername"
            :disabled="editing"
            placeholder="MR 作者的 GitLab 登录名，如 samxiao"
          />
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
          <p v-if="editing && editingHasUserId" class="cell-muted">已配置：{{ editingMaskedUserId }}。留空不会清除原值。</p>
        </el-form-item>
        <el-checkbox
          v-if="editing && editingHasUserId"
          v-model="form.clearWecomUserId"
          :disabled="Boolean(form.wecomUserId.trim())"
        >清除已配置的 userid</el-checkbox>
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
 * 为什么单独一页而不是塞进环境变量：映射是**多条**记录，且每条的账号、
 * 姓名、userid 需要一起校验；塞进键值配置会变成手工拼 JSON，既难改也易错。
 *
 * 校验以后端为准：前端只做必填与格式的即时提示，真正拦截在
 * `/api/wecom-contacts` 里，避免两套规则漂移。
 */
import { onMounted, reactive, ref } from "vue";
import { ElMessage, type FormInstance, type FormRules } from "element-plus";
import { Plus } from "@element-plus/icons-vue";
import { api, isApiError } from "../api/client.ts";
import type { WecomContact } from "../types.ts";

const loading = ref(false);
const saving = ref(false);
const contacts = ref<WecomContact[]>([]);
const dialogVisible = ref(false);
/** 编辑态：为 true 时账号不可改，避免改键导致旧记录残留。 */
const editing = ref(false);
const editingHasUserId = ref(false);
const editingMaskedUserId = ref("");
const formRef = ref<FormInstance>();
const form = reactive({ gitlabUsername: "", wecomName: "", wecomUserId: "", clearWecomUserId: false });

/** 与后端一致的账号字符集。 */
const GITLAB_USERNAME_PATTERN = /^[a-zA-Z0-9_.-]+$/;
/** 与后端一致的 userid 字符集。 */
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
        // 编辑仅改姓名时留空 userid 会保留旧值；显式清除后则必须另填姓名。
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
  try {
    contacts.value = await api.get<WecomContact[]>("/api/wecom-contacts");
  } catch (error) {
    ElMessage.error(isApiError(error) ? error.message : "加载映射失败");
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
  // API 不再返回明文；不能把中间掩码当作真实 userid 回填或再次保存。
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

async function onDelete(row: WecomContact): Promise<void> {
  try {
    await api.delete(`/api/wecom-contacts/${encodeURIComponent(row.gitlabUsername)}`);
    ElMessage.success("已删除");
    await load();
  } catch (error) {
    ElMessage.error(isApiError(error) ? error.message : "删除失败");
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
.hint {
  margin-bottom: 16px;
}

.hint__body {
  margin-top: 4px;
  font-size: 13px;
  color: var(--el-text-color-regular);
}

.cell-muted {
  color: var(--el-text-color-secondary);
}

.username,
.mono {
  font-family: var(--el-font-family-mono, "SFMono-Regular", Consolas, monospace);
  font-size: 13px;
}
</style>
