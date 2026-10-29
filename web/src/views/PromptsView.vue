<template>
  <div class="page-container prompts-page">
    <header class="page-header">
      <div>
        <h1 class="page-header__title">Prompt 管理</h1>
        <p class="page-header__desc">共享评审规则，按项目配置仓库上下文与安全自动合并；未配置项目沿用 default。</p>
      </div>
      <div class="page-header__actions">
        <el-button :loading="loading" @click="load"><el-icon><Refresh /></el-icon>刷新</el-button>
        <el-tooltip :disabled="!yamlImportBlocked" :content="yamlImportBlockReason" placement="bottom">
          <span class="action-tooltip">
            <el-button :loading="importing" :disabled="yamlImportBlocked" @click="onImport"><el-icon><Download /></el-icon>从 yaml 导入</el-button>
          </span>
        </el-tooltip>
        <el-button type="primary" @click="openCreate"><el-icon><Plus /></el-icon>新建</el-button>
      </div>
    </header>

    <el-alert v-if="loadError" type="error" :closable="false" show-icon>
      <template #title>{{ loadError }}</template>
      <el-button link type="primary" :loading="loading" @click="load">重新加载列表</el-button>
    </el-alert>
    <section class="sheet-panel prompt-ledger" aria-labelledby="prompt-list-title">
      <div class="sheet-panel__head">
        <div>
          <h2 id="prompt-list-title">评审 Prompt</h2>
          <p>名称用于管理；项目关联决定哪些仓库允许评审。</p>
        </div>
        <span class="sheet-panel__meta">{{ prompts.length }} 条</span>
      </div>
      <div class="table-shell">
        <el-table v-loading="loading" :data="prompts" class="prompt-table">
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
          <el-table-column label="项目执行" min-width="190">
            <template #default="{ row }">
              <div class="repository-state">
                <span v-if="row.repository === 'default'" class="cell-muted">全局兜底，不配置项目执行</span>
                <template v-else>
                  <span>仓库上下文 {{ enabledCount(row) }} / {{ row.projects.length }}</span>
                  <span :class="autoMergeEnabledCount(row) ? 'auto-merge-count--enabled' : 'cell-muted'">
                    自动合并 {{ autoMergeEnabledCount(row) }} / {{ row.projects.length }}
                  </span>
                  <span class="cell-muted">{{ row.hasRepositoryStandards ? '已配置仓库规范' : '未填写仓库规范' }}</span>
                </template>
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
              <el-tooltip v-if="rowAutoMergeProtected(row)" content="该 Prompt 关联项目已启用自动合并，仅管理员可以删除" placement="top">
                <span><el-button link type="danger" disabled>删除</el-button></span>
              </el-tooltip>
              <el-popconfirm v-else :title="`删除 ${row.repository}？关联项目将重新匹配规则，最后解绑的项目将关闭仓库上下文。`" @confirm="onDelete(row)">
                <template #reference><el-button link type="danger" :loading="deletingId === row.id" :disabled="deletingId !== null">删除</el-button></template>
              </el-popconfirm>
            </template>
          </el-table-column>
          <template #empty><el-empty :description="loadError ? '列表未加载成功，请重试' : '暂无 Prompt，可新建或从 yaml 导入'" :image-size="90" /></template>
        </el-table>
      </div>
    </section>

    <div class="prompt-overview-grid">
      <section class="sheet-panel coverage-panel" aria-labelledby="coverage-title">
        <div class="sheet-panel__head">
          <div>
            <h2 id="coverage-title">配置覆盖</h2>
            <p>当前 Prompt 关联与执行能力概览。</p>
          </div>
        </div>
        <div class="overview-list">
          <div v-for="item in coverageStats" :key="item.label" class="overview-item">
            <div>
              <strong>{{ item.label }}</strong>
              <span>{{ item.note }}</span>
            </div>
            <b>{{ item.value }}</b>
          </div>
        </div>
      </section>

      <section class="sheet-panel workflow-panel" aria-labelledby="workflow-title">
        <div class="sheet-panel__head">
          <div>
            <h2 id="workflow-title">编辑流程</h2>
            <p>宽编辑器按业务顺序组织，保存时原子提交。</p>
          </div>
        </div>
        <div class="workflow-list">
          <div v-for="item in workflowItems" :key="item.label" class="workflow-item">
            <strong>{{ item.label }}</strong>
            <span>{{ item.note }}</span>
          </div>
        </div>
      </section>
    </div>

    <el-dialog v-model="dialogVisible" :title="editingId === null ? '新建 Prompt' : `编辑 Prompt：${editingName}`"
      class="repository-prompt-dialog" width="min(1080px, calc(100vw - 32px))" top="4vh" destroy-on-close
      :close-on-click-modal="false" :close-on-press-escape="!saving" :show-close="!saving" :before-close="beforeClose" @closed="onClosed">
      <el-skeleton v-if="editorLoading" :rows="9" animated />
      <el-alert v-else-if="detailError" type="error" :closable="false" show-icon>
        <template #title>{{ detailError }}</template><el-button link type="primary" @click="retryEditor">重新加载详情</el-button>
      </el-alert>
      <el-form v-else ref="formRef" :model="form" :rules="formRules" :disabled="saving || autoMergeProtected || autoMergeStateUnknown" label-position="top" @submit.prevent="onSave">
        <el-alert v-if="metaError" type="warning" :closable="false" show-icon class="section-notice">
          <template #title>下拉建议加载失败，已有配置不会清空；新关联项目的仓库上下文与自动合并状态需加载后才能修改。</template>
          <el-button link type="primary" :loading="metaLoading" @click="reloadMeta">重试加载建议</el-button>
        </el-alert>
        <el-alert v-if="autoMergeProtected" type="warning" :closable="false" show-icon class="write-protection-notice"
          title="此 Prompt 关联了已启用自动合并的项目，仅管理员可以修改或删除；当前表单只读，可查看后取消关闭。" />
        <el-alert v-else-if="autoMergeStateUnknown" type="warning" :closable="false" show-icon class="write-protection-notice"
          title="项目自动合并状态尚未加载，普通账号暂时只读；请重试加载建议或取消关闭。" />
        <!-- 名称放在标签页之外：编辑时无论当前哪个分组都可见，改名不依赖切换标签。 -->
        <el-form-item label="名称" prop="repository" class="editor-identity">
          <el-input v-model="form.repository" placeholder="例如通用评审规则" :disabled="editingId !== null && editingName === 'default'" class="name-input" />
          <span v-if="editingName === 'default'" class="cell-muted">default 是全局兜底，名称不可修改</span>
          <span v-else class="cell-muted">可修改；保存后列表名称随之更新</span>
        </el-form-item>
        <el-tabs v-model="activeSection" tab-position="left" class="editor-tabs">
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
              <el-alert v-if="form.repository === 'default'" type="info" :closable="false" show-icon title="default 是全局兜底，不绑定项目，不配置仓库上下文或自动合并。" />
              <template v-else>
                <el-alert v-if="!isAdmin" type="info" :closable="false" show-icon class="section-notice"
                  title="只有管理员可以修改自动合并策略；若关联项目已启用，整份 Prompt 将切换为只读。" />
                <div class="section-heading"><h2>项目执行配置</h2><el-tag size="small" type="info" effect="plain">按项目配置</el-tag></div>
                <p class="section-description">开关保存后对后续评审生效；同一项目在其他 Prompt 中也共享此状态。</p>
                <div v-if="form.projects.length" class="project-settings">
                  <article v-for="project in form.projects" :key="projectKey(project)" class="project-setting">
                    <header class="project-setting__header">
                      <strong>{{ project }}</strong>
                      <el-tag v-if="!canEnableAutoMerge(project)" size="small" type="info" effect="plain">短项目名</el-tag>
                    </header>
                    <div class="project-execution-row">
                      <div class="project-setting__name"><strong>拉取仓库上下文</strong>
                        <span v-if="!canEnableRepositoryContext(project)" class="cell-muted">项目名包含不允许的字符，无法开启</span>
                        <span v-else-if="form.projectStates[projectKey(project)] === undefined" class="cell-muted">状态待加载</span>
                        <span v-else class="cell-muted">{{ form.projectStates[projectKey(project)] ? '读取相关仓库文件辅助评审' : '仅使用本次 diff 评审' }}</span>
                      </div>
                      <el-switch :model-value="form.projectStates[projectKey(project)] === true" :aria-label="`${project} 拉取仓库进行 Review`"
                        :disabled="!canEnableRepositoryContext(project) || form.projectStates[projectKey(project)] === undefined"
                        active-text="开启" inactive-text="关闭" @change="onProjectToggle(project, $event)" />
                    </div>
                    <div class="auto-merge-setting">
                      <div class="project-execution-row">
                        <div class="project-setting__name"><h3>自动合并</h3>
                          <span v-if="!canEnableAutoMerge(project)" class="cell-muted">仅完整 namespace/project 可开启，短项目名不会模糊匹配</span>
                          <span v-else-if="!form.autoMergeKnown[projectKey(project)]" class="cell-muted">状态待加载</span>
                          <span v-else-if="!isAdmin" class="cell-muted">只有管理员可以修改自动合并策略，当前为只读</span>
                          <span v-else class="cell-muted">达到门槛并通过固定安全检查后，由服务端请求 GitLab 合并</span>
                        </div>
                        <el-switch :model-value="form.autoMergePolicies[projectKey(project)].enabled" :aria-label="`${project} 自动合并`"
                          :disabled="!isAdmin || !canEnableAutoMerge(project) || !form.autoMergeKnown[projectKey(project)]"
                          active-text="开启" inactive-text="关闭" @change="onAutoMergeToggle(project, $event)" />
                      </div>
                      <div v-if="form.autoMergeKnown[projectKey(project)] && form.autoMergePolicies[projectKey(project)].enabled" class="auto-merge-fields">
                        <el-form-item label="最低评分">
                          <el-input-number v-model="form.autoMergePolicies[projectKey(project)].minimumScore" :min="1" :max="100" :step="1"
                            :disabled="!isAdmin" controls-position="right" />
                        </el-form-item>
                        <el-alert class="auto-merge-identity" type="info" :closable="false" show-icon
                          title="系统始终合并到 MR 当前目标分支，不会修改目标；合并身份由本次 Webhook 的 X-Gitlab-Token 所属 GitLab 账号决定。" />
                        <el-form-item label="允许的 MR 目标分支" class="auto-merge-fields__mode">
                          <el-radio-group v-model="form.autoMergePolicies[projectKey(project)].targetMode" class="target-mode-grid" :disabled="!isAdmin"
                            @change="onAutoMergeTargetModeChange(project, $event)">
                            <el-radio value="default" border class="target-mode-card">
                              <span class="target-mode-card__copy"><strong>仅项目默认分支（推荐）</strong><small>运行时读取 GitLab 项目的默认分支，仅该目标允许</small></span>
                            </el-radio>
                            <el-radio value="specified" border class="target-mode-card">
                              <span class="target-mode-card__copy"><strong>指定目标分支</strong><small>只允许下方列出的精确分支名</small></span>
                            </el-radio>
                            <el-radio value="any" border class="target-mode-card target-mode-card--danger">
                              <span class="target-mode-card__copy"><strong>任意目标分支（危险）</strong><small>不限制 MR 当前目标分支</small></span>
                            </el-radio>
                          </el-radio-group>
                        </el-form-item>
                        <el-form-item v-if="form.autoMergePolicies[projectKey(project)].targetMode === 'specified'" label="指定目标分支（精确匹配）" class="auto-merge-fields__branches">
                          <el-select v-model="form.autoMergePolicies[projectKey(project)].targetBranches" multiple filterable allow-create default-first-option
                            :reserve-keyword="false" :disabled="!isAdmin" placeholder="输入 main、release 等分支后回车"
                            @change="normalizeAutoMergeBranches(project)">
                            <el-option v-for="branch in form.autoMergePolicies[projectKey(project)].targetBranches" :key="branch" :label="branch" :value="branch" />
                          </el-select>
                        </el-form-item>
                        <el-alert v-else-if="form.autoMergePolicies[projectKey(project)].targetMode === 'any'" class="auto-merge-any-warning" type="error" :closable="false" show-icon
                          title="危险：所有目标分支的 MR 都可能在通过固定安全门后自动合并。请仅在明确接受该范围时使用。" />
                        <el-form-item label="请求合并方式">
                          <el-radio-group v-model="form.autoMergePolicies[projectKey(project)].method" :disabled="!isAdmin">
                            <el-radio-button value="merge">Merge commit</el-radio-button>
                            <el-radio-button value="squash">Squash</el-radio-button>
                          </el-radio-group>
                        </el-form-item>
                        <el-form-item label="源分支处理">
                          <el-switch v-model="form.autoMergePolicies[projectKey(project)].removeSourceBranch" :disabled="!isAdmin" active-text="请求合并后删除源分支" inactive-text="不主动删除源分支" />
                        </el-form-item>
                        <el-alert class="auto-merge-safety" type="warning" :closable="false" show-icon
                          title="critical / high 问题固定阻断自动合并；GitLab 的审批、CI、冲突与保护分支规则仍照常生效。" />
                      </div>
                    </div>
                  </article>
                </div>
                <el-empty v-else description="先关联项目，再配置仓库上下文与自动合并" :image-size="60" />
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
          <el-button type="primary" :loading="saving" :disabled="editorLoading || !detailReady || autoMergeProtected || autoMergeStateUnknown" @click="onSave">保存</el-button>
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
import { currentIsAdmin } from "../stores/auth.ts";
import type { PromptMeta, PromptSummary, StoredPrompt } from "../types.ts";
import { buildPromptPayload, canEnableAutoMerge, canEnableRepositoryContext, createPromptDraft, createRequestGeneration,
  normalizeTargetBranches, projectKey, REPOSITORY_STANDARDS_MAX_LENGTH, summarizeAutoMergeConfirmation,
  synchronizeProjectSettings, validatePromptDraft, type PromptSection } from "./prompt-form.ts";

const isAdmin = currentIsAdmin();
const loading = ref(false), saving = ref(false), importing = ref(false);
const listReady = ref(false);
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
/** 普通账号不能改动任何关联了已启用自动合并项目的 Prompt。 */
const autoMergeProtected = computed(() => !isAdmin.value && form.value.projects.some(project =>
  form.value.autoMergeKnown[projectKey(project)] === true && form.value.autoMergePolicies[projectKey(project)]?.enabled === true));
/** 未取得项目执行状态时同样 fail closed，避免保存后才收到权限 403。 */
const autoMergeStateUnknown = computed(() => !isAdmin.value && form.value.projects.some(project =>
  !form.value.autoMergeKnown[projectKey(project)]));
const listHasEnabledAutoMerge = computed(() => prompts.value.some(prompt =>
  prompt.projectSettings?.some(setting => setting.autoMergePolicy?.enabled) === true));
const yamlImportBlocked = computed(() => !isAdmin.value &&
  (!listReady.value || loading.value || Boolean(loadError.value) || listHasEnabledAutoMerge.value));
const yamlImportBlockReason = computed(() => {
  if (isAdmin.value) return "";
  if (!listReady.value || loading.value) return "Prompt 列表加载完成前暂不允许导入";
  if (loadError.value) return "Prompt 列表加载失败，无法确认自动合并权限";
  if (listHasEnabledAutoMerge.value) return "存在已启用自动合并的项目，只有管理员可以从 YAML 导入";
  return "";
});

/** 覆盖概览按项目名去重，避免同一项目被多条规则重复计数。 */
const coverageStats = computed(() => {
  const projects = new Set<string>();
  const repositoryContextProjects = new Set<string>();
  for (const prompt of prompts.value) {
    if (prompt.repository === "default") continue;
    for (const project of prompt.projects) projects.add(project);
    for (const setting of prompt.projectSettings ?? []) {
      if (setting.repositoryContextEnabled) repositoryContextProjects.add(setting.project);
    }
  }
  return [
    { label: "关联项目", value: projects.size, note: "受非 default 规则覆盖" },
    { label: "仓库上下文", value: repositoryContextProjects.size, note: "已开启拉取仓库" },
    { label: "模型覆盖", value: prompts.value.filter(item => item.providerId || item.model).length, note: "条规则指定厂商或模型" },
    { label: "企微通知", value: prompts.value.filter(item => item.hasWecomWebhook).length, note: "条规则配置低分提醒" },
  ];
});
const workflowItems = [
  { label: "项目与执行", note: "关联项目、仓库上下文与安全自动合并" },
  { label: "评审 Prompt", note: "System Prompt 与 User Prompt" },
  { label: "仓库规范", note: "共享代码规范，最多 32,000 字符" },
  { label: "模型与通知", note: "厂商、模型、企微阈值与机器人" },
] as const;

const requiredText = (_rule: unknown, value: unknown, callback: (error?: Error) => void): void => {
  callback(typeof value === "string" && value.trim() ? undefined : new Error("此项不能为空"));
};
const formRules: FormRules = {
  repository: [{validator:requiredText,trigger:"blur"}], systemPrompt: [{validator:requiredText,trigger:"blur"}], userPrompt: [{validator:requiredText,trigger:"blur"}],
  repositoryStandards: [{max:REPOSITORY_STANDARDS_MAX_LENGTH,message:`最多 ${REPOSITORY_STANDARDS_MAX_LENGTH} 字符`,trigger:"blur"}],
};

function enabledCount(row: PromptSummary): number { return row.projectSettings?.filter(item => item.repositoryContextEnabled).length ?? 0; }
function autoMergeEnabledCount(row: PromptSummary): number { return row.projectSettings?.filter(item => item.autoMergePolicy?.enabled).length ?? 0; }
function rowAutoMergeProtected(row: PromptSummary): boolean { return !isAdmin.value && autoMergeEnabledCount(row) > 0; }
function errorMessage(error: unknown, fallback: string): string { return isApiError(error) ? error.message : fallback; }

/** 请求序号使旧列表响应不能覆盖更晚的刷新/保存结果。 */
async function load(): Promise<void> {
  const request = listGeneration.start(); loading.value = true; loadError.value = "";
  try {
    const result = await api.get<PromptSummary[]>("/api/prompts");
    if (mounted && listGeneration.isCurrent(request)) { prompts.value = result; listReady.value = true; }
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
function onAutoMergeToggle(project: string, value: string | number | boolean): void {
  const key = projectKey(project);
  if (typeof value === "boolean" && isAdmin.value && form.value.autoMergeKnown[key] && canEnableAutoMerge(project)) {
    form.value.autoMergePolicies[key].enabled = value;
  }
}
function normalizeAutoMergeBranches(project: string): void {
  const policy = form.value.autoMergePolicies[projectKey(project)];
  policy.targetBranches = normalizeTargetBranches(policy.targetBranches);
}
function onAutoMergeTargetModeChange(project: string, value: string | number | boolean): void {
  if (!isAdmin.value || (value !== "default" && value !== "specified" && value !== "any")) return;
  const policy = form.value.autoMergePolicies[projectKey(project)];
  policy.targetMode = value;
  if (value !== "specified") policy.targetBranches = [];
}
function onProviderChange(): void { form.value.model = ""; }

/** 高影响能力只在扩大权限时确认，普通门槛调整沿用已有保存确认。 */
async function confirmAutoMergeChanges(): Promise<boolean> {
  const summary = summarizeAutoMergeConfirmation(form.value);
  if (summary.enabledProjects.length === 0 && summary.removeSourceBranchProjects.length === 0 && summary.anyTargetProjects.length === 0) return true;
  const lines: string[] = [];
  if (summary.enabledProjects.length) lines.push(`启用自动合并：${summary.enabledProjects.join("、")}`);
  if (summary.removeSourceBranchProjects.length) lines.push(`请求合并后删除源分支：${summary.removeSourceBranchProjects.join("、")}`);
  if (summary.anyTargetProjects.length) lines.push(`允许任意目标分支（危险）：${summary.anyTargetProjects.join("、")}`);
  lines.push("critical/high 问题仍固定阻断；GitLab 审批、CI、冲突与保护分支规则仍照常生效。");
  try {
    await ElMessageBox.confirm(lines.join("\n"), "确认自动合并策略", {
      confirmButtonText: "确认并保存", cancelButtonText: "返回检查", type: "warning",
    });
    return true;
  } catch {
    return false;
  }
}

/** 保存期间锁定草稿；只有成功响应才关闭，列表刷新失败不误报成保存失败。 */
async function onSave(): Promise<void> {
  if (autoMergeProtected.value || autoMergeStateUnknown.value) return;
  if (saving.value || !detailReady.value || editorLoading.value) return;
  saving.value = true;
  try {
    const errors = validatePromptDraft(form.value);
    if (errors.length) { activeSection.value = errors[0].group; await nextTick(); }
    const valid = await formRef.value?.validate().catch(() => false);
    if (errors.length || !valid) { if (errors.length) ElMessage.warning(errors[0].message); return; }
    if (!(await confirmAutoMergeChanges())) return;
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
  if (rowAutoMergeProtected(row)) { ElMessage.warning("该 Prompt 关联项目已启用自动合并，仅管理员可以删除"); return; }
  if (deletingId.value !== null) return;
  deletingId.value = row.id;
  try { await api.delete(`/api/prompts/${row.id}`); ElMessage.success("已删除，相关项目将重新匹配评审规则"); await load(); }
  catch (error) { ElMessage.error(errorMessage(error,"删除失败")); }
  finally { deletingId.value = null; }
}
async function onImport(): Promise<void> {
  if (yamlImportBlocked.value) { ElMessage.warning(yamlImportBlockReason.value); return; }
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
.prompts-page {
  gap: 18px;
}

.action-tooltip {
  display: inline-flex;
}

.cell-strong {
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.cell-muted {
  color: var(--el-text-color-secondary);
}

.sheet-panel {
  overflow: hidden;
  background-color: var(--el-bg-color);
  border: 1px solid var(--el-border-color-light);
  border-radius: var(--el-border-radius-base);
}

.sheet-panel__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 17px 20px 14px;
  border-bottom: 1px solid var(--el-border-color-lighter);
}

.sheet-panel__head h2 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  line-height: 22px;
  color: var(--el-text-color-primary);
}

.sheet-panel__head p {
  margin: 5px 0 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--el-text-color-secondary);
}

.sheet-panel__meta {
  flex: none;
  font-size: 12px;
  line-height: 22px;
  color: var(--el-text-color-secondary);
  font-variant-numeric: tabular-nums;
}

.table-shell {
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
}

.prompt-table {
  width: 100%;
}

.prompt-table :deep(.el-table__inner-wrapper::before) {
  display: none;
}

.repo-cell,
.project-tags {
  display: flex;
  align-items: center;
  min-width: 0;
  gap: 8px;
}

.repo-cell__icon {
  flex-shrink: 0;
  color: var(--el-text-color-secondary);
}

.project-tags {
  flex-wrap: wrap;
  gap: 4px;
}

.repository-state {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 7px;
  font-size: 13px;
}

.prompt-overview-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 18px;
  align-items: start;
}

.overview-list,
.workflow-list {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 1px;
  background-color: var(--el-border-color-lighter);
}

.overview-item,
.workflow-item {
  min-width: 0;
  min-height: 76px;
  padding: 14px 16px;
  background-color: var(--el-bg-color);
}

.overview-item {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.overview-item div,
.workflow-item {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.overview-item strong,
.workflow-item strong {
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.overview-item span,
.workflow-item span {
  font-size: 12px;
  line-height: 18px;
  color: var(--el-text-color-secondary);
}

.overview-item b {
  flex: none;
  font-size: 22px;
  font-weight: 500;
  line-height: 28px;
  color: var(--el-text-color-primary);
  font-variant-numeric: tabular-nums;
}

.full-width {
  width: 100%;
}

.name-input {
  max-width: 480px;
}

.section-notice,
.write-protection-notice {
  margin-bottom: 16px;
}

.editor-identity {
  padding: 16px 18px 10px;
  margin-bottom: 18px;
  background-color: var(--el-fill-color-light);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: var(--el-border-radius-base);
}

.editor-identity :deep(.el-form-item__content) {
  gap: 8px 12px;
}

.editor-tabs {
  min-height: 430px;
}

.editor-tabs :deep(.el-tabs__header.is-left) {
  width: 152px;
  padding: 8px;
  margin-right: 24px;
  background-color: var(--el-fill-color-light);
  border-radius: var(--el-border-radius-base);
}

.editor-tabs :deep(.el-tabs__nav-wrap.is-left::after) {
  display: none;
}

.editor-tabs :deep(.el-tabs__active-bar.is-left) {
  display: none;
}

.editor-tabs :deep(.el-tabs__item.is-left) {
  justify-content: flex-start;
  height: 42px;
  padding: 0 12px;
  text-align: left;
  border-radius: var(--el-border-radius-small);
}

.editor-tabs :deep(.el-tabs__item.is-left.is-active) {
  color: var(--el-text-color-primary);
  background-color: var(--el-bg-color);
}

.editor-tabs :deep(.el-tabs__content) {
  min-width: 0;
  overflow: visible;
}

.editor-section {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.section-heading {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.section-heading h2 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.section-description {
  margin: 0 0 16px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--el-text-color-secondary);
}

.editor-section .section-description {
  margin-bottom: 0;
}

/* Element Plus 的 info 浅色默认值不跟随本项目 dark token；仅在本编辑区复用现有主题填充。 */
.editor-section :deep(.el-alert--info.is-light) {
  color: var(--el-text-color-regular);
  background-color: var(--el-fill-color-light);
}

.project-settings {
  border: 1px solid var(--el-border-color-light);
  border-radius: var(--el-border-radius-base);
}

.project-setting {
  padding: 16px;
}

.project-setting + .project-setting {
  border-top: 1px solid var(--el-border-color-light);
}

.project-setting__header,
.project-execution-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.project-setting__header {
  align-items: center;
  padding-bottom: 14px;
  font-size: 13px;
  overflow-wrap: anywhere;
}

.project-setting__name {
  display: flex;
  flex-direction: column;
  min-width: 0;
  gap: 6px;
  overflow-wrap: anywhere;
  font-size: 13px;
}

.project-setting__name h3 {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.project-setting :deep(.el-switch) {
  flex-shrink: 0;
}

.auto-merge-setting {
  padding-top: 14px;
  margin-top: 14px;
  border-top: 1px solid var(--el-border-color-lighter);
}

.auto-merge-fields {
  display: grid;
  grid-template-columns: minmax(160px, 0.7fr) minmax(240px, 1.3fr);
  gap: 14px 18px;
  padding: 16px;
  margin-top: 14px;
  background-color: var(--el-fill-color-light);
  border-radius: var(--el-border-radius-base);
}

.auto-merge-fields :deep(.el-form-item) {
  margin-bottom: 0;
}

.auto-merge-fields :deep(.el-select),
.auto-merge-fields :deep(.el-input-number) {
  width: 100%;
}

.auto-merge-identity,
.auto-merge-fields__mode,
.auto-merge-fields__branches,
.auto-merge-any-warning,
.auto-merge-safety {
  grid-column: 1 / -1;
}

.target-mode-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
  width: 100%;
}

.target-mode-card {
  width: 100%;
  height: auto;
  min-height: 68px;
  padding: 12px;
  margin: 0;
  align-items: flex-start;
}

.target-mode-card :deep(.el-radio__label) {
  min-width: 0;
  padding-left: 8px;
  white-space: normal;
}

.target-mode-card__copy {
  display: flex;
  flex-direction: column;
  gap: 4px;
  line-height: 1.35;
}

.target-mode-card__copy strong {
  color: var(--el-text-color-primary);
}

.target-mode-card__copy small {
  color: var(--el-text-color-secondary);
}

.target-mode-card--danger :deep(.el-radio__label strong) {
  color: var(--el-color-danger);
}

.auto-merge-count--enabled {
  color: var(--el-color-success);
  font-weight: 600;
}

.standards-textarea :deep(textarea) {
  font-size: 13px;
  line-height: 1.6;
}

.editor-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  font-size: 13px;
}

:global(.repository-prompt-dialog.el-dialog) {
  display: flex;
  flex-direction: column;
  max-height: 92vh;
  margin-bottom: 0;
  overflow: hidden;
  border: 1px solid var(--el-border-color-light);
  border-radius: 12px;
}

:global(.repository-prompt-dialog .el-dialog__header) {
  padding: 18px 22px;
  margin-right: 0;
  border-bottom: 1px solid var(--el-border-color-lighter);
}

:global(.repository-prompt-dialog .el-dialog__body) {
  min-height: 0;
  padding: 18px 22px 20px;
  overflow-y: auto;
}

:global(.repository-prompt-dialog .el-dialog__footer) {
  flex-shrink: 0;
  padding: 14px 22px;
  background-color: var(--el-fill-color-light);
  border-top: 1px solid var(--el-border-color-lighter);
}

@media (max-width: 900px) {
  .prompt-overview-grid {
    grid-template-columns: 1fr;
  }

  .editor-tabs :deep(.el-tabs__header.is-left) {
    width: 132px;
    margin-right: 16px;
  }

  .auto-merge-fields {
    grid-template-columns: 1fr;
  }

  .target-mode-grid {
    grid-template-columns: 1fr;
  }

  .auto-merge-identity,
  .auto-merge-fields__mode,
  .auto-merge-fields__branches,
  .auto-merge-any-warning,
  .auto-merge-safety {
    grid-column: auto;
  }
}

@media (max-width: 768px) {
  .prompts-page .page-header {
    flex-direction: column;
  }

  .prompts-page .page-header__actions {
    flex-wrap: wrap;
  }

  .overview-list,
  .workflow-list {
    grid-template-columns: 1fr 1fr;
  }

  .project-execution-row {
    flex-wrap: wrap;
  }

  .editor-footer {
    flex-wrap: wrap;
    align-items: flex-end;
  }
}
</style>
