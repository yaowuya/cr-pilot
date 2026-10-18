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

    <!--
      分类展示：配置项按用途分组，而不是一长串平铺。
      AI 模型类的 URL/Key/Model 已迁到「AI 厂商」页统一管理（支持多厂商），
      这里只保留一个指引，避免两处都能改造成事实源分叉。
    -->
    <el-card v-for="group in groups" :key="group.name">
      <template #header>
        <div class="group-header">
          <div class="group-header__title">
            <span class="group-header__icon" :style="{ backgroundColor: group.bg, color: group.color }">
              <el-icon><component :is="group.icon" /></el-icon>
            </span>
            <div>
              <div class="group-header__name">{{ group.name }}</div>
              <div class="group-header__desc">{{ group.desc }}</div>
            </div>
          </div>
          <el-tag v-if="group.count > 0" size="small" type="info" effect="plain">{{ group.count }} 项</el-tag>
        </div>
      </template>

      <!-- AI 模型分组：不列具体键，直接引导去厂商页 -->
      <div v-if="group.name === 'AI 模型'" class="ai-hint">
        <p class="ai-hint__text">
          模型厂商的 API 地址、密钥与模型清单已迁移到独立页面，支持配置多个厂商（OpenAI、DeepSeek、
          Anthropic、通义千问等），并可指定每个项目使用哪个厂商。
        </p>
        <el-button type="primary" @click="goProviders">
          <el-icon><Cpu /></el-icon>
          前往 AI 厂商配置
        </el-button>
      </div>

      <el-table v-else v-loading="loading" :data="group.rows">
        <!--
          配置项列：中文名做标题、英文键名做副标题、用途说明再下一行。
          只显示英文键名时运维看不出这一项是干什么的，因此说明必须与键名同列展示。
        -->
        <el-table-column label="配置项" min-width="360">
          <template #default="{ row }">
            <div class="key-cell">
              <div class="key-cell__head">
                <span class="key-cell__label">{{ row.label || row.key }}</span>
                <div class="key-cell__tags">
                  <el-tag v-if="row.masked" type="warning" size="small" effect="plain">密钥</el-tag>
                  <el-tag v-if="row.readOnly" type="info" size="small" effect="plain">只读</el-tag>
                  <el-tag v-if="row.restartRequired" type="danger" size="small" effect="plain">需重启</el-tag>
                  <el-tag v-if="row.overridden" type="primary" size="small" effect="plain">已覆盖</el-tag>
                </div>
              </div>
              <!-- 有中文名时键名降为副标题；未登记的键本身就是标题，不重复显示 -->
              <code v-if="row.label" class="key-cell__name">{{ row.key }}</code>
              <p v-if="row.description" class="key-cell__desc">{{ row.description }}</p>
              <p v-if="row.hint" class="key-cell__hint">
                {{ row.hint }}<template v-if="row.defaultValue">；默认 {{ row.defaultValue }}</template>
              </p>
            </div>
          </template>
        </el-table-column>

        <el-table-column label="当前值" min-width="300">
          <template #default="{ row }">
            <el-input
              v-model="row.draft"
              :type="row.masked && !row.revealed && row.draft ? 'password' : 'text'"
              :placeholder="row.masked ? '留空表示不修改' : row.defaultValue ? `未设置（默认 ${row.defaultValue}）` : '未设置'"
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

        <el-table-column label="状态" width="100">
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
 *
 * 分类展示（D-023）：键名按前缀与语义归入固定分组，避免几十项平铺难找。
 * AI 模型相关的键不再在此编辑——多厂商配置需要 URL/Key/Model 成组管理，
 * 单键编辑无法表达，统一收敛到「AI 厂商」页。
 */
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import { Check, Connection, Cpu, Document, Hide, Refresh, Setting, View } from "@element-plus/icons-vue";
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

/** 一个配置分组。 */
interface ConfigGroup {
  name: string;
  desc: string;
  icon: unknown;
  color: string;
  bg: string;
  rows: ConfigRow[];
  count: number;
}

const router = useRouter();
const loading = ref(false);
const saving = ref(false);
const rows = ref<ConfigRow[]>([]);

/**
 * 键名 → 分组。
 *
 * 用前缀与显式清单而不是「猜」：分组是给人看的，错归组比不归组更糟。
 * 未命中的键落到「其他」，保证新增配置不会凭空消失。
 */
const GROUP_RULES: Array<{ name: string; desc: string; icon: unknown; color: string; bg: string; match: (key: string) => boolean }> = [
  {
    name: "AI 模型",
    desc: "多厂商模型配置已迁移到独立页面",
    icon: Cpu,
    color: "#8b5cf6",
    bg: "rgb(139 92 246 / 10%)",
    // LLMGW_API_KEY 是老的单厂商密钥，也归到这里提示迁移。
    match: (key) => /^(LLMGW_API_KEY|LLM_|AI_)/.test(key),
  },
  {
    name: "GitLab 集成",
    desc: "GitLab 实例地址、证书与 API 超时",
    icon: Connection,
    color: "#0ea5e9",
    bg: "rgb(14 165 233 / 10%)",
    match: (key) => key.startsWith("GITLAB_"),
  },
  {
    name: "评审行为",
    desc: "超时、分批预算、风格与规则目录",
    icon: Document,
    color: "#5b5bd6",
    bg: "rgb(91 91 214 / 10%)",
    match: (key) => key.startsWith("REVIEW_") || key === "QUEUE_CONCURRENCY",
  },
  {
    name: "服务与存储",
    desc: "监听地址、日志与数据库路径",
    icon: Setting,
    color: "#10b981",
    bg: "rgb(16 185 129 / 10%)",
    match: (key) => ["PORT", "HOST", "LOG_FILE", "LOG_LEVEL", "DB_PATH"].includes(key),
  },
  {
    name: "账号与安全",
    desc: "管理员引导账号与令牌盐",
    icon: Setting,
    color: "#f59e0b",
    bg: "rgb(245 158 11 / 10%)",
    match: (key) => key.startsWith("ADMIN_") || key === "AUTH_SALT",
  },
];

/** 按规则分组；未命中的键进「其他」。 */
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
    // AI 模型分组即使没有键也展示：它是「去别处配置」的指引，不展示就没人知道要迁移。
    if (list.length === 0 && rule.name !== "AI 模型") continue;
    result.push({ ...rule, rows: list, count: list.length });
  }
  if (others.length > 0) {
    result.push({
      name: "其他",
      desc: "未归类的配置项",
      icon: Setting,
      color: "#64748b",
      bg: "rgb(100 116 139 / 10%)",
      rows: others,
      count: others.length,
    });
  }
  return result;
});

function goProviders(): void {
  void router.push("/providers");
}

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
/* 分组头：图标 + 名称 + 说明，右侧数量 */
.group-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.group-header__title {
  display: flex;
  align-items: center;
  gap: 10px;
}

.group-header__icon {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  font-size: 16px;
  border-radius: 9px;
}

.group-header__name {
  font-size: 14px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.group-header__desc {
  margin-top: 2px;
  font-size: 12px;
  font-weight: 400;
  color: var(--el-text-color-secondary);
}

/* AI 模型分组的迁移指引 */
.ai-hint {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  padding: 4px 0;
}

.ai-hint__text {
  max-width: 720px;
  margin: 0;
  font-size: 13px;
  line-height: 1.7;
  color: var(--el-text-color-regular);
}

/*
  配置项列：中文名 + 标签一行，英文键名一行，用途说明一行。
  层次靠字号与颜色拉开，避免四行文字看起来一样重。
*/
.key-cell {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.key-cell__head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.key-cell__label {
  font-size: 14px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

/* 英文键名：等宽小字，作为技术标识而非主标题 */
.key-cell__name {
  align-self: flex-start;
  padding: 1px 6px;
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  font-size: 11px;
  color: var(--el-text-color-secondary);
  background-color: var(--el-fill-color-light);
  border-radius: 4px;
  word-break: break-all;
}

.key-cell__desc {
  margin: 2px 0 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--el-text-color-regular);
}

/* 取值提示与默认值：最弱的一级，作为补充信息 */
.key-cell__hint {
  margin: 0;
  font-size: 11px;
  line-height: 1.5;
  color: var(--el-text-color-placeholder);
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

/* 窄屏：指引改为上下排布 */
@media (max-width: 768px) {
  .ai-hint {
    flex-direction: column;
    align-items: flex-start;
  }
}
</style>
