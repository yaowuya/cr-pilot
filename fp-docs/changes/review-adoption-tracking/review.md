# AI 评审建议采纳追踪 — 开发设计评审

## 评审结论

**建议通过**。数据模型、判定算法、调度方式和统计口径均已确定，且每条设计结论都有当前代码或用户确认作为依据。主要风险集中在两点：GitLab API 调用量增加可能触达限流，以及「代码变化」不等于「改对了」这一口径限制必须在产品文案中保持一致。

| 评审面 | 结论 | 设计依据 |
| --- | --- | --- |
| 决策 | 共 15 项；阻塞 15 / 非阻塞 0；全部终态 | `design/backend.md#Decision Ledger`、`design/frontend.md#Decision Ledger` |
| 数据 | 新增 `review_findings` 表与 3 个索引，无数据迁移 | `design/backend.md#数据模型` |
| 接口 | 新增 `GET /api/reviews/adoption`，其余接口不变 | `design/backend.md#接口权限与兼容边界` |
| 前端 | 统计页新增「采纳情况」区块，无新增路由与菜单 | `design/frontend.md#前端设计` |
| 不做事项 | 不判断改动正确性、不回溯历史、不引入外部调度框架 | `design/backend.md#风险迁移发布回滚与监控` |

## 业务和技术主线

一条建议的生命周期分四段：评审发布行内评论时写入建议记录与代码指纹；MR 产生新提交时由 webhook 触发追踪；定时器扫描待追踪项，用指纹在新版本中重新定位目标行并读取讨论解决状态；最后按项目、提交人、严重级别聚合采纳率。

判定逻辑的核心是「单行文本指纹 + ±3 行窗口」。行号会随后续提交漂移，用行号直接比对会把位移误判为改动；整文件指纹又会因任何无关改动失效。只有单行指纹能在保持定位精度的同时抵抗行号漂移。

方案复用现有能力，未引入新框架：调度复用进程内定时器（`src/shared/queue.ts` 已有串行执行），展示复用现有统计卡片与 `ChartCard`，配置沿用 `src/shared/config.ts:85` 的环境变量模式。新增的抽象只有建议仓储与追踪用例两处，均因一对多数据关系和独立生命周期而必要。

失败收束：追踪任一步失败只记日志并保留原判定，不影响评审主流程；定位失败如实记 `unknown`，不计入分母。

## 核心对象与职责

| 对象/模块 | 职责 | 不负责 | 协作对象 | 设计依据 |
| --- | --- | --- | --- | --- |
| `ReviewFinding` | 建议实体、指纹计算、判定枚举 | 不做 IO、不读 GitLab | 仓储、追踪用例 | `design/backend.md#核心对象与职责` |
| `ReviewFindingRepository` | 建议落库、待追踪查询、判定更新 | 不计算判定 | SQLite 实现 | `design/backend.md#核心对象与职责` |
| `AdoptionTracker` | 拉取新内容、重定位、判定、落库、聚合 | 不改评审结果、不发评论 | GitLab 客户端、仓储 | `design/backend.md#状态并发与执行流程` |
| `StatsView.vue` | 展示指标与图表 | 不做聚合计算 | `api` 客户端、`ChartCard` | `design/frontend.md#核心对象与职责` |

## 数据模型评审

### 接近实现的模型代码

```text
export interface ReviewFinding {
  id: number;
  recordId: number;
  projectId: number;
  mrIid: number;
  marker: string;
  findingId: string;
  severity: string;
  path: string;
  line: number;
  lineKey: "new_line" | "old_line";
  baseSha: string;
  headSha: string;
  codeFingerprint: string;
  discussionId: string | null;
  noteId: number | null;
  outcome: FindingOutcome;
  trackedAt: number | null;
  createdAt: number;
}
```

`FindingOutcome` 为 `pending | adopted | resolved-without-change | ignored | unknown`。

### 物理存储、继承与重复存储

| 逻辑对象 | 物理表/存储 | 继承字段来源 | 主键与关联键 | 重复存储结论 |
| --- | --- | --- | --- | --- |
| `ReviewFinding` | `review_findings`（`node:sqlite` 直连） | 无 ORM 与基类，表结构独立声明 | `id` 自增；`record_id` 外键 → `review_records` | `project_id` / `mr_iid` 冗余存储，换取追踪扫描免联表，写入时同事务保证一致 |

### 字段与存储取舍

| 字段或存储选择 | 最终方案 | 主要取舍 | 项目证据 |
| --- | --- | --- | --- |
| `code_fingerprint` | SHA-256 前 16 位十六进制 | 定长可索引，避免行文本明文落库扩大泄露面 | `design/backend.md#字段与存储取舍` |
| `outcome` | TEXT 四态枚举 | 能区分「已解决但未改」这类需复核情况，布尔会丢失 | `design/backend.md#字段与存储取舍` |
| 建议与记录关联 | 独立表 + `record_id` | 可建索引直接聚合，JSON 列需全表解析 | `design/backend.md#字段与存储取舍` |

### 查询模式与索引映射、约束与迁移

| 查询模式 | 过滤/排序/关联字段 | 索引或访问路径 | 设计依据 |
| --- | --- | --- | --- |
| 定时扫描待判定 | `outcome='pending'` 且 `tracked_at IS NULL`，按 `created_at` 升序 | `idx_findings_tracking` | `design/backend.md#查询模式与索引映射` |
| 单次评审明细 | `record_id = ?` | `idx_findings_record` | `design/backend.md#查询模式与索引映射` |
| 采纳率聚合 | 按 `project_id` / 提交人 / `severity` 分组 | `idx_findings_project` + 全表聚合 | `design/backend.md#查询模式与索引映射` |

唯一约束 `UNIQUE (head_sha, marker)` 保证同一版本同一建议只落一行，重跑评审不重复计数。无软删除，评审记录删除时级联删除。只新增表与索引，`IF NOT EXISTS` 幂等，无数据迁移；回滚代码后新表闲置。

## 状态、并发和执行流程

状态机：`pending` → `adopted` / `resolved-without-change` / `ignored` / `unknown`。终态可被后续追踪覆盖（先 `ignored` 后又改代码），因此每次追踪都重新计算并更新 `tracked_at`。

执行流程：定时器按 `ADOPTION_SYNC_INTERVAL_MS` 触发 `runOnce()`，模块内布尔标志保证不重叠；按 MR 聚合待追踪项，`head_sha` 未变则跳过；拉取 discussions 建立 `marker → resolved` 映射；用 `getFileRaw` 取最新文件内容，在 `[line-3, line+3]` 窗口内搜索指纹匹配行；按匹配与解决状态写入四态。

失败恢复：任一步异常只记 `warn` 并保留原状态，下一轮重试；GitLab 限流时整轮跳过。

## 接口、权限和旧入口隔离

| 接口/入口 | 主键或资源 | 权限 | 兼容或隔离边界 | 设计依据 |
| --- | --- | --- | --- | --- |
| `GET /api/reviews/adoption` | `from` / `to` / `projectId` 查询参数 | 登录即可读，不要求 admin | 新增接口；现有 `/api/reviews`、`/api/reviews/stats` 响应结构不变 | `design/backend.md#接口权限与兼容边界` |
| `POST /review/webhook` | MR 事件 | 维持原有 `X-Gitlab-Token` 语义 | `update` + `oldrev` 入追踪队列；其余事件维持原评审触发，不改既有行为 | `design/backend.md#架构主线` |

响应结构包含总体采纳率、不可统计计数（`fallback` / `unknown`）、按项目、按提交人、按严重级四组聚合。历史记录无建议明细，统计只覆盖上线后数据。

## 前端方案

`/stats` 页面在现有指标卡下方新增「采纳情况」区块，包含三个数值指标（采纳率、可统计数、不可统计数）、两个排行表（按项目、按提交人）和一个按严重级的分布图。

全部复用现有组件：`el-card`、`el-table`、`el-tag`、`el-empty` 与 `ChartCard`，不新建组件。数据用局部 `ref<AdoptionStats>` 与现有 `stats` ref 并列，不引入 Pinia。不新增路由与菜单。

视觉来源为 UI/UX 规范与相邻页面推导：`web/src/views/StatsView.vue`、`web/src/styles/index.css`、`fp-docs/settings/frontend.md`。无 Figma 与截图基线，未做浏览器截图比对。

Visual Checks：指标卡与现有卡片对齐；采纳率显示百分比，分母为 0 显示「—」；排行表空态显示 `el-empty`；亮/暗主题颜色正确；≤768px 窄屏不溢出。

## 主要风险、迁移、发布和验证

### 主要风险

| 具体失败场景 | 影响 | 预防或处理 | 设计依据 |
| --- | --- | --- | --- |
| GitLab API 调用量增加（每条建议一次文件读取） | 触发限流，影响评审 | 同一 MR 只取一次文件内容并缓存；每轮限量处理 MR 数 | `design/backend.md#风险迁移发布回滚与监控` |
| 指纹定位失败（大重构、文件删除） | 该条记 `unknown`，不计入分母 | 允许 ±3 行窗口位移；仍失败如实标记 | `design/backend.md#风险迁移发布回滚与监控` |
| 判定把「别人改动」当成采纳 | 采纳率虚高 | 只在该建议评审之后的新提交范围内判定；`head_sha` 相同则跳过 | `design/backend.md#风险迁移发布回滚与监控` |
| 追踪影响服务启动 | 启动变慢或异常 | 追踪由定时器驱动，不阻塞 `startServer`；启动日志打印开关与间隔 | `design/backend.md#风险迁移发布回滚与监控` |

有意延后项：无。

### 迁移与发布

只新增表与索引，`CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` 幂等，旧库启动自动补齐，无数据迁移。回滚代码后新表闲置不影响既有功能。发布后通过 `ADOPTION_TRACKING_ENABLED=false` 可立即关闭追踪，无需回滚代码。监控信号为 GitLab 429 日志与每轮追踪的状态计数。

### 验证清单

- [ ] `node --test test/domain/review-finding.test.ts`：空白差异不改变指纹，内容变化改变指纹（`design/backend.md#验证方案`）
- [ ] `node --test test/infrastructure/sqlite/review-finding-repo.test.ts`：重复 marker 不产生两行，按 outcome 扫描正确（同上）
- [ ] `node --test test/application/adoption-tracker.test.ts`：四态判定各自成立（同上）
- [ ] `node --test test/interfaces/http/adoption.test.ts`：采纳率与不可统计计数正确，无数据时 rate 为 null（同上）
- [ ] `node --test test/interfaces/http/webhook.test.ts`：`update` + `oldrev` 入追踪，其他事件维持原行为（同上）
- [ ] `npm test`：全量回归通过（同上）
- [ ] `npm run typecheck`：前后端类型检查通过（同上）
- [ ] `npm --prefix web run typecheck` 与 `npm run build:frontend`：前端检查与构建通过（`design/frontend.md#验证方案`）
- [ ] 实现时同步完成注释自审：新增公开对象有契约说明，非显然逻辑有原因注释（共享工程质量契约）

## 评审顺序与抽查路径

1. **数据模型与判定算法**（`design/backend.md#数据模型`、`#状态并发与执行流程`）——整条链路的正确性都建立在这两处，指纹粒度与窗口大小若有偏差，后续所有统计都会失真。
2. **GitLab API 调用与限流风险**（`design/backend.md#风险迁移发布回滚与监控`）——新增调用直接影响生产评审服务，需要在实现前确认缓存与限量策略足够。
3. **统计口径与不可统计处理**（`design/backend.md#接口权限与兼容边界`）——分母定义决定指标是否可信，也决定产品文案能否自洽。
4. **前端展示与空态**（`design/frontend.md#前端设计`）——风险最低，可在实现后按 Visual Checks 抽查。

- 建议抽查：`src/infrastructure/gitlab/gitlab-client.ts:209`（讨论字段映射）、`src/application/review-pipeline.ts:701`（marker 生成位置）、`src/infrastructure/sqlite/database.ts:117`（建表与 PRAGMA）

## 评审结论记录

- [ ] 通过：设计完整，可以进入计划阶段。
- [ ] 有条件通过：需要在计划或实现前满足的条件。
- [ ] 退回修改：需要返回 fp-brainstorm 的精确章节。

## 设计入口

- `design/00-index.md`
