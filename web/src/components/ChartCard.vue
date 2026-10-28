<template>
  <div ref="host" class="chart-card" :style="{ height }" />
</template>

<script setup lang="ts">
/**
 * ECharts 轻封装：只负责挂载、更新、随容器尺寸自适应、跟随主题。
 *
 * 为什么按需引入而不是 `import * as echarts from "echarts"`：
 * 全量包约 1MB（gzip 350KB+），而统计页只用到柱状图与折线图。这里只注册
 * 实际用到的图表类型与组件，`chart-echarts.ts` 集中登记，避免每个使用点
 * 各写一遍 `use()` 造成重复注册。
 *
 * 主题跟随：项目用 `<html class="dark">` 切换暗色。ECharts 无法自动感知 CSS
 * 变量，因此监听 class 变化后重新 setOption，把文字/轴线颜色换成当前主题的
 * 值——否则暗色下图表文字几乎看不见。
 */
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { echarts, registerCharts } from "../composables/chart-echarts.ts";

registerCharts();

const props = defineProps<{
  /** ECharts option 对象；变化时自动重绘。 */
  option: Record<string, unknown>;
  /** 容器高度，允许调用方按图表类型给不同高度。 */
  height?: string;
}>();

const host = ref<HTMLDivElement>();
let chart: ReturnType<typeof echarts.init> | undefined;
/** 主题观察器：class 变化时重绘，让坐标轴与文字颜色跟随亮/暗切换。 */
let themeObserver: MutationObserver | undefined;

/** 从当前主题根变量解析实际颜色；fallback 只用于变量缺失的独立挂载场景。 */
function cssToken(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

/** 解析 option 中的 CSS 变量颜色，ECharts 本身不会解释 `var(...)`。 */
function resolveCssColor(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const match = value.match(/^var\((--[\w-]+)\)$/);
  return match ? cssToken(match[1]!, value) : value;
}

/**
 * 把主题相关的颜色注入 option。
 *
 * 不在 option 里写死颜色，而是渲染时统一套用：调用方只关心数据与图形类型，
 * 配色由这里保证与页面主题一致。这样新增图表不会漏掉暗色适配。
 */
function withTheme(option: Record<string, unknown>): Record<string, unknown> {
  const textColor = cssToken("--el-text-color-regular", "#526077");
  const lineColor = cssToken("--el-border-color-light", "#e7eaf0");

  return {
    // 透明背景：图表底色由卡片决定，避免暗色下出现一块突兀的白底
    backgroundColor: "transparent",
    textStyle: { color: textColor },
    ...option,
    // legend 自有默认颜色不会继承顶层 textStyle，必须单独跟随主题。
    legend: applyLegendStyle(option.legend, textColor),
    // 坐标轴样式统一覆盖，避免每个调用点重复配置
    xAxis: applyAxisStyle(option.xAxis, textColor, lineColor),
    yAxis: applyAxisStyle(option.yAxis, textColor, lineColor),
    // 系列上的标签/数值同属文字，也要跟主题走；否则暗色下深色数字贴在深色
    // 背景上几乎不可见（柱状图条尾的次数值就是典型例子）
    series: applySeriesStyle(option.series, textColor),
  };
}

/** 为单个或多个图例补齐主题文字色，同时保留布局与交互配置。 */
function applyLegendStyle(legend: unknown, textColor: string): unknown {
  if (!legend) return legend;
  const entries = Array.isArray(legend) ? legend : [legend];
  return entries.map((entry) => {
    const record = entry as Record<string, unknown>;
    return { ...record, textStyle: { ...(record.textStyle as object ?? {}), color: textColor } };
  });
}

/**
 * 给 series（对象或数组）里的 label 补上主题文字色。
 *
 * 只覆盖 label.color，不动其他样式：调用方对图形本身的配置（颜色、圆角、
 * 柱宽）应当保留，这里只解决「文字在暗色下看不清」这一个问题。
 */
function applySeriesStyle(series: unknown, textColor: string): unknown {
  if (!series) return series;
  const items = Array.isArray(series) ? series : [series];
  return items.map((item) => {
    const record = item as Record<string, unknown>;
    const label = record.label as Record<string, unknown> | undefined;
    const itemStyle = record.itemStyle as Record<string, unknown> | undefined;
    const lineStyle = record.lineStyle as Record<string, unknown> | undefined;
    return {
      ...record,
      ...(label ? { label: { color: textColor, ...label } } : {}),
      ...(itemStyle ? { itemStyle: { ...itemStyle, color: resolveCssColor(itemStyle.color) } } : {}),
      ...(lineStyle ? { lineStyle: { ...lineStyle, color: resolveCssColor(lineStyle.color) } } : {}),
    };
  });
}

/** 给 xAxis/yAxis（可能是对象或数组）套用统一的文字与网格线颜色。 */
function applyAxisStyle(
  axis: unknown,
  textColor: string,
  lineColor: string,
): unknown {
  if (!axis) return axis;
  const items = Array.isArray(axis) ? axis : [axis];
  return items.map((item) => {
    const record = item as Record<string, unknown>;
    return {
      ...record,
      axisLabel: { color: textColor, ...(record.axisLabel as object ?? {}) },
      axisLine: { lineStyle: { color: lineColor }, ...(record.axisLine as object ?? {}) },
      splitLine: { lineStyle: { color: lineColor }, ...(record.splitLine as object ?? {}) },
    };
  });
}

/** 应用 option 并适配容器尺寸。 */
function render(): void {
  if (!chart) return;
  // notMerge=true：数据维度变化时要完全替换，否则残留旧的 series 会串图
  chart.setOption(withTheme(props.option), true);
  chart.resize();
}

onMounted(() => {
  if (!host.value) return;
  chart = echarts.init(host.value);
  render();

  // 容器尺寸变化（侧边栏折叠、窗口缩放）时重绘尺寸
  window.addEventListener("resize", onResize);
  // 主题切换：<html> 的 class 变化
  themeObserver = new MutationObserver(() => render());
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
});

function onResize(): void {
  chart?.resize();
}

watch(
  () => props.option,
  () => render(),
  { deep: true },
);

onBeforeUnmount(() => {
  window.removeEventListener("resize", onResize);
  themeObserver?.disconnect();
  // dispose 而非 clear：ECharts 实例持有 canvas 与事件监听，不释放会泄漏
  chart?.dispose();
  chart = undefined;
});
</script>

<style scoped>
.chart-card {
  width: 100%;
}
</style>
