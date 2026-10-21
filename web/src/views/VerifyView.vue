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
        <div class="verify-actions">
          <el-button :loading="wecomRunning" :disabled="aiRunning" @click="previewWecom">
            <el-icon><View /></el-icon>
            仅预览
          </el-button>
          <el-popconfirm
            title="确认发送到群里？消息会以 [验证] 开头，但仍会出现在真实工作群。"
            confirm-button-text="确认发送"
            cancel-button-text="取消"
            width="320"
            @confirm="sendWecom"
          >
            <template #reference>
              <el-button type="danger" :loading="wecomRunning" :disabled="aiRunning">
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
import { computed, onBeforeUnmount, ref } from "vue";
import { ElMessage } from "element-plus";
import { Cpu, Promotion, View } from "@element-plus/icons-vue";
import { api, isApiError } from "../api/client.ts";
import type { VerifyTask } from "../types.ts";

/** 轮询间隔：AI 验证约 1 分钟，2 秒一次足够及时且不打扰后端。 */
const POLL_INTERVAL_MS = 2000;

const aiTask = ref<VerifyTask | null>(null);
const wecomTask = ref<VerifyTask | null>(null);
/** 轮询定时器；页面卸载时必须清掉，否则会继续请求已离开的页面。 */
let pollTimer: ReturnType<typeof setInterval> | null = null;

const aiRunning = computed(() => aiTask.value?.status === "running");
const wecomRunning = computed(() => wecomTask.value?.status === "running");

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
        item.assign(latest);
      } catch (error) {
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
  try {
    const { taskId } = await api.post<{ taskId: string }>(path, body);
    assign({
      id: taskId,
      kind: path.includes("wecom") ? "wecom" : "ai",
      status: "running",
      message: `${label}执行中…`,
      detail: "",
      durationMs: 0,
      startedAt: Date.now(),
      finishedAt: null,
    });
    ensurePolling();
  } catch (error) {
    ElMessage.error(isApiError(error) ? error.message : `${label}提交失败`);
  }
}

function runAi(): void {
  aiTask.value = null;
  void submitTask("/api/verify/ai", {}, (task) => { aiTask.value = task; }, "AI 验证");
}

function previewWecom(): void {
  wecomTask.value = null;
  void submitTask("/api/verify/wecom", { confirmSend: false }, (task) => { wecomTask.value = task; }, "企微预览");
}

function sendWecom(): void {
  wecomTask.value = null;
  void submitTask("/api/verify/wecom", { confirmSend: true }, (task) => { wecomTask.value = task; }, "企微发送");
}

onBeforeUnmount(() => {
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

.verify-actions {
  display: flex;
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
