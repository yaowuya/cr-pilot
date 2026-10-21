# AI 评审建议采纳追踪 — 技术方案设计

## 第一部分：架构决策

### Decision Ledger

| ID | Decision | Source | Blocking | Status | Evidence / explicit confirmation |
| --- | --- | --- | --- | --- | --- |
| D-001 | 采纳判定以行内容指纹重新定位目标行为主，讨论解决状态为辅 | `proposal.md#Handoff Decision Ledger` P-001 | yes | `PRD-confirmed` | D-001: selected 行内容指纹追踪; proposal P-001 已确认 |
| D-002 | 新增 `review_findings` 表而非在 `review_records` 上加列 | `src/domain/review-record.ts:9` 现有记录为一条 MR 一行 | yes | `code-verified` | D-002: 一条 MR 有多条建议，1:N 关系无法用单行记录承载; `src/infrastructure/sqlite/database.ts:17` |
| D-003 | 代码指纹取被评论行的规范化文本哈希，不取整文件或整个 diff | user answer | yes | `user-confirmed` | D-003: selected 单行指纹; user message「该技术方案可行」 |
| D-004 | 追踪触发合并在现有 webhook 入口，识别 `update` 事件且 `oldrev` 存在时入追踪队列 | `src/interfaces/http/app.ts:65` 现有仅校验 object_kind | yes | `code-verified` | D-004: webhook 是唯一入口，无需新增推送配置; `src/interfaces/http/webhook-parser.ts:31` |
| D-005 | 追踪任务复用现有进程内队列，每秒轮询由 `setInterval` 驱动 | `src/shared/queue.ts` 现有队列 | yes | `user-confirmed` | D-005: selected 复用进程内定时器; proposal P-004 |
| D-006 | 讨论读取补齐 `resolvable`/`resolved`，并新增 `getFileRaw` 读取目标行 | `src/infrastructure/gitlab/gitlab-client.ts:209` 当前丢弃字段 | yes | `code-verified` | D-006: 现有映射只保留 id/body/position; `src/domain/review-task.ts:35` |
| D-007 | 判定结果只落四态枚举，无法定位记 `unknown` 且不计入分母 | `proposal.md#Out of Scope` | yes | `PRD-confirmed` | D-007: 不猜测定位失败项; proposal P-003 |
| D-008 | 统计接口挂在 `/api/reviews/adoption`，与现有 `/api/reviews/stats` 同级 | `src/interfaces/http/api/reviews.ts:83` | yes | `code-verified` | D-008: 复用已有 reviews 路由组与鉴权; `src/bootstrap.ts:230` |
| D-009 | 后端设计采用 small form（`design/backend.md`） | `<artifact-layout>` 默认 small | yes | `code-verified` | D-009: 预计低于 500 行 / 30,000 字符 |
| D-010 | 前端设计采用 small form（`design/frontend.md`） | `<artifact-layout>` 默认 small | yes | `code-verified` | D-010: 仅新增统计卡片与类型，远低于硬限制 |
| D-011 | 追踪开关与同步间隔通过环境变量配置，默认开启、间隔 10 分钟 | `src/shared/config.ts:85` 现有配置读取模式 | yes | `user-confirmed` | D-011: selected 默认开启、10 分钟间隔; user message「采用最佳推荐」 |
| D-012 | 不修改评审主流程的并发与超时，追踪独立在队列外串行执行 | `src/application/review-pipeline.ts:166` | yes | `code-verified` | D-012: 追踪与评审无共享可变状态，串行避免同时打 GitLab |

### 决策 1：采纳判定以行内容指纹为主

- **ID**：`D-001`
- **选择**：对每条已发布的行内评论记录被评论行的规范化文本哈希；追踪时在新版本中按文件与指纹重新定位，文本变化或被删除即判定代码已变化。
- **理由**：行号会随后续提交漂移（插入/删除行），直接按行号比对会把位移误判为改动。讨论解决状态是人工动作，可能漏点或误点，只能作为辅助信号。
- **来源**：proposal P-001（用户确认）；`src/domain/inline-comment.ts:159` 已有 marker 作为建议唯一标识。
- **是否阻塞**：是

### 决策 2：建议明细独立建表

- **ID**：`D-002`
- **选择**：新增 `review_findings` 表，通过 `record_id` 关联 `review_records`。
- **理由**：现有 `review_records` 一条 MR 一行（`src/domain/review-record.ts:9`），而一次评审可产生多条建议，是一对多关系。把建议塞成 JSON 列会让统计必须全表解析，且无法按严重级建索引。
- **来源**：当前代码结构，`src/infrastructure/sqlite/database.ts:17`
- **是否阻塞**：是

### 决策 3：指纹粒度取单行

- **ID**：`D-003`
- **选择**：只对目标行文本做规范化（去首尾空白、压缩内部连续空白）后取哈希。
- **理由**：整文件指纹在任意无关改动后即失配，等于失去定位能力；整个 diff 指纹无法回答「具体哪一行被改」。单行指纹同时满足定位精度与抗噪要求。
- **来源**：用户确认（proposal 技术方案）
- **是否阻塞**：是

### 决策 4：追踪触发复用现有 webhook 入口

- **ID**：`D-004`
- **选择**：在现有 `/review/webhook` 中识别 `object_attributes.action === "update"` 且 `oldrev` 非空的事件，判定为「有新提交」，将该 MR 加入追踪队列；其余事件维持原有评审触发逻辑。
- **理由**：GitLab 侧无需新增 webhook 配置，也不需要额外权限；现有入口已带 `X-Gitlab-Instance` 与 `X-Gitlab-Token`，可直接复用 `src/interfaces/http/webhook-parser.ts:41` 的凭证解析。
- **来源**：当前代码
- **是否阻塞**：是

### 决策 5：追踪调度复用进程内队列与定时器

- **ID**：`D-005`
- **选择**：新增一个 `adoption-tracker` 用例，由 `setInterval` 每 10 分钟扫描待追踪记录并串行处理；不引入外部调度框架。
- **理由**：项目已是单进程 Node 服务（`src/bootstrap.ts:125` 单一组合根），引入 cron 库或外部调度器只为跑一个周期任务，收益不足以抵消运维复杂度。现有 `src/shared/queue.ts` 已提供串行执行能力。
- **来源**：proposal P-004（用户确认）
- **是否阻塞**：是

### 决策 6：补齐 GitLab discussions 字段与文件读取能力

- **ID**：`D-006`
- **选择**：`getDiscussions` 的 note 映射补 `resolvable`、`resolved`；新增 `getFileRaw(projectId, ref, path)` 用于取目标行文本。
- **理由**：解决状态是 GitLab 已有的返回字段，当前实现丢弃了（`src/infrastructure/gitlab/gitlab-client.ts:209`）。取目标行必须有原始文件内容，现有客户端没有该能力。
- **来源**：当前代码
- **是否阻塞**：是

### 决策 7：四态判定与分母口径

- **ID**：`D-007`
- **选择**：判定结果为 `adopted` / `resolved-without-change` / `pending` / `unknown` 四态。采纳率分母只包含成功发布行内评论且可定位的建议。
- **理由**：降级并入汇总的建议没有行锚点，无法追踪；把不可追踪项放进分母会系统性压低采纳率并掩盖数据质量问题。单列不可统计条数才能同时暴露覆盖缺口。
- **来源**：proposal P-003、Out of Scope
- **是否阻塞**：是

### 决策 8：统计接口位置

- **ID**：`D-008`
- **选择**：`GET /api/reviews/adoption`，返回总体采纳率、按项目、按提交人、按严重级四组聚合及不可统计计数。
- **理由**：复用现有 `reviews` 路由组（`src/interfaces/http/api/reviews.ts:83`）与 `/api` 鉴权中间件，不新增路由组与权限分支。
- **来源**：当前代码
- **是否阻塞**：是

### 决策 9、10：设计产物采用 small form

- **ID**：`D-009`、`D-010`
- **选择**：后端 `design/backend.md`、前端 `design/frontend.md`，均为 small form。
- **理由**：两端内容均预计远低于 500 行 / 30,000 字符的硬限制，按 artifact-layout 契约默认 small。
- **来源**：共享 artifact-layout 契约
- **是否阻塞**：是

### 决策 11：追踪配置项

- **ID**：`D-011`
- **选择**：新增 `ADOPTION_TRACKING_ENABLED`（默认 `true`）与 `ADOPTION_SYNC_INTERVAL_MS`（默认 `600000`）。
- **理由**：追踪会产生额外 GitLab API 调用，部署方可能需要关闭；沿用 `src/shared/config.ts:85` 现有的环境变量读取模式，不引入新的配置机制。
- **来源**：用户确认（采用最佳推荐）
- **是否阻塞**：是

### 决策 12：追踪与评审解耦

- **ID**：`D-012`
- **选择**：追踪任务不进入评审队列，由独立定时器串行执行，不修改管线并发与超时。
- **理由**：两者共享 GitLab API 配额但无共享状态。追踪若进入评审队列会与真实评审争抢并发槽位，延长评审等待时间。
- **来源**：当前代码
- **是否阻塞**：是

### Pre-write Confirmation Evidence

- Covered IDs: `D-001`, `D-002`, `D-003`, `D-004`, `D-005`, `D-006`, `D-007`, `D-008`, `D-009`, `D-010`, `D-011`, `D-012`
- Outstanding blocking decisions: `none`
- Explicit user authorization to write: 用户给出「该技术方案可行，用fp-start，切换一个分支，进行开发。技术方案已定，其他不需要我确认，采用最佳推荐」，授权按上述已确认方案写入 `design/backend.md` 与 `design/frontend.md`

## 第二部分：技术方案详述

### 设计范围适用性

| 评审范围 | 要求 | Canonical owner section | 证据或不适用理由 |
| --- | --- | --- | --- |
| 架构主线 | 必填 | `#架构主线` | proposal What Changes 1-4；`src/bootstrap.ts:125` |
| 核心对象与职责 | 必填 | `#核心对象与职责` | 新增追踪用例与仓储职责见下表 |
| 数据模型 | 条件适用 | `#数据模型` | 新增 `review_findings` 表（D-002） |
| 状态、并发与执行流程 | 条件适用 | `#状态并发与执行流程` | 定时追踪与 webhook 触发（D-004、D-005） |
| 接口、权限与兼容边界 | 条件适用 | `#接口权限与兼容边界` | 新增统计接口（D-008） |
| 前端方案 | 条件适用 | 见 `design/frontend.md` | 统计页新增卡片（D-010） |
| 风险、迁移、发布、回滚与监控 | 必填 | `#风险迁移发布回滚与监控` | 见下方风险表 |
| 验证方案 | 必填 | `#验证方案` | 见下方验证表 |

### 架构主线

一条建议从产生到判定，经过四步：

1. **写入**：评审管线成功发布行内评论后，用被评论行的文本算出指纹，连同 marker、路径、行号、严重级、版本坐标写入 `review_findings`。发布失败降级进汇总的建议也写一条，但标记为不可追踪。
2. **触发**：GitLab 在 MR 有新提交时推送 `update` 事件。webhook 识别出该事件后，把 MR 加入追踪待办，而不是重新触发评审。
3. **判定**：定时器扫描待办，拉取该 MR 最新文件内容，按路径与指纹重新定位每条建议的目标行，比较文本是否变化，同时读取讨论的 `resolved` 状态，写入判定结果。
4. **聚合**：统计接口按项目、提交人、严重级聚合采纳率，并把不可统计项单列返回。

失败收束：追踪任一步失败只记日志并保留原判定状态，不影响评审主流程；单条建议定位失败记 `unknown`，不猜测。

### 核心对象与职责

| 对象/模块 | 职责 | 不负责 | 协作对象 | 证据 |
| --- | --- | --- | --- | --- |
| `ReviewFinding`（domain） | 建议实体、指纹计算、判定枚举 | 不做 IO、不读 GitLab | 仓储、追踪用例 | `src/domain/review-record.ts:9` 现有记录模型 |
| `ReviewFindingRepository`（domain 端口） | 建议落库、按 MR 查询待追踪、更新判定 | 不计算判定 | SQLite 实现 | `src/domain/runtime-config.ts:18` 端口惯例 |
| `createReviewFindingRepository`（infra） | SQLite 读写实现 | 不决定业务口径 | — | `src/infrastructure/sqlite/review-record-repo.ts:56` |
| `AdoptionTracker`（application） | 拉取新内容、重定位、判定、落库、聚合统计 | 不改评审结果、不发评论 | GitLab 客户端、仓储、logger | `src/application/review-pipeline.ts:166` 用例惯例 |
| `createReviewFindingsRouter`（interface） | 暴露采纳统计接口 | 不做聚合计算 | — | `src/interfaces/http/api/reviews.ts:83` |

### 后端模块设计

- `src/domain/review-finding.ts`：`ReviewFinding`、`FindingOutcome`、`fingerprintLine(line)` 纯函数、`ReviewFindingRepository` 端口、`AdoptionStats` 聚合类型。
- `src/infrastructure/sqlite/review-finding-repo.ts`：建表外的读写实现，含 `insert`、`listByReview`、`listPendingTracking`、`updateOutcome`、`getAdoptionStats`。
- `src/application/adoption-tracker.ts`：`createAdoptionTracker(deps)` 返回 `runOnce()` 与 `start(intervalMs)`；内部完成重定位与判定。
- `src/interfaces/http/api/reviews.ts`：新增 `GET /adoption`，复用现有鉴权。
- `src/domain/review-task.ts`：`GitlabClient` 增加 `getFileRaw`，`Discussion.notes` 增加 `resolvable` / `resolved`。

### 数据模型

#### 接近实现的模型代码

```ts
/**
 * 一条被评审的建议及其后续采纳判定。
 *
 * 为什么存指纹而不只存行号：后续提交会插入/删除行，行号随之漂移；
 * 只有被评论行的文本能在新版本中稳定定位同一处代码。
 */
export interface ReviewFinding {
  id: number;
  /** 关联的评审记录；降级进汇总的建议同样有记录。 */
  recordId: number;
  projectId: number;
  mrIid: number;
  /** 行内评论的幂等标记，形如 `<!-- marker:{head_sha}:{id} -->`。 */
  marker: string;
  /** 建议在当前批次中的编号，来自模型输出。 */
  findingId: string;
  severity: string;
  path: string;
  line: number;
  lineKey: "new_line" | "old_line";
  /** 评审时的版本坐标，用于判断是否已有新提交。 */
  baseSha: string;
  headSha: string;
  /**
   * 被评论行的规范化文本哈希；空串表示该建议未成功发布行内评论
   * （降级并入汇总），无法追踪。
   */
  codeFingerprint: string;
  /** GitLab 讨论与评论 ID，用于回查解决状态；未发布时为空。 */
  discussionId: string | null;
  noteId: number | null;
  outcome: FindingOutcome;
  /** 最近一次判定时间；未判定为 null。 */
  trackedAt: number | null;
  createdAt: number;
}

/** 采纳判定的四态。`unknown` 不计入采纳率分母。 */
export type FindingOutcome = "pending" | "adopted" | "resolved-without-change" | "ignored" | "unknown";
```

#### 完整字段定义

使用上方模型代码作为唯一字段载体，本小节省略。

#### 字段与存储取舍

| 字段/数据 | 候选表示 | 最终选择 | 数据体积与读取方式 | 选择理由 | 证据 |
| --- | --- | --- | --- | --- | --- |
| `code_fingerprint` | 明文行文本 / 短哈希 | SHA-256 前 16 位十六进制 | 定长 16 字符，可索引 | 行文本可能含业务敏感内容，落库明文会扩大泄露面；短哈希足够抗碰撞 | D-003 |
| `outcome` | 布尔 `adopted` / 多值枚举 | TEXT 枚举 | 单行读取 | 四态能区分「解决但未改」这类需要人工复核的情况，布尔会丢失 | D-007 |
| 建议与记录的关联 | `review_records` 加 JSON 列 / 独立表 | 独立表 + `record_id` | 一对多，按外键关联 | 独立表可按严重级、路径建索引并直接聚合，JSON 列需全表解析 | D-002 |

#### 逻辑模型与物理存储

| 逻辑对象 | ORM/Schema 对象 | 物理表或存储 | 主键与关联键 | 证据 |
| --- | --- | --- | --- | --- |
| `ReviewFinding` | 无 ORM，`node:sqlite` 直连 | `review_findings` | `id` 自增；`record_id` 外键指向 `review_records` | `src/infrastructure/sqlite/database.ts:117` |

#### 继承字段与重复存储结论

项目无 ORM 与基类模型，`SCHEMA` 中每张表独立声明，无继承字段可复用。`project_id` / `mr_iid` 在 `review_findings` 中重复存储（`review_records` 已有），原因是追踪扫描需要直接按 MR 定位待处理项，避免每次都联表；该冗余由写入时同事务保证一致。

#### 索引、约束与软删除

- 主键 `id INTEGER PRIMARY KEY AUTOINCREMENT`
- 外键 `record_id REFERENCES review_records (id) ON DELETE CASCADE`（`PRAGMA foreign_keys = ON` 已在 `database.ts:123` 开启）
- 唯一约束 `UNIQUE (head_sha, marker)`：同一版本同一建议只落一行，重跑评审不会重复计数
- 索引 `idx_findings_tracking (outcome, tracked_at)`：服务定时器扫描待判定项
- 索引 `idx_findings_record (record_id)`：服务按记录查明细
- 索引 `idx_findings_project (project_id, created_at DESC)`：服务按项目聚合
- 无软删除：建议记录是审计事实，删除评审记录时随之级联删除

#### 查询模式与索引映射

| 查询模式 | 过滤/排序/关联字段 | 对应索引或访问路径 | 选择理由 | 证据 |
| --- | --- | --- | --- | --- |
| 定时扫描待判定 | `outcome = 'pending'` 且 `tracked_at IS NULL`，按 `created_at` 升序限量 | `idx_findings_tracking` | 只扫未判定项，随处理推进集合缩小 | D-005 |
| 单次评审明细 | `record_id = ?` | `idx_findings_record` | 外键等值查询 | `src/domain/review-record.ts:81` |
| 采纳率聚合 | 按 `project_id` / 提交人 / `severity` 分组计数 | `idx_findings_project` + 全表聚合 | 聚合需扫描命中区间，索引缩小扫描范围 | D-008 |

#### 生命周期数据归属

建议记录归属评审记录：评审记录写入成功后才写建议，评审记录被清理时级联删除。追踪只更新 `outcome` 与 `tracked_at`，不新增记录。

#### Migration 影响

只新增表与索引，`CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` 幂等，旧库启动时自动补齐，无数据迁移。回滚代码后新表闲置，不影响既有功能（`src/infrastructure/sqlite/database.ts:10` 已声明该约束）。

#### 技术栈专项结论

非 Django 项目，无 ORM。沿用 `node:sqlite` `DatabaseSync` 同步 API 与单连接模式（`src/infrastructure/sqlite/database.ts:110`），不引入查询构建器。字段类型使用 SQLite 动态类型下的 `INTEGER` / `TEXT`，时间统一存 Unix 毫秒 `INTEGER`，与现有表一致。

### 状态、并发与执行流程

**建议状态机**：`pending` →（追踪后）→ `adopted` / `resolved-without-change` / `ignored` / `unknown`。终态可被后续追踪覆盖（例如先 `ignored` 后又改代码），因此每次追踪都重新计算并更新 `tracked_at`。

**追踪执行流程**：

1. 定时器每 `ADOPTION_SYNC_INTERVAL_MS` 触发 `runOnce()`；同一时刻只允许一个实例运行（模块内布尔标志），避免重叠。
2. 取待追踪记录：`outcome = 'pending'` 或 `tracked_at` 早于「最近一次提交时间」的项，按 MR 聚合。
3. 对每个 MR：拉取最新提交列表与 `head_sha`；若 `head_sha` 与记录中的 `head_sha` 相同，说明没有新提交，跳过。
4. 拉取 discussions，建立 `marker → resolved` 映射。
5. 对每条建议：用 `getFileRaw` 取最新文件内容，按 `path` 找到目标行区间，在 `[line-3, line+3]` 窗口内搜索指纹匹配行（应对少量位移）。
6. 判定：找到且文本未变 → `ignored`（若 `resolved` 为真则 `resolved-without-change`）；文本变化或行被删除 → `adopted`；文件不存在或窗口内无匹配 → `unknown`。
7. 落库并记日志（项目、MR、建议数、各状态计数）。

**失败恢复**：任一步异常只记 `warn` 并保留原状态；下一次定时器重试。GitLab 限流时整轮跳过，不阻塞。

### 接口、权限与兼容边界

`GET /api/reviews/adoption`

查询参数：`from`、`to`（Unix 毫秒，可选）、`projectId`（可选）。

响应：

```ts
export interface AdoptionStats {
  /** 总体：可统计建议数、采纳数、采纳率（0-1，分母为 0 时为 null）。 */
  total: { tracked: number; adopted: number; rate: number | null };
  /** 不可统计条数：降级进汇总、无法定位等。 */
  untrackable: { fallback: number; unknown: number };
  byProject: { name: string; tracked: number; adopted: number; rate: number | null }[];
  byCommitter: { name: string; tracked: number; adopted: number; rate: number | null }[];
  bySeverity: { severity: string; tracked: number; adopted: number; rate: number | null }[];
}
```

权限：与其余 `/api` 接口一致，登录即可读，不额外要求 admin（`src/interfaces/http/app.ts:104` 统一挂鉴权）。

兼容边界：现有 `/api/reviews` 与 `/api/reviews/stats` 的响应结构不变；新增字段只出现在新接口。历史记录没有建议明细，统计自然只覆盖上线后数据，响应中通过 `untrackable` 与文档说明起点。

### 风险、迁移、发布、回滚与监控

| 具体失败场景 | 影响 | 预防或处理 | 发布/回滚/监控安排 | 证据 |
| --- | --- | --- | --- | --- |
| GitLab API 调用量增加（每条建议一次文件读取） | 触发限流，影响评审 | 同一 MR 只取一次文件内容并缓存；每轮限量处理 MR 数 | 观察 GitLab 429 日志；回滚只需设 `ADOPTION_TRACKING_ENABLED=false` | D-005、D-011 |
| 指纹定位失败（大重构、文件删除） | 该条记 `unknown`，不计入分母 | 允许 ±3 行窗口位移；仍失败则如实标记 | 统计接口单列 `unknown` 计数 | D-007 |
| 判定把「别人改动」当成采纳 | 采纳率虚高 | 只在该建议评审之后的新提交范围内判定；`head_sha` 相同则跳过 | 报告注明指标口径为代码变化率 | D-001 |
| 旧库升级 | 无数据迁移，启动自动建表 | `IF NOT EXISTS` 幂等 | 回滚代码后表闲置 | `database.ts:10` |
| 追踪影响服务启动 | 启动变慢或异常 | 追踪只在服务启动后由定时器驱动，不阻塞 `startServer` | 启动日志打印追踪开关与间隔 | D-012 |

**有意延后项**：无。

### 验证方案

| 验证项 | 命令或操作 | 预期结果 | 覆盖的设计结论 | 证据 owner |
| --- | --- | --- | --- | --- |
| 指纹纯函数 | `node --test test/domain/review-finding.test.ts` | 空白差异不改变指纹；内容变化改变指纹 | D-003 | 本节 |
| 仓储读写与幂等 | `node --test test/infrastructure/sqlite/review-finding-repo.test.ts` | 重复 marker 不产生两行；按 outcome 扫描正确 | D-002 | 本节 |
| 追踪判定四态 | `node --test test/application/adoption-tracker.test.ts` | 未变→ignored、变化→adopted、解决未变→resolved-without-change、找不到→unknown | D-001、D-007 | 本节 |
| 统计接口 | `node --test test/interfaces/http/adoption.test.ts` | 采纳率与不可统计计数正确；无数据时 rate 为 null | D-008 | 本节 |
| webhook 分流 | `node --test test/interfaces/http/webhook.test.ts` | `update` + `oldrev` 入追踪；其他事件维持原行为 | D-004 | 本节 |
| 全量回归 | `npm test` | 全部通过 | 全部 | 本节 |
| 类型检查 | `npm run typecheck` | 通过 | 全部 | 本节 |
