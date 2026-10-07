<template>
  <div>
    <el-card>
      <template #header>
        <div class="card-header">
          <span>管理员账号</span>
          <el-button type="primary" @click="openCreate">新增</el-button>
        </div>
      </template>

      <el-table v-loading="loading" :data="admins" border>
        <el-table-column prop="username" label="用户名" min-width="180" />
        <el-table-column label="创建时间" min-width="180">
          <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="120">
          <template #default="{ row }">
            <el-popconfirm title="确认删除该管理员账号？" @confirm="onDelete(row)">
              <template #reference>
                <el-button link type="danger">删除</el-button>
              </template>
            </el-popconfirm>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty description="暂无管理员账号" />
        </template>
      </el-table>
    </el-card>

    <el-dialog v-model="dialogVisible" title="新增管理员" width="420px">
      <el-form ref="formRef" :model="form" :rules="rules" label-position="top">
        <el-form-item label="用户名" prop="username">
          <el-input v-model="form.username" placeholder="用户名" />
        </el-form-item>
        <el-form-item label="密码" prop="password">
          <el-input v-model="form.password" type="password" placeholder="至少 8 位" show-password />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="onCreate">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
/**
 * 管理员账号管理页。
 *
 * 删除约束由后端判定（禁止删自己、禁止删最后一个），页面原样透传后端的错误文案
 * 而不是自行判断——避免前后端两套规则不一致时给出误导提示。
 */
import { onMounted, reactive, ref } from "vue";
import { ElMessage, type FormInstance, type FormRules } from "element-plus";
import { api, isApiError } from "../api/client.ts";
import type { AdminUser } from "../types.ts";

const loading = ref(false);
const saving = ref(false);
const admins = ref<AdminUser[]>([]);
const dialogVisible = ref(false);
const formRef = ref<FormInstance>();
const form = reactive({ username: "", password: "" });

/** 与后端一致的密码最小长度，提前拦截避免无谓请求。 */
const MIN_PASSWORD_LENGTH = 8;

const rules: FormRules = {
  username: [{ required: true, message: "请输入用户名", trigger: "blur" }],
  password: [
    { required: true, message: "请输入密码", trigger: "blur" },
    { min: MIN_PASSWORD_LENGTH, message: `密码长度不能少于 ${MIN_PASSWORD_LENGTH} 位`, trigger: "blur" },
  ],
};

async function load(): Promise<void> {
  loading.value = true;
  try {
    admins.value = await api.get<AdminUser[]>("/api/admins");
  } catch (error) {
    ElMessage.error(isApiError(error) ? error.message : "加载管理员失败");
  } finally {
    loading.value = false;
  }
}

function openCreate(): void {
  form.username = "";
  form.password = "";
  dialogVisible.value = true;
}

async function onCreate(): Promise<void> {
  const valid = await formRef.value?.validate().catch(() => false);
  if (!valid) return;
  saving.value = true;
  try {
    await api.post("/api/admins", { username: form.username, password: form.password });
    ElMessage.success("已新增管理员");
    dialogVisible.value = false;
    await load();
  } catch (error) {
    ElMessage.error(isApiError(error) ? error.message : "新增失败");
  } finally {
    saving.value = false;
  }
}

async function onDelete(row: AdminUser): Promise<void> {
  try {
    await api.delete(`/api/admins/${row.id}`);
    ElMessage.success("已删除");
    await load();
  } catch (error) {
    // 后端对「删自己」与「删最后一个」返回不同文案，原样展示。
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
.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
</style>
