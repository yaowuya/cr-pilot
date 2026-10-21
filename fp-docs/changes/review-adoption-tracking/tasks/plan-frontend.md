# AI 评审建议采纳追踪 Frontend Implementation Plan

> **For agentic workers:** REQUIRED FLOW: Use `fp-execute` to implement this plan task-by-task. Only task markers use checkbox (`- [ ] **Task frontend-NNN: ...**`) syntax for tracking; substeps are plain ordered instructions.

**Goal:** 在现有统计页新增「采纳情况」区块，展示采纳率、可统计/不可统计数量，以及按项目、按提交人、按严重级的分布。

**Architecture:** 全部改动集中在 `StatsView.vue` 与其依赖的类型定义。数据层新增一个只读请求与一个 `ref`，与现有 `stats` 并列；展示层复用现有 `el-card`、`el-table`、`ChartCard` 与统计卡片样式。不新增路由、菜单、组件或状态库。

**Tech Stack:** Vue `^3.5.13`（`<script setup lang="ts">`）、Vue Router `^4.5.0`、Element Plus `^2.9.1`、ECharts（经 `ChartCard` 封装）、Vite `^6.0.7`、`vue-tsc`。

## Global Constraints

- 前端源码根为 `web/`，入口 `web/src/main.ts`；Element Plus 全量注册，组件前缀沿 `el-*`（`fp-docs/settings/frontend.md:19-22`）。
- 状态管理只用 Vue 组合式 API 的局部 `ref`/`computed`；未批准引入 Pinia 或 Vuex，不得新增（`fp-docs/settings/frontend.md:26`）。
- 请求统一经 `web/src/api/client.ts` 的 `api`，错误判断用 `isApiError`，提示用 `ElMessage`；不得绕过封装直接 `fetch`（`fp-docs/settings/frontend.md:27`）。
- 颜色、字号、间距必须复用现有 CSS 变量 `--el-*` 与 `--app-*`，不得硬编码品牌色（`fp-docs/settings/frontend.md:33`）。
- 图表统一使用 `web/src/components/ChartCard.vue`，其内部已处理亮/暗主题与实例释放；不直接实例化 ECharts（`web/src/views/StatsView.vue:111`）。
- 样式写在组件 `<style scoped>` 中；不新增全局类（`fp-docs/settings/frontend.md:33`）。
- 采纳率分母为 0 时显示「—」，不得显示 `0%`（`design/backend.md#接口权限与兼容边界`）。
- 不新增前端依赖，不修改 Vite 配置与构建输出路径。
- Engineering quality: `C:\Users\Lenovo\.dsh\skills\_shared\engineering-quality.md`；Vue 规范读 `C:\Users\Lenovo\.dsh\skills\_shared\code-standards\common.md` 与 `vue.md`；本项目注释使用中文，解释职责与非显然约束（`web/src/views/StatsView.vue:113`）；最小方案为「一个接口 + 一个区块」，延后项为无。

## File Structure

| Path | Action | Responsibility |
| --- | --- | --- |
| `web/src/types.ts` | modify | 新增 `AdoptionStats` 及子类型 |
| `web/src/views/StatsView.vue` | modify | 新增采纳数据请求、区块模板与局部样式 |

## Frontend Interface Ledger

| Interface | Owner Task | Contract | Consumers | Verification |
| --- | --- | --- | --- | --- |
| `AdoptionStats` | `frontend-001` | 与 `GET /api/reviews/adoption` 响应结构一一对应：`total`、`untrackable`、`byProject`、`byCommitter`、`bySeverity` | `StatsView.vue` | `npm --prefix web run typecheck` |
| `AdoptionDimensionRow` | `frontend-001` | `{ name: string; tracked: number; adopted: number; rate: number \| null }` | `StatsView.vue` | 同上 |
| `adoption` ref + `loadAdoption()` | `frontend-001` | 挂载时请求一次；失败只提示并保留空态，不影响 `stats` | `StatsView.vue` | 同上 |
| `采纳情况` 区块 | `frontend-002` | 3 个指标卡 + 2 个排行表 + 1 个严重级图表 | 用户 | 人工核对 + Visual Checks |

## UI/E2E Delivery Contract

| Task ID | Case ID | Source-derived condition | UI Delivery Level | Runtime route | E2E Applicability | Required lifecycle evidence | Coverage matrix | Rationale |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `frontend-002` | `adoption-section` | proposal `Capabilities/adoption-metrics`；design `frontend.md#前端设计` | `static-only` | `/stats` | `N/A` | `SOURCE_READY -> STATIC_UI_READY -> VISUAL_REVIEW_PASS` | `.fp-execute/e2e/frontend-002/adoption-section/coverage-matrix.md` | 只读统计展示，不含用户输入、写入或跨业务边界操作；无交互分支持续观察 |

## Visual Evidence Manifest

| Task ID | Case ID | Approved design source | Runtime route | Scenario/state | Viewport | Theme | Fixture | Reference | Current | Acceptance rule | Failure class |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `frontend-002` | `adoption-section` | 无 Figma；设计来源为 `design/frontend.md#Visual Source` + 现有 `StatsView.vue` | `/stats` | 有采纳数据 | 1440×900 | light | 本地服务真实数据（无 Mock） | `CANNOT_VERIFY`（无 approved Figma/截图源） | `.fp-execute/visual/frontend-002/adoption-section/current.png` | 与现有指标卡对齐、无溢出、亮暗主题正确 | `visual-source-missing` |

**视觉证据说明**：本次无 Figma 与截图基线（`fp-docs/settings/frontend.md:40`），因此 `reference.png` 无法从 approved design source 生成，`VISUAL_REVIEW_PASS` 不成立。按 UI/E2E 契约，该项记 `CANNOT_VERIFY` 并在最终评审如实报告，不以 `current.png` 冒充参考图，也不标记为 PASS。

---

- [x] **Task frontend-001: 采纳统计类型与数据加载**

**Files:**
- Modify: `web/src/types.ts`
- Modify: `web/src/views/StatsView.vue:110-270`
- Test: `npm --prefix web run typecheck`

**Reasoning:**
- 类型与请求先行，页面区块才有稳定数据来源；独立成任务便于单独验证接口契约。
- 与现有 `stats` 请求解耦，任一失败不影响另一个区块。

**Depends on:** None

**Interfaces:**
- Consumes: `GET /api/reviews/adoption`
- Produces: `AdoptionStats`、`AdoptionDimensionRow`、`adoption` ref、`loadAdoption()`
- Contract checks: 类型与后端响应字段完全一致；失败不抛出未捕获异常

**Step 1: Write the failing test**

本任务无独立前端测试框架（项目未配置），以类型检查作为失败验证手段。

在 `web/src/types.ts` 中先写下预期类型定义的反向验证：临时在 `StatsView.vue` 中引用尚不存在的 `AdoptionStats`。

**Step 2: Run check to verify it fails**

Run: `npm --prefix web run typecheck`
Expected: FAIL，报错 `Cannot find name 'AdoptionStats'`

**Step 3: Write minimal implementation**

在 `types.ts` 追加类型：

```ts
/** 一组维度的采纳聚合；`rate` 为 0-1，分母为 0 时为 null。 */
export interface AdoptionDimensionRow {
  name: string;
  tracked: number;
  adopted: number;
  rate: number | null;
}

/** 采纳统计：可统计部分与不可统计部分分开呈现。 */
export interface AdoptionStats {
  total: { tracked: number; adopted: number; rate: number | null };
  untrackable: { fallback: number; unknown: number };
  byProject: AdoptionDimensionRow[];
  byCommitter: AdoptionDimensionRow[];
  bySeverity: AdoptionDimensionRow[];
}
```

在 `StatsView.vue` 的 `<script setup>` 中加入 `adoption` ref 与 `loadAdoption()`，在 `onMounted` 中与 `load()` 并列调用；失败时 `ElMessage.error`，并把 `adoption` 置为初始空值。

**Step 4: Run check to verify it passes**

Run: `npm --prefix web run typecheck`
Expected: PASS

自审：新增函数 JSDoc 说明为何与 `load()` 分离；类型字段与后端契约逐项比对一致。

**Step 5: Commit**

```bash
git add web/src/types.ts web/src/views/StatsView.vue
git commit -m "feat: 统计页接入采纳统计数据"
```

---

- [x] **Task frontend-002: 采纳情况区块与视觉核对**

**Files:**
- Modify: `web/src/views/StatsView.vue:1-110`（模板）、`:270-330`（样式）
- Test: `npm --prefix web run build:frontend`

**Reasoning:**
- 展示是本次唯一的用户可见交付，需与现有卡片视觉一致。
- 复用现有组件与类，避免引入第二套展示样式。

**Depends on:** `frontend-001`

**Interfaces:**
- Consumes: `adoption` ref、`AdoptionStats`
- Produces: `/stats` 页面「采纳情况」区块
- Contract checks: 分母为 0 显示「—」；空数组显示 `el-empty`；亮暗主题无硬编码色

**Step 1: Write the failing test**

项目未配置前端单元测试框架。以构建作为第一步验证：

Run: `npm run build:frontend`
Expected: 基线通过（此时尚未新增区块，用于确认构建可用）

**Step 2: Add the section markup**

在现有指标卡区块之后、趋势图之前插入 `el-card`，内含：

- 三个指标：采纳率（`rate === null` 显示「—」，否则 `(rate * 100).toFixed(1) + "%"`）、可统计建议数、不可统计条数；
- 两个排行表（按项目、按提交人），列为名称、可统计、采纳、采纳率，空态 `el-empty`；
- 一个严重级分布图，复用 `ChartCard` 与现有 `buildRankingOption` 的同类配置。

样式只加组件内 scoped 类，间距与字号复用小节标题与表格的现有值。

**Step 3: Run build to verify it compiles**

Run: `npm run build:frontend`
Expected: PASS，产出 `dist/`

**Step 4: Run typecheck**

Run: `npm --prefix web run typecheck`
Expected: PASS

**Step 5: Visual checks（记录结果，不改代码）**

按 `design/frontend.md#Visual Checks` 逐项核对：指标卡对齐、分母为 0 显示「—」、空态 `el-empty`、亮暗主题、≤768px 不溢出。

记录：本次无 approved Figma/截图源，`reference.png` 不可得，视觉评审结论为 `CANNOT_VERIFY`，证据路径 `.fp-execute/visual/frontend-002/adoption-section/`。

**Step 6: Commit**

```bash
git add web/src/views/StatsView.vue
git commit -m "feat: 统计页新增采纳情况区块"
```

## Coverage Matrix

| Source | Requirement / Boundary | Tasks | Verification |
| --- | --- | --- | --- |
| proposal.md | 统计页呈现采纳率与不可统计部分 | `frontend-001`, `frontend-002` | `npm run build:frontend` |
| design/frontend.md | 复用现有卡片与 ChartCard（D-014） | `frontend-002` | `npm --prefix web run typecheck` |
| design/frontend.md | 不新增路由与菜单（D-013） | `frontend-002` | 人工核对 `web/src/router/index.ts` 未变 |
| design/frontend.md | 视觉来源为现有页面推导（D-015） | `frontend-002` | Visual Checks 记录 |
| Visual | 分母为 0 显示「—」 | `frontend-002` | Visual Checks 第 2 项 |
| Visual | 空态与主题一致 | `frontend-002` | Visual Checks 第 3、4 项 |
| UI/E2E | `static-only`，E2E N/A | `frontend-002` | `.fp-execute/e2e/frontend-002/adoption-section/coverage-matrix.md` |
