import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const view = readFileSync(new URL("../../../web/src/views/PromptsView.vue", import.meta.url), "utf8").replace(/\s+/g, " ");
const types = readFileSync(new URL("../../../web/src/types.ts", import.meta.url), "utf8");

/** 逐项目工作台需要完整策略字段，列表只汇总上下文与自动合并启用数。 */
test("Prompt 页面在项目执行中展示自动合并策略与固定安全阻断说明", () => {
  assert.match(view, /label="项目执行"/);
  assert.match(view, /仓库上下文[^<]*\{\{\s*enabledCount\(row\)\s*\}\}\s*\/\s*\{\{\s*row\.projects\.length\s*\}\}/);
  assert.match(view, /自动合并[^<]*\{\{\s*autoMergeEnabledCount\(row\)\s*\}\}\s*\/\s*\{\{\s*row\.projects\.length\s*\}\}/);
  assert.match(view, />自动合并<\/h3>/);
  assert.match(view, /最低评分/);
  assert.match(view, /目标分支/);
  assert.match(view, /合并方式/);
  assert.match(view, /合并后删除源分支/);
  assert.match(view, /critical[^<]*high[^<]*固定阻断/i);
  assert.match(view, /GitLab[^<]*(审批|CI|冲突|保护分支)/);
});

test("自动合并 UI 使用真实管理员状态，并保护 default、短项目名与未知 meta", () => {
  assert.match(view, /currentIsAdmin/);
  assert.match(view, /const isAdmin = currentIsAdmin\(\)/);
  assert.match(view, /只有管理员可以修改自动合并策略/);
  assert.match(view, /!isAdmin/);
  assert.match(view, /!canEnableAutoMerge\(project\)/);
  assert.match(view, /form\.autoMergeKnown\[projectKey\(project\)\]/);
  assert.match(view, /状态待加载/);
  assert.match(view, /default 是全局兜底[^<]*不绑定项目[^<]*自动合并/);
});

test("非管理员打开含自动合并的 Prompt 时整个表单只读，仍可查看和取消", () => {
  assert.match(view, /const autoMergeProtected = computed\(\(\) => !isAdmin\.value[\s\S]*autoMergePolicies\[projectKey\(project\)\]\?\.enabled/);
  assert.match(view, /<el-form[^>]+:disabled="saving \|\| autoMergeProtected \|\| autoMergeStateUnknown"/);
  assert.match(view, /v-if="autoMergeProtected"[\s\S]{0,240}仅管理员可以修改[\s\S]{0,120}只读/);
  assert.match(view, /:disabled="editorLoading \|\| !detailReady \|\| autoMergeProtected \|\| autoMergeStateUnknown"[^>]*>保存/);
  assert.match(view, /if \(autoMergeProtected\.value \|\| autoMergeStateUnknown\.value\) return/);
  assert.match(view, /@click="requestClose">取消/);
});

test("新增关联立即按 meta 策略进入保护，未知状态也不会让普通账号误保存", () => {
  assert.match(view, /function onProjectsChange\(\): void \{ synchronizeProjectSettings\(form\.value,metaLoaded\.value \? meta\.value\.projectSettings \?\? \[\] : undefined\); \}/);
  assert.match(view, /const autoMergeStateUnknown = computed\(\(\) => !isAdmin\.value[\s\S]*!form\.value\.autoMergeKnown\[projectKey\(project\)\]/);
  assert.match(view, /v-else-if="autoMergeStateUnknown"[\s\S]{0,240}状态尚未加载[\s\S]{0,160}暂时只读/);
});

test("非管理员遇到已启用自动合并或列表未知时，YAML 导入预先禁用并有原因", () => {
  assert.match(view, /const listHasEnabledAutoMerge = computed/);
  assert.match(view, /const yamlImportBlocked = computed\(\(\) => !isAdmin\.value/);
  assert.match(view, /:disabled="yamlImportBlocked"[^>]*>[^<]*<el-icon><Download/);
  assert.match(view, /存在已启用自动合并的项目/);
  assert.match(view, /if \(yamlImportBlocked\.value\)[\s\S]{0,180}ElMessage\.warning/);
});

test("非管理员仍可查看受保护 Prompt，但删除入口会在请求前阻断", () => {
  assert.match(view, /v-if="rowAutoMergeProtected\(row\)"[\s\S]{0,180}仅管理员可以删除/);
  assert.match(view, /function rowAutoMergeProtected\(row: PromptSummary\)/);
  assert.match(view, /if \(rowAutoMergeProtected\(row\)\)[\s\S]{0,160}ElMessage\.warning/);
  assert.match(view, /@click="openEdit\(row\)">编辑/);
});

test("目标分支限制用 default / specified / any 三种明确模式，且不暗示系统改写 MR", () => {
  assert.match(view, /仅项目默认分支（推荐）/);
  assert.match(view, /指定目标分支/);
  assert.match(view, /任意目标分支（危险）/);
  assert.match(view, /系统始终合并到 MR 当前目标分支，不会修改目标；合并身份由本次 Webhook 的 X-Gitlab-Token 所属 GitLab 账号决定。/);
  assert.match(view, /form\.autoMergePolicies\[projectKey\(project\)\]\.targetMode === 'specified'/);
  assert.match(view, /form\.autoMergePolicies\[projectKey\(project\)\]\.targetMode === 'any'[\s\S]{0,300}(危险|所有目标分支)/);
  assert.match(view, /@change="onAutoMergeTargetModeChange\(project, \$event\)"/);
});

test("首次启用、删除源分支或切换任意目标时，保存前汇总二次确认", () => {
  assert.match(view, /summarizeAutoMergeConfirmation/);
  assert.match(view, /enabledProjects/);
  assert.match(view, /removeSourceBranchProjects/);
  assert.match(view, /anyTargetProjects/);
  assert.match(view, /ElMessageBox\.confirm/);
  assert.match(view, /启用自动合并/);
  assert.match(view, /删除源分支/);
  assert.match(view, /允许任意目标分支/);
  assert.match(view, /critical\/high/);
});

test("前端类型声明 camelCase 自动合并响应契约", () => {
  assert.match(types, /export type AutoMergeMethod = "merge" \| "squash"/);
  assert.match(types, /export type AutoMergeTargetMode = "default" \| "specified" \| "any"/);
  assert.match(types, /export interface ProjectAutoMergePolicy[\s\S]*enabled:\s*boolean[\s\S]*minimumScore:\s*number[\s\S]*targetMode\?:\s*AutoMergeTargetMode[\s\S]*targetBranches:\s*string\[\][\s\S]*method:\s*AutoMergeMethod[\s\S]*removeSourceBranch:\s*boolean/);
  assert.match(types, /export interface ProjectReviewSetting[\s\S]*autoMergePolicy\?:\s*ProjectAutoMergePolicy/);
});
