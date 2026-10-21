# AI 评审建议采纳追踪 — 前端设计

## 第一部分：架构决策

### Decision Ledger

| ID | Decision | Source | Blocking | Status | Evidence / explicit confirmation |
| --- | --- | --- | --- | --- | --- |
| D-013 | 采纳数据只读展示在现有统计页，不新增独立页面与菜单 | `web/src/views/StatsView.vue:42` 已有统计卡片布局 | yes | `code-verified` | D-013: 统计页已是聚合视图的既有归属，新增页面会分散同一类数据 |
| D-014 | 新增卡片复用现有 `.stat-card` 与 `ChartCard` 组件，不引入图表库 | `web/src/views/StatsView.vue:134` 现有统计卡片 | yes | `code-verified` | D-014: 现有卡片与图表封装已覆盖该展示需求 |
| D-015 | 视觉来源为 UI/UX 规范 + 相邻页面推导，无 Figma 与截图 | `fp-docs/settings/frontend.md:40` 无权威设计稿 | yes | `code-verified` | D-015: settings 记录当前以生产源码为基线，无 Figma 基线 |

### 决策 1：采纳数据放在现有统计页

- **ID**：`D-013`
- **选择**：在 `StatsView.vue` 顶部指标区下方新增「采纳情况」卡片，不新增路由与菜单项。
- **理由**：采纳率与现有评分、评审次数同属聚合指标，用户看统计时应在同一页面。新增独立页面会让「评审质量」数据分裂在两个入口，且需要额外菜单与路由维护。
- **来源**：当前代码 `web/src/views/StatsView.vue:42`
- **是否阻塞**：是

### 决策 2：复用现有卡片与图表组件

- **ID**：`D-014`
- **选择**：数值型指标复用现有 `metricCards` 结构，分布型数据复用 `ChartCard` + ECharts 配置生成函数。
- **理由**：现有统计页已有完整的指标卡与图表封装（`web/src/views/StatsView.vue:134`），再引入第二套展示组件会造成样式分叉。
- **来源**：当前代码
- **是否阻塞**：是

### 决策 3：视觉来源以规范和相邻页面推导

- **ID**：`D-015`
- **选择**：不启动 Figma 链路，视觉值全部取自 `fp-docs/settings/frontend.md` 与现有 `StatsView.vue` 的真实样式。
- **理由**：settings 明确记录当前以生产源码为视觉基线、无权威 Figma（`fp-docs/settings/frontend.md:40`）；本次只新增卡片，不改变页面结构。
- **来源**：`fp-docs/settings/frontend.md`
- **是否阻塞**：是

### Pre-write Confirmation Evidence

- Covered IDs: `D-013`, `D-014`, `D-015`
- Outstanding blocking decisions: `none`
- Explicit user authorization to write: 用户给出「技术方案已定，其他不需要我确认，采用最佳推荐」，授权按上述方案写入 `design/frontend.md`

## 第二部分：技术方案详述

### 设计范围适用性

| 评审范围 | 要求 | Canonical owner section | 证据或不适用理由 |
| --- | --- | --- | --- |
| 架构主线 | 必填 | `#架构主线` | 现有统计页数据流，`web/src/views/StatsView.vue:258` |
| 核心对象与职责 | 必填 | `#核心对象与职责` | 见下表 |
| 数据模型 | 条件适用 | `N/A` | 前端只消费接口 DTO，无本地持久化；类型见 `#API模块` |
| 状态、并发与执行流程 | 条件适用 | `N/A` | 只读展示，无写入与并发状态 |
| 接口、权限与兼容边界 | 条件适用 | `#API模块` | 复用现有 `/api` 封装与鉴权 |
| 前端方案 | 条件适用 | 本文件全部章节 | D-013、D-014、D-015 |
| 风险、迁移、发布、回滚与监控 | 必填 | `#风险与回退` | 见下方 |
| 验证方案 | 必填 | `#验证方案` | 见下方 |

### 架构主线

统计页挂载时并发请求 `/api/reviews/stats` 与新增的 `/api/reviews/adoption`；两者独立加载，任一失败不影响另一个卡片渲染。采纳数据只读，不产生任何写操作。

### 核心对象与职责

| 对象/模块 | 职责 | 不负责 | 协作对象 | 证据 |
| --- | --- | --- | --- | --- |
| `StatsView.vue` | 展示指标与图表，组织请求 | 不做聚合计算 | `api` 客户端、`ChartCard` | `web/src/views/StatsView.vue:258` |
| `AdoptionStats`（类型） | 描述接口返回结构 | 不承载业务逻辑 | — | `web/src/types.ts:139` 现有类型惯例 |

### 前端设计

#### 页面/视图

`/stats` 现有页面新增一个区块，标题「采纳情况」，位于现有指标卡下方、趋势图上方。不新增路由、不新增菜单。

区块内容：

1. 三个数值指标：采纳率、可统计建议数、不可统计条数。
2. 两个排行表：按项目、按提交人的采纳率（复用现有排行表结构）。
3. 一个按严重级的分布图（复用 `ChartCard`）。

#### 组件

全部复用：`el-card`、`el-table`、`el-tag`、`el-empty` 与 `ChartCard`。不新建组件——本次只有一个使用点，按工程质量契约不预先抽象。

#### API 模块

沿用 `web/src/api/client.ts` 的 `api.get`，新增调用 `api.get<AdoptionStats>("/api/reviews/adoption", { params })`。错误处理沿用 `isApiError` + `ElMessage.error`。

#### 路由

不新增路由。`/stats` 已在 `web/src/router/index.ts:29` 注册，登录即可访问。

#### 状态管理

局部 `ref<AdoptionStats>`，与现有 `stats` ref 并列。不引入 Pinia 或全局状态（`fp-docs/settings/frontend.md:26` 记录未批准引入）。

### 风险、迁移、发布、回滚与监控

| 具体失败场景 | 影响 | 预防或处理 | 发布/回滚/监控安排 | 证据 |
| --- | --- | --- | --- | --- |
| 采纳接口失败 | 该区块空态，不影响现有统计 | 独立 catch，展示 `el-empty` 与错误提示 | 不影响其他卡片；回滚只删区块 |
| 无数据（刚上线） | 卡片显示 0 或空态 | 采纳率分母为 0 时显示「—」，不可统计项如实显示 | 页面文案说明数据起点为功能上线后 | D-007 |

**有意延后项**：无。

### 验证方案

| 验证项 | 命令或操作 | 预期结果 | 覆盖的设计结论 | 证据 owner |
| --- | --- | --- | --- | --- |
| 类型检查 | `npm --prefix web run typecheck` | 通过 | D-013、D-014 | 本节 |
| 构建 | `npm run build:frontend` | 成功产出 `dist/` | 全部 | 本节 |
| 空数据处理 | 本地无数据时打开 `/stats` | 采纳率显示「—」，不报错 | D-007 | 本节 |
| 亮/暗主题 | 切换主题后查看新卡片 | 颜色沿用语义 token，无硬编码 | D-015 | 本节 |

#### Visual Source

- 类型：UI-UX spec + existing page
- 来源：`web/src/views/StatsView.vue`、`web/src/styles/index.css`、`fp-docs/settings/frontend.md`
- 可信边界：卡片间距、字号、色值均取自现有页面与 token；未做浏览器截图比对

#### UI 组件树与 Figma 解析映射

| 设计区域/节点 | 目标 DOM/组件层级 | 项目组件 | 布局策略 | 关键 token/尺寸 | 备注 |
| --- | --- | --- | --- | --- | --- |
| 采纳指标区 | `section > .metric-grid > .stat-card × 3` | `el-card` | CSS Grid 自适应 | 沿现有指标卡间距 16px | 复用现有类名 |
| 采纳排行 | `el-card > el-table` | `el-table` | 与现有排行表一致 | 字号 13px，次要文字用 `--el-text-color-secondary` | 两列：名称、采纳率 |
| 严重级分布 | `el-card > ChartCard` | `ChartCard` | 单列，高度 260px | 主题色由 ChartCard 注入 | 沿用现有图表主题逻辑 |

#### Visual Checks

- [ ] 三个指标卡与现有指标卡对齐，间距一致（来源：existing page）
- [ ] 采纳率显示为百分比，分母为 0 时显示「—」而非 0%（来源：D-007）
- [ ] 排行表空态显示 `el-empty`，不出现空白表格（来源：existing page `AdminsView.vue:51`）
- [ ] 亮/暗主题下卡片背景、文字、图表颜色正确（来源：`fp-docs/settings/frontend.md:35`）
- [ ] 窄屏（≤768px）下指标卡换行不溢出（来源：`AdminLayout.vue` 现有断点）
