<template>
  <div class="page-container">
    <header class="page-header">
      <div>
        <h1 class="page-header__title">环境变量</h1>
        <p class="page-header__desc">配置写入数据库并覆盖同名环境变量；标记「需重启」的项在重启后生效</p>
      </div>
      <div class="page-header__actions">
        <el-button :loading="loading" @click="load">
          <el-icon><Refresh /></el-icon>
          刷新
        </el-button>
        <el-button type="primary" :loading="saving" @click="onSave">
          <el-icon><Check /></el-icon>
          保存
        </el-button>
      </div>
    </header>

    <el-alert type="info" :closable="false" show-icon>
      <template #title>
        密钥类字段不回传真实值，留空表示不修改；只有实际输入过内容的项才会提交。
      </template>
    </el-alert>

    <el-card>
      <el-table v-loading="loading" :data="rows">
        <el-table-column label="配置项" width="260">
          <template #default="{ row }">
            <div class="key-cell">
              <span class="key-cell__name">{{ row.key }}</span>
              <div class="key-cell__tags">
                <el-tag v-if="row.masked" type="warning" size="small" effect="plain">密钥</el-tag>
                <el-tag v-if="row.readOnly" type="info" size="small" effect="plain">只读</el-tag>
                <el-tag v-if="row.restartRequired" type="danger" size="small" effect="plain">需重启</el-tag>
                <el-tag v-if="row.overridden" type="primary" size="small" effect="plain">已覆盖</el-tag>
              </div>
            </div>
          </template>
        </el-table-column>

        <el-table-column label="当前值" min-width="340">
          <template #default="{ row }">
            <el-input
              v-model="row.draft"
              :type="row.masked && !row.revealed && row.draft ? 'password' : 'text'"
              :placeholder="row.masked ? '留空表示不修改' : ''"
              :disabled="row.readOnly"
              @input="row.dirty = true"
            >
              <!-- 密钥项：后端不回传真实值，输入框里只有用户自己刚输入的内容。
                   该图标仅切换本地可见性，不产生网络请求。 -->
              <template v-if="row.masked && row.draft" #suffix>
                <el-icon class="reveal-icon" @click="row.revealed = !row.revealed">
                  <View v-if="!row.revealed" />
                  <Hide v-else />
                </el-icon>
              </template>
            </el-input>
          </template>
        </el-table-column>

        <el-table-column label="状态" width="110">
          <template #default="{ row }">
            <span v-if="row.dirty && row.draft.trim() !== ''" class="status status--dirty">待保存</span>
            <span v-else class="status status--idle">未修改</span>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>

<script setup lang="ts">
/**
 * 环境变量管理页。
 *
 * 密钥项默认显示后端返回的掩码（后端不回传真实值），输入框留空表示不修改；
 * 只有用户实际输入了内容才会提交该项，避免把掩码当成新值写回数据库。
 */
import { onMounted, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { Check, Hide, Refresh, View } from "@element-plus/icons-vue";
import { api, isApiError } from "../api/client.ts";
import type { ConfigItem } from "../types.ts";

/** 表格行：在接口数据上追加编辑态。 */
interface ConfigRow extends ConfigItem {
  /** 用户输入的草稿值；初始为空（表示不修改）。 */
  draft: string;
  /** 是否被用户修改过。 */
  dirty: boolean;
  /** 是否已展开显示（掩码项用，仅本地状态）。 */
  revealed: boolean;
}

const loading = ref(false);
const saving = ref(false);
const rows = ref<ConfigRow[]>([]);

async function load(): Promise<void> {
  loading.value = true;
  try {
    const result = await api.get<{ items: ConfigItem[] }>("/api/config");
    rows.value = result.items.map((item) => ({
      ...item,
      // 非密钥项直接带出当前值供编辑；密钥项留空，防止把掩码写回库。
      // 只读项也预填当前值但输入框禁用（见模板）。
      draft: item.masked ? "" : item.value,
      dirty: false,
      revealed: false,
    }));
  } catch (error) {
    ElMessage.error(isApiError(error) ? error.message : "加载配置失败");
  } finally {
    loading.value = false;
  }
}

/** 只提交用户实际改动过、非只读且非空的项。 */
async function onSave(): Promise<void> {
  const changed = rows.value.filter((row) => row.dirty && !row.readOnly && row.draft.trim() !== "");
  if (changed.length === 0) {
    ElMessage.warning("没有需要保存的修改");
    return;
  }
  saving.value = true;
  try {
    const result = await api.put<{ restartRequired: string[] }>("/api/config", {
      items: changed.map((row) => ({ key: row.key, value: row.draft })),
    });
    if (result.restartRequired.length > 0) {
      await ElMessageBox.alert(
        `以下配置需要重启容器后才生效：\n${result.restartRequired.join("、")}`,
        "配置已保存，需重启生效",
        { type: "warning", confirmButtonText: "知道了" },
      );
    } else {
      ElMessage.success("已保存，配置立即生效");
    }
    await load();
  } catch (error) {
    ElMessage.error(isApiError(error) ? error.message : "保存失败");
  } finally {
    saving.value = false;
  }
}

onMounted(() => {
  void load();
});
</script>

<style scoped>
/* 配置项列：键名在上，标签在下，避免长键名与多个标签挤在一行 */
.key-cell {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.key-cell__name {
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  font-size: 13px;
  font-weight: 500;
  color: var(--el-text-color-primary);
  word-break: break-all;
}

.key-cell__tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.reveal-icon {
  cursor: pointer;
  color: var(--el-text-color-secondary);
}

.reveal-icon:hover {
  color: var(--el-color-primary);
}

.status {
  font-size: 13px;
}

.status--dirty {
  color: var(--el-color-warning);
}

.status--idle {
  color: var(--el-text-color-secondary);
}
</style>
