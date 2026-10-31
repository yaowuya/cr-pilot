<template>
  <div class="page-container">
    <header class="page-header">
      <div>
        <h1 class="page-header__title">统计分析</h1>
        <p class="page-header__desc">从评审量、评分和提交人三个维度观察运行质量</p>
      </div>
      <div class="page-header__actions">
        <el-date-picker
          v-model="range"
          type="daterange"
          range-separator="至"
          start-placeholder="开始日期"
          end-placeholder="结束日期"
          value-format="x"
          :default-time="dateRangeDefaultTime"
          @change="loadStats"
        />
        <el-button :loading="loading" @click="loadStats"><el-icon><Refresh /></el-icon>刷新</el-button>
      </div>
    </header>

    <el-alert v-if="errorMessage" type="error" :closable="false" show-icon>
      <template #title>统计数据加载失败</template>
      <div class="error-action">{{ errorMessage }} <el-button link type="primary" :loading="loading" @click="loadStats">重新加载</el-button></div>
    </el-alert>

    <section v-loading="loading" class="metric-strip">
      <article><span>评审次数</span><strong>{{ stats.total }}</strong><small>统计：当前筛选范围内全部记录</small></article>
      <article><span>涉及项目</span><strong>{{ stats.projectCount }}</strong><small>统计：project_id 去重</small></article>
      <article><span>活跃提交人</span><strong>{{ stats.committerCount }}</strong><small>统计：committer_name 去重</small></article>
      <article><span>平均评分</span><strong>{{ stats.avgScore === null ? "—" : stats.avgScore.toFixed(1) }}</strong><small>计算：有效分数总和 ÷ 有评分记录</small></article>
    </section>

    <div class="analytics-grid">
      <section class="analytics-panel trend-panel">
        <header class="panel-header"><div><h2>评审趋势</h2><p>柱形表示每日评审次数，折线表示当天平均分。</p></div><span>{{ stats.total }} 次</span></header>
        <ChartCard v-if="hasDaily" :option="trendOption" height="250px" />
        <el-empty v-else description="当前范围暂无趋势数据" :image-size="64" />
      </section>
      <section class="analytics-panel share-panel">
        <header class="panel-header"><div><h2>项目占比</h2><p>项目评审次数 ÷ 总评审次数。</p></div></header>
        <div v-if="stats.byProject.length" class="share-list">
          <div v-for="row in stats.byProject.slice(0, 6)" :key="row.name" class="share-row">
            <span>{{ row.name }}</span><i><b :style="{ width: `${shareOf(row.count)}%` }" /></i><strong>{{ formatShare(row.count) }}</strong>
          </div>
        </div>
        <el-empty v-else description="暂无项目统计" :image-size="64" />
      </section>
    </div>

    <div class="dimension-grid">
      <section v-for="dimension in dimensions" :key="dimension.key" class="analytics-panel">
        <header class="panel-header"><div><h2>{{ dimension.title }}</h2><p>{{ dimension.description }}</p></div><span>{{ dimension.rows.length }} 项</span></header>
        <el-table :data="dimension.rows" size="default" empty-text="暂无统计数据">
          <el-table-column prop="name" :label="dimension.nameLabel" min-width="180" show-overflow-tooltip>
            <template #default="{ row }"><span class="row-name">{{ row.name }}</span></template>
          </el-table-column>
          <el-table-column prop="count" label="评审数" width="86" align="right" sortable />
          <el-table-column label="平均分" width="92" align="right" sortable :sort-by="'avgScore'">
            <template #default="{ row }"><span :class="scoreClass(row.avgScore)">{{ formatScore(row.avgScore) }}</span></template>
          </el-table-column>
          <el-table-column label="最低/最高" width="104" align="right">
            <template #default="{ row }">{{ formatScore(row.minScore) }} / {{ formatScore(row.maxScore) }}</template>
          </el-table-column>
          <el-table-column label="Token" width="92" align="right" sortable :sort-by="'totalTokens'">
            <template #default="{ row }">{{ formatTokens(row.totalTokens) }}</template>
          </el-table-column>
        </el-table>
      </section>
    </div>

    <section class="analytics-panel token-panel">
      <header class="panel-header">
        <div>
          <h2>Token 使用</h2>
          <p>来自模型实际返回的 usage，不做估算；只统计有 usage 数据的 {{ stats.tokens.recordedReviews }} 次评审。</p>
        </div>
        <span>缓存命中率 {{ formatPercent(stats.tokens.cacheHitRate) }}</span>
      </header>
      <div class="token-strip">
        <article><span>总 Token</span><strong>{{ formatTokens(stats.tokens.total) }}</strong><small>输入 + 输出（含缓存读写）</small></article>
        <article><span>输入</span><strong>{{ formatTokens(stats.tokens.input) }}</strong><small>含缓存命中与写入</small></article>
        <article><span>输出</span><strong>{{ formatTokens(stats.tokens.output) }}</strong><small>模型生成内容</small></article>
        <article><span>每次平均</span><strong>{{ formatTokens(stats.tokens.avgPerReview) }}</strong><small>总量 ÷ {{ stats.tokens.recordedReviews }} 次有数据评审</small></article>
      </div>
      <p class="token-note">
        缓存读取 {{ formatTokens(stats.tokens.cacheRead) }}、缓存写入 {{ formatTokens(stats.tokens.cacheWrite) }}；两者都是输入的子集，不与输入相加。
        「—」表示没有 usage 数据（历史记录或模型未返回），不是零消耗。
      </p>
    </section>
  </div>
</template>

<script setup lang="ts">
/** 评审运行统计页；建议采纳已迁移到独立 `/adoption` 页面。 */
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { ElMessage } from "element-plus";
import { Refresh } from "@element-plus/icons-vue";
import ChartCard from "../components/ChartCard.vue";
import { api, isApiError } from "../api/client.ts";
import { inclusiveCalendarRange } from "../date-range.ts";
import type { ReviewStats } from "../types.ts";

const loading = ref(false);
/** 只允许最后一次请求更新状态，快速改日期或刷新时旧响应不得覆盖新意图。 */
let requestGeneration = 0;
const errorMessage = ref("");
const range = ref<[string, string] | null>(null);
const dateRangeDefaultTime = [new Date(2000, 0, 1, 0, 0, 0), new Date(2000, 0, 1, 23, 59, 59, 999)];
const stats = ref<ReviewStats>({
  total: 0, projectCount: 0, committerCount: 0, avgScore: null, daily: [], byProject: [], byCommitter: [],
  tokens: {
    recordedReviews: 0, input: null, output: null, cacheRead: null, cacheWrite: null,
    total: null, avgPerReview: null, cacheHitRate: null,
  },
});
const hasDaily = computed(() => stats.value.daily.length > 0);
const dimensions = computed(() => [
  { key: "project", title: "按项目评分", description: "只使用成功解析出的分数。", nameLabel: "项目", rows: stats.value.byProject },
  { key: "committer", title: "按提交人", description: "评审次数与评分使用同一筛选范围。", nameLabel: "提交人", rows: stats.value.byCommitter },
]);
const trendOption = computed(() => ({
  tooltip: { trigger: "axis" },
  legend: { data: ["评审次数", "平均分"], top: 0 },
  grid: { left: 8, right: 8, bottom: 8, top: 38, containLabel: true },
  xAxis: { type: "category", data: stats.value.daily.map((item) => item.date), axisLine: { show: false }, axisTick: { show: false } },
  yAxis: [
    { type: "value", name: "次数", minInterval: 1 },
    { type: "value", name: "平均分", min: 0, max: 100, splitLine: { show: false } },
  ],
  series: [
    { name: "评审次数", type: "bar", data: stats.value.daily.map((item) => item.count), itemStyle: { color: "var(--app-chart-primary)" }, barMaxWidth: 24 },
    { name: "平均分", type: "line", yAxisIndex: 1, smooth: false, showSymbol: false, data: stats.value.daily.map((item) => item.avgScore), lineStyle: { color: "var(--app-chart-secondary)", width: 2 }, itemStyle: { color: "var(--app-chart-secondary)" } },
  ],
}));

function queryParams(): Record<string, unknown> { return inclusiveCalendarRange(range.value); }
function shareOf(count: number): number { return stats.value.total > 0 ? (count / stats.value.total) * 100 : 0; }
function formatShare(count: number): string { return stats.value.total > 0 ? `${((count / stats.value.total) * 100).toFixed(1)}%` : "—"; }
function formatScore(score: number | null): string { return score === null ? "—" : score.toFixed(1); }
/** token 用千分位、整数值；null 显示「—」而不是 0，避免把「没采到」读成「没消耗」。 */
function formatTokens(value: number | null): string { return value === null ? "—" : Math.round(value).toLocaleString("zh-CN"); }
function formatPercent(value: number | null): string { return value === null ? "—" : `${(value * 100).toFixed(1)}%`; }
function scoreClass(score: number | null): string { if (score === null) return "is-muted"; if (score < 60) return "is-low"; if (score < 80) return "is-mid"; return "is-good"; }
async function loadStats(): Promise<void> {
  const request = ++requestGeneration;
  loading.value = true;
  errorMessage.value = "";
  try {
    const result = await api.get<ReviewStats>("/api/reviews/stats", queryParams());
    if (request !== requestGeneration) return;
    stats.value = result;
  } catch (error) {
    if (request !== requestGeneration) return;
    errorMessage.value = isApiError(error) ? error.message : "统计数据加载失败";
    ElMessage.error(errorMessage.value);
  } finally {
    if (request === requestGeneration) loading.value = false;
  }
}
onMounted(() => { void loadStats(); });
onBeforeUnmount(() => { requestGeneration += 1; });
</script>

<style scoped>
.error-action { display: flex; align-items: center; gap: 6px; }
.metric-strip,.analytics-panel { font-variant-numeric: tabular-nums; }
.metric-strip { display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); border: 1px solid var(--el-border-color-light); border-radius: var(--el-border-radius-base); overflow: hidden; }
.metric-strip article { padding: 18px; border-left: 1px solid var(--el-border-color-light); }
.metric-strip article:first-child { border-left: 0; }
.metric-strip span,.metric-strip small { display: block; color: var(--el-text-color-regular); }
.metric-strip span { font-size: 12px; }.metric-strip strong { display: block; margin-top: 6px; font-size: 28px; font-weight: 500; font-variant-numeric: tabular-nums; }.metric-strip small { margin-top: 7px; font-size: 11px; line-height: 1.4; }
.analytics-grid { display: grid; grid-template-columns: minmax(0,1.45fr) minmax(320px,.75fr); gap: 18px; }
.dimension-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
.analytics-panel { border: 1px solid var(--el-border-color-light); border-radius: var(--el-border-radius-base); overflow: hidden; background: var(--el-bg-color); }
.panel-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; padding: 17px 19px 14px; }
.panel-header h2 { margin: 0; font-size: 16px; }.panel-header p { margin: 5px 0 0; color: var(--el-text-color-regular); font-size: 12px; }.panel-header>span { color: var(--el-text-color-secondary); font-size: 12px; }
.trend-panel :deep(.chart-card) { border: 0; }
.share-list { padding: 8px 18px 18px; }
.share-row { display: grid; grid-template-columns: minmax(130px,1fr) 100px 52px; gap: 12px; align-items: center; min-height: 43px; font-size: 13px; }
.share-row i { height: 7px; overflow: hidden; background: var(--el-fill-color); }.share-row i b { display: block; height: 100%; background: var(--app-chart-primary); }.share-row strong { text-align: right; font-variant-numeric: tabular-nums; }
.row-name { color: var(--el-text-color-primary); font-weight: 600; }
/* Element Plus 会把排序图标算进宽度，列标题在窄列里折行；统计表列多，
   统一禁止表头换行，由列宽保证可读性。 */
.dimension-grid :deep(.el-table th .cell) { white-space: nowrap; }
.token-panel { margin-top: 0; }
.token-strip { display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); border-top: 1px solid var(--el-border-color-light); }
.token-strip article { padding: 16px 19px; border-left: 1px solid var(--el-border-color-light); }
.token-strip article:first-child { border-left: 0; }
.token-strip span,.token-strip small { display: block; color: var(--el-text-color-regular); }
.token-strip span { font-size: 12px; }
.token-strip strong { display: block; margin-top: 6px; font-size: 22px; font-weight: 500; font-variant-numeric: tabular-nums; }
.token-strip small { margin-top: 6px; font-size: 11px; line-height: 1.4; }
.token-note { margin: 0; padding: 12px 19px 16px; color: var(--el-text-color-secondary); font-size: 12px; line-height: 1.6; }
@media (max-width: 1100px) { .token-strip { grid-template-columns: repeat(2,minmax(0,1fr)); } }
.is-low { color: var(--el-color-danger); }.is-mid { color: var(--el-color-warning); }.is-good { color: var(--el-color-success); }.is-muted { color: var(--el-text-color-secondary); }
@media (max-width: 1100px) { .analytics-grid,.dimension-grid { grid-template-columns: 1fr; } }
</style>
