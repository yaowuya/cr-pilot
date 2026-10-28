<template>
  <div class="page-container verify-page">
    <header class="page-header">
      <div>
        <h1 class="page-header__title">功能自检</h1>
        <p class="page-header__desc">不用等真实 MR，直接验证 AI 评审与企微推送两条链路是否可用</p>
      </div>
    </header>

    <div class="verify-workbench">
      <el-card
        shadow="never"
        class="verify-channel"
        aria-labelledby="ai-channel-title"
      >
        <template #header>
          <div class="channel-header">
            <div>
              <h2 id="ai-channel-title" class="channel-title">AI 评审链路</h2>
              <p class="channel-summary">验证模型配置、Prompt 解析与结构化结果</p>
            </div>
            <el-tag size="small" type="info" effect="plain">真实调用</el-tag>
          </div>
        </template>
        <p class="verify-desc">
          使用固定的合成 diff 调用真实模型，检查能否返回评审正文并解析出总分；过程不会写入真实 MR。
        </p>
        <ul class="channel-facts" aria-label="AI 自检范围">
          <li><span class="channel-fact__mark" />读取当前生效的 Prompt 与模型绑定</li>
          <li><span class="channel-fact__mark" />创建隔离会话并执行合成评审</li>
          <li><span class="channel-fact__mark" />异步轮询任务状态与解析结果</li>
        </ul>
        <div class="channel-actions">
          <el-button type="primary" :loading="aiRunning" :disabled="wecomRunning" @click="runAi">
            <el-icon><Cpu /></el-icon>
            开始验证 AI 评审
          </el-button>
          <span>约 1 分钟，会消耗一次模型额度</span>
        </div>

        <div v-if="aiTask" class="verify-result">
          <el-alert :type="resultType(aiTask)" :closable="false" show-icon>
            <template #title>{{ aiTask.message }}</template>
            <div v-if="aiTask.durationMs > 0" class="verify-result__meta">
              耗时 {{ (aiTask.durationMs / 1000).toFixed(1) }} 秒
            </div>
          </el-alert>
          <pre v-if="aiTask.detail" class="verify-result__detail">{{ aiTask.detail }}</pre>
        </div>
      </el-card>

      <el-card
        shadow="never"
        class="verify-channel"
        aria-labelledby="wecom-channel-title"
      >
        <template #header>
          <div class="channel-header">
            <div>
              <h2 id="wecom-channel-title" class="channel-title">企微通知链路</h2>
              <p class="channel-summary">先选择目标与提交人，预览后再确认实发</p>
            </div>
            <el-tag size="small" type="warning" effect="light" class="send-warning">可真实发送</el-tag>
          </div>
        </template>
        <p class="verify-desc">
          组装一条带 <strong>[验证]</strong> 前缀的通知；仅预览不会请求机器人，确认发送才会真正发到群里。
        </p>
        <div class="verify-submitter">
          <label for="verify-bot">企微机器人</label>
          <el-select
            id="verify-bot"
            v-model="webhookId"
            placeholder="请选择要发送到的群机器人"
            :loading="botsLoading"
            :disabled="botsLoading || aiRunning || wecomRunning"
            @change="clearWecomResult"
          >
            <el-option
              v-for="bot in bots"
              :key="bot.id"
              :value="bot.id"
              :label="botLabel(bot)"
            />
          </el-select>
          <p v-if="botsError" class="verify-submitter__hint" role="alert">
            {{ botsError }}
            <el-button link type="primary" :disabled="aiRunning || wecomRunning" @click="loadBots">重试</el-button>
          </p>
          <p v-else-if="botsLoading" class="verify-submitter__hint">正在加载机器人列表…</p>
          <p v-else-if="botsLoaded && bots.length === 0" class="verify-submitter__hint">
            当前生效的数据库 Prompt 或 YAML 规则没有配置企微 webhook。请先到「Prompt 管理」检查项目规则与 default，再检查规则目录。
          </p>
          <p v-else-if="selectedBot" class="verify-submitter__hint">
            将发送到 {{ botLabel(selectedBot) }}；地址由服务端按配置解析，页面不接触完整密钥。
          </p>
        </div>
        <div class="verify-submitter">
          <label for="verify-submitter">测试提交人</label>
          <el-select
            id="verify-submitter"
            v-model="gitlabUsername"
            placeholder="请选择要验证 @ 的提交人"
            filterable
            :loading="contactsLoading"
            :disabled="contactsLoading || aiRunning || wecomRunning"
            @change="clearWecomResult"
          >
            <el-option
              v-for="contact in contacts"
              :key="contact.gitlabUsername"
              :value="contact.gitlabUsername"
              :label="contact.wecomName ? `${contact.wecomName}（${contact.gitlabUsername}）` : contact.gitlabUsername"
            />
          </el-select>
          <p v-if="contactsError" class="verify-submitter__hint" role="alert">
            {{ contactsError }}
            <el-button link type="primary" :disabled="aiRunning || wecomRunning" @click="loadContacts">重试</el-button>
          </p>
          <p v-else-if="contactsLoading" class="verify-submitter__hint">正在加载企微映射…</p>
          <p v-else-if="contactsLoaded && contacts.length === 0" class="verify-submitter__hint">
            暂无提交人映射，请先前往 <router-link to="/wecom-contacts">企微映射</router-link> 登记，然后
            <el-button link type="primary" :disabled="aiRunning || wecomRunning" @click="loadContacts">刷新列表</el-button>。
          </p>
          <p v-else class="verify-submitter__hint">
            {{ selectedContact ? (selectedContact.hasWecomUserId ? '已配置 userid，将验证真实成员提及。' : '未配置 userid，仅显示 @中文名，不触发成员提醒。') : '自检没有真实 MR 作者，请明确选择；不会自动 @ 登录者或其他人。' }}
          </p>
        </div>
        <div class="verify-actions">
          <el-button :loading="wecomRunning" :disabled="aiRunning || !canVerifyWecom" @click="previewWecom">
            <el-icon><View /></el-icon>
            仅预览
          </el-button>
          <el-popconfirm
            :title="sendConfirmation"
            :disabled="aiRunning || wecomRunning || !canVerifyWecom"
            confirm-button-text="确认发送"
            cancel-button-text="取消"
            width="320"
            @confirm="sendWecom"
          >
            <template #reference>
              <el-button class="send-button" type="danger" :loading="wecomRunning" :disabled="aiRunning || !canVerifyWecom">
                <el-icon><Promotion /></el-icon>
                发送验证消息
              </el-button>
            </template>
          </el-popconfirm>
        </div>

        <div v-if="wecomTask" class="verify-result">
          <el-alert :type="resultType(wecomTask)" :closable="false" show-icon>
            <template #title>{{ wecomTask.message }}</template>
            <div v-if="wecomTask.durationMs > 0" class="verify-result__meta">
              耗时 {{ (wecomTask.durationMs / 1000).toFixed(1) }} 秒
            </div>
          </el-alert>
          <pre v-if="wecomTask.detail" class="verify-result__detail">{{ wecomTask.detail }}</pre>
        </div>
      </el-card>
    </div>

    <div class="verify-support-grid">
      <el-card shadow="never" class="support-panel recent-panel">
        <template #header>
          <div class="support-header">
            <div>
              <h2>最近自检</h2>
              <p>仅展示本次页面会话提交的任务，不把结果伪装成持久审计记录。</p>
            </div>
            <span>{{ recentTasks.length }} 条</span>
          </div>
        </template>
        <el-table v-if="recentTasks.length > 0" :data="recentTasks" class="recent-table">
          <el-table-column label="类型" min-width="100">
            <template #default="{ row }">{{ taskKindLabel(row) }}</template>
          </el-table-column>
          <el-table-column label="目标" min-width="170">
            <template #default="{ row }">{{ taskTarget(row) }}</template>
          </el-table-column>
          <el-table-column label="结果" width="90">
            <template #default="{ row }">
              <el-tag size="small" :type="row.status === 'failed' ? 'danger' : resultType(row)" effect="plain">{{ taskStatusLabel(row) }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="耗时" width="90">
            <template #default="{ row }"><span class="num">{{ taskDuration(row) }}</span></template>
          </el-table-column>
          <el-table-column label="开始时间" min-width="150">
            <template #default="{ row }"><span class="num">{{ formatTaskTime(row.startedAt) }}</span></template>
          </el-table-column>
        </el-table>
        <el-empty v-else description="本次页面会话尚未运行自检" :image-size="64" />
      </el-card>

      <el-card shadow="never" class="support-panel safety-panel">
        <template #header>
          <div class="support-header">
            <div>
              <h2>安全说明</h2>
              <p>自检触达真实外部边界，但将写入和敏感信息控制在明确范围内。</p>
            </div>
          </div>
        </template>
        <dl class="safety-list">
          <div>
            <dt>AI 评审</dt>
            <dd>使用合成 diff 调用真实模型，不会写入真实 MR，也不会修改仓库文件。</dd>
          </div>
          <div>
            <dt>企微预览</dt>
            <dd>只组装带 [验证] 前缀的消息，不向群机器人发起请求。</dd>
          </div>
          <div>
            <dt>确认发送</dt>
            <dd>二次确认后才实发；机器人与提交人选择会同时锁定，避免重复操作。</dd>
          </div>
          <div>
            <dt>敏感信息</dt>
            <dd>页面只使用脱敏标识，不接触完整机器人地址或成员 userid。</dd>
          </div>
        </dl>
      </el-card>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 功能自检页：两个按钮分别验证 AI 评审与企微推送。
 *
 * 为什么轮询而不是直接等待：AI 评审约需 1 分钟，同步请求容易被浏览器或代理
 * 超时截断。后端已改为「提交返回任务 ID」，页面按固定间隔查询结果。
 *
 * 同一时间只允许跑一个任务：并发调用会各消耗一次模型额度，结果也会混在一起。
 */
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { ElMessage } from "element-plus";
import { Cpu, Promotion, View } from "@element-plus/icons-vue";
import { api, isApiError } from "../api/client.ts";
import type { VerifyTask, WecomBot, WecomContact } from "../types.ts";

/** 轮询间隔：AI 验证约 1 分钟，2 秒一次足够及时且不打扰后端。 */
const POLL_INTERVAL_MS = 2000;

const aiTask = ref<VerifyTask | null>(null);
const wecomTask = ref<VerifyTask | null>(null);
/** 当前页面会话里的任务，按最近开始时间排序；不伪造服务端不存在的历史记录。 */
const recentTasks = computed<VerifyTask[]>(() =>
  [aiTask.value, wecomTask.value]
    .filter((task): task is VerifyTask => task !== null)
    .sort((left, right) => right.startedAt - left.startedAt),
);
// 在 POST 返回任务 ID 之前也要防重复提交，不能只根据任务状态禁用按钮。
const submitting = ref<"ai" | "wecom" | null>(null);
const bots = ref<WecomBot[]>([]);
const botsLoading = ref(false);
const botsLoaded = ref(false);
const botsError = ref("");
const webhookId = ref("");
const selectedBot = computed(() => bots.value.find((bot) => bot.id === webhookId.value));
const contacts = ref<WecomContact[]>([]);
const contactsLoading = ref(false);
const contactsLoaded = ref(false);
const contactsError = ref("");
const gitlabUsername = ref("");
const selectedContact = computed(() => contacts.value.find((contact) => contact.gitlabUsername === gitlabUsername.value));
const canVerifyWecom = computed(
  () =>
    botsLoaded.value &&
    !botsLoading.value &&
    !botsError.value &&
    Boolean(selectedBot.value) &&
    contactsLoaded.value &&
    !contactsLoading.value &&
    !contactsError.value &&
    Boolean(selectedContact.value),
);
const sendConfirmation = computed(() => {
  const contact = selectedContact.value;
  const name = contact?.wecomName || contact?.gitlabUsername || "未选择提交人";
  const bot = selectedBot.value ? botLabel(selectedBot.value) : "未选择机器人";
  return contact?.hasWecomUserId
    ? `将向「${bot}」发送 [验证] 消息，并真实 @「${name}」。确认发送？`
    : `将向「${bot}」发送 [验证] 消息，末尾仅展示 @${name}，不会触发成员提醒。确认发送？`;
});

/** 机器人下拉文案：脱敏 key + 关联仓库，便于分辨是哪台机器人。 */
function botLabel(bot: WecomBot): string {
  const repo = bot.repositories[0] ?? "未关联仓库";
  const extra = bot.repositories.length > 1 ? ` 等 ${bot.repositories.length} 个仓库` : "";
  return `${bot.maskedKey} · ${repo}${extra}`;
}

/** 加载已配置的机器人；不默认选中，避免误发到不相关的群。 */
async function loadBots(): Promise<void> {
  if (botsLoading.value || disposed) return;
  botsLoading.value = true;
  botsError.value = "";
  try {
    const { items } = await api.get<{ items: WecomBot[] }>("/api/verify/wecom-bots");
    if (disposed) return;
    bots.value = items;
    botsLoaded.value = true;
    if (!items.some((bot) => bot.id === webhookId.value)) webhookId.value = "";
  } catch (error) {
    if (!disposed) botsError.value = isApiError(error) ? error.message : "加载机器人列表失败";
  } finally {
    if (!disposed) botsLoading.value = false;
  }
}
/** 轮询定时器；页面卸载时必须清掉，否则会继续请求已离开的页面。 */
let pollTimer: ReturnType<typeof setInterval> | null = null;
let disposed = false;

const aiRunning = computed(() => submitting.value === "ai" || aiTask.value?.status === "running");
const wecomRunning = computed(() => submitting.value === "wecom" || wecomTask.value?.status === "running");

/** 加载现有企微映射；不默认选择第一条，避免误提醒无关人员。 */
async function loadContacts(): Promise<void> {
  if (contactsLoading.value || disposed) return;
  contactsLoading.value = true;
  contactsError.value = "";
  try {
    const items = await api.get<WecomContact[]>("/api/wecom-contacts");
    if (disposed) return;
    contacts.value = items;
    contactsLoaded.value = true;
    if (!items.some((contact) => contact.gitlabUsername === gitlabUsername.value)) gitlabUsername.value = "";
  } catch (error) {
    if (!disposed) contactsError.value = isApiError(error) ? error.message : "加载企微映射失败";
  } finally {
    if (!disposed) contactsLoading.value = false;
  }
}

/** 换人后清除旧预览，避免用户把前一位成员的结果当成当前选择的验证结果。 */
function clearWecomResult(): void {
  if (!wecomRunning.value) wecomTask.value = null;
}

/** 任务状态映射成 Element Plus 的统一状态语义。 */
function resultType(task: VerifyTask): "success" | "error" | "info" {
  if (task.status === "running") return "info";
  return task.status === "success" ? "success" : "error";
}

function taskKindLabel(task: VerifyTask): string {
  return task.kind === "ai" ? "AI 评审" : "企微通知";
}

function taskTarget(task: VerifyTask): string {
  if (task.kind === "ai") return "当前模型 · 合成 diff";
  const contact = selectedContact.value?.wecomName || selectedContact.value?.gitlabUsername;
  return contact ? `所选机器人 · ${contact}` : "所选机器人与提交人";
}

function taskStatusLabel(task: VerifyTask): string {
  if (task.status === "running") return "运行中";
  return task.status === "success" ? "成功" : "失败";
}

function taskDuration(task: VerifyTask): string {
  return task.durationMs > 0 ? `${(task.durationMs / 1000).toFixed(1)} 秒` : "—";
}

function formatTaskTime(value: number): string {
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

/** 停止轮询。 */
function stopPolling(): void {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

/**
 * 轮询直到两个任务都不在运行。
 *
 * 用单一全局定时器而不是每任务一个：两个按钮本来就互斥，一个定时器足够，
 * 也避免任务结束后定时器泄漏。
 */
function ensurePolling(): void {
  if (pollTimer !== null) return;
  pollTimer = setInterval(async () => {
    const running: { task: VerifyTask; assign: (task: VerifyTask) => void }[] = [];
    if (aiTask.value?.status === "running") {
      running.push({ task: aiTask.value, assign: (task) => { aiTask.value = task; } });
    }
    if (wecomTask.value?.status === "running") {
      running.push({ task: wecomTask.value, assign: (task) => { wecomTask.value = task; } });
    }
    if (running.length === 0) {
      stopPolling();
      return;
    }
    for (const item of running) {
      try {
        const latest = await api.get<VerifyTask>(`/api/verify/tasks/${item.task.id}`);
        if (disposed) return;
        item.assign(latest);
      } catch (error) {
        if (disposed) return;
        // 任务过期（404）时停止该任务的轮询并提示，避免无限重试。
        ElMessage.warning(isApiError(error) ? error.message : "查询验证结果失败");
        item.assign({ ...item.task, status: "failed", message: "查询结果失败或任务已过期" });
      }
    }
    if (aiTask.value?.status !== "running" && wecomTask.value?.status !== "running") stopPolling();
  }, POLL_INTERVAL_MS);
}

/** 提交一个验证任务并把返回的任务设为当前任务。 */
async function submitTask(
  path: string,
  body: unknown,
  assign: (task: VerifyTask) => void,
  label: string,
): Promise<void> {
  if (aiRunning.value || wecomRunning.value || disposed) return;
  const kind = path.includes("wecom") ? "wecom" : "ai";
  submitting.value = kind;
  try {
    const { taskId } = await api.post<{ taskId: string }>(path, body);
    if (disposed) return;
    assign({
      id: taskId,
      kind,
      status: "running",
      message: `${label}执行中…`,
      detail: "",
      durationMs: 0,
      startedAt: Date.now(),
      finishedAt: null,
    });
    ensurePolling();
  } catch (error) {
    if (!disposed) ElMessage.error(isApiError(error) ? error.message : `${label}提交失败`);
  } finally {
    submitting.value = null;
  }
}

function runAi(): void {
  if (aiRunning.value || wecomRunning.value) return;
  aiTask.value = null;
  void submitTask("/api/verify/ai", {}, (task) => { aiTask.value = task; }, "AI 验证");
}

/** 预览与实发使用同一份提交人输入，实际企微身份只在服务端根据映射解析。 */
function submitWecom(confirmSend: boolean): void {
  if (aiRunning.value || wecomRunning.value) return;
  const contact = selectedContact.value;
  const bot = selectedBot.value;
  if (!canVerifyWecom.value || !contact || !bot) {
    ElMessage.warning("请先选择企微机器人与已登记企微映射的测试提交人");
    return;
  }
  wecomTask.value = null;
  void submitTask(
    "/api/verify/wecom",
    { confirmSend, gitlabUsername: contact.gitlabUsername, webhookId: bot.id },
    (task) => { wecomTask.value = task; },
    confirmSend ? "企微发送" : "企微预览",
  );
}

function previewWecom(): void {
  submitWecom(false);
}

function sendWecom(): void {
  submitWecom(true);
}

onMounted(() => {
  void loadBots();
  void loadContacts();
});
onBeforeUnmount(() => {
  disposed = true;
  stopPolling();
});
</script>

<style scoped>
.verify-page {
  min-width: 0;
}

.verify-workbench {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 18px;
  align-items: start;
}

.verify-channel,
.support-panel {
  min-width: 0;
  border-color: var(--el-border-color);
  box-shadow: none; /* taste-skill-ignore: cancel the global resting-card shadow. */
}

.verify-channel:hover,
.support-panel:hover {
  box-shadow: none; /* taste-skill-ignore: resting panels stay flat on hover. */
}

.verify-channel :deep(.el-card__header),
.support-panel :deep(.el-card__header) {
  padding: 17px 19px 14px;
  background-color: var(--el-bg-color);
  border-bottom-color: var(--el-border-color-lighter);
}

.verify-channel :deep(.el-card__body) {
  padding: 18px 20px 20px;
}

.channel-header,
.support-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 14px;
}

.channel-title,
.support-header h2 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  line-height: 22px;
  color: var(--el-text-color-primary);
}

.channel-summary,
.support-header p {
  margin: 5px 0 0;
  font-size: 12px;
  font-weight: 400;
  line-height: 18px;
  color: var(--el-text-color-regular);
}

.support-header > span {
  flex: none;
  font-size: 12px;
  font-weight: 400;
  line-height: 22px;
  color: var(--el-text-color-secondary);
  white-space: nowrap;
}

.verify-desc {
  margin: 0 0 16px;
  font-size: 13px;
  line-height: 1.65;
  color: var(--el-text-color-regular);
}

.channel-facts {
  padding: 0;
  margin: 0 0 18px;
  list-style: none;
  border-top: 1px solid var(--el-border-color-lighter);
}

.channel-facts li {
  display: grid;
  grid-template-columns: 10px minmax(0, 1fr);
  gap: 10px;
  align-items: center;
  min-height: 42px;
  font-size: 12px;
  line-height: 18px;
  color: var(--el-text-color-regular);
  border-bottom: 1px solid var(--el-border-color-lighter);
}

.channel-fact__mark {
  width: 8px;
  height: 8px;
  background-color: var(--el-color-primary);
  border-radius: 50%;
}

.channel-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px 14px;
}

.channel-actions > span {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.verify-submitter {
  display: grid;
  gap: 7px;
  min-width: 0;
  margin-bottom: 14px;
}

.verify-submitter label {
  font-size: 13px;
  font-weight: 500;
  color: var(--el-text-color-primary);
}

.verify-submitter :deep(.el-select) {
  width: 100%;
}

.verify-submitter__hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.55;
  color: var(--el-text-color-secondary);
}

.verify-submitter__hint[role="alert"] {
  color: var(--el-color-danger);
}

.verify-submitter__hint a {
  color: var(--el-color-primary);
}

.verify-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.verify-result {
  margin-top: 16px;
}

.verify-result__meta {
  margin-top: 4px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.verify-result__detail {
  max-height: 260px;
  padding: 12px;
  margin: 8px 0 0;
  overflow: auto;
  font-family: var(--el-font-family-mono, "SFMono-Regular", Consolas, monospace); /* taste-skill-ignore: task output can contain literal code. */
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  background-color: var(--el-fill-color-light);
  border-radius: var(--el-border-radius-small);
}

.verify-support-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.45fr) minmax(280px, 0.85fr);
  gap: 18px;
  align-items: start;
}

.recent-panel :deep(.el-card__body) {
  padding: 0;
}

.recent-panel :deep(.el-table__inner-wrapper::before) {
  display: none;
}

.recent-panel :deep(.el-table th.el-table__cell) {
  background-color: var(--el-bg-color);
}

.num {
  font-variant-numeric: tabular-nums;
}

.safety-panel :deep(.el-card__body) {
  padding: 0;
}

.safety-list {
  margin: 0;
}

.safety-list > div {
  display: grid;
  grid-template-columns: 92px minmax(0, 1fr);
  gap: 12px;
  padding: 14px 18px;
  border-bottom: 1px solid var(--el-border-color-lighter);
}

.safety-list > div:last-child {
  border-bottom: 0;
}

.safety-list dt {
  font-size: 13px;
  font-weight: 600;
  line-height: 20px;
  color: var(--el-text-color-primary);
}

.safety-list dd {
  margin: 0;
  font-size: 12px;
  line-height: 20px;
  color: var(--el-text-color-regular);
}

.send-warning {
  --el-tag-text-color: #6f4700;
  --el-tag-bg-color: #fff6df;
  --el-tag-border-color: #e8c675;
}

:global(html.dark .send-warning) {
  --el-tag-text-color: #f6c453;
  --el-tag-bg-color: #3a2f18;
  --el-tag-border-color: #7a5d21;
}

.send-button.is-disabled,
.send-button.is-disabled:hover {
  color: var(--el-text-color-secondary);
  background: var(--el-fill-color-light);
  border-color: var(--el-border-color);
}

/* 768px 档位给双通道和表格完整宽度，避免侧栏折叠后内容仍横向溢出。 */
@media (max-width: 960px) {
  .verify-workbench {
    grid-template-columns: minmax(0, 1fr);
  }

  .verify-support-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
