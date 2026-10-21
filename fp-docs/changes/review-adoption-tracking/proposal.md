# AI 评审建议采纳追踪

## Why

当前系统只记录「评审发生过」：评分、文件数、耗时、成败。没有人能回答「AI 提的问题到底有没有被改」——这个信息只存在于评审当下的 MR 评论里，事后无法聚合。

团队的真实诉求是评估 AI 评审的实际价值：如果绝大多数建议都被忽略，继续投入评审算力就没有依据；如果某类问题反复被忽略，说明提示词或规则需要调整。缺少采纳数据时，只能凭印象判断。

之所以现在做：行内评论已经带幂等标记 `<!-- marker:{head_sha}:{id} -->`（`src/domain/inline-comment.ts:159`），每条建议都能被唯一识别。这个锚点让「评论 → 建议 → 后续代码」的关联第一次成为可行，之前没有这个基础。

## What Changes

### 1. 评审时持久化每条建议

新增 `review_findings` 表，在行内评论发布成功时写入每条建议：项目、MR、marker、严重级、文件路径、行号、评审时的 `base_sha` / `head_sha`、讨论与评论 ID，以及**被评论行的代码指纹**。

指纹是对目标行文本做规范化（去首尾空白、压缩连续空白）后的哈希。它是后续判定的核心：行号会随后续提交漂移，只有行内容能稳定定位「AI 当时评论的是哪一行代码」。

同时记录该条建议是否成功发布了行内评论：发布失败会降级并入汇总评论（`src/application/review-pipeline.ts:726`），这类建议没有行锚点，必须与已发布项分开统计，否则分母失真。

### 2. 补齐讨论解决状态

GitLab 的 discussions 接口返回 `resolvable` 与 `resolved`，当前映射层把它们丢弃了（`src/infrastructure/gitlab/gitlab-client.ts:209`）。补齐后即可识别「研发点了已解决」。

这是采纳判定的辅助信号，不是主判据：点了已解决不代表真改了代码，反之也有人直接改代码不点解决。

### 3. 评审后追踪代码是否真的变化

拿到评审之后的新提交，对每条已发布建议重新定位目标行：

- 按 `path` 找文件，用指纹在新版本中定位目标行；
- 目标行文本变化或该行被删除 → 记为代码已变化；
- 目标行仍在且未变 → 记为未变化；
- 文件被删除或整体重构导致无法定位 → 记为 `unknown`，不做猜测。

判定结果结合解决状态落库，形成四态：已采纳、已解决但代码未变、未处理、无法判定。

### 4. 统计口径与页面呈现

采纳率 = 代码已变化的建议数 ÷ 已成功发布行内评论的建议数。同时单列不可统计条数（降级并入汇总、无法定位），避免用分母掩盖缺口。

在统计页新增采纳卡片，按项目和按提交人给出采纳率与趋势，并可按严重级看「哪类问题最容易被忽略」。

## Capabilities

### New Capabilities

- `review-finding-tracking`: 评审建议从「一次性评论」变为可追踪记录，带代码指纹与讨论状态
- `adoption-metrics`: 按项目、提交人、严重级统计采纳率与趋势，并显式区分不可统计部分

### Modified Capabilities

- `review-records`: 评审记录与建议明细建立关联，可从汇总下沉到单条建议
- `gitlab-discussions`: 讨论读取补齐 `resolvable` / `resolved` 字段
- `webhook-events`: 识别 MR 的 `update` 事件并区分「有新提交需追踪」与「需重新评审」

## Out of Scope

- 不判断「改动是否正确」：指纹只能证明目标行变了，不能证明改得对。因此指标命名为**代码变化率**，产品文案统一使用该措辞，不宣称「修复正确率」。
- 不做语义级 diff 判定或调用模型判断改动动机，成本高且不稳定。
- 不回溯历史数据：上线前的评审没有存指纹，无法补算，报告中说明起点时间。
- 不修改评审触发时机与并发策略。
- 不引入外部调度框架：追踪任务复用现有进程内队列与定时器。

## Impact

- `src/infrastructure/sqlite/database.ts` - 新增 `review_findings` 表与索引
- `src/domain/review-finding.ts` - 新增建议实体、指纹计算端口、追踪结果模型
- `src/infrastructure/sqlite/review-finding-repo.ts` - 新增仓储实现
- `src/application/review-pipeline.ts` - 行内评论成功后写入建议记录；指纹取被评论行文本
- `src/application/adoption-tracker.ts` - 新增追踪用例：拉取新提交、重定位、判定、落库
- `src/infrastructure/gitlab/gitlab-client.ts` - discussions 补齐 `resolvable` / `resolved`；补提交列表与文件 diff 读取能力
- `src/interfaces/http/app.ts` - webhook 区分 `update` 事件，有新提交时入追踪队列而非重复评审
- `src/interfaces/http/api/reviews.ts` - 新增采纳统计接口
- `src/bootstrap.ts` - 装配追踪用例、仓储与定时同步
- `src/shared/config.ts` - 新增追踪开关与同步间隔配置
- `web/src/views/StatsView.vue` - 新增采纳率卡片与排行
- `web/src/types.ts` - 采纳统计类型定义
- `scripts/build-openapi.ts` - 补采纳统计接口到 OpenAPI
- `docs/openapi.json` - 重新生成

### Handoff Decision Ledger

| ID | Decision | Source | Blocking | Status | Evidence / explicit confirmation |
| --- | --- | --- | --- | --- | --- |
| P-001 | 采纳判定采用「行内容指纹追踪」，而非仅依赖评论已解决状态 | user answer | yes | `user-confirmed` | P-001: selected 行内容指纹追踪方案; user message「该技术方案可行，用fp-start，切换一个分支，进行开发」 |
| P-002 | 指标命名为「代码变化率」，不宣称修复正确率 | assistant recommendation accepted by user blanket authorization | yes | `user-confirmed` | P-002: selected 代码变化率口径; user message「技术方案已定，其他不需要我确认，采用最佳推荐」 |
| P-003 | 不可统计部分（降级汇总、无法定位）单列，不计入分母 | assistant recommendation accepted by user blanket authorization | yes | `user-confirmed` | P-003: selected 单列不可统计; user message「技术方案已定，其他不需要我确认，采用最佳推荐」 |
| P-004 | 追踪调度复用进程内定时器，不引入外部调度框架 | assistant recommendation accepted by user blanket authorization | yes | `user-confirmed` | P-004: selected 复用进程内定时器; user message「技术方案已定，其他不需要我确认，采用最佳推荐」 |
| P-005 | 不回溯历史数据，统计起点为上线时刻 | assistant recommendation accepted by user blanket authorization | yes | `user-confirmed` | P-005: selected 不回溯历史; user message「技术方案已定，其他不需要我确认，采用最佳推荐」 |
| P-006 | 提案采用 small form（`proposal.md`） | `<artifact-layout §Split selection and safety limits>` 默认 small | yes | `code-verified` | P-006: 本提案预计远低于 500 行 / 30,000 字符，按契约默认 small form |
| P-007 | slug 为 `review-adoption-tracking` | user answer | yes | `user-confirmed` | P-007: selected review-adoption-tracking; user message「用fp-start，切换一个分支，进行开发」并在本会话分支名 `feature/review-adoption-tracking` 中确认 |

### Pre-write Confirmation Evidence

- Covered IDs: `P-001`, `P-002`, `P-003`, `P-004`, `P-005`, `P-006`, `P-007`
- Outstanding blocking decisions: `none`
- Explicit user authorization to write: 用户在本次会话给出「该技术方案可行，用fp-start，切换一个分支，进行开发。技术方案已定，其他不需要我确认，采用最佳推荐」，授权按上述已定方案写入 `fp-docs/changes/review-adoption-tracking/proposal.md`
