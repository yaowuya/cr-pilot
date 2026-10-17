<template>
  <div class="page-container">
    <header class="page-header">
      <div>
        <h1 class="page-header__title">管理员</h1>
        <p class="page-header__desc">管理控制台登录账号，至少保留一个可用账号</p>
      </div>
      <div class="page-header__actions">
        <el-button type="primary" @click="openCreate">
          <el-icon><Plus /></el-icon>
          新增账号
        </el-button>
      </div>
    </header>

    <el-card>
      <el-table v-loading="loading" :data="admins">
        <el-table-column label="账号" min-width="240">
          <template #default="{ row }">
            <div class="admin-cell">
              <span class="admin-cell__avatar">{{ row.username.charAt(0).toUpperCase() }}</span>
              <div class="admin-cell__info">
                <span class="admin-cell__name">{{ row.username }}</span>
                <span v-if="row.username === selfName" class="admin-cell__self">当前登录</span>
                <!-- 管理员身份来自 ADMIN_USERNAME 配置，页面上不可授予或撤销（D-024） -->
                <span v-if="row.isAdmin" class="admin-cell__admin">管理员</span>
              </div>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="创建时间" min-width="200">
          <template #default="{ row }">
            <span class="cell-muted">{{ formatTime(row.createdAt) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="120" fixed="right">
          <template #default="{ row }">
            <el-popconfirm
              title="确认删除该管理员账号？"
              :disabled="row.username === selfName"
              @confirm="onDelete(row)"
            >
              <template #reference>
                <el-button link type="danger" :disabled="row.username === selfName">
                  删除
                </el-button>
              </template>
            </el-popconfirm>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty description="暂无管理员账号" :image-size="90" />
        </template>
      </el-table>
    </el-card>

    <el-dialog v-model="dialogVisible" title="新增管理员" width="440px" destroy-on-close>
      <el-form ref="formRef" :model="form" :rules="rules" label-position="top">
        <el-form-item label="用户名" prop="username">
          <el-input v-model="form.username" placeholder="请输入用户名">
            <template #prefix>
              <el-icon><User /></el-icon>
            </template>
          </el-input>
        </el-form-item>
        <el-form-item label="密码" prop="password">
          <el-input v-model="form.password" type="password" placeholder="至少 8 位" show-password>
            <template #prefix>
              <el-icon><Lock /></el-icon>
            </template>
          </el-input>
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
 * 唯一的前端侧限制是「自己」那一行按钮禁用：这是纯体验优化，不替代后端校验。
 */
import { onMounted, reactive, ref } from "vue";
import { ElMessage, type FormInstance, type FormRules } from "element-plus";
import { Lock, Plus, User } from "@element-plus/icons-vue";
import { api, isApiError } from "../api/client.ts";
import { currentUsername } from "../stores/auth.ts";
import type { AdminUser } from "../types.ts";

const loading = ref(false);
const saving = ref(false);
const admins = ref<AdminUser[]>([]);
const dialogVisible = ref(false);
const formRef = ref<FormInstance>();
const form = reactive({ username: "", password: "" });

/** 当前登录账号名：用于给「自己」那一行打标记并禁用删除按钮。 */
const selfName = currentUsername();

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
.cell-muted {
  color: var(--el-text-color-secondary);
}

/* 账号列：头像 + 名称 + 自身标记 */
.admin-cell {
  display: flex;
  align-items: center;
  gap: 10px;
}

.admin-cell__avatar {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  font-size: 13px;
  font-weight: 600;
  color: #fff;
  background: linear-gradient(135deg, var(--el-color-primary) 0%, var(--el-color-primary-light-3) 100%);
  border-radius: 50%;
}

.admin-cell__info {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.admin-cell__name {
  font-weight: 500;
  color: var(--el-text-color-primary);
}

.admin-cell__self {
  padding: 1px 7px;
  font-size: 11px;
  color: var(--el-color-primary);
  background-color: var(--el-color-primary-light-9);
  border-radius: 10px;
}

/* 管理员标记：用成功色与「当前登录」的主色区分，避免两个标签混淆 */
.admin-cell__admin {
  padding: 1px 7px;
  font-size: 11px;
  color: var(--el-color-success);
  background-color: var(--el-color-success-light-9);
  border-radius: 10px;
}
</style>
