<template>
  <div class="page-container">
    <header class="page-header">
      <div>
        <h1 class="page-header__title">统计分析</h1>
        <p class="page-header__desc">按项目与提交人两个维度分析评审情况</p>
      </div>
      <div class="page-header__actions">
        <el-date-picker
          v-model="range"
          type="daterange"
          range-separator="至"
          start-placeholder="开始日期"
          end-placeholder="结束日期"
          value-format="x"
          size="default"
          @change="load"
        />
        <el-button :loading="loading" @click="load">
          <el-icon><Refresh /></el-icon>
          刷新
        </el-button>
      </div>
    </header>

    <!-- 概览指标 -->
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

    <!-- 趋势：次数用柱、平均分用线，双 Y 轴 -->
    <el-card>
      <template #header>
        <div class="card-header"><span>评审趋势</span></div>
      </template>
      <ChartCard v-if="hasData" :option="trendOption" height="280px" />
      <el-empty v-else description="暂无数据" :image-size="80" />
    </el-card>

    <!-- 两个维度：图表看分布，表格看精确值 -->
    <div class="dimension-grid">
      <el-card v-for="dim in dimensions" :key="dim.key">
        <template #header>
          <div class="card-header">
            <span>{{ dim.title }}</span>
            <el-tag size="small" type="info" effect="plain">{{ dim.rows.length }} 组</el-tag>
          </div>
        </template>

        <ChartCard v-if="dim.rows.length > 0" :option="dim.chartOption" :height="barHeight(dim.rows.length)" />

        <el-table :data="dim.rows" size="small" class="dimension-table">
          <el-table-column prop="name" :label="dim.nameLabel" min-width="180" show-overflow-tooltip>
            <template #default="{ row }">
              <span class="cell-strong">{{ row.name }}</span>
            </template>
          </el-table-column>
          <el-table-column prop="count" label="次数" width="80" align="right" sortable />
          <el-table-column label="平均分" width="90" align="right" sortable :sort-by="'avgScore'">
            <template #default="{ row }">
              <!-- null 是「没有带分数的记录」，与 0 分必须区别展示 -->
              <span v-if="row.avgScore === null" class="cell-muted">—</span>
              <span v-else class="score" :class="scoreClass(row.avgScore)">{{ row.avgScore.toFixed(1) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="最低" width="80" align="right">
            <template #default="{ row }">
              <span v-if="row.minScore === null" class="cell-muted">—</span>
              <span v-else class="cell-muted">{{ row.minScore }}</span>
            </template>
          </el-table-column>
          <el-table-column label="最高" width="80" align="right">
            <template #default="{ row }">
              <span v-if="row.maxScore === null" class="cell-muted">—</span>
              <span v-else class="cell-muted">{{ row.maxScore }}</span>
            </template>
          </el-table-column>
          <template #empty>
            <el-empty description="暂无数据" :image-size="70" />
          </template>
        </el-table>
      </el-card>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 统计分析页（独立页面 + 图表）。
 *
 * 数据来自 `GET /api/reviews/stats`：一次请求返回概览、按日趋势、按项目与
 * 按提交人两个维度的聚合。时间筛选同时作用于全部区块，保证下拉选完看到的是
 * 同一口径的数字。
 *
 * 图表与表格并用：图表看分布与趋势，表格看精确值——只看图表读不出具体分数，
 * 只给表格又看不出谁高谁低。
 */
import { computed, onMounted, ref } from "vue";
import { ElMessage } from "element-plus";
import { Document, Refresh, Star, TrendCharts, User } from "@element-plus/icons-vue";
import ChartCard from "../components/ChartCard.vue";
import { api, isApiError } from "../api/client.ts";
import type { DimensionStat, ReviewStats } from "../types.ts";

const loading = ref(false);
/** 时间筛选；null 表示不限。值为 [起, 止] 的毫秒时间戳字符串。 */
const range = ref<[string, string] | null>(null);

const stats = ref<ReviewStats>({
  total: 0,
  projectCount: 0,
  committerCount: 0,
  avgScore: null,
  daily: [],
  byProject: [],
  byCommitter: [],
});

/** 有任意数据时才画趋势图，避免空图看起来像加载失败。 */
const hasData = computed(() => stats.value.daily.length > 0);

/** 四个概览指标。 */
const statCards = computed(() => [
  { label: "评审总次数", value: stats.value.total, icon: Document, color: "#5b5bd6", bg: "rgb(91 91 214 / 10%)" },
  { label: "涉及项目数", value: stats.value.projectCount, icon: TrendCharts, color: "#0ea5e9", bg: "rgb(14 165 233 / 10%)" },
  { label: "提交人数", value: stats.value.committerCount, icon: User, color: "#10b981", bg: "rgb(16 185 129 / 10%)" },
  {
    label: "平均分",
    value: stats.value.avgScore === null ? "—" : stats.value.avgScore.toFixed(1),
    suffix: stats.value.avgScore === null ? "" : " 分",
    icon: Star,
    color: "#f59e0b",
    bg: "rgb(245 158 11 / 10%)",
  },
]);

/**
 * 趋势图：柱状表示次数（左轴），折线表示平均分（右轴）。
 *
 * 双轴是必要的：次数是几十的量级、分数是 0-100，同轴会让折线贴着底部看不清。
 */
const trendOption = computed(() => ({
  tooltip: { trigger: "axis" },
  legend: { data: ["评审次数", "平均分"], top: 0 },
  grid: { left: 8, right: 8, bottom: 8, top: 40, containLabel: true },
  xAxis: { type: "category", data: stats.value.daily.map((item) => item.date) },
  yAxis: [
    { type: "value", name: "次数", minInterval: 1 },
    { type: "value", name: "平均分", min: 0, max: 100 },
  ],
  series: [
    {
      name: "评审次数",
      type: "bar",
      data: stats.value.daily.map((item) => item.count),
      itemStyle: { color: "#5b5bd6", borderRadius: [4, 4, 0, 0] },
      barMaxWidth: 36,
    },
    {
      name: "平均分",
      type: "line",
      yAxisIndex: 1,
      smooth: true,
      // 没有分数的那些天不该画成 0 分，用 null 让折线断开
      data: stats.value.daily.map((item) => item.avgScore),
      itemStyle: { color: "#f59e0b" },
      symbolSize: 7,
    },
  ],
}));

/** 两个维度的配置：结构相同、字段不同，合并成数组避免重复模板。 */
const dimensions = computed(() => [
  {
    key: "project",
    title: "按项目统计",
    nameLabel: "项目",
    rows: stats.value.byProject,
    chartOption: buildRankingOption(stats.value.byProject),
  },
  {
    key: "committer",
    title: "按提交人统计",
    nameLabel: "提交人",
    rows: stats.value.byCommitter,
    chartOption: buildRankingOption(stats.value.byCommitter),
  },
]);

/**
 * 横向柱状排行图。
 *
 * 只取前 10：完整清单在下方表格里，图表放太多条会挤成一片看不出差异。
 * 横向（yAxis 为 category）而不是纵向：项目名很长，横向才放得下标签。
 */
function buildRankingOption(rows: DimensionStat[]): Record<string, unknown> {
  const top = rows.slice(0, 10);
  // ECharts 的 category 轴从下往上画，反转后最大值在最上方，符合阅读习惯
  const names = top.map((item) => item.name).reverse();
  const counts = top.map((item) => item.count).reverse();
  // 高度随条数增长，避免条数少时留白、条数多时挤在一起
  return {
    tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
    // right 留足空间给条尾的数值标签：40 时数值会贴住右边界，
    // 暗色下与背景对比低几乎看不清。60 让标签与边界之间有余量。
    grid: { left: 8, right: 60, bottom: 8, top: 8, containLabel: true },
    xAxis: { type: "value", minInterval: 1 },
    yAxis: {
      type: "category",
      data: names,
      axisLabel: {
        // 项目全名很长，超出部分截断，完整值在 tooltip 与表格里看
        formatter: (value: string) => (value.length > 22 ? `${value.slice(0, 22)}…` : value),
      },
    },
    series: [
      {
        type: "bar",
        data: counts,
        itemStyle: { color: "#5b5bd6", borderRadius: [0, 4, 4, 0] },
        barMaxWidth: 22,
        // 数值直接标在条尾，省一次 hover
        // 数值直接标在条尾，省一次 hover。颜色由 ChartCard 按主题统一注入，
        // 这里只声明位置与格式。
        label: { show: true, position: "right", formatter: "{c}", fontWeight: 500 },
      },
    ],
  };
}

/** 图表高度随条数自适应：每条约 32px，加上下留白。 */
function barHeight(count: number): string {
  const visible = Math.min(count, 10);
  return `${Math.max(160, visible * 32 + 40)}px`;
}

/** 分数着色：低于 60 红、60-79 橙、80+ 绿。 */
function scoreClass(score: number): string {
  if (score < 60) return "score--low";
  if (score < 80) return "score--mid";
  return "score--high";
}

/** 拉取统计数据；时间筛选有值时带 from/to。 */
async function load(): Promise<void> {
  loading.value = true;
  try {
    stats.value = await api.get<ReviewStats>("/api/reviews/stats", {
      from: range.value?.[0] || undefined,
      to: range.value?.[1] || undefined,
    });
  } catch (error) {
    if (!isApiError(error) || error.status !== 401) {
      ElMessage.error(isApiError(error) ? error.message : "加载统计失败");
    }
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  void load();
});
</script>

<style scoped>
/* ---------- 概览卡片（与评审记录页保持同一视觉） ---------- */
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

/* ---------- 两维度并排 ---------- */
.dimension-grid {
  display: grid;
  gap: 16px;
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

/* 表格紧跟图表，中间留一点距离 */
.dimension-table {
  margin-top: 12px;
}

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

/* 窄屏：卡片与两维度都堆成单列 */
@media (max-width: 1100px) {
  .stat-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .dimension-grid {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 640px) {
  .stat-grid {
    grid-template-columns: 1fr;
  }
}
</style>
