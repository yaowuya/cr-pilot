<template>
  <el-card>
    <template #header>
      <div class="card-header">
        <span>环境变量</span>
        <div>
          <el-button :loading="loading" @click="load">刷新</el-button>
          <el-button type="primary" :loading="saving" @click="onSave">保存</el-button>
        </div>
      </div>
    </template>

    <el-alert
      type="info"
      :closable="false"
      class="hint"
      title="保存后大部分配置立即生效；标记「需重启」的项需重启容器。密钥类字段以掩码显示，保存时会写入你填写的新值。"
    />

    <el-table v-loading="loading" :data="rows" border>
      <el-table-column prop="key" label="配置项" width="260" />
      <el-table-column label="当前值" min-width="320">
        <template #default="{ row }">
          <el-input
            v-model="row.draft"
            :type="row.masked && !row.revealed ? 'text' : 'text'"
            :placeholder="row.masked ? '留空表示不修改' : ''"
            @input="row.dirty = true"
          />
        </template>
      </el-table-column>
      <el-table-column label="说明" width="140">
        <template #default="{ row }">
          <el-tag v-if="row.masked" type="warning" size="small">密钥</el-tag>
          <el-tag v-if="row.restartRequired" type="danger" size="small" class="tag-gap">需重启</el-tag>
          <el-tag v-if="row.overridden" type="info" size="small" class="tag-gap">已覆盖</el-tag>
        </template>
      </el-table-column>
    </el-table>
  </el-card>
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

/** 只提交用户实际改动过且非空的项。 */
async function onSave(): Promise<void> {
  const changed = rows.value.filter((row) => row.dirty && row.draft.trim() !== "");
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
        "部分配置需重启",
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
.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.hint {
  margin-bottom: 16px;
}

.tag-gap {
  margin-left: 4px;
}
</style>
