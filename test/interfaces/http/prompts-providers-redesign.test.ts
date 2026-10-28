import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const promptsSource = readFileSync(
  new URL("../../../web/src/views/PromptsView.vue", import.meta.url),
  "utf8",
);
const providersSource = readFileSync(
  new URL("../../../web/src/views/ProvidersView.vue", import.meta.url),
  "utf8",
);

/** 压平模板空白，让断言只关注用户可见结构而不绑定格式化。 */
function compact(source: string): string {
  return source.replace(/\s+/g, " ").trim();
}

test("Prompt 页按 Framed Sheet 呈现评审列表、配置覆盖与编辑流程", () => {
  const source = compact(promptsSource);

  assert.match(
    source,
    /<section class="sheet-panel prompt-ledger" aria-labelledby="prompt-list-title">/,
    "评审 Prompt 列表应成为页面的主工作表",
  );
  assert.match(source, /id="prompt-list-title">评审 Prompt<\/h2>/);
  assert.match(source, /\{\{\s*prompts\.length\s*\}\}\s*条/);
  assert.match(source, /<section class="sheet-panel coverage-panel" aria-labelledby="coverage-title">/);
  assert.match(source, /id="coverage-title">配置覆盖<\/h2>/);
  assert.match(source, /关联项目/);
  assert.match(source, /仓库上下文/);
  assert.match(source, /模型覆盖/);
  assert.match(source, /企微通知/);
  assert.match(source, /<section class="sheet-panel workflow-panel" aria-labelledby="workflow-title">/);
  assert.match(source, /id="workflow-title">编辑流程<\/h2>/);
});

test("AI 厂商页以厂商概览和项目绑定两张工作表承载全部配置", () => {
  const source = compact(providersSource);

  assert.match(source, /<div class="page-container providers-page">/);
  assert.match(
    source,
    /<section class="sheet-panel providers-overview"[^>]*aria-labelledby="providers-overview-title">/,
  );
  assert.match(source, /id="providers-overview-title">厂商概览<\/h2>/);
  assert.match(source, /\{\{\s*providers\.length\s*\}\}\s*个厂商/);
  assert.match(source, /class="provider-sheet-card"/);
  assert.match(
    source,
    /<section v-if="loaded" class="sheet-panel binding-panel" aria-labelledby="binding-title">/,
  );
  assert.match(source, /id="binding-title">项目级模型绑定<\/h2>/);
  assert.match(source, /\{\{\s*bindings\.length\s*\}\}\s*条绑定/);
  assert.match(source, /class="provider-editor-dialog"/);
  assert.match(source, /width="min\(960px, calc\(100vw - 32px\)\)"/);
});

test("Prompt 重排不削弱独立失败、旧响应守卫、未知开关和未保存关闭保护", () => {
  const source = compact(promptsSource);

  assert.match(source, /Promise\.allSettled\(\[ row \? api\.get<StoredPrompt>/);
  assert.match(source, /detail\.status === "rejected"/);
  assert.match(source, /suggestions\.status === "fulfilled"/);
  assert.match(source, /editorGeneration\.isCurrent\(request\)/);
  assert.match(source, /listGeneration\.isCurrent\(request\)/);
  assert.match(source, /metaGeneration\.isCurrent\(request\)/);
  assert.match(source, /form\.projectStates\[projectKey\(project\)\] === undefined/);
  assert.match(
    source,
    /:disabled="!canEnableRepositoryContext\(project\) \|\| form\.projectStates\[projectKey\(project\)\] === undefined"/,
  );
  assert.match(source, /detailReady\.value && dirty\.value/);
  assert.match(source, /有未保存的配置，关闭会放弃这些修改/);

  for (const contract of [
    /v-model="form\.repository"/,
    /v-model="form\.projects"/,
    /v-model:system-prompt="form\.systemPrompt"/,
    /v-model:user-prompt="form\.userPrompt"/,
    /v-model="form\.repositoryStandards"/,
    /v-model="form\.providerId"/,
    /v-model="form\.model"/,
    /v-model="form\.wecomScoreThreshold"/,
    /v-model="form\.wecomWebhookUrl"/,
  ]) {
    assert.match(source, contract);
  }
});

test("AI 厂商重排保留密钥留空、模板降级、删除回落与项目绑定契约", () => {
  const source = compact(providersSource);

  assert.match(source, /editingId\.value \? "留空表示不修改现有密钥"/);
  assert.match(source, /api_key:\s*form\.apiKey \|\| undefined/);
  assert.match(source, /async function loadTemplates\(\).*?catch \{.*?模板只是预填便利，失败不阻断新建/s);
  assert.match(source, /v-else class="template-fallback">暂无可用模板，请手动填写/);
  assert.match(source, /引用它的 prompt 与项目绑定将回落到全局默认厂商/);
  assert.match(source, /await api\.delete\(`\/api\/providers\/\$\{provider\.id\}`\)/);
  assert.match(source, /\/api\/providers\/bindings\/\$\{encodeURIComponent\(bindingForm\.project\.trim\(\)\)\}/);
  assert.match(source, /\/api\/providers\/bindings\/\$\{encodeURIComponent\(project\)\}/);
  assert.match(source, /provider_id:\s*bindingForm\.providerId/);
  assert.match(source, /model:\s*bindingForm\.model \|\| undefined/);

  for (const field of ["form.label", "form.name", "form.baseUrl", "form.apiKey", "form.api", "form.models", "form.defaultModel", "form.isDefault"]) {
    assert.match(source, new RegExp(`v-model="${field.replace(".", "\\.")}"`));
  }
});

test("两页把 768px 收敛为内部表格滚动和可重排工作区，不制造页面级横向溢出", () => {
  const prompts = compact(promptsSource);
  const providers = compact(providersSource);

  assert.match(prompts, /width="min\(1080px, calc\(100vw - 32px\)\)"/);
  assert.match(prompts, /\.table-shell \{ min-width: 0; max-width: 100%; overflow: hidden; \}/);
  assert.match(prompts, /@media \(max-width: 900px\).*?\.prompt-overview-grid \{ grid-template-columns: 1fr;/);
  assert.match(prompts, /@media \(max-width: 768px\).*?\.prompts-page \.page-header \{ flex-direction: column;/);

  assert.match(providers, /\.provider-grid \{ display: grid; grid-template-columns: repeat\(auto-fit, minmax\(280px, 1fr\)\);/);
  assert.match(providers, /\.table-shell \{ min-width: 0; max-width: 100%; overflow: hidden; \}/);
  assert.match(providers, /@media \(max-width: 768px\).*?\.providers-page \.page-header \{ flex-direction: column;/);
  assert.doesNotMatch(providers, /width="680px"/);
});
