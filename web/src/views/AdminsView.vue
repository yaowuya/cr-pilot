<template>
  <div class="page-container admins-page">
    <header class="page-header">
      <div>
        <h1 class="page-header__title">管理员</h1>
        <p class="page-header__desc">管理控制台登录账号；身份由部署配置决定，系统至少保留一个可用账号</p>
      </div>
      <div class="page-header__actions">
        <el-button type="primary" :disabled="saving" @click="openCreate">
          <el-icon><Plus /></el-icon>
          新增账号
        </el-button>
      </div>
    </header>

    <el-card shadow="never" class="sheet-panel account-ledger">
      <template #header>
        <div class="panel-header">
          <div>
            <h2>控制台账号</h2>
            <p>账号可登录控制台；只有 ADMIN_USERNAME 对应账号具备账号管理权限。</p>
          </div>
          <span>{{ admins.length }} 个账号</span>
        </div>
      </template>
      <div v-if="loadError || deleteError" class="account-feedback">
        <el-alert
          v-if="loadError"
          type="error"
          :closable="false"
          show-icon
          :title="loadError"
        >
          <el-button link type="primary" :disabled="loading" @click="load">重试加载</el-button>
        </el-alert>
        <el-alert
          v-if="deleteError"
          type="error"
          show-icon
          :title="deleteError"
          @close="deleteError = ''"
        />
      </div>
      <el-table
        v-if="!loadError || admins.length > 0"
        v-loading="loading"
        :data="admins"
        class="accounts-table"
      >
        <el-table-column label="账号" min-width="220">
          <template #default="{ row }">
            <div class="account-identity">
              <span>{{ row.username }}</span>
              <el-tag v-if="row.username === selfName" size="small" effect="plain">当前账号</el-tag>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="身份" min-width="150">
          <template #default="{ row }">
            <!-- 权限来自 ADMIN_USERNAME，页面只展示后端结果，不能在这里授予或撤销。 -->
            <el-tag v-if="row.isAdmin" size="small" type="success" effect="plain">管理员</el-tag>
            <span v-else class="cell-muted">普通账号</span>
          </template>
        </el-table-column>
        <el-table-column label="创建时间" min-width="190">
          <template #default="{ row }">
            <span class="cell-muted num">{{ formatTime(row.createdAt) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="120" fixed="right">
          <template #default="{ row }">
            <span v-if="row.username === selfName" class="delete-disabled">不可删除</span>
            <el-popconfirm
              v-else
              :title="`确认删除账号「${row.username}」？删除后该账号将无法登录。`"
              confirm-button-text="确认删除"
              cancel-button-text="取消"
              width="320"
              @confirm="onDelete(row)"
            >
              <template #reference>
                <el-button
                  link
                  type="danger"
                  :loading="deletingId === row.id"
                  :disabled="deletingId !== null"
                >
                  删除
                </el-button>
              </template>
            </el-popconfirm>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty description="暂无管理员账号" :image-size="80" />
        </template>
      </el-table>
    </el-card>

    <div class="admin-support-grid">
      <el-card shadow="never" class="sheet-panel support-panel">
        <template #header>
          <div class="panel-header">
            <div>
              <h2>权限边界</h2>
              <p>菜单与路由限制只改善体验，服务端授权才是最终边界。</p>
            </div>
          </div>
        </template>
        <dl class="support-facts">
          <div><dt>登录页面</dt><dd>所有已登记账号均可访问</dd></div>
          <div><dt>管理员页面</dt><dd>仅 ADMIN_USERNAME 对应账号</dd></div>
          <div><dt>接口保护</dt><dd>非管理员请求返回 403</dd></div>
          <div><dt>身份来源</dt><dd>部署配置决定，不在页面授予</dd></div>
        </dl>
      </el-card>

      <el-card shadow="never" class="sheet-panel support-panel">
        <template #header>
          <div class="panel-header">
            <div>
              <h2>账号安全</h2>
              <p>前端提前防误操作，后端继续校验全部删除与密码规则。</p>
            </div>
          </div>
        </template>
        <dl class="support-facts">
          <div><dt>当前账号</dt><dd>禁止删除正在登录的账号</dd></div>
          <div><dt>最低保留</dt><dd>系统至少保留一个可用账号</dd></div>
          <div><dt>密码长度</dt><dd>新账号密码至少 8 位</dd></div>
          <div><dt>危险操作</dt><dd>删除必须确认具体账号与影响</dd></div>
        </dl>
      </el-card>
    </div>

    <el-dialog
      v-model="dialogVisible"
      title="新增账号"
      width="440px"
      destroy-on-close
      :close-on-click-modal="!saving"
      :close-on-press-escape="!saving"
    >
      <p class="dialog-note">新账号可登录控制台；是否具备管理员权限由 ADMIN_USERNAME 决定，不能在此授予。</p>
      <el-alert v-if="createError" class="dialog-error" type="error" :closable="false" show-icon :title="createError" />
      <el-form ref="formRef" :model="form" :rules="rules" label-position="top">
        <el-form-item label="用户名" prop="username">
          <el-input v-model="form.username" placeholder="请输入用户名" autocomplete="username">
            <template #prefix>
              <el-icon><User /></el-icon>
            </template>
          </el-input>
        </el-form-item>
        <el-form-item label="密码" prop="password">
          <el-input
            v-model="form.password"
            type="password"
            placeholder="至少 8 位"
            autocomplete="new-password"
            show-password
          >
            <template #prefix>
              <el-icon><Lock /></el-icon>
            </template>
          </el-input>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button :disabled="saving" @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" :disabled="saving" @click="onCreate">保存账号</el-button>
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
import { nextTick, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { ElMessage, type FormInstance, type FormRules } from "element-plus";
import { Lock, Plus, User } from "@element-plus/icons-vue";
import { api, isApiError } from "../api/client.ts";
import { currentUsername } from "../stores/auth.ts";
import type { AdminUser } from "../types.ts";

const loading = ref(false);
/** 写后刷新可以超越初始加载；只允许最后一轮列表请求落地。 */
let loadRequestGeneration = 0;
const saving = ref(false);
const deletingId = ref<number | null>(null);
const admins = ref<AdminUser[]>([]);
const loadError = ref("");
const createError = ref("");
const deleteError = ref("");
const dialogVisible = ref(false);
const formRef = ref<FormInstance>();
const form = reactive({ username: "", password: "" });

/** 当前登录账号名：用于给「自己」那一行打标记并禁用删除按钮。 */
const selfName = currentUsername();

/** 与后端一致的密码最小长度，提前拦截避免无谓请求。 */
const MIN_PASSWORD_LENGTH = 8;

const rules: FormRules = {
  username: [
    { required: true, message: "请输入用户名", trigger: "blur" },
    { pattern: /\S/, message: "用户名不能只包含空格", trigger: "blur" },
  ],
  password: [
    { required: true, message: "请输入密码", trigger: "blur" },
    { min: MIN_PASSWORD_LENGTH, message: `密码长度不能少于 ${MIN_PASSWORD_LENGTH} 位`, trigger: "blur" },
  ],
};

async function load(): Promise<void> {
  const request = ++loadRequestGeneration;
  loading.value = true;
  loadError.value = "";
  try {
    const result = await api.get<AdminUser[]>("/api/admins");
    if (request !== loadRequestGeneration) return;
    admins.value = result;
  } catch (error) {
    if (request !== loadRequestGeneration) return;
    loadError.value = isApiError(error) ? error.message : "加载管理员失败";
  } finally {
    if (request === loadRequestGeneration) loading.value = false;
  }
}

async function openCreate(): Promise<void> {
  form.username = "";
  form.password = "";
  createError.value = "";
  dialogVisible.value = true;
  await nextTick();
  formRef.value?.clearValidate();
}

async function onCreate(): Promise<void> {
  if (saving.value) return;
  const valid = await formRef.value?.validate().catch(() => false);
  if (!valid) return;
  saving.value = true;
  createError.value = "";
  try {
    await api.post("/api/admins", { username: form.username.trim(), password: form.password });
    ElMessage.success("已新增账号");
    dialogVisible.value = false;
    await load();
  } catch (error) {
    // 409 重名、400 校验等后端文案留在表单里，用户可以直接修改原输入后重试。
    createError.value = isApiError(error) ? error.message : "新增账号失败";
  } finally {
    saving.value = false;
  }
}

async function onDelete(row: AdminUser): Promise<void> {
  if (deletingId.value !== null || row.username === selfName.value) return;
  deletingId.value = row.id;
  deleteError.value = "";
  try {
    await api.delete(`/api/admins/${row.id}`);
    ElMessage.success("已删除账号");
    await load();
  } catch (error) {
    // 后端对「删自己」「删最后一个」和竞态下的资源变化分别给出文案，页面原样展示。
    deleteError.value = isApiError(error) ? error.message : "删除账号失败";
  } finally {
    deletingId.value = null;
  }
}

function formatTime(value: number): string {
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

onMounted(() => {
  void load();
});
onBeforeUnmount(() => {
  loadRequestGeneration += 1;
});
</script>

<style scoped>
.admins-page {
  min-width: 0;
}

.sheet-panel {
  min-width: 0;
  border-color: var(--el-border-color);
  box-shadow: none; /* taste-skill-ignore: cancel the global resting-card shadow. */
}

.sheet-panel:hover {
  box-shadow: none; /* taste-skill-ignore: resting panels stay flat on hover. */
}

.sheet-panel :deep(.el-card__header) {
  padding: 17px 19px 14px;
  background-color: var(--el-bg-color);
  border-bottom-color: var(--el-border-color-lighter);
}

.panel-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 14px;
}

.panel-header h2 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  line-height: 22px;
  color: var(--el-text-color-primary);
}

.panel-header p {
  margin: 5px 0 0;
  font-size: 12px;
  font-weight: 400;
  line-height: 18px;
  color: var(--el-text-color-regular);
}

.panel-header > span {
  flex: none;
  font-size: 12px;
  font-weight: 400;
  line-height: 22px;
  color: var(--el-text-color-secondary);
  white-space: nowrap;
}

.account-ledger :deep(.el-card__body) {
  padding: 0;
}

.account-feedback {
  display: grid;
  gap: 8px;
  padding: 12px 18px;
  border-bottom: 1px solid var(--el-border-color-lighter);
}

.account-ledger :deep(.el-table__inner-wrapper::before) {
  display: none;
}

.account-ledger :deep(.el-table th.el-table__cell) {
  background-color: var(--el-bg-color);
}

.account-identity {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  min-width: 0;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.cell-muted,
.delete-disabled {
  color: var(--el-text-color-secondary);
}

.delete-disabled {
  font-size: 12px;
}

.num {
  font-variant-numeric: tabular-nums;
}

.admin-support-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 18px;
  align-items: start;
}

.support-panel :deep(.el-card__body) {
  padding: 0;
}

.support-facts {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 1px;
  margin: 0;
  overflow: hidden;
  background-color: var(--el-border-color-lighter);
}

.support-facts > div {
  min-width: 0;
  min-height: 78px;
  padding: 14px 16px;
  background-color: var(--el-bg-color);
}

.support-facts dt {
  font-size: 13px;
  font-weight: 600;
  line-height: 20px;
  color: var(--el-text-color-primary);
}

.support-facts dd {
  margin: 5px 0 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--el-text-color-regular);
}

.dialog-note {
  margin: 0 0 16px;
  font-size: 13px;
  line-height: 20px;
  color: var(--el-text-color-regular);
}

.dialog-error {
  margin-bottom: 16px;
}

/* 768px 档位让权限说明纵向展开，账号台账继续使用 Element Plus 表格自身的横向容器。 */
@media (max-width: 960px) {
  .admin-support-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
