<template>
  <div class="page-container config-page">
    <header class="page-header">
      <div>
        <h1 class="page-header__title">环境变量</h1>
        <p class="page-header__desc">查看运行配置并安全覆盖允许在线修改的项目；标记「需重启」的项在重启后生效</p>
      </div>
      <div class="page-header__actions">
        <el-button :loading="loading" @click="load">
          <el-icon><Refresh /></el-icon>
          刷新
        </el-button>
        <el-button type="primary" :loading="saving" @click="onSave">
          <el-icon><Check /></el-icon>
          保存更改
        </el-button>
      </div>
    </header>

    <el-alert class="secret-notice" type="info" :closable="false" show-icon>
      <template #title>
        密钥类字段不回传真实值，留空表示不修改；只有实际输入过内容的项才会提交。
      </template>
    </el-alert>

    <el-alert v-if="loadError" type="error" :closable="false" show-icon class="load-alert">
      <template #title>运行配置加载失败</template>
      {{ loadError }} <el-button link type="primary" :loading="loading" @click="load">重新加载</el-button>
    </el-alert>

    <!--
      配置项仍按既有业务规则分组；视觉上改为原型的双列 Framed Sheet，
      让每组成为一张可独立浏览的工作表，而不是把所有字段压进一张宽表格。
    -->
    <div v-if="loaded" v-loading="loading" class="config-grid">
      <div v-for="(column, columnIndex) in configColumns" :key="columnIndex" class="config-column">
        <section v-for="group in column" :key="group.name" class="config-panel">
        <header class="config-panel__header">
          <div>
            <h2 class="config-panel__title">{{ group.name }}</h2>
            <p class="config-panel__desc">{{ group.desc }}</p>
          </div>
          <span class="config-panel__count">{{ group.count > 0 ? `${group.count} 项` : "集中管理" }}</span>
        </header>

        <!-- AI 模型分组不列出旧单键，继续引导到唯一事实源「AI 厂商」。 -->
        <div v-if="group.name === 'AI 模型'" class="provider-guide">
          <div>
            <h3 class="provider-guide__title">模型连接统一在厂商页维护</h3>
            <p class="provider-guide__text">
              API 地址、密钥、协议与模型清单需要成组保存；厂商页还支持全局默认与项目级模型绑定。
            </p>
          </div>
          <el-button type="primary" @click="goProviders">
            <el-icon><Cpu /></el-icon>
            前往 AI 厂商配置
          </el-button>
        </div>

        <div v-else class="config-list">
          <article
            v-for="row in group.rows"
            :key="row.key"
            class="config-item"
            :class="{ 'is-dirty': row.dirty && row.draft.trim() !== '' }"
          >
            <div class="config-item__heading">
              <div class="config-item__identity">
                <div class="config-item__title-row">
                  <span class="config-item__label">{{ row.label || row.key }}</span>
                  <div class="config-item__tags">
                    <el-tag v-if="row.masked" type="warning" size="small" effect="plain">密钥</el-tag>
                    <el-tag v-if="row.readOnly" type="info" size="small" effect="plain">只读</el-tag>
                    <el-tag v-if="row.restartRequired" type="danger" size="small" effect="plain">需重启</el-tag>
                    <el-tag v-if="row.overridden" type="primary" size="small" effect="plain">已覆盖</el-tag>
                  </div>
                </div>
                <code v-if="row.label" class="config-item__key">{{ row.key }}</code>
              </div>
              <span v-if="row.dirty && row.draft.trim() !== ''" class="config-status config-status--dirty">待保存</span>
              <span v-else-if="row.dirty" class="config-status">留空不提交</span>
              <span v-else class="config-status">未修改</span>
            </div>

            <p v-if="row.description" class="config-item__desc">{{ row.description }}</p>
            <p v-if="row.hint || row.defaultValue" class="config-item__hint">
              <template v-if="row.hint">{{ row.hint }}</template>
              <template v-if="row.hint && row.defaultValue">；</template>
              <template v-if="row.defaultValue">默认 {{ row.defaultValue }}</template>
            </p>

            <el-input
              v-model="row.draft"
              class="config-item__input"
              :type="row.masked && !row.revealed && row.draft ? 'password' : 'text'"
              :placeholder="row.masked ? '留空表示不修改' : row.defaultValue ? `未设置（默认 ${row.defaultValue}）` : '未设置'"
              :disabled="row.readOnly"
              :aria-label="`${row.label || row.key} 当前值`"
              @input="row.dirty = true"
            >
              <!-- 后端不回传真实密钥；此按钮只切换用户本次输入内容的本地可见性。 -->
              <template v-if="row.masked && row.draft" #suffix>
                <button
                  type="button"
                  class="secret-toggle"
                  :aria-label="row.revealed ? '隐藏本次输入的密钥' : '显示本次输入的密钥'"
                  :title="row.revealed ? '隐藏密钥' : '显示密钥'"
                  @mousedown.prevent
                  @click="row.revealed = !row.revealed"
                >
                  <el-icon><Hide v-if="row.revealed" /><View v-else /></el-icon>
                </button>
              </template>
            </el-input>
          </article>
        </div>
        </section>
      </div>
    </div>

    <div class="config-footnote">
      <strong>生效规则</strong>
      <span>保存时只提交已修改、非空且可编辑的项目；端口、数据库路径、凭据盐等标记项需要重启容器。</span>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 环境变量管理页。
 *
 * 密钥项的草稿始终从空值开始，避免把接口掩码写回数据库；保存只提交用户
 * 实际改动过的非空可编辑项。分组规则同时承担配置导航与新增键的兜底展示。
 */
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import { Check, Cpu, Hide, Refresh, View } from "@element-plus/icons-vue";
import { api, isApiError } from "../api/client.ts";
import type { ConfigItem } from "../types.ts";

/** 接口配置项追加页面内编辑态后的行模型。 */
interface ConfigRow extends ConfigItem {
  /** 用户输入的草稿值；密钥项初始为空，表示保留原值。 */
  draft: string;
  /** 用户是否改动过该输入。 */
  dirty: boolean;
  /** 是否显示用户本次输入的密钥，只影响本地输入框。 */
  revealed: boolean;
}

/** 页面中的一个配置分组。 */
interface ConfigGroup {
  name: string;
  desc: string;
  rows: ConfigRow[];
  count: number;
}

/** 固定分组规则；match 只决定展示位置，不改变配置写入语义。 */
interface ConfigGroupRule {
  name: string;
  desc: string;
  match: (key: string) => boolean;
}

const router = useRouter();
const loading = ref(false);
const loaded = ref(false);
const loadError = ref("");
const saving = ref(false);
const rows = ref<ConfigRow[]>([]);

/**
 * 键名到分组的显式映射。
 *
 * 用前缀与明确清单而不是模糊猜测；未命中的键进入「其他」，保证新增或
 * 历史遗留配置不会从页面消失。AI 模型组仅保留厂商页导航，避免双事实源。
 */
const GROUP_RULES: ConfigGroupRule[] = [
  {
    name: "AI 模型",
    desc: "API、密钥、协议与模型清单统一在 AI 厂商页维护",
    // LLMGW_API_KEY 是旧单厂商密钥，也归入此组提示迁移。
    match: (key) => /^(LLMGW_API_KEY|LLM_|AI_)/.test(key),
  },
  {
    name: "GitLab 集成",
    desc: "实例地址、证书校验与 API 请求边界",
    match: (key) => key.startsWith("GITLAB_"),
  },
  {
    name: "评审行为",
    desc: "并发、超时、分批预算、风格与规则目录",
    match: (key) => key.startsWith("REVIEW_") || key === "QUEUE_CONCURRENCY",
  },
  {
    name: "服务与存储",
    desc: "监听端口、日志输出与数据库位置",
    match: (key) => ["PORT", "HOST", "LOG_FILE", "LOG_LEVEL", "DB_PATH"].includes(key),
  },
  {
    name: "账号与安全",
    desc: "管理员引导账号与部署凭据盐",
    match: (key) => key.startsWith("ADMIN_") || key === "AUTH_SALT",
  },
];

/** 按固定规则分组，未命中的配置统一进入「其他」。 */
const groups = computed<ConfigGroup[]>(() => {
  const buckets = new Map<string, ConfigRow[]>();
  const others: ConfigRow[] = [];

  for (const row of rows.value) {
    const rule = GROUP_RULES.find((item) => item.match(row.key));
    if (!rule) {
      others.push(row);
      continue;
    }
    const list = buckets.get(rule.name) ?? [];
    list.push(row);
    buckets.set(rule.name, list);
  }

  const result: ConfigGroup[] = [];
  for (const rule of GROUP_RULES) {
    const list = buckets.get(rule.name) ?? [];
    // AI 模型组即使没有遗留键也必须出现，它是唯一事实源的导航入口。
    if (list.length === 0 && rule.name !== "AI 模型") continue;
    result.push({ name: rule.name, desc: rule.desc, rows: list, count: list.length });
  }

  if (others.length > 0) {
    result.push({ name: "其他", desc: "尚未归入固定用途分组的配置项", rows: others, count: others.length });
  }
  return result;
});

/**
 * 将固定顺序的分组交错放入两列，让每列独立向下堆叠。
 * 这避免短 AI 指引被相邻的长 GitLab 分组撑出整行空洞，同时保持每组稳定 key。
 */
const configColumns = computed<[ConfigGroup[], ConfigGroup[]]>(() => {
  const columns: [ConfigGroup[], ConfigGroup[]] = [[], []];
  groups.value.forEach((group, index) => columns[index % columns.length].push(group));
  return columns;
});

function goProviders(): void {
  void router.push("/providers");
}

/** 从接口重新建立编辑草稿；任何旧脏值都随显式刷新丢弃。 */
async function load(): Promise<void> {
  loading.value = true;
  loadError.value = "";
  try {
    const result = await api.get<{ items: ConfigItem[] }>("/api/config");
    rows.value = result.items.map((item) => ({
      ...item,
      // 密钥真实值不会从接口返回，必须以空草稿表示“保留原值”。
      draft: item.masked ? "" : item.value,
      dirty: false,
      revealed: false,
    }));
    loaded.value = true;
  } catch (error) {
    loadError.value = isApiError(error) ? error.message : "加载配置失败";
    ElMessage.error(loadError.value);
  } finally {
    loading.value = false;
  }
}

/** 只提交用户实际改动过、非只读且非空的项。 */
async function onSave(): Promise<void> {
  if (saving.value) return;
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
.config-page {
  gap: 18px;
}

.secret-notice {
  border: 1px solid var(--el-border-color-lighter);
}

.config-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
  align-items: start;
  min-width: 0;
}

.config-column {
  display: grid;
  gap: 16px;
  align-content: start;
  min-width: 0;
}

.config-panel {
  min-width: 0;
  overflow: hidden;
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: var(--el-border-radius-base);
}

.config-panel__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 16px 18px 14px;
  border-bottom: 1px solid var(--el-border-color-lighter);
}

.config-panel__header > div {
  min-width: 0;
}

.config-panel__title,
.provider-guide__title {
  margin: 0;
  color: var(--el-text-color-primary);
}

.config-panel__title {
  font-size: 16px;
  line-height: 22px;
}

.config-panel__desc {
  margin: 4px 0 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--el-text-color-secondary);
}

.config-panel__count {
  flex: none;
  padding-top: 2px;
  font-size: 12px;
  line-height: 20px;
  color: var(--el-text-color-secondary);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.provider-guide {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  padding: 20px 18px;
  background: var(--el-fill-color-light);
}

.provider-guide > div {
  min-width: 0;
}

.provider-guide__title {
  font-size: 14px;
  line-height: 20px;
}

.provider-guide__text {
  margin: 6px 0 0;
  font-size: 13px;
  line-height: 20px;
  color: var(--el-text-color-regular);
}

.provider-guide .el-button {
  flex: none;
}

.config-list {
  display: grid;
}

.config-item {
  min-width: 0;
  padding: 15px 18px 16px 15px;
  border-left: 3px solid transparent;
}

.config-item + .config-item {
  border-top: 1px solid var(--el-border-color-lighter);
}

.config-item.is-dirty {
  border-left-color: var(--el-color-warning);
}

.config-item__heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.config-item__identity {
  min-width: 0;
}

.config-item__title-row,
.config-item__tags {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
}

.config-item__title-row {
  gap: 8px;
}

.config-item__tags {
  gap: 4px;
}

.config-item__label {
  font-size: 14px;
  font-weight: 600;
  line-height: 20px;
  color: var(--el-text-color-primary);
}

.config-item__key {
  display: inline-block;
  max-width: 100%;
  margin-top: 5px;
  overflow: hidden;
  font-family: var(--el-font-family-mono, "SFMono-Regular", Consolas, monospace);
  font-size: 11px;
  line-height: 18px;
  color: var(--el-text-color-regular);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.config-status {
  flex: none;
  padding-top: 2px;
  font-size: 12px;
  line-height: 18px;
  color: var(--el-text-color-secondary);
  white-space: nowrap;
}

.config-status--dirty {
  color: var(--el-color-warning);
}

.config-item__desc,
.config-item__hint {
  margin: 0;
}

.config-item__desc {
  margin-top: 8px;
  font-size: 13px;
  line-height: 19px;
  color: var(--el-text-color-regular);
}

.config-item__hint {
  margin-top: 4px;
  font-size: 12px;
  line-height: 18px;
  color: var(--el-text-color-secondary);
}

.config-item__input {
  width: 100%;
  margin-top: 12px;
}

.secret-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  color: var(--el-text-color-secondary);
  cursor: pointer;
  background: transparent;
  border: 0;
  border-radius: var(--el-border-radius-small);
}

.secret-toggle:hover,
.secret-toggle:focus-visible {
  color: var(--el-color-primary);
  background: var(--el-fill-color-light);
}

.secret-toggle:focus-visible {
  outline: 2px solid var(--el-color-primary-light-5);
  outline-offset: 1px;
}

.config-footnote {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 13px 16px;
  font-size: 12px;
  line-height: 19px;
  color: var(--el-text-color-regular);
  background: var(--el-fill-color-light);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: var(--el-border-radius-base);
}

.config-footnote strong {
  flex: none;
  color: var(--el-text-color-primary);
}

@media (max-width: 900px) {
  .config-panel__header,
  .config-item {
    padding-right: 14px;
    padding-left: 14px;
  }

  .provider-guide {
    align-items: flex-start;
    flex-direction: column;
    padding-right: 14px;
    padding-left: 14px;
  }
}

@media (max-width: 680px) {
  .config-grid {
    grid-template-columns: 1fr;
  }

  .page-header,
  .config-footnote {
    flex-direction: column;
  }

  .page-header__actions {
    width: 100%;
  }

  .page-header__actions .el-button {
    flex: 1;
  }
}
</style>
