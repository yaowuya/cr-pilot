<template>
  <div class="page-container">
    <header class="page-header">
      <div>
        <h1 class="page-header__title">评审记录</h1>
        <p class="page-header__desc">查看每次 MR 评审的结果、评分与耗时</p>
      </div>
    </header>

    <!-- 统计卡片：图标 + 数值 + 说明。数字用等宽字体，多个卡片对齐 -->
    <section class="stat-grid">
      <article v-for="card in statCards" :key="card.label" class="stat-card">
        <div class="stat-card__icon" :style="{ backgroundColor: card.bg, color: card.color }">
          <el-icon><component :is="card.icon" /></el-icon>
        </div>
        <div class="stat-card__body">
          <p class="stat-card__label">{{ card.label }}</p>
          <p class="stat-card__value">
            {{ card.value }}<span v-if="card.suffix" class="stat-card__suffix">{{ card.suffix }}</span>
          </p>
        </div>
      </article>
    </section>

    <el-card>
      <template #header>
        <div class="card-header">
          <span>记录列表</span>
          <el-button :loading="loading" @click="refresh">
            <el-icon><Refresh /></el-icon>
            刷新
          </el-button>
        </div>
      </template>

      <!-- 筛选条：标签在上、控件在下，比 inline 表单在窄屏更稳 -->
      <el-form class="filter-bar" @submit.prevent>
        <el-form-item label="项目 ID">
          <el-input v-model="filters.projectId" placeholder="如 123" clearable />
        </el-form-item>
        <el-form-item label="提交人">
          <el-input v-model="filters.committer" placeholder="提交人姓名" clearable />
        </el-form-item>
        <el-form-item label="时间范围">
          <el-date-picker
            v-model="filters.range"
            type="daterange"
            range-separator="至"
            start-placeholder="开始日期"
            end-placeholder="结束日期"
            value-format="x"
          />
        </el-form-item>
        <el-form-item class="filter-bar__actions">
          <el-button type="primary" @click="onSearch">
            <el-icon><Search /></el-icon>
            查询
          </el-button>
          <el-button @click="onReset">重置</el-button>
        </el-form-item>
      </el-form>

      <el-table v-loading="loading" :data="items">
        <el-table-column prop="projectName" label="项目" min-width="200" show-overflow-tooltip>
          <template #default="{ row }">
            <span class="cell-strong">{{ row.projectName }}</span>
          </template>
        </el-table-column>
        <el-table-column label="MR" width="90">
          <template #default="{ row }">
            <el-tag size="small" type="info" effect="plain">!{{ row.mrIid }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="committerName" label="提交人" width="130" show-overflow-tooltip />
        <el-table-column prop="changeCount" label="文件数" width="90" align="right" />
        <el-table-column prop="batchCount" label="批次数" width="90" align="right" />
        <el-table-column label="分数" width="110" align="right">
          <template #default="{ row }">
            <!-- 0 分与「未解析出分数」在库里分别是 0 与 null，页面必须区别展示 -->
            <span v-if="row.score === null" class="cell-muted">—</span>
            <span v-else class="score" :class="scoreClass(row.score)">{{ row.score }}</span>
          </template>
        </el-table-column>
        <el-table-column label="耗时" width="100" align="right">
          <template #default="{ row }">
            <span class="cell-muted">{{ (row.durationMs / 1000).toFixed(1) }}s</span>
          </template>
        </el-table-column>
        <el-table-column label="结果" width="100">
          <template #default="{ row }">
            <el-tag :type="row.result === 'success' ? 'success' : 'danger'" size="small" effect="light">
              {{ row.result === "success" ? "成功" : "失败" }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="时间" width="180">
          <template #default="{ row }">
            <span class="cell-muted">{{ formatTime(row.startedAt) }}</span>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty description="暂无评审记录" :image-size="90" />
        </template>
      </el-table>

      <div class="pager">
        <el-pagination
          v-model:current-page="page"
          v-model:page-size="pageSize"
          layout="total, sizes, prev, pager, next"
          :page-sizes="[10, 20, 50, 100]"
          :total="total"
          background
          @current-change="loadList"
          @size-change="onSearch"
        />
      </div>
    </el-card>
  </div>
</template>

<script setup lang="ts">
/**
 * 评审记录与统计页。
 *
 * 列表与统计分开请求：统计不受分页影响，因此只在挂载与筛选变更时刷新，
 * 翻页只重新拉列表。分数列区分 `null`（未解析出分数）与 `0`（真实零分）。
 */
import { computed, onMounted, reactive, ref } from "vue";
import { ElMessage } from "element-plus";
import { Document, Refresh, Search, Star, TrendCharts, User } from "@element-plus/icons-vue";
import { api, isApiError } from "../api/client.ts";
import type { ReviewRecord, ReviewStats } from "../types.ts";

const loading = ref(false);
const items = ref<ReviewRecord[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(20);
const stats = ref<ReviewStats>({ total: 0, projectCount: 0, committerCount: 0, avgScore: null, daily: [] });

const filters = reactive<{ projectId: string; committer: string; range: [string, string] | null }>({
  projectId: "",
  committer: "",
  range: null,
});

/**
 * 统计卡片数据。
 *
 * 颜色写死在这里而不是 CSS 类：四张卡片用四种语义色，集中一处便于调整，
 * 且色值需与图标底色/前景色配对，拆到 CSS 反而要维护四组类名。
 */
const statCards = computed(() => [
  {
    label: "评审总次数",
    value: stats.value.total,
    icon: Document,
    color: "#5b5bd6",
    bg: "rgb(91 91 214 / 10%)",
  },
  {
    label: "涉及项目数",
    value: stats.value.projectCount,
    icon: TrendCharts,
    color: "#0ea5e9",
    bg: "rgb(14 165 233 / 10%)",
  },
  {
    label: "提交人数",
    value: stats.value.committerCount,
    icon: User,
    color: "#10b981",
    bg: "rgb(16 185 129 / 10%)",
  },
  {
    label: "平均分",
    // null 表示还没有带分数的记录，显示 — 而不是 0，避免误导
    value: stats.value.avgScore === null ? "—" : stats.value.avgScore.toFixed(1),
    suffix: stats.value.avgScore === null ? "" : " 分",
    icon: Star,
    color: "#f59e0b",
    bg: "rgb(245 158 11 / 10%)",
  },
]);

/** 分数着色：低于 60 红、60-79 橙、80+ 绿，让低分记录在列表中一眼可见。 */
function scoreClass(score: number): string {
  if (score < 60) return "score--low";
  if (score < 80) return "score--mid";
  return "score--high";
}

/** 把筛选条件转成后端查询参数。 */
function filterParams(): Record<string, unknown> {
  return {
    project_id: filters.projectId || undefined,
    committer: filters.committer || undefined,
    from: filters.range?.[0] || undefined,
    to: filters.range?.[1] || undefined,
  };
}

async function loadList(): Promise<void> {
  loading.value = true;
  try {
    const result = await api.get<{ items: ReviewRecord[]; total: number }>("/api/reviews", {
      ...filterParams(),
      page: page.value,
      pageSize: pageSize.value,
    });
    items.value = result.items;
    total.value = result.total;
  } catch (error) {
    if (!isApiError(error) || error.status !== 401) {
      ElMessage.error(isApiError(error) ? error.message : "加载评审记录失败");
    }
  } finally {
    loading.value = false;
  }
}

async function loadStats(): Promise<void> {
  try {
    stats.value = await api.get<ReviewStats>("/api/reviews/stats", filterParams());
  } catch (error) {
    if (!isApiError(error) || error.status !== 401) {
      ElMessage.error(isApiError(error) ? error.message : "加载统计失败");
    }
  }
}

/** 筛选或页大小变更：回到第一页并同时刷新列表与统计。 */
async function onSearch(): Promise<void> {
  page.value = 1;
  await Promise.all([loadList(), loadStats()]);
}

/** 只刷新列表，不动筛选与页码。 */
async function refresh(): Promise<void> {
  await Promise.all([loadList(), loadStats()]);
}

async function onReset(): Promise<void> {
  filters.projectId = "";
  filters.committer = "";
  filters.range = null;
  await onSearch();
}

/** 时间戳转本地可读时间。 */
function formatTime(value: number): string {
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

onMounted(() => {
  void Promise.all([loadList(), loadStats()]);
});
</script>

<style scoped>
/* ---------- 统计卡片 ---------- */
.stat-grid {
  display: grid;
  gap: 16px;
  grid-template-columns: repeat(4, minmax(0, 1fr));
}

.stat-card {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 20px;
  background-color: var(--el-bg-color);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: var(--el-border-radius-base);
  transition:
    box-shadow var(--app-transition) ease,
    transform var(--app-transition) ease;
}

.stat-card:hover {
  box-shadow: var(--app-shadow);
  transform: translateY(-1px);
}

.stat-card__icon {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 46px;
  height: 46px;
  font-size: 21px;
  border-radius: 12px;
}

.stat-card__body {
  min-width: 0;
}

.stat-card__label {
  margin: 0 0 4px;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}

.stat-card__value {
  margin: 0;
  font-size: 24px;
  font-weight: 600;
  line-height: 1.2;
  color: var(--el-text-color-primary);
  font-variant-numeric: tabular-nums;
}

.stat-card__suffix {
  margin-left: 2px;
  font-size: 13px;
  font-weight: 400;
  color: var(--el-text-color-secondary);
}

/* ---------- 卡片头 ---------- */
.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

/* ---------- 筛选条 ---------- */
.filter-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 12px 16px;
  margin-bottom: 4px;
}

.filter-bar :deep(.el-form-item) {
  margin: 0;
}

.filter-bar :deep(.el-form-item__label) {
  padding-bottom: 4px;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}

.filter-bar :deep(.el-input) {
  width: 150px;
}

.filter-bar__actions {
  align-self: flex-end;
}

/* ---------- 表格单元格 ---------- */
.cell-strong {
  font-weight: 500;
  color: var(--el-text-color-primary);
}

.cell-muted {
  color: var(--el-text-color-secondary);
}

.score {
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.score--low {
  color: #ef4444;
}

.score--mid {
  color: #f59e0b;
}

.score--high {
  color: #10b981;
}

.pager {
  display: flex;
  justify-content: flex-end;
  margin-top: 16px;
}

/* 窄屏：统计卡片两列，筛选控件换行 */
@media (max-width: 1100px) {
  .stat-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 640px) {
  .stat-grid {
    grid-template-columns: 1fr;
  }

  .filter-bar :deep(.el-input) {
    width: 100%;
  }
}
</style>
