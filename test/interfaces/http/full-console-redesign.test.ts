import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const router = readFileSync(new URL("../../../web/src/router/index.ts", import.meta.url), "utf8");
const layout = readFileSync(new URL("../../../web/src/layouts/AdminLayout.vue", import.meta.url), "utf8");
const styles = readFileSync(new URL("../../../web/src/styles/index.css", import.meta.url), "utf8");
const adoption = readFileSync(new URL("../../../web/src/views/AdoptionView.vue", import.meta.url), "utf8");
const reviews = readFileSync(new URL("../../../web/src/views/ReviewsView.vue", import.meta.url), "utf8");
const stats = readFileSync(new URL("../../../web/src/views/StatsView.vue", import.meta.url), "utf8");
const providers = readFileSync(new URL("../../../web/src/views/ProvidersView.vue", import.meta.url), "utf8");
const config = readFileSync(new URL("../../../web/src/views/ConfigView.vue", import.meta.url), "utf8");
const wecom = readFileSync(new URL("../../../web/src/views/WecomContactsView.vue", import.meta.url), "utf8");

test("采纳率成为独立路由和菜单，管理外壳使用 Framed Sheet", () => {
  assert.match(router, /path:\s*"adoption"[\s\S]*AdoptionView\.vue/);
  assert.match(layout, /path:\s*"\/adoption"[\s\S]*title:\s*"采纳率"/);
  assert.match(layout, /app-content__sheet/);
  assert.match(styles, /--app-sidebar-bg:\s*#eef2f7/);
  assert.match(styles, /\.el-button--primary:not\(\.is-link\)/);
  assert.match(adoption, /方案 B 的项目工作台与方案 C 的审计生命周期/);
  assert.match(adoption, /代码变化率\s*=\s*已采纳\s*÷\s*可统计/);
  assert.match(adoption, /使用评审发生时保存的项目名称/);
  assert.match(adoption, /projectDisplayName\(row\.name\)/, "项目表应显示短项目名并保留完整路径");
  assert.match(adoption, /v-model="selectedProjectId"/);
  assert.match(adoption, /projectId:\s*selectedProjectId\.value/);
});

test("日期范围包含结束日最后一毫秒，统计请求只允许最后一轮更新", () => {
  for (const source of [reviews, stats, adoption]) {
    assert.match(source, /new Date\(2000,\s*0,\s*1,\s*23,\s*59,\s*59,\s*999\)/);
    assert.match(source, /:default-time="dateRangeDefaultTime"/);
  }
  for (const source of [stats, adoption]) {
    assert.match(source, /let requestGeneration\s*=\s*0/);
    assert.match(source, /request\s*!==\s*requestGeneration/);
    assert.match(source, /onBeforeUnmount\(\(\)\s*=>\s*\{\s*requestGeneration\s*\+=\s*1/);
  }
});

test("暗色主题覆盖语义状态色，图表颜色随主题切换", () => {
  const darkBlock = styles.match(/html:root\.dark\s*\{[\s\S]*?\n\}/)?.[0] ?? "";
  for (const token of ["--el-color-success", "--el-color-warning", "--el-color-danger", "--el-color-info"]) {
    assert.match(darkBlock, new RegExp(token));
  }
  for (const token of ["--app-chart-primary", "--app-chart-secondary", "--app-chart-muted", "--app-chart-success"]) {
    assert.match(darkBlock, new RegExp(token));
  }
  assert.match(stats, /var\(--app-chart-primary\)/);
  assert.match(adoption, /var\(--app-chart-success\)/);
  assert.doesNotMatch(stats, /splitLine:\s*\{\s*lineStyle:\s*\{\s*color:\s*"#edf1f5"/);
  assert.doesNotMatch(adoption, /splitLine:\s*\{\s*lineStyle:\s*\{\s*color:\s*"#edf1f5"/);
});

test("配置类页面把首次加载失败与真实空数据分开呈现", () => {
  for (const source of [providers, config, wecom]) {
    assert.match(source, /const loaded\s*=\s*ref\(false\)/);
    assert.match(source, /const loadError\s*=\s*ref\(""\)/);
    assert.match(source, /v-if="loadError"/);
    assert.match(source, /重新加载/);
    assert.match(source, /loaded\.value\s*=\s*true/);
  }
});
