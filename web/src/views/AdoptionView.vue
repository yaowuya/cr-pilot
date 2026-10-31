<template>
  <div class="page-container">
    <header class="page-header">
      <div>
        <h1 class="page-header__title">采纳率</h1>
        <p class="page-header__desc">哪些项目仍在等待判定，评审建议是否真正带来了代码变化？</p>
      </div>
      <div class="page-header__actions">
        <el-select v-model="selectedProjectId" clearable :value-on-clear="null" placeholder="全部项目" class="project-filter" @change="loadAdoption">
          <el-option v-for="project in projectOptions" :key="project.id" :value="project.id" :label="project.name" />
        </el-select>
        <el-date-picker
          v-model="range"
          type="daterange"
          range-separator="至"
          start-placeholder="开始日期"
          end-placeholder="结束日期"
          value-format="x"
          :default-time="dateRangeDefaultTime"
          @change="loadAdoption"
        />
        <el-button :loading="loading" @click="loadAdoption"><el-icon><Refresh /></el-icon>刷新</el-button>
      </div>
    </header>

    <nav class="adoption-tabs" aria-label="采纳率维度">
      <button v-for="tab in tabs" :key="tab.key" :class="{ active: activeTab === tab.key }" @click="activeTab = tab.key">
        {{ tab.label }}
      </button>
    </nav>

    <el-alert v-if="errorMessage" type="error" :closable="false" show-icon>
      <template #title>采纳统计加载失败</template>
      <div class="error-action">{{ errorMessage }} <el-button link type="primary" :loading="loading" @click="loadAdoption">重新加载</el-button></div>
    </el-alert>

    <!-- 方案 B 的项目工作台与方案 C 的审计生命周期在同一工作表中呈现。 -->
    <section v-loading="loading" class="adoption-report">
      <header class="report-header">
        <div>
          <h2>代码变化率</h2>
          <p>等待判定、不可统计与 95 分及以上评审的建议均不进入分母；每个数字均显示计算方式。</p>
        </div>
        <span>{{ rangeLabel }} · {{ selectedProjectLabel }}</span>
      </header>

      <div class="report-body">
        <div class="rate-hero">
          <p class="metric-label">代码变化率</p>
          <p class="rate-value">{{ formatRate(adoption?.total.rate ?? null) }}</p>
          <p class="formula">代码变化率 = 已采纳 {{ adoption?.total.adopted ?? 0 }} ÷ 可统计 {{ adoption?.total.tracked ?? 0 }}</p>
          <div class="metric-ledger">
            <div v-for="metric in ledgerMetrics" :key="metric.label" class="ledger-row">
              <i :style="{ backgroundColor: metric.color }" />
              <div><strong>{{ metric.label }}</strong><small>计算：{{ metric.formula }}</small></div>
              <b>{{ metric.value }}</b>
            </div>
          </div>
        </div>

        <div class="lifecycle">
          <div class="lifecycle-title"><div><h3>建议生命周期</h3><p>同一批数据，从产生到完成判定逐层收敛。</p></div><span>共 {{ suggestionTotal }} 条</span></div>
          <div v-for="step in lifecycleSteps" :key="step.label" class="lifecycle-row">
            <div><strong>{{ step.label }}</strong><small>计算：{{ step.formula }}</small></div>
            <div class="lifecycle-track"><i :style="{ width: `${step.share}%`, backgroundColor: step.color }" /></div>
            <b>{{ step.value }}</b>
          </div>
        </div>
      </div>
    </section>

    <el-alert
      v-if="excludedHighScore > 0"
      type="success"
      :closable="false"
      show-icon
    >
      <template #title>已按口径排除 {{ excludedHighScore }} 条高分建议</template>
      这些建议来自评审总分 ≥ 95 分的记录：分子与分母同时排除，避免低风险评审稀释采纳率。排除项不计入等待判定。
    </el-alert>

    <el-alert
      v-if="adoption && adoption.total.tracked === 0 && (adoption.total.pending > 0 || untrackableTotal > 0)"
      type="info"
      :closable="false"
      show-icon
    >
      <template #title>当前没有已完成判定的建议</template>
      等待判定 {{ adoption.total.pending }} 条；不可追踪 {{ untrackableTotal }} 条。两类建议都不会被当作未采纳加入分母。
    </el-alert>

    <div v-if="activeTab !== 'method'" class="adoption-main">
      <section class="adoption-panel">
        <header class="panel-header">
          <div>
            <h2>{{ activeTab === "project" ? "按项目" : "按提交人" }}</h2>
            <p>{{ activeTab === "project" ? "使用评审发生时保存的项目名称，不显示数字 ID。" : "等待判定与已完成判定使用同一统计口径。" }}</p>
          </div>
          <span>{{ activeRows.length }} 项</span>
        </header>
        <el-table :data="activeRows" :row-key="adoptionRowKey" size="default" empty-text="暂无采纳数据">
          <el-table-column prop="name" :label="activeTab === 'project' ? '项目' : '提交人'" min-width="240" show-overflow-tooltip>
            <template #default="{ row }">
              <span class="row-name">{{ activeTab === "project" ? projectDisplayName(row.name) : row.name }}</span>
              <small v-if="activeTab === 'project' && projectDisplayName(row.name) !== row.name" class="row-path">{{ row.name }}</small>
            </template>
          </el-table-column>
          <el-table-column prop="pending" label="等待判定" width="105" align="right" sortable />
          <el-table-column prop="tracked" label="可统计" width="90" align="right" sortable />
          <el-table-column prop="adopted" label="已采纳" width="90" align="right" sortable />
          <el-table-column label="代码变化率" width="145" align="right" sortable :sort-by="'rate'">
            <template #default="{ row }">
              <div class="rate-cell"><span class="rate-track"><i :style="{ width: `${(row.rate ?? 0) * 100}%` }" /></span><strong :class="rateClass(row.rate)">{{ formatRate(row.rate) }}</strong></div>
            </template>
          </el-table-column>
        </el-table>
        <footer class="panel-formula">等待判定 = 有行锚点且 outcome=pending；可统计 = 已采纳 + 已解决但未变 + 未采纳；代码变化率 = 已采纳 ÷ 可统计。</footer>
      </section>

      <aside class="adoption-panel attention-panel">
        <header class="panel-header"><div><h2>需要跟进</h2><p>按等待判定数降序，只显示仍需动作的项目。</p></div></header>
        <template v-if="attentionRows.length">
          <article v-for="row in attentionRows" :key="adoptionRowKey(row)" class="attention-row">
            <div><strong>{{ projectDisplayName(row.name) }}</strong><b>等待 {{ row.pending }}</b></div>
            <p>{{ row.name }}<br />等待占比：{{ row.pending }} ÷ {{ row.pending + row.tracked }} = {{ formatRate(row.pending / (row.pending + row.tracked)) }}</p>
          </article>
        </template>
        <el-empty v-else description="当前没有等待判定的项目" :image-size="64" />
        <div class="method-note"><strong>队列计算</strong><br />等待判定不是“未采纳”，因此不进入代码变化率分母。</div>
      </aside>
    </div>

    <section v-else class="method-grid">
      <article v-for="method in methods" :key="method.label"><strong>{{ method.label }}</strong><p>{{ method.formula }}</p><small>{{ method.note }}</small></article>
    </section>

    <section class="severity-panel">
      <header class="panel-header"><div><h2>严重级分布</h2><p>等待判定、完成判定与已采纳使用同一时间筛选。</p></div></header>
      <ChartCard v-if="severityRows.length" :option="severityOption" :height="barHeight(severityRows.length)" />
      <el-empty v-else description="暂无严重级采纳数据" :image-size="64" />
    </section>
  </div>
</template>

<script setup lang="ts">
/**
 * 独立采纳分析页，负责加载 `/api/reviews/adoption`、按项目/提交人切换并解释统计口径。
 * 不变量：pending、fallback、unknown 都不进入采纳率分母；unknown 有行锚点，fallback 没有；
 * 评审总分 ≥ 95 分的建议分子分母同时排除，单独计数，不能与不可追踪相加；
 * 项目筛选使用服务端返回的 projectId，但界面始终显示评审发生时保存的项目名称。
 */
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { ElMessage } from "element-plus";
import { Refresh } from "@element-plus/icons-vue";
import ChartCard from "../components/ChartCard.vue";
import { api, isApiError } from "../api/client.ts";
import { inclusiveCalendarRange } from "../date-range.ts";
import type { AdoptionDimensionRow, AdoptionStats } from "../types.ts";

type AdoptionTab = "project" | "committer" | "method";
const tabs: Array<{ key: AdoptionTab; label: string }> = [
  { key: "project", label: "按项目" },
  { key: "committer", label: "按提交人" },
  { key: "method", label: "统计口径" },
];
const activeTab = ref<AdoptionTab>("project");
const range = ref<[string, string] | null>(null);
const selectedProjectId = ref<number | null>(null);
const projectOptions = ref<Array<{ id: number; name: string }>>([]);
const dateRangeDefaultTime = [new Date(2000, 0, 1, 0, 0, 0), new Date(2000, 0, 1, 23, 59, 59, 999)];
const adoption = ref<AdoptionStats | null>(null);
const loading = ref(false);
/** 只允许最后一次筛选请求更新页面，离页后所有未决响应均失效。 */
let requestGeneration = 0;
const errorMessage = ref("");
const projectRows = computed(() => adoption.value?.byProject ?? []);
const committerRows = computed(() => adoption.value?.byCommitter ?? []);
const severityRows = computed(() => adoption.value?.bySeverity ?? []);
const activeRows = computed(() => activeTab.value === "project" ? projectRows.value : committerRows.value);
const untrackableTotal = computed(() => (adoption.value?.untrackable.fallback ?? 0) + (adoption.value?.untrackable.unknown ?? 0));
/** 评审总分 ≥ 95 而被排除的建议数；与 untrackable 是不同口径，不能相加。 */
const excludedHighScore = computed(() => adoption.value?.excluded.highScore ?? 0);
// 建议总量必须含高分排除项：它们已从 tracked/pending 中移除，若不加回来，
// 页面的「建议总量」会小于实际落库条数，看起来像数据丢失。
const suggestionTotal = computed(() => (adoption.value?.total.pending ?? 0) + (adoption.value?.total.tracked ?? 0) + untrackableTotal.value + excludedHighScore.value);
// unknown 仍有代码指纹/行锚点，只是无法可靠定位；有锚点总数只排除空指纹 fallback。
// 高分排除项也带行锚点，必须加回来，否则「总量 − 空指纹 fallback」的公式对不上。
const anchoredTotal = computed(() => (adoption.value?.total.pending ?? 0) + (adoption.value?.total.tracked ?? 0)
  + (adoption.value?.untrackable.unknown ?? 0) + excludedHighScore.value);
const rangeLabel = computed(() => range.value ? "自定义范围" : "全部时间");
const selectedProjectLabel = computed(() => {
  if (selectedProjectId.value === null) return `${projectOptions.value.length} 个项目`;
  const option = projectOptions.value.find((item) => item.id === selectedProjectId.value);
  return option ? projectDisplayName(option.name) : `项目 ${selectedProjectId.value}`;
});

const ledgerMetrics = computed(() => [
  { label: "等待判定", value: adoption.value?.total.pending ?? 0, formula: "有行锚点且 outcome=pending", color: "var(--app-chart-primary)" },
  { label: "可统计", value: adoption.value?.total.tracked ?? 0, formula: "已采纳 + 已解决但未变 + 未采纳", color: "var(--el-text-color-secondary)" },
  { label: "不可统计", value: untrackableTotal.value, formula: `fallback ${adoption.value?.untrackable.fallback ?? 0} + unknown ${adoption.value?.untrackable.unknown ?? 0}`, color: "var(--el-color-warning)" },
]);
const lifecycleSteps = computed(() => {
  const total = suggestionTotal.value;
  const tracked = adoption.value?.total.tracked ?? 0;
  const adopted = adoption.value?.total.adopted ?? 0;
  const share = (value: number) => total > 0 ? (value / total) * 100 : 0;
  return [
    { label: "建议总量", value: total, formula: "等待 + 可统计 + 不可统计 + 高分排除", share: share(total), color: "var(--el-text-color-secondary)" },
    { label: "有行锚点", value: anchoredTotal.value, formula: "总量 − 空指纹 fallback", share: share(anchoredTotal.value), color: "var(--app-chart-primary)" },
    { label: "已完成判定", value: tracked, formula: "已采纳 + 已解决但未变 + 未采纳", share: share(tracked), color: "var(--el-text-color-secondary)" },
    { label: "代码已变化", value: adopted, formula: "已采纳建议", share: share(adopted), color: "var(--el-color-primary)" },
  ];
});
const attentionRows = computed(() => [...projectRows.value].filter((row) => row.pending > 0).sort((a, b) => b.pending - a.pending).slice(0, 3));
const methods = computed(() => [
  { label: "建议总量", formula: `等待 ${adoption.value?.total.pending ?? 0} + 可统计 ${adoption.value?.total.tracked ?? 0} + 不可统计 ${untrackableTotal.value} + 高分排除 ${excludedHighScore.value} = ${suggestionTotal.value}`, note: "所有已落库建议" },
  { label: "等待判定", formula: `有行锚点且 outcome=pending = ${adoption.value?.total.pending ?? 0}`, note: "等待新提交或 MR 终态" },
  { label: "可统计", formula: `已完成判定 = ${adoption.value?.total.tracked ?? 0}`, note: "采纳率分母" },
  { label: "代码变化率", formula: `已采纳 ${adoption.value?.total.adopted ?? 0} ÷ 可统计 ${adoption.value?.total.tracked ?? 0} = ${formatRate(adoption.value?.total.rate ?? null)}`, note: "只证明代码变化，不证明修复正确" },
  { label: "不可统计", formula: `fallback + unknown = ${untrackableTotal.value}`, note: "不进入分母" },
  { label: "高分排除", formula: `评审总分 ≥ 95 分的建议 = ${excludedHighScore.value}`, note: "分子与分母同时排除；不属于不可追踪" },
]);
const severityOption = computed(() => ({
  tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
  legend: { data: ["等待判定", "可统计", "已采纳"], top: 0 },
  grid: { left: 8, right: 36, bottom: 8, top: 38, containLabel: true },
  xAxis: { type: "value", minInterval: 1 },
  yAxis: { type: "category", data: severityRows.value.map((row) => row.name.toUpperCase()).reverse(), axisLine: { show: false }, axisTick: { show: false } },
  series: [
    { name: "等待判定", type: "bar", data: severityRows.value.map((row) => row.pending).reverse(), itemStyle: { color: "var(--app-chart-primary)" }, barMaxWidth: 14 },
    { name: "可统计", type: "bar", data: severityRows.value.map((row) => row.tracked).reverse(), itemStyle: { color: "var(--app-chart-muted)" }, barMaxWidth: 14 },
    { name: "已采纳", type: "bar", data: severityRows.value.map((row) => row.adopted).reverse(), itemStyle: { color: "var(--app-chart-success)" }, barMaxWidth: 14 },
  ],
}));

function queryParams(): Record<string, unknown> {
  return {
    ...inclusiveCalendarRange(range.value),
    projectId: selectedProjectId.value ?? undefined,
  };
}
function formatRate(rate: number | null): string { return rate === null ? "—" : `${(rate * 100).toFixed(1)}%`; }
function projectDisplayName(name: string): string { return name.split("/").filter(Boolean).at(-1) ?? name; }
function adoptionRowKey(row: AdoptionDimensionRow): string { return row.projectId === undefined ? row.name : `${row.projectId}:${row.name}`; }
function rateClass(rate: number | null): string { if (rate === null) return "is-muted"; if (rate >= 0.2) return "is-good"; if (rate < 0.1) return "is-low"; return ""; }
function barHeight(count: number): string { return `${Math.max(180, count * 34 + 72)}px`; }
async function loadAdoption(): Promise<void> {
  const request = ++requestGeneration;
  loading.value = true;
  errorMessage.value = "";
  try {
    const result = await api.get<AdoptionStats>("/api/reviews/adoption", queryParams());
    if (request !== requestGeneration) return;
    adoption.value = result;
    if (selectedProjectId.value === null) {
      const options = new Map<number, { id: number; name: string }>();
      for (const row of result.byProject) {
        if (row.projectId !== undefined && !options.has(row.projectId)) options.set(row.projectId, { id: row.projectId, name: row.name });
      }
      projectOptions.value = [...options.values()];
    }
  } catch (error) {
    if (request !== requestGeneration) return;
    errorMessage.value = isApiError(error) ? error.message : "采纳统计加载失败";
    ElMessage.error(errorMessage.value);
  } finally {
    if (request === requestGeneration) loading.value = false;
  }
}
onMounted(() => { void loadAdoption(); });
onBeforeUnmount(() => { requestGeneration += 1; });
</script>

<style scoped>
.error-action { display: flex; align-items: center; gap: 6px; }
.project-filter { width: 210px; }
.adoption-tabs { display: flex; gap: 26px; border-bottom: 1px solid var(--el-border-color-light); }
.adoption-tabs button { position: relative; height: 38px; padding: 0; border: 0; background: transparent; color: var(--el-text-color-regular); cursor: pointer; }
.adoption-tabs button.active { color: var(--el-text-color-primary); font-weight: 600; }
.adoption-tabs button.active::after { position: absolute; right: -7px; bottom: -1px; left: -7px; height: 2px; background: var(--el-color-primary); content: ""; }
.adoption-report,.adoption-panel,.severity-panel { border: 1px solid var(--el-border-color-light); border-radius: var(--el-border-radius-base); overflow: hidden; background: var(--el-bg-color); }
.report-header,.panel-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding: 17px 20px 14px; border-bottom: 1px solid var(--el-border-color-lighter); }
.report-header h2,.panel-header h2 { margin: 0; font-size: 16px; }
.report-header p,.panel-header p { margin: 5px 0 0; color: var(--el-text-color-regular); font-size: 12px; }
.report-header>span,.panel-header>span { color: var(--el-text-color-secondary); font-size: 12px; white-space: nowrap; }
.report-body { display: grid; grid-template-columns: 390px minmax(0,1fr); }
.rate-hero { padding: 25px 24px 20px; border-right: 1px solid var(--el-border-color-light); }
.metric-label,.formula { color: var(--el-text-color-regular); font-size: 12px; }
.rate-value { margin: 7px 0 0; color: var(--el-color-primary); font-size: 40px; font-weight: 500; line-height: 1; font-variant-numeric: tabular-nums; }
.formula { margin: 9px 0 0; }
.metric-ledger { margin-top: 20px; border-top: 1px solid var(--el-border-color-lighter); }
.ledger-row { display: grid; grid-template-columns: 10px 1fr auto; gap: 10px; align-items: center; min-height: 56px; border-bottom: 1px solid var(--el-border-color-lighter); }
.ledger-row i { width: 8px; height: 8px; border-radius: 2px; }
.ledger-row strong,.ledger-row small { display: block; }
.ledger-row strong { font-size: 13px; }
.ledger-row small { margin-top: 3px; color: var(--el-text-color-regular); font-size: 11px; }
.ledger-row>b { font-size: 17px; font-variant-numeric: tabular-nums; }
.lifecycle { padding: 23px 24px 20px; }
.lifecycle-title { display: flex; justify-content: space-between; gap: 12px; }
.lifecycle-title h3 { margin: 0; font-size: 16px; }
.lifecycle-title p { margin: 5px 0 0; color: var(--el-text-color-regular); font-size: 12px; }
.lifecycle-title>span { color: var(--el-text-color-secondary); font-size: 12px; }
.lifecycle-row { display: grid; grid-template-columns: 120px minmax(100px,1fr) 46px; gap: 12px; align-items: center; min-height: 58px; border-bottom: 1px solid var(--el-border-color-lighter); }
.lifecycle-row:last-child { border-top: 2px solid var(--el-color-primary); border-bottom: 0; background: var(--el-color-primary-light-9); }
.lifecycle-row strong,.lifecycle-row small { display: block; }
.lifecycle-row strong { font-size: 13px; }
.lifecycle-row small { margin-top: 3px; color: var(--el-text-color-regular); font-size: 11px; }
.lifecycle-row>b { text-align: right; font-variant-numeric: tabular-nums; }
.lifecycle-track,.rate-track { overflow: hidden; background: var(--el-fill-color); }
.lifecycle-track { height: 8px; border-radius: 99px; }
.lifecycle-track i,.rate-track i { display: block; height: 100%; }
.adoption-main { display: grid; grid-template-columns: minmax(0,1fr) 320px; gap: 18px; }
.row-name { display: block; color: var(--el-text-color-primary); font-weight: 600; }
.row-path { display: block; margin-top: 3px; color: var(--el-text-color-regular); font-size: 11px; }
.rate-cell { display: flex; align-items: center; justify-content: flex-end; gap: 8px; }
.rate-track { width: 64px; height: 5px; }
.rate-track i { background: var(--el-color-primary); }
.rate-cell strong { min-width: 44px; font-variant-numeric: tabular-nums; }
.is-good { color: var(--el-color-success); }.is-low { color: var(--el-color-danger); }.is-muted { color: var(--el-text-color-secondary); }
.panel-formula,.method-note { padding: 11px 14px; background: var(--el-fill-color-light); color: var(--el-text-color-regular); font-size: 12px; line-height: 1.55; }
.attention-row { padding: 13px 16px; border-top: 1px solid var(--el-border-color-lighter); }
.attention-row>div { display: flex; justify-content: space-between; gap: 10px; }
.attention-row b { color: var(--app-chart-primary); font-size: 12px; }
.attention-row p { margin: 5px 0 0; color: var(--el-text-color-regular); font-size: 11px; }
.method-note { margin: 14px 16px 16px; }
.method-grid { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 1px; background: var(--el-border-color-light); border: 1px solid var(--el-border-color-light); }
.method-grid article { padding: 16px; background: var(--el-bg-color); }
.method-grid p { margin: 7px 0; font-size: 13px; }
.method-grid small { color: var(--el-text-color-regular); font-size: 12px; }
.severity-panel :deep(.chart-card) { border: 0; }
@media (max-width: 1100px) {
  .page-header { flex-wrap: wrap; }
  .page-header__actions { flex-wrap: wrap; }
  .adoption-main { grid-template-columns: 1fr; }
  .attention-panel { display: grid; grid-template-columns: repeat(3,1fr); }
  .attention-panel .panel-header,.attention-panel .method-note { grid-column: 1/-1; }
  .report-body { grid-template-columns: 330px minmax(0,1fr); }
  .method-grid { grid-template-columns: 1fr 1fr; }
}
</style>
