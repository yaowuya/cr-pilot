import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const viewSource = readFileSync(new URL("../../../web/src/views/ReviewsView.vue", import.meta.url), "utf8");
const templateSource = viewSource.slice(viewSource.indexOf("<template>"), viewSource.indexOf("<script setup"));
const styleSource = viewSource.slice(viewSource.indexOf("<style scoped>"), viewSource.lastIndexOf("</style>"));

/** 压平模板空白，让断言只约束用户可见契约而不绑定格式化结果。 */
function compact(source: string): string {
  return source.replace(/\s+/g, " ").trim();
}

test("ReviewsView 重构仍保留筛选、分页、外链与 null/0 业务语义", () => {
  const source = compact(viewSource);

  assert.match(source, /api\.get<\{ items: ReviewRecord\[\]; total: number \}>\("\/api\/reviews", \{[^}]*\.\.\.filterParams\(\),[^}]*page: page\.value,[^}]*pageSize: pageSize\.value/s);
  assert.match(source, /api\.get<ReviewStats>\("\/api\/reviews\/stats", filterParams\(\)\)/);
  assert.match(source, /v-model="filters\.projectId"/);
  assert.match(source, /v-model="filters\.committer"/);
  assert.match(source, /v-model="filters\.range"/);
  assert.match(source, /@click="onSearch"/);
  assert.match(source, /@click="onReset"/);
  assert.match(source, /v-model:current-page="page"/);
  assert.match(source, /v-model:page-size="pageSize"/);
  assert.match(source, /@current-change="loadList"/);
  assert.match(source, /@size-change="onSearch"/);

  assert.match(source, /v-if="row\.mrUrl"[^>]*:href="row\.mrUrl"[^>]*target="_blank"[^>]*rel="noopener noreferrer"/);
  assert.match(source, /v-if="row\.score === null"[^>]*>—<\/span>[^<]*<span v-else[^>]*>\{\{ row\.score \}\}<\/span>/);
  assert.match(source, /stats\.value\.avgScore === null \? "—" : stats\.value\.avgScore\.toFixed\(1\)/);
  assert.ok((source.match(/error\.status !== 401/g) ?? []).length >= 2, "列表与统计请求都必须沿用 401 静默回跳行为");
});

test("ReviewsView 使用 Framed Sheet 指标条、列表工作表与 768px 局部横向滚动", () => {
  const template = compact(templateSource);

  assert.match(template, /class="reviews-page page-container"/);
  assert.match(template, /<section[^>]*class="review-metrics"[^>]*aria-label="评审概览"/);
  assert.match(template, /<article v-for="card in statCards"[^>]*class="review-metric"/);
  assert.doesNotMatch(template, /stat-card__icon|backgroundColor: card\.bg/, "指标应为一个分栏条，不再使用四张图标卡片");
  assert.match(template, /<section class="review-sheet" aria-labelledby="review-list-title">/);
  assert.match(template, /<h2 id="review-list-title"[^>]*>最近评审<\/h2>/);
  assert.match(template, /\{\{ pageRangeLabel \}\}/);

  assert.match(styleSource, /\.review-table-wrap\s*\{[^}]*overflow-x:\s*auto/s);
  assert.match(styleSource, /\.review-table\s*\{[^}]*min-width:\s*9\d{2}px/s);
  assert.match(styleSource, /@media\s*\(max-width:\s*900px\)[\s\S]*?\.filter-bar[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
  assert.doesNotMatch(styleSource, /#[\da-f]{3,8}\b/i, "页面局部样式应复用 Element Plus 与应用 token，而不是新增硬编码色值");
});

test("ReviewsView 的概览与列表分别暴露加载、错误重试和空态，401 仍只交给客户端回跳", () => {
  const template = compact(templateSource);
  const source = compact(viewSource);

  assert.match(template, /class="review-metrics"[^>]*v-loading="statsLoading"[^>]*aria-busy="statsLoading"/);
  assert.match(template, /v-if="statsError"[^>]*class="load-alert"[\s\S]*?@click="loadStats"[^>]*>重试概览/);
  assert.match(template, /v-if="listError"[^>]*class="load-alert"[\s\S]*?@click="loadList"[^>]*>重试列表/);
  assert.match(template, /:description="listError \? '评审记录未加载成功，请重试' : '暂无评审记录'"/);
  assert.match(template, /:loading="loading \|\| statsLoading"/);

  assert.match(source, /const listError = ref\(""\)/);
  assert.match(source, /const statsError = ref\(""\)/);
  assert.match(source, /const statsLoading = ref\(false\)/);
  assert.match(source, /listError\.value = isApiError\(error\) \? error\.message : "加载评审记录失败"/);
  assert.match(source, /statsError\.value = isApiError\(error\) \? error\.message : "加载统计失败"/);
  assert.match(source, /if \(!isApiError\(error\) \|\| error\.status !== 401\) \{ listError\.value =/);
  assert.match(source, /if \(!isApiError\(error\) \|\| error\.status !== 401\) \{ statsError\.value =/);
});

test("ReviewsView 只允许最后一次列表与概览请求更新页面状态", () => {
  const source = compact(viewSource);

  assert.match(source, /let listRequestGeneration = 0/);
  assert.match(source, /let statsRequestGeneration = 0/);
  assert.match(source, /async function loadList\(\).*?const request = \+\+listRequestGeneration;.*?if \(request !== listRequestGeneration\) return;.*?items\.value = result\.items/s);
  assert.match(source, /async function loadStats\(\).*?const request = \+\+statsRequestGeneration;.*?if \(request !== statsRequestGeneration\) return;.*?stats\.value =/s);
  assert.match(source, /finally \{ if \(request === listRequestGeneration\) loading\.value = false; \}/);
  assert.match(source, /finally \{ if \(request === statsRequestGeneration\) statsLoading\.value = false; \}/);
  assert.match(source, /onBeforeUnmount\(\(\) => \{ listRequestGeneration \+= 1; statsRequestGeneration \+= 1; \}\)/);
});
