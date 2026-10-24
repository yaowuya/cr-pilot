<template>
  <div class="page-container prompts-page">
    <header class="page-header">
      <div>
        <h1 class="page-header__title">Prompt 管理</h1>
        <p class="page-header__desc">共享评审规则，按项目选择是否读取仓库上下文。未配置项目沿用 default。</p>
      </div>
      <div class="page-header__actions">
        <el-button :loading="loading" @click="load"><el-icon><Refresh /></el-icon>刷新</el-button>
        <el-button :loading="importing" @click="onImport"><el-icon><Download /></el-icon>从 yaml 导入</el-button>
        <el-button type="primary" @click="openCreate"><el-icon><Plus /></el-icon>新建</el-button>
      </div>
    </header>

    <el-alert v-if="loadError" type="error" :closable="false" show-icon>
      <template #title>{{ loadError }}</template>
      <el-button link type="primary" :loading="loading" @click="load">重新加载列表</el-button>
    </el-alert>
    <el-card>
      <el-table v-loading="loading" :data="prompts">
        <el-table-column label="名称" min-width="160" show-overflow-tooltip>
          <template #default="{ row }">
            <div class="repo-cell">
              <el-icon class="repo-cell__icon"><Folder /></el-icon>
              <span class="cell-strong">{{ row.repository }}</span>
              <el-tag v-if="row.repository === 'default'" size="small" type="warning" effect="plain">默认</el-tag>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="关联项目" min-width="220">
          <template #default="{ row }">
            <span v-if="row.repository === 'default'" class="cell-muted">全局兜底，不绑定项目</span>
            <span v-else-if="row.projects.length === 0" class="cell-muted">未关联项目</span>
            <div v-else class="project-tags">
              <el-tag v-for="project in row.projects.slice(0, 3)" :key="project" size="small" effect="plain">{{ project }}</el-tag>
              <el-tooltip v-if="row.projects.length > 3" :content="row.projects.slice(3).join('、')">
                <el-tag size="small" type="info" effect="plain">+{{ row.projects.length - 3 }}</el-tag>
              </el-tooltip>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="仓库上下文" min-width="160">
          <template #default="{ row }">
            <div class="repository-state">
              <el-tag :type="enabledCount(row) ? 'success' : 'info'" size="small" effect="light">
                {{ row.repository === 'default' ? '不自动开启' : enabledCount(row) ? `已开启 ${enabledCount(row)} / ${row.projects.length}` : '未开启' }}
              </el-tag>
              <span class="cell-muted">{{ row.hasRepositoryStandards ? '已配置仓库规范' : '未填写仓库规范' }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="模型" min-width="160" show-overflow-tooltip>
          <template #default="{ row }">
            <span v-if="!row.providerId" class="cell-muted">跟随全局默认</span>
            <span v-else-if="!row.providerLabel" class="cell-muted">厂商已删除</span>
            <span v-else>{{ row.providerLabel }} / {{ row.model ?? '默认模型' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="企微推送" width="100">
          <template #default="{ row }"><el-tag :type="row.hasWecomWebhook ? 'success' : 'info'" size="small">{{ row.hasWecomWebhook ? '已配置' : '未配置' }}</el-tag></template>
        </el-table-column>
        <el-table-column label="更新时间" width="170">
          <template #default="{ row }"><span class="cell-muted">{{ formatTime(row.updatedAt) }}</span></template>
        </el-table-column>
        <el-table-column label="操作" width="160" fixed="right">
          <template #default="{ row }">
            <!-- 一个入口即可：名称、项目开关、Prompt、规范、模型都在同一个弹窗内分区编辑，
                 分成「仓库设置」和「编辑」只是重复入口，容易让用户以为保存范围不同。 -->
            <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
            <el-popconfirm :title="`删除 ${row.repository}？关联项目将重新匹配规则，最后解绑的项目将关闭仓库上下文。`" @confirm="onDelete(row)">
              <template #reference><el-button link type="danger" :loading="deletingId === row.id" :disabled="deletingId !== null">删除</el-button></template>
            </el-popconfirm>
          </template>
        </el-table-column>
        <template #empty><el-empty :description="loadError ? '列表未加载成功，请重试' : '暂无 Prompt，可新建或从 yaml 导入'" :image-size="90" /></template>
      </el-table>
    </el-card>

    <el-dialog v-model="dialogVisible" :title="editingId === null ? '新建 Prompt' : `编辑 Prompt：${editingName}`"
      class="repository-prompt-dialog" width="min(900px, calc(100vw - 32px))" top="5vh" destroy-on-close
      :close-on-click-modal="false" :close-on-press-escape="!saving" :show-close="!saving" :before-close="beforeClose" @closed="onClosed">
      <el-skeleton v-if="editorLoading" :rows="9" animated />
      <el-alert v-else-if="detailError" type="error" :closable="false" show-icon>
        <template #title>{{ detailError }}</template><el-button link type="primary" @click="retryEditor">重新加载详情</el-button>
      </el-alert>
      <el-form v-else ref="formRef" :model="form" :rules="formRules" :disabled="saving" label-position="top" @submit.prevent="onSave">
        <el-alert v-if="metaError" type="warning" :closable="false" show-icon class="section-notice">
          <template #title>下拉建议加载失败，已有配置不会清空；新关联的仓库开关需加载状态后才能修改。</template>
          <el-button link type="primary" :loading="metaLoading" @click="reloadMeta">重试加载建议</el-button>
        </el-alert>
        <!-- 名称放在标签页之外：编辑时无论当前哪个分组都可见，改名不依赖切换标签。 -->
        <el-form-item label="名称" prop="repository">
          <el-input v-model="form.repository" placeholder="例如通用评审规则" :disabled="editingId !== null && editingName === 'default'" class="name-input" />
          <span v-if="editingName === 'default'" class="cell-muted">default 是全局兜底，名称不可修改</span>
          <span v-else class="cell-muted">可修改；保存后列表名称随之更新</span>
        </el-form-item>
        <el-tabs v-model="activeSection">
          <el-tab-pane label="项目与执行" name="projects">
            <section class="editor-section">
              <el-row :gutter="16">
                <el-col :xs="24" :sm="14"><el-form-item label="关联项目（可多选）" prop="projects">
                  <el-select v-model="form.projects" multiple filterable allow-create default-first-option :reserve-keyword="false" class="full-width"
                    placeholder="选择或输入项目名（如 group/project 或 auto-ops）后回车" :disabled="form.repository === 'default'" @change="onProjectsChange">
                    <el-option v-for="project in meta.projects" :key="project" :label="project" :value="project" />
                  </el-select>
                </el-form-item></el-col>
              </el-row>
              <el-alert v-if="form.repository === 'default'" type="info" :closable="false" show-icon title="default 是全局兜底，不绑定项目，也不会自动为未配置项目开启仓库拉取。" />
              <template v-else>
                <div class="section-heading"><h2>拉取仓库进行 Review</h2><el-tag size="small" type="info" effect="plain">按项目配置</el-tag></div>
                <p class="section-description">开关保存后对后续评审生效；同一项目在其他 Prompt 中也共享此状态。</p>
                <div v-if="form.projects.length" class="project-settings">
                  <div v-for="project in form.projects" :key="projectKey(project)" class="project-setting">
                    <div class="project-setting__name"><strong>{{ project }}</strong>
                      <span v-if="!canEnableRepositoryContext(project)" class="cell-muted">项目名包含不允许的字符，无法开启</span>
                      <span v-else-if="form.projectStates[projectKey(project)] === undefined" class="cell-muted">状态待加载</span>
                      <span v-else class="cell-muted">{{ form.projectStates[projectKey(project)] ? '读取相关仓库文件辅助评审' : '仅使用本次 diff 评审' }}</span>
                    </div>
                    <el-switch :model-value="form.projectStates[projectKey(project)] === true" :aria-label="`${project} 拉取仓库进行 Review`"
                      :disabled="!canEnableRepositoryContext(project) || form.projectStates[projectKey(project)] === undefined"
                      active-text="开启" inactive-text="关闭" @change="onProjectToggle(project, $event)" />
                  </div>
                </div>
                <el-empty v-else description="先关联项目，再选择是否拉取仓库" :image-size="60" />
                <el-alert type="info" :closable="false" show-icon title="短项目名按路径结尾匹配（如 auto-ops 匹配 group/auto-ops），精确或更长的关联优先；实际仓库地址始终由本次 MR 的源项目确定。需要任务 GitLab token 具备仓库读取权限，采用单分支浅克隆，只读相关上下文，不执行代码；拉取失败、超时或版本不可用将终止本次评审。" />
              </template>
            </section>
          </el-tab-pane>
          <el-tab-pane label="评审 Prompt" name="prompt">
            <p class="section-description">定义评审角色和本次变更的输入模板。整个仓库的约束请放在独立的「仓库规范」中。</p>
            <PromptEditor v-model:system-prompt="form.systemPrompt" v-model:user-prompt="form.userPrompt" />
          </el-tab-pane>
          <el-tab-pane label="仓库规范" name="standards">
            <section class="editor-section">
              <el-alert type="info" :closable="false" show-icon title="关联项目共享 · 选填。仅对已开启仓库上下文的项目生效，留空仍可评审；关闭开关不会删除规范。" />
              <el-form-item label="仓库代码规范" prop="repositoryStandards">
                <el-input v-model="form.repositoryStandards" type="textarea" :rows="9" resize="vertical" class="standards-textarea"
                  :maxlength="REPOSITORY_STANDARDS_MAX_LENGTH" show-word-limit
                  placeholder="建议描述整个仓库：架构与模块边界、命名约定、接口契约、数据与事务、安全权限、日志、测试和性能要求。" />
              </el-form-item>
              <p class="section-description">规范不会覆盖 System/User Prompt。评审仍聚焦本次 MR，不扫描无关历史问题。</p>
            </section>
          </el-tab-pane>
          <el-tab-pane label="模型与通知" name="delivery">
            <p class="section-description">以下配置由本条 Prompt 的关联项目共享，优先级及通知规则保持不变。</p>
            <el-row :gutter="16">
              <el-col :xs="24" :sm="10"><el-form-item label="LLM 厂商（可选）">
                <el-select v-model="form.providerId" clearable placeholder="跟随全局默认厂商" class="full-width" @change="onProviderChange">
                  <el-option v-if="form.providerId && !providerOptions.some(item => item.id === form.providerId)" :value="form.providerId" :label="`当前厂商 #${form.providerId}（建议未加载或已删除）`" />
                  <el-option v-for="provider in providerOptions" :key="provider.id" :value="provider.id" :label="provider.isDefault ? `${provider.label}（全局默认）` : provider.label" />
                </el-select>
              </el-form-item></el-col>
              <el-col :xs="24" :sm="7"><el-form-item label="模型（可选）"><el-select v-model="form.model" clearable :disabled="!form.providerId" placeholder="跟随厂商默认" class="full-width"><el-option v-for="model in modelOptions" :key="model" :label="model" :value="model" /></el-select></el-form-item></el-col>
              <el-col :xs="24" :sm="7"><el-form-item label="企微评分阈值（可选）"><el-input v-model="form.wecomScoreThreshold" placeholder="低于该值才推送，如 70" /></el-form-item></el-col>
            </el-row>
            <el-form-item label="企微 Webhook（可选）"><el-input v-model="form.wecomWebhookUrl" placeholder="企业微信群机器人 Webhook URL" /></el-form-item>
          </el-tab-pane>
        </el-tabs>
      </el-form>
      <template #footer>
        <div class="editor-footer"><span class="cell-muted">更改仅影响后续开始的评审</span><div>
          <el-button :disabled="saving" @click="requestClose">取消</el-button>
          <el-button type="primary" :loading="saving" :disabled="editorLoading || !detailReady" @click="onSave">保存</el-button>
        </div></div>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
/** Prompt 配置页：共享规则与项目执行方式分离，所有编辑在一个草稿内原子保存。 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from "element-plus";
import { Download, Folder, Plus, Refresh } from "@element-plus/icons-vue";
import PromptEditor from "../components/PromptEditor.vue";
import { api, isApiError } from "../api/client.ts";
import type { PromptMeta, PromptSummary, StoredPrompt } from "../types.ts";
import { buildPromptPayload, canEnableRepositoryContext, createPromptDraft, createRequestGeneration, projectKey,
  REPOSITORY_STANDARDS_MAX_LENGTH, synchronizeProjectSettings, validatePromptDraft, type PromptSection } from "./prompt-form.ts";

const loading = ref(false), saving = ref(false), importing = ref(false);
const loadError = ref(""), detailError = ref(""), metaError = ref(false);
const prompts = ref<PromptSummary[]>([]);
const dialogVisible = ref(false), editorLoading = ref(false), detailReady = ref(false), metaLoading = ref(false);
const editingId = ref<number | null>(null), editingName = ref("");
const editingRow = ref<PromptSummary>();
const activeSection = ref<PromptSection>("projects");
const form = ref(createPromptDraft());
const formRef = ref<FormInstance>();
const meta = ref<PromptMeta>({ projects: [], providers: [] });
const metaLoaded = ref(false), baseline = ref("");
const deletingId = ref<number | null>(null);
const listGeneration = createRequestGeneration(), editorGeneration = createRequestGeneration(), metaGeneration = createRequestGeneration();
let currentEditorRequest = 0;
let mounted = true;
const dirty = computed(() => JSON.stringify(buildPromptPayload(form.value)) !== baseline.value);
const providerOptions = computed(() => meta.value.providers);
const modelOptions = computed(() => {
  const models = meta.value.providers.find(item => item.id === form.value.providerId)?.models ?? [];
  return form.value.model && !models.includes(form.value.model) ? [form.value.model, ...models] : models;
});
const requiredText = (_rule: unknown, value: unknown, callback: (error?: Error) => void): void => {
  callback(typeof value === "string" && value.trim() ? undefined : new Error("此项不能为空"));
};
const formRules: FormRules = {
  repository: [{validator:requiredText,trigger:"blur"}], systemPrompt: [{validator:requiredText,trigger:"blur"}], userPrompt: [{validator:requiredText,trigger:"blur"}],
  repositoryStandards: [{max:REPOSITORY_STANDARDS_MAX_LENGTH,message:`最多 ${REPOSITORY_STANDARDS_MAX_LENGTH} 字符`,trigger:"blur"}],
};

function enabledCount(row: PromptSummary): number { return row.projectSettings?.filter(item => item.repositoryContextEnabled).length ?? 0; }
function errorMessage(error: unknown, fallback: string): string { return isApiError(error) ? error.message : fallback; }

/** 请求序号使旧列表响应不能覆盖更晚的刷新/保存结果。 */
async function load(): Promise<void> {
  const request = listGeneration.start(); loading.value = true; loadError.value = "";
  try {
    const result = await api.get<PromptSummary[]>("/api/prompts");
    if (mounted && listGeneration.isCurrent(request)) prompts.value = result;
  } catch (error) {
    if (mounted && listGeneration.isCurrent(request)) loadError.value = errorMessage(error,"加载 Prompt 列表失败");
  } finally { if (mounted && listGeneration.isCurrent(request)) loading.value = false; }
}

/** 打开后同时加载详情/建议；未加载成功的默认表单绝不允许保存。 */
async function openEditor(row: PromptSummary | undefined, section: PromptSection): Promise<void> {
  if (saving.value) return;
  const request = editorGeneration.start(); currentEditorRequest = request; metaGeneration.invalidate(); metaLoading.value = false;
  editingRow.value = row; editingId.value = row?.id ?? null; editingName.value = row?.repository ?? "";
  // 编辑已有记录时默认停在第一个标签，名称与关联项目最先可见；打开后可按需切换其余分组。
  activeSection.value = row === undefined ? section : "projects";
  form.value = createPromptDraft(); baseline.value = JSON.stringify(buildPromptPayload(form.value));
  detailError.value = ""; metaError.value = false; metaLoaded.value = false; detailReady.value = false;
  editorLoading.value = true; dialogVisible.value = true;
  const [detail, suggestions] = await Promise.allSettled([
    row ? api.get<StoredPrompt>(`/api/prompts/${row.id}`) : Promise.resolve(undefined), api.get<PromptMeta>("/api/prompts/meta"),
  ]);
  if (!mounted || !dialogVisible.value || !editorGeneration.isCurrent(request)) return;
  if (detail.status === "rejected") detailError.value = errorMessage(detail.reason,"加载 Prompt 详情失败");
  else { form.value = createPromptDraft(detail.value); detailReady.value = true; }
  if (suggestions.status === "fulfilled") { meta.value = suggestions.value; metaLoaded.value = true; }
  else { meta.value = {projects:[],providers:[]}; metaError.value = true; }
  baseline.value = JSON.stringify(buildPromptPayload(form.value)); editorLoading.value = false;
}
function openCreate(): void { void openEditor(undefined,"projects"); }
function openEdit(row: PromptSummary): void { void openEditor(row,"projects"); }
function retryEditor(): void { void openEditor(editingRow.value,activeSection.value); }

/** 建议重试只能初始化未知状态，不能覆盖用户已改的项目开关/正文。 */
async function reloadMeta(): Promise<void> {
  if (metaLoading.value) return;
  const request = metaGeneration.start(), editor = currentEditorRequest; metaLoading.value = true;
  try {
    const result = await api.get<PromptMeta>("/api/prompts/meta");
    if (!mounted || !dialogVisible.value || !editorGeneration.isCurrent(editor) || !metaGeneration.isCurrent(request)) return;
    meta.value = result; metaLoaded.value = true; metaError.value = false;
    synchronizeProjectSettings(form.value, result.projectSettings ?? []);
  } catch { if (mounted && editorGeneration.isCurrent(editor)) metaError.value = true; }
  finally { if (metaGeneration.isCurrent(request)) metaLoading.value = false; }
}
function onProjectsChange(): void { synchronizeProjectSettings(form.value,metaLoaded.value ? meta.value.projectSettings ?? [] : undefined); }
function onProjectToggle(project: string, value: string | number | boolean): void { if (typeof value === "boolean") form.value.projectStates[projectKey(project)] = value; }
function onProviderChange(): void { form.value.model = ""; }

/** 保存期间锁定草稿；只有成功响应才关闭，列表刷新失败不误报成保存失败。 */
async function onSave(): Promise<void> {
  if (saving.value || !detailReady.value || editorLoading.value) return;
  saving.value = true;
  try {
    const errors = validatePromptDraft(form.value);
    if (errors.length) { activeSection.value = errors[0].group; await nextTick(); }
    const valid = await formRef.value?.validate().catch(() => false);
    if (errors.length || !valid) { if (errors.length) ElMessage.warning(errors[0].message); return; }
    const payload = buildPromptPayload(form.value);
    if (editingId.value === null) await api.post("/api/prompts",payload);
    else await api.put(`/api/prompts/${editingId.value}`,payload);
    baseline.value = JSON.stringify(payload); dialogVisible.value = false;
    ElMessage.success("已保存，下一次评审使用新配置");
    await load();
    if (loadError.value) ElMessage.warning("保存成功，但列表刷新失败，请重试刷新");
  } catch (error) { ElMessage.error(errorMessage(error,"保存失败，输入已保留")); }
  finally { saving.value = false; }
}

async function beforeClose(done: () => void): Promise<void> {
  if (saving.value) return;
  if (detailReady.value && dirty.value) {
    try { await ElMessageBox.confirm("有未保存的配置，关闭会放弃这些修改。", "放弃修改？", {confirmButtonText:"放弃修改",cancelButtonText:"继续编辑",type:"warning"}); }
    catch { return; }
  }
  editorGeneration.invalidate(); metaGeneration.invalidate(); metaLoading.value = false; done();
}
function requestClose(): void { void beforeClose(() => {dialogVisible.value = false;}); }
function onClosed(): void {
  // 旧关闭动画结束时可能已经打开另一项，不能让其 closed 事件取消新的编辑请求。
  if (!dialogVisible.value) { editorGeneration.invalidate(); metaGeneration.invalidate(); metaLoading.value = false; }
}

async function onDelete(row: PromptSummary): Promise<void> {
  if (deletingId.value !== null) return;
  deletingId.value = row.id;
  try { await api.delete(`/api/prompts/${row.id}`); ElMessage.success("已删除，相关项目将重新匹配评审规则"); await load(); }
  catch (error) { ElMessage.error(errorMessage(error,"删除失败")); }
  finally { deletingId.value = null; }
}
async function onImport(): Promise<void> {
  if (importing.value) return;
  importing.value = true;
  try {
    const result = await api.post<{imported:number;skipped:number}>("/api/prompts/import");
    ElMessage.success(`导入完成：新增 ${result.imported} 条，跳过 ${result.skipped} 条`); await load();
  } catch (error) { ElMessage.error(errorMessage(error,"导入失败")); }
  finally { importing.value = false; }
}
function formatTime(value: number): string { return new Date(value).toLocaleString("zh-CN",{hour12:false}); }
onMounted(() => { void load(); });
onBeforeUnmount(() => { mounted = false; listGeneration.invalidate(); editorGeneration.invalidate(); metaGeneration.invalidate(); });
</script>

<style scoped>
.cell-strong { font-weight: 500; color: var(--el-text-color-primary); }
.cell-muted { color: var(--el-text-color-secondary); }
.repo-cell, .project-tags { display: flex; align-items: center; gap: 8px; min-width: 0; }
.repo-cell__icon { flex-shrink: 0; color: var(--el-color-primary); }
.project-tags { flex-wrap: wrap; gap: 4px; }
.repository-state { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; font-size: 13px; }
.full-width { width: 100%; }
.name-input { max-width: 420px; }
.section-notice { margin-bottom: 16px; }
.editor-section { display: flex; flex-direction: column; gap: 16px; }
.section-heading { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.section-heading h2 { margin: 0; font-size: 14px; font-weight: 600; color: var(--el-text-color-primary); }
.section-description { margin: 0 0 16px; color: var(--el-text-color-secondary); font-size: 13px; line-height: 1.6; }
.editor-section .section-description { margin-bottom: 0; }
/* Element Plus 的 info 浅色默认值不跟随本项目 dark token；仅在本编辑区复用现有主题填充。 */
.editor-section :deep(.el-alert--info.is-light) { background-color: var(--el-fill-color-light); color: var(--el-text-color-regular); }
.project-settings { border: 1px solid var(--el-border-color-light); border-radius: var(--el-border-radius-base); }
.project-setting { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 16px; }
.project-setting + .project-setting { border-top: 1px solid var(--el-border-color-light); }
.project-setting__name { display: flex; flex-direction: column; gap: 8px; min-width: 0; font-size: 13px; overflow-wrap: anywhere; }
.project-setting :deep(.el-switch) { flex-shrink: 0; }
.standards-textarea :deep(textarea) { font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace; font-size: 13px; line-height: 1.6; }
.editor-footer { display: flex; align-items: center; justify-content: space-between; gap: 16px; font-size: 13px; }
:global(.repository-prompt-dialog) { display: flex; flex-direction: column; max-height: 90vh; margin-bottom: 0; }
:global(.repository-prompt-dialog .el-dialog__body) { min-height: 0; overflow-y: auto; }
:global(.repository-prompt-dialog .el-dialog__footer) { flex-shrink: 0; }
@media (max-width: 768px) {
  .prompts-page .page-header { flex-direction: column; }
  .prompts-page .page-header__actions { flex-wrap: wrap; }
  .project-setting { flex-wrap: wrap; }
  .editor-footer { align-items: flex-end; flex-wrap: wrap; }
}
</style>
