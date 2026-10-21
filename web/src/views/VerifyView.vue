<template>
  <div class="page-container">
    <header class="page-header">
      <div>
        <h1 class="page-header__title">功能自检</h1>
        <p class="page-header__desc">不用等真实 MR，直接验证 AI 评审与企微推送两条链路是否可用</p>
      </div>
    </header>

    <el-alert type="info" :closable="false" show-icon>
      <template #title>
        AI 验证会真实调用一次模型（约 1 分钟，消耗额度）；企微验证默认只预览，确认后才真的发到群里。
      </template>
    </el-alert>

    <div class="verify-grid">
      <!-- AI 评审验证 -->
      <el-card>
        <template #header>
          <div class="card-header">
            <span>验证 AI 评审</span>
            <el-tag size="small" type="info" effect="plain">真实调用模型</el-tag>
          </div>
        </template>
        <p class="verify-desc">
          用一段固定样例 diff 调用真实模型，检查能否返回评审正文并解析出总分。
          样例包含 SQL 注入、硬编码密钥、N+1 查询三类典型问题。
        </p>
        <el-button type="primary" :loading="aiRunning" :disabled="wecomRunning" @click="runAi">
          <el-icon><Cpu /></el-icon>
          开始验证 AI 评审
        </el-button>

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

      <!-- 企微推送验证 -->
      <el-card>
        <template #header>
          <div class="card-header">
            <span>验证企微推送</span>
            <el-tag size="small" type="warning" effect="plain">会发群消息</el-tag>
          </div>
        </template>
        <p class="verify-desc">
          组装一条带 <strong>[验证]</strong> 前缀的消息，确认配置的群机器人能否正常收到。
          消息明确标注不是真实评审提醒。
        </p>
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
            {{ selectedContact ? (selectedContact.wecomUserId ? '已配置 userid，将验证真实成员提及。' : '未配置 userid，仅显示 @中文名，不触发成员提醒。') : '自检没有真实 MR 作者，请明确选择；不会自动 @ 登录者或其他人。' }}
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
              <el-button type="danger" :loading="wecomRunning" :disabled="aiRunning || !canVerifyWecom">
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
import type { VerifyTask, WecomContact } from "../types.ts";

/** 轮询间隔：AI 验证约 1 分钟，2 秒一次足够及时且不打扰后端。 */
const POLL_INTERVAL_MS = 2000;

const aiTask = ref<VerifyTask | null>(null);
const wecomTask = ref<VerifyTask | null>(null);
// 在 POST 返回任务 ID 之前也要防重复提交，不能只根据任务状态禁用按钮。
const submitting = ref<"ai" | "wecom" | null>(null);
const contacts = ref<WecomContact[]>([]);
const contactsLoading = ref(false);
const contactsLoaded = ref(false);
const contactsError = ref("");
const gitlabUsername = ref("");
const selectedContact = computed(() => contacts.value.find((contact) => contact.gitlabUsername === gitlabUsername.value));
const canVerifyWecom = computed(() => contactsLoaded.value && !contactsLoading.value && !contactsError.value && Boolean(selectedContact.value));
const sendConfirmation = computed(() => {
  const contact = selectedContact.value;
  const name = contact?.wecomName || contact?.gitlabUsername || "未选择提交人";
  return contact?.wecomUserId
    ? `将向配置的群发送 [验证] 消息，并真实 @「${name}」。确认发送？`
    : `将向配置的群发送 [验证] 消息，末尾仅展示 @${name}，不会触发成员提醒。确认发送？`;
});
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

/** 任务状态映射成 el-alert 类型。 */
function resultType(task: VerifyTask): "success" | "error" | "info" {
  if (task.status === "running") return "info";
  return task.status === "success" ? "success" : "error";
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
  if (!canVerifyWecom.value || !contact) {
    ElMessage.warning("请先选择已登记企微映射的测试提交人");
    return;
  }
  wecomTask.value = null;
  void submitTask(
    "/api/verify/wecom",
    { confirmSend, gitlabUsername: contact.gitlabUsername },
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

onMounted(() => { void loadContacts(); });
onBeforeUnmount(() => {
  disposed = true;
  stopPolling();
});
</script>

<style scoped>
.verify-grid {
  display: grid;
  gap: 16px;
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.verify-desc {
  margin: 0 0 16px;
  font-size: 13px;
  line-height: 1.7;
  color: var(--el-text-color-regular);
}

.verify-submitter {
  display: grid;
  gap: 8px;
  margin-bottom: 16px;
}

.verify-submitter label {
  color: var(--el-text-color-primary);
  font-size: 13px;
}

.verify-submitter__hint {
  margin: 0;
  color: var(--el-text-color-secondary);
  font-size: 12px;
  line-height: 1.6;
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
  font-family: var(--el-font-family-mono, "SFMono-Regular", Consolas, monospace);
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  background-color: var(--el-fill-color-light);
  border-radius: var(--el-border-radius-small);
}

/* 窄屏下两列并排会挤成一条，改为单列 */
@media (max-width: 900px) {
  .verify-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
