<template>
  <div class="reviews-page page-container">
    <header class="page-header">
      <div>
        <h1 class="page-header__title">评审记录</h1>
        <p class="page-header__desc">查看每次 MR 评审的结果、评分与耗时</p>
      </div>
      <div class="page-header__actions">
        <el-button @click="goStats">
          <el-icon><TrendCharts /></el-icon>
          查看统计
        </el-button>
        <el-button :loading="loading || statsLoading" @click="refresh">
          <el-icon><Refresh /></el-icon>
          刷新
        </el-button>
      </div>
    </header>

    <el-alert v-if="statsError" type="error" :closable="false" show-icon class="load-alert">
      <template #title>概览加载失败</template>
      <div class="load-alert__content">
        <span>{{ statsError }}</span>
        <el-button link type="primary" :loading="statsLoading" @click="loadStats">重试概览</el-button>
      </div>
    </el-alert>

    <!-- 概览保持为一张分栏工作条，避免四张图标卡片抢过记录列表的视觉层级。 -->
    <section class="review-metrics" v-loading="statsLoading" :aria-busy="statsLoading" aria-label="评审概览">
      <article v-for="card in statCards" :key="card.label" class="review-metric">
        <p class="review-metric__label">{{ card.label }}</p>
        <p class="review-metric__value">
          {{ card.value }}<span v-if="card.suffix" class="review-metric__suffix">{{ card.suffix }}</span>
        </p>
        <p class="review-metric__note">{{ card.note }}</p>
      </article>
    </section>

    <section class="review-sheet" aria-labelledby="review-list-title">
      <div class="review-sheet__header">
        <div>
          <h2 id="review-list-title" class="review-sheet__title">最近评审</h2>
          <p class="review-sheet__note">按开始时间倒序；筛选会同时更新列表与概览。</p>
        </div>
        <span class="review-sheet__range" aria-live="polite">{{ pageRangeLabel }}</span>
      </div>

      <div class="review-sheet__body">
        <el-form class="filter-bar" label-position="top" @submit.prevent>
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
              :default-time="dateRangeDefaultTime"
            />
          </el-form-item>
          <el-form-item class="filter-bar__actions">
            <el-button @click="onReset">重置</el-button>
            <el-button type="primary" @click="onSearch">
              <el-icon><Search /></el-icon>
              查询
            </el-button>
          </el-form-item>
        </el-form>

        <el-alert v-if="listError" type="error" :closable="false" show-icon class="load-alert">
          <template #title>评审记录加载失败</template>
          <div class="load-alert__content">
            <span>{{ listError }}</span>
            <el-button link type="primary" :loading="loading" @click="loadList">重试列表</el-button>
          </div>
        </el-alert>

        <div class="review-table-wrap">
          <el-table v-loading="loading" :data="items" class="review-table">
            <el-table-column label="项目 / MR" min-width="250" show-overflow-tooltip>
              <template #default="{ row }">
                <div class="project-cell">
                  <div class="project-cell__primary">
                    <span class="cell-strong">{{ row.projectName }}</span>
                    <!-- 历史记录可能没有 MR URL；此时保留编号，但不渲染无效链接。 -->
                    <a
                      v-if="row.mrUrl"
                      :href="row.mrUrl"
                      target="_blank"
                      rel="noopener noreferrer"
                      class="mr-link"
                      :title="`在 GitLab 中打开 !${row.mrIid}`"
                    >
                      !{{ row.mrIid }}
                    </a>
                    <el-tag v-else size="small" type="info" effect="plain">!{{ row.mrIid }}</el-tag>
                  </div>
                  <span class="cell-subline">项目 ID {{ row.projectId }}</span>
                </div>
              </template>
            </el-table-column>
            <el-table-column prop="committerName" label="提交人" min-width="150" show-overflow-tooltip />
            <el-table-column prop="changeCount" label="文件" width="76" align="right" />
            <el-table-column prop="batchCount" label="批次" width="76" align="right" />
            <el-table-column label="分数" width="86" align="right">
              <template #default="{ row }">
                <!-- 0 分与「未解析出分数」在库里分别是 0 与 null，页面必须区别展示。 -->
                <span v-if="row.score === null" class="cell-muted">—</span>
                <span v-else class="score" :class="scoreClass(row.score)">{{ row.score }}</span>
              </template>
            </el-table-column>
            <el-table-column label="耗时" width="90" align="right">
              <template #default="{ row }">
                <span class="cell-muted cell-number">{{ (row.durationMs / 1000).toFixed(1) }}s</span>
              </template>
            </el-table-column>
            <el-table-column label="结果" width="96">
              <template #default="{ row }">
                <span class="result" :class="row.result === 'success' ? 'result--success' : 'result--failed'">
                  <i class="result__dot" aria-hidden="true"></i>
                  {{ row.result === "success" ? "成功" : "失败" }}
                </span>
              </template>
            </el-table-column>
            <el-table-column label="时间" width="180">
              <template #default="{ row }">
                <span class="cell-muted cell-number">{{ formatTime(row.startedAt) }}</span>
              </template>
            </el-table-column>
            <template #empty>
              <el-empty
                :description="listError ? '评审记录未加载成功，请重试' : '暂无评审记录'"
                :image-size="80"
              />
            </template>
          </el-table>
        </div>
      </div>

      <footer class="review-sheet__footer">
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
      </footer>
    </section>
  </div>
</template>

<script setup lang="ts">
/**
 * 评审记录与统计页。
 *
 * 列表与统计分开请求：挂载、筛选与手动刷新会同时更新两者，翻页只重新拉列表。
 * 分数列区分 `null`（未解析出分数）与 `0`（真实零分）。
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { Refresh, Search, TrendCharts } from "@element-plus/icons-vue";
import { api, isApiError } from "../api/client.ts";
import { inclusiveCalendarRange } from "../date-range.ts";
import type { ReviewRecord, ReviewStats } from "../types.ts";

const router = useRouter();

/** 跳到独立的统计分析页。 */
function goStats(): void {
  void router.push("/stats");
}

const loading = ref(false);
const statsLoading = ref(false);
const listError = ref("");
const statsError = ref("");
/** 递增请求代次避免快速筛选或翻页时，旧响应覆盖最后一次用户意图。 */
let listRequestGeneration = 0;
let statsRequestGeneration = 0;
const items = ref<ReviewRecord[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(20);
// 记录页只用概览与 daily，但类型上必须给全字段（统计页需要 byProject/byCommitter）
const stats = ref<ReviewStats>({
  total: 0,
  projectCount: 0,
  committerCount: 0,
  avgScore: null,
  daily: [],
  byProject: [],
  byCommitter: [],
});

const filters = reactive<{ projectId: string; committer: string; range: [string, string] | null }>({
  projectId: "",
  committer: "",
  range: null,
});
/** 结束日取当天末尾，避免 daterange 默认 00:00 漏掉结束日内记录。 */
const dateRangeDefaultTime = [new Date(2000, 0, 1, 0, 0, 0), new Date(2000, 0, 1, 23, 59, 59, 999)];

/** 概览指标来自完整筛选结果，与当前分页中的行数无关。 */
const statCards = computed(() => [
  { label: "评审总次数", value: stats.value.total, note: "当前筛选范围" },
  { label: "涉及项目数", value: stats.value.projectCount, note: "按项目去重" },
  { label: "提交人数", value: stats.value.committerCount, note: "按提交人去重" },
  {
    label: "平均分",
    // null 表示还没有带分数的记录，显示 — 而不是 0，避免误导
    value: stats.value.avgScore === null ? "—" : stats.value.avgScore.toFixed(1),
    suffix: stats.value.avgScore === null ? "" : " 分",
    note: "仅统计有效分数",
  },
]);

/** 当前页范围；空结果仍明确显示 0，而不是用破折号表示缺失。 */
const pageRangeLabel = computed(() => {
  if (total.value === 0) return "0 条记录";
  const start = (page.value - 1) * pageSize.value + 1;
  const end = Math.min(page.value * pageSize.value, total.value);
  return `${start}–${end} / ${total.value} 条`;
});

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
    ...inclusiveCalendarRange(filters.range),
  };
}

async function loadList(): Promise<void> {
  const request = ++listRequestGeneration;
  loading.value = true;
  listError.value = "";
  try {
    const result = await api.get<{ items: ReviewRecord[]; total: number }>("/api/reviews", {
      ...filterParams(),
      page: page.value,
      pageSize: pageSize.value,
    });
    if (request !== listRequestGeneration) return;
    items.value = result.items;
    total.value = result.total;
  } catch (error) {
    if (request !== listRequestGeneration) return;
    if (!isApiError(error) || error.status !== 401) {
      listError.value = isApiError(error) ? error.message : "加载评审记录失败";
      ElMessage.error(listError.value);
    }
  } finally {
    if (request === listRequestGeneration) loading.value = false;
  }
}

async function loadStats(): Promise<void> {
  const request = ++statsRequestGeneration;
  statsLoading.value = true;
  statsError.value = "";
  try {
    const result = await api.get<ReviewStats>("/api/reviews/stats", filterParams());
    if (request !== statsRequestGeneration) return;
    stats.value = result;
  } catch (error) {
    if (request !== statsRequestGeneration) return;
    if (!isApiError(error) || error.status !== 401) {
      statsError.value = isApiError(error) ? error.message : "加载统计失败";
      ElMessage.error(statsError.value);
    }
  } finally {
    if (request === statsRequestGeneration) statsLoading.value = false;
  }
}

/** 筛选或页大小变更：回到第一页并同时刷新列表与统计。 */
async function onSearch(): Promise<void> {
  page.value = 1;
  await Promise.all([loadList(), loadStats()]);
}

/** 刷新列表与概览，但保留当前筛选和页码。 */
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

onBeforeUnmount(() => {
  listRequestGeneration += 1;
  statsRequestGeneration += 1;
});
</script>

<style scoped>
.reviews-page {
  min-width: 0;
}

.load-alert__content {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 16px;
}

.review-sheet__body > .load-alert {
  width: auto;
  margin: 12px 16px 0;
}

/* ---------- 概览指标：一个工作条，而不是四张悬浮卡 ---------- */
.review-metrics {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  overflow: hidden;
  background-color: var(--el-bg-color);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: var(--el-border-radius-base);
}

.review-metric {
  min-width: 0;
  padding: 16px 18px;
}

.review-metric + .review-metric {
  border-left: 1px solid var(--el-border-color-lighter);
}

.review-metric__label,
.review-metric__value,
.review-metric__note {
  margin: 0;
}

.review-metric__label {
  font-size: 12px;
  line-height: 18px;
  color: var(--el-text-color-regular);
}

.review-metric__value {
  margin-top: 5px;
  overflow: hidden;
  font-size: 26px;
  font-weight: 500;
  line-height: 32px;
  color: var(--el-text-color-primary);
  text-overflow: ellipsis;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.review-metric__suffix {
  margin-left: 2px;
  font-size: 13px;
  font-weight: 400;
  color: var(--el-text-color-secondary);
}

.review-metric__note {
  margin-top: 4px;
  font-size: 11px;
  line-height: 17px;
  color: var(--el-text-color-secondary);
}

/* ---------- Framed Sheet 列表 ---------- */
.review-sheet {
  min-width: 0;
  overflow: hidden;
  background-color: var(--el-bg-color);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: var(--el-border-radius-base);
}

.review-sheet__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 16px 18px 14px;
}

.review-sheet__title,
.review-sheet__note {
  margin: 0;
}

.review-sheet__title {
  font-size: 16px;
  font-weight: 600;
  line-height: 24px;
  color: var(--el-text-color-primary);
}

.review-sheet__note {
  margin-top: 3px;
  font-size: 12px;
  line-height: 18px;
  color: var(--el-text-color-secondary);
}

.review-sheet__range {
  flex: none;
  padding-top: 2px;
  font-size: 12px;
  line-height: 20px;
  color: var(--el-text-color-regular);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.review-sheet__body {
  min-width: 0;
}

/* ---------- 筛选工作带 ---------- */
.filter-bar {
  display: grid;
  grid-template-columns: minmax(120px, 0.7fr) minmax(150px, 1fr) minmax(240px, 1.35fr) auto;
  gap: 12px 16px;
  align-items: end;
  padding: 14px 16px;
  background-color: var(--el-fill-color-light);
  border-top: 1px solid var(--el-border-color-lighter);
  border-bottom: 1px solid var(--el-border-color-lighter);
}

.filter-bar :deep(.el-form-item) {
  min-width: 0;
  margin: 0;
}

.filter-bar :deep(.el-form-item__label) {
  height: auto;
  padding: 0 0 5px;
  font-size: 12px;
  line-height: 18px;
  color: var(--el-text-color-regular);
}

.filter-bar :deep(.el-input),
.filter-bar :deep(.el-date-editor) {
  width: 100%;
}

.filter-bar__actions {
  justify-self: end;
}

.filter-bar__actions :deep(.el-form-item__content) {
  flex-wrap: nowrap;
  justify-content: flex-end;
}

/* ---------- 表格与单元格 ---------- */
.review-table-wrap {
  max-width: 100%;
  overflow-x: auto;
  overscroll-behavior-inline: contain;
}

.review-table {
  min-width: 980px;
}

.review-table :deep(.el-table__inner-wrapper::before) {
  display: none;
}

.review-table :deep(th.el-table__cell) {
  height: 38px;
  font-size: 12px;
  font-weight: 500;
}

.review-table :deep(td.el-table__cell) {
  height: 50px;
}

.project-cell {
  min-width: 0;
}

.project-cell__primary {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.cell-strong {
  min-width: 0;
  overflow: hidden;
  font-weight: 600;
  color: var(--el-text-color-primary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cell-subline {
  display: block;
  margin-top: 2px;
  font-size: 11px;
  line-height: 16px;
  color: var(--el-text-color-secondary);
}

.cell-muted {
  color: var(--el-text-color-secondary);
}

.cell-number,
.score {
  font-variant-numeric: tabular-nums;
}

.score {
  font-weight: 600;
}

.score--low {
  color: var(--el-color-danger);
}

.score--mid {
  color: var(--el-color-warning);
}

.score--high {
  color: var(--el-color-success);
}

.mr-link {
  flex: none;
  font-size: 13px;
  font-weight: 600;
  color: var(--el-color-primary);
  text-decoration: none;
  font-variant-numeric: tabular-nums;
}

.mr-link:hover {
  text-decoration: underline;
}

.mr-link:focus-visible {
  border-radius: var(--el-border-radius-small);
  outline: 2px solid var(--el-color-primary);
  outline-offset: 2px;
}

.result {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 500;
  white-space: nowrap;
}

.result__dot {
  width: 6px;
  height: 6px;
  background-color: currentcolor;
  border-radius: 50%;
}

.result--success {
  color: var(--el-color-success);
}

.result--failed {
  color: var(--el-color-danger);
}

.review-sheet__footer {
  display: flex;
  justify-content: flex-end;
  padding: 12px 16px;
  background-color: var(--el-fill-color-light);
  border-top: 1px solid var(--el-border-color-lighter);
}

.review-sheet__footer :deep(.el-pagination) {
  flex-wrap: wrap;
  justify-content: flex-end;
  row-gap: 8px;
}

/* 768px 视口下外壳已折叠；页面保留两列筛选，表格只在工作表内部滚动。 */
@media (max-width: 900px) {
  .review-metrics {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .review-metric + .review-metric {
    border-left: 0;
  }

  .review-metric:nth-child(even) {
    border-left: 1px solid var(--el-border-color-lighter);
  }

  .review-metric:nth-child(n + 3) {
    border-top: 1px solid var(--el-border-color-lighter);
  }

  .filter-bar {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
