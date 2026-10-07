<template>
  <div>
    <el-row :gutter="16" class="stat-row">
      <el-col :span="6">
        <el-card><el-statistic title="评审总次数" :value="stats.total" /></el-card>
      </el-col>
      <el-col :span="6">
        <el-card><el-statistic title="涉及项目数" :value="stats.projectCount" /></el-card>
      </el-col>
      <el-col :span="6">
        <el-card><el-statistic title="提交人数" :value="stats.committerCount" /></el-card>
      </el-col>
      <el-col :span="6">
        <el-card>
          <!-- 平均分可能是 null（尚无带分数的记录），用 - 表示而不是 0 -->
          <el-statistic title="平均分" :value="stats.avgScore ?? 0" :precision="1" suffix="分" />
        </el-card>
      </el-col>
    </el-row>

    <el-card>
      <el-form :inline="true" @submit.prevent>
        <el-form-item label="项目 ID">
          <el-input v-model="filters.projectId" placeholder="项目 ID" clearable style="width: 140px" />
        </el-form-item>
        <el-form-item label="提交人">
          <el-input v-model="filters.committer" placeholder="提交人" clearable style="width: 160px" />
        </el-form-item>
        <el-form-item label="时间范围">
          <el-date-picker
            v-model="filters.range"
            type="daterange"
            range-separator="至"
            start-placeholder="开始日期"
            end-placeholder="结束日期"
            value-format="x"
          />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="onSearch">查询</el-button>
          <el-button @click="onReset">重置</el-button>
        </el-form-item>
      </el-form>

      <el-table v-loading="loading" :data="items" border>
        <el-table-column prop="projectName" label="项目" min-width="200" show-overflow-tooltip />
        <el-table-column prop="mrIid" label="MR" width="80" />
        <el-table-column prop="committerName" label="提交人" width="120" />
        <el-table-column prop="changeCount" label="文件数" width="80" />
        <el-table-column prop="batchCount" label="批次数" width="80" />
        <el-table-column label="分数" width="80">
          <template #default="{ row }">
            <!-- 0 分与「未解析出分数」在库里分别是 0 与 null，页面必须区别展示 -->
            {{ row.score === null ? "—" : row.score }}
          </template>
        </el-table-column>
        <el-table-column label="耗时" width="100">
          <template #default="{ row }">{{ (row.durationMs / 1000).toFixed(1) }}s</template>
        </el-table-column>
        <el-table-column label="结果" width="90">
          <template #default="{ row }">
            <el-tag :type="row.result === 'success' ? 'success' : 'danger'" size="small">
              {{ row.result === "success" ? "成功" : "失败" }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="时间" width="180">
          <template #default="{ row }">{{ formatTime(row.startedAt) }}</template>
        </el-table-column>
        <template #empty>
          <el-empty description="暂无评审记录" />
        </template>
      </el-table>

      <el-pagination
        v-model:current-page="page"
        v-model:page-size="pageSize"
        class="pager"
        layout="total, sizes, prev, pager, next"
        :page-sizes="[10, 20, 50, 100]"
        :total="total"
        @current-change="loadList"
        @size-change="onSearch"
      />
    </el-card>
  </div>
</template>

<script setup lang="ts">
/**
 * 评审记录与统计页。
 *
 * 列表与统计分开请求：统计不受分页影响，因此只在挂载与筛选变更时刷新，
 * 翻页只重新拉列表。分数列区分 `null`（未解析出分数）与 `0`（真实零分）。
 */
import { onMounted, reactive, ref } from "vue";
import { ElMessage } from "element-plus";
import { api, isApiError } from "../api/client.ts";
import type { ReviewRecord, ReviewStats } from "../types.ts";

const loading = ref(false);
const items = ref<ReviewRecord[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(20);
const stats = ref<ReviewStats>({ total: 0, projectCount: 0, committerCount: 0, avgScore: null, daily: [] });

const filters = reactive<{ projectId: string; committer: string; range: [string, string] | null }>({
  projectId: "",
  committer: "",
  range: null,
});

/** 把筛选条件转成后端查询参数。 */
function filterParams(): Record<string, unknown> {
  return {
    project_id: filters.projectId || undefined,
    committer: filters.committer || undefined,
    from: filters.range?.[0] || undefined,
    to: filters.range?.[1] || undefined,
  };
}

async function loadList(): Promise<void> {
  loading.value = true;
  try {
    const result = await api.get<{ items: ReviewRecord[]; total: number }>("/api/reviews", {
      ...filterParams(),
      page: page.value,
      pageSize: pageSize.value,
    });
    items.value = result.items;
    total.value = result.total;
  } catch (error) {
    if (!isApiError(error) || error.status !== 401) {
      ElMessage.error(isApiError(error) ? error.message : "加载评审记录失败");
    }
  } finally {
    loading.value = false;
  }
}

async function loadStats(): Promise<void> {
  try {
    stats.value = await api.get<ReviewStats>("/api/reviews/stats", filterParams());
  } catch (error) {
    if (!isApiError(error) || error.status !== 401) {
      ElMessage.error(isApiError(error) ? error.message : "加载统计失败");
    }
  }
}

/** 筛选或页大小变更：回到第一页并同时刷新列表与统计。 */
async function onSearch(): Promise<void> {
  page.value = 1;
  await Promise.all([loadList(), loadStats()]);
}

async function onReset(): Promise<void> {
  filters.projectId = "";
  filters.committer = "";
  filters.range = null;
  await onSearch();
}

/** 时间戳转本地可读时间。 */
function formatTime(value: number): string {
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

onMounted(() => {
  void Promise.all([loadList(), loadStats()]);
});
</script>

<style scoped>
.stat-row {
  margin-bottom: 16px;
}

.pager {
  margin-top: 16px;
  justify-content: flex-end;
}
</style>
