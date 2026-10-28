import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const chart = readFileSync(new URL("../../../web/src/components/ChartCard.vue", import.meta.url), "utf8");
const stats = readFileSync(new URL("../../../web/src/views/StatsView.vue", import.meta.url), "utf8");
const adoption = readFileSync(new URL("../../../web/src/views/AdoptionView.vue", import.meta.url), "utf8");
const styles = readFileSync(new URL("../../../web/src/styles/index.css", import.meta.url), "utf8");

test("图表颜色来自全局主题 token，暗色图例与系列会重新解析", () => {
  for (const token of ["--app-chart-primary", "--app-chart-secondary", "--app-chart-muted", "--app-chart-success"]) {
    assert.match(styles, new RegExp(`${token}:`));
  }
  assert.match(chart, /getComputedStyle\(document\.documentElement\)/);
  assert.match(chart, /applyLegendStyle\(option\.legend, textColor\)/);
  assert.match(chart, /resolveCssColor\(itemStyle\.color\)/);
  assert.match(chart, /resolveCssColor\(lineStyle\.color\)/);
  assert.match(stats, /var\(--app-chart-primary\)/);
  assert.match(stats, /var\(--app-chart-secondary\)/);
  assert.match(adoption, /var\(--app-chart-muted\)/);
  assert.match(adoption, /var\(--app-chart-success\)/);
  assert.doesNotMatch(stats, /const chartPalette/);
  assert.doesNotMatch(adoption, /const chartPalette/);
});
