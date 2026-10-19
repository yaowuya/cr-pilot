/**
 * ECharts 按需注册。
 *
 * 集中在这里而不是散落在各组件，原因：`echarts.use()` 是全局副作用，
 * 多处重复注册同一组件既浪费又难看；而且新增图表类型时只改这一处，
 * 不用去翻哪个组件注册了什么。
 *
 * 只注册统计页实际用到的能力：
 * - BarChart / LineChart：项目与提交人排行、按日趋势
 * - GridComponent：坐标系
 * - TooltipComponent：悬浮提示（图表可读性的关键）
 * - LegendComponent：多系列图例（趋势图的次数 + 平均分）
 *
 * 未注册的组件不会打进产物。若后续新增饼图/雷达图，在这里补 `PieChart` 等即可。
 */
import * as echarts from "echarts/core";
import { BarChart, LineChart } from "echarts/charts";
import { GridComponent, LegendComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";

/** 幂等注册：重复调用不会重复 use。 */
let registered = false;

/** 注册本页图表所需的 ECharts 模块。组件挂载时调用。 */
export function registerCharts(): void {
  if (registered) return;
  echarts.use([BarChart, LineChart, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer]);
  registered = true;
}

export { echarts };
