# GitLab 行内评论与管理控制台 — 后端技术方案设计

## 第一部分：架构决策

### Decision Ledger

| ID | Decision | Source | Blocking | Status | Evidence / explicit confirmation |
| --- | --- | --- | --- | --- | --- |
| D-001 | 依赖方向保持 interfaces → application → domain，infrastructure 实现 domain 端口 | `src/domain/review-task.ts:1-7` | no | `code-verified` | 领域层文件头注释明确「不依赖任何外层，所有实现由 infrastructure 注入」 |
| D-002 | 组合根单点装配，新增装配集中在 bootstrap | `src/bootstrap.ts:44-70` | no | `code-verified` | `main()` 内完成 queue/client/rules/reviewer/pipeline 的构建与注入 |
| D-003 | 持久化用 Node 22 内置 `node:sqlite` 的 `DatabaseSync`，需处理 ExperimentalWarning | `package.json` engines `node>=22.19.0`；本地实测脚本输出 | yes | `code-verified` | 实测 `insert` 返回 `{lastInsertRowid, changes}`、`get` 返回行对象、`run().changes` 可用；同时输出 ExperimentalWarning |
| D-004 | 行内评论定位完全对齐 auto-ops 参考实现：拉 `/versions` 取最新 diff version 的三个 SHA，解析 diff 计算 added/removed 行号集，AI 输出 JSON（path + new_line 或 old_line），服务端校验后拼 position | 参考实现 `D:\02-canway\01-code\auto-ops\.claude\skills\code-review\scripts\gitlab_mr_review.py:93-142, :332-343` | yes | `user-confirmed` | D-004: selected A「完全对齐参考实现」；用户消息「A. 完全对齐参考实现（推荐）」 |
| D-005 | 幂等 marker + 发布后校验：每条评论正文尾部追加 `<!-- marker:{head_sha}:{id} -->`，发布前查重跳过，发布后重新拉 discussions 校验 marker、路径与行号 | 参考实现 `gitlab_mr_review.py:269-275, :280-331, :361-394` | yes | `user-confirmed` | D-005: selected A「幂等 marker + 发布后校验」；用户消息「A. 幂等 marker + 发布后校验（推荐）」 |
| D-006 | AI 输出采用 JSON 结构化格式，schema 与参考实现一致：`reviewed_head_sha` + `summary.body` + `findings[]`，每个 finding 的 `new_line` 与 `old_line` 二选一 | 参考实现 `references/review.schema.json:1-70` | yes | `user-confirmed` | D-006: selected A「JSON 结构化输出」；用户消息「A. JSON 结构化输出（推荐，与参考一致）」 |
| D-007 | 评审记录用单张明细表，基础统计用 SQL 实时聚合 | user answer | yes | `user-confirmed` | D-007: selected A「单张明细表，统计用 SQL 实时聚合」；用户消息「A. 单张明细表，统计用 SQL 实时聚合（推荐）」 |
| D-008 | 会话机制用 Bearer 令牌 + 前端 localStorage 存储 | user answer | yes | `user-confirmed` | D-008: selected C「Bearer 令牌 + localStorage」；用户消息「C. Bearer 令牌 + localStorage」 |
| D-009 | 令牌用不透明随机串，不建会话表，不实现踢下线（最简实现） | user answer | yes | `user-confirmed` | D-009: 用户消息「最简单实现，不需要踢下线功能」 |
| D-010 | 密码哈希用 scrypt，盐为 SHA256(用户名 + 环境变量固定盐)，不新增字段 | user answer | yes | `user-confirmed` | D-010: selected A「盐 = SHA256(用户名 + 固定盐)」；用户消息「A. 盐 = SHA256(用户名 + 固定盐)（推荐）」 |
| D-011 | 首次启动无管理员时，用环境变量 `ADMIN_USERNAME` / `ADMIN_PASSWORD` 创建首个账号 | user answer | yes | `user-confirmed` | D-011: selected A「环境变量引导创建」；用户消息「A. 环境变量引导创建（推荐）」 |
| D-012 | 环境变量管理全部项可改，密钥类字段回显为掩码 | user answer | yes | `user-confirmed` | D-012: selected B「全部可改，密钥回显为掩码」；用户消息「B. 全部可改，密钥回显为掩码」 |
| D-013 | 前端视觉来源按 Element Plus 组件库规范推导，不启动 Figma 或截图链路 | user answer | yes | `user-confirmed` | D-013: selected A「按 Element Plus 组件库规范推导」；用户消息「A. 按 Element Plus 组件库规范推导（推荐）」 |
| D-014 | 配置保存后立即生效：写入 DB 覆盖表并同步 `process.env`，接口标注哪些项需重启 | user answer | yes | `user-confirmed` | D-014: selected A「立即生效（DB + process.env 同步），并标注哪些项需重启」；用户消息「A. 立即生效（DB + process.env 同步），并标注哪些项需重启（推荐）」 |
| D-015 | prompt 删除即删除，被删项目回落到 default prompt，无软删除 | user answer | yes | `user-confirmed` | D-015: selected A「删除即删除，回落到 default」；用户消息「A. 删除即删除，回落到 default（推荐）」 |
| D-016 | 前端构建产物输出到 `web/dist`，Express 静态托管并做 SPA fallback | user answer | yes | `user-confirmed` | D-016: selected A「构建产物输出到 web/dist，Express 静态托管」；用户消息「A. 构建产物输出到 web/dist，Express 静态托管（推荐）」 |
| D-017 | GitLab 客户端在现有 `GitlabClient` 端口上扩展 3 个方法，不新建独立端口 | 参考实现 `gitlab_mr_review.py:128-155`；现有 `src/domain/review-task.ts:60-71` | yes | `user-confirmed` | 方案对比后用户消息「确认方案并授权写入」：与现有三个方法同属 GitLab MR API 调用并共用 request 封装，拆两个端口会导致同一 HTTP 封装实例化两次 |
| D-018 | SQLite 并发策略：单连接 + WAL + busy_timeout | `node:sqlite` 本地实测；`QUEUE_CONCURRENCY` 默认 5 | yes | `user-confirmed` | 方案对比后用户消息「确认方案并授权写入」：Node 单线程事件循环串行化 JS 侧同步 SQL，WAL + busy_timeout 足以覆盖队列并发 |

### 决策 1：行内评论定位方案

- **ID**：`D-004`
- **选择**：拉 `/versions` 取最新 diff version 的 `base_sha`/`start_sha`/`head_sha`，解析 diff 计算合法行号集，AI 输出 JSON（path + new_line 或 old_line），服务端校验后拼 position
- **理由**：GitLab Discussions API 的 position 必须携带三个 SHA 与文件路径、行号。SHA 属于 MR 的版本信息而非 AI 可推导的内容，让模型输出 SHA 会把易错信息引入 prompt。参考实现已验证该路径可行（`gitlab_mr_review.py:131-142` 取 versions[0]）。同时 `parse_diff_lines` 逐 hunk 跟踪 `@@` 计数器算出 added/removed 集合（`:93-125`），是「行号是否落在 diff 变更行上」的唯一可靠判据——直接用 AI 给的行号而不校验，GitLab 会返回 400。
- **来源**：参考实现代码 + 本轮用户确认
- **状态**：`user-confirmed`
- **是否阻塞**：是

### 决策 2：幂等与发布后校验

- **ID**：`D-005`
- **选择**：每条评论正文尾部追加 marker，发布前拉已有 notes/discussions 跳过已存在项，发布后重新拉 discussions 校验 marker、路径与行号
- **理由**：webhook 可能重复触发（如 GitLab 重试、人工点 Test），无幂等会让同一 MR 刷屏。发布成功不等于定位正确——GitLab 接受 position 后可能锚定到相邻行，只有回读校验才能发现。参考实现把这两步作为固定环节（`:280, :310-331, :357`）。代价是每次评审多 2 次 API 调用（查 discussions、发后回读），在单次评审已需分钟级模型调用的前提下可忽略。
- **来源**：参考实现代码 + 本轮用户确认
- **状态**：`user-confirmed`
- **是否阻塞**：是

### 决策 3：AI 输出格式

- **ID**：`D-006`
- **选择**：JSON 结构化输出，schema 与参考实现一致
- **理由**：JSON 可用 JSON Schema 严格校验（参考实现已有 `references/review.schema.json`），其中 `oneOf` 强制 `new_line` 与 `old_line` 互斥、`additionalProperties: false` 禁止意外字段。Markdown 内嵌标记块无法做等价约束，解析失败时难以区分「模型没按格式输出」与「格式本身有歧义」。
- **来源**：参考实现 schema + 本轮用户确认
- **状态**：`user-confirmed`
- **是否阻塞**：是

### 决策 4：数据模型与统计方式

- **ID**：`D-007`
- **选择**：单张明细表，统计用 SQL 实时聚合
- **理由**：proposal 承诺「每次评审一条明细 + 基础统计」。单表 + `GROUP BY` 满足两个查询模式，且新增统计维度（如按分支、按 severity）无需改表或双写。物化汇总表需要维护双写一致性，而评审写入频率低（每 MR 一次），实时聚合的代价可接受——在十万级记录前 `COUNT`/`AVG` 走索引或全表扫描都在毫秒级。
- **来源**：本轮用户确认
- **状态**：`user-confirmed`
- **是否阻塞**：是

### 决策 5：会话与令牌

- **ID**：`D-008`、`D-009`
- **选择**：Bearer 令牌 + 前端 localStorage；令牌为不透明随机串，不建会话表，不实现踢下线
- **理由**：按用户明确要求取最简实现。无会话表意味着不引入 `sessions` 表、过期时间字段与清理逻辑，令牌校验退化为「查 admins 表 + 比对哈希」，一次数据库查询完成。已知代价：无法主动踢下线，管理员改密码后旧令牌仍有效直到进程重启；该代价已在风险表登记。
- **来源**：本轮用户确认
- **状态**：`user-confirmed`
- **是否阻塞**：是

### 决策 6：密码哈希

- **ID**：`D-010`
- **选择**：scrypt + SHA256(用户名 + 固定盐)
- **理由**：`node:crypto` 内置 scrypt，无需新增依赖。固定盐由「用户名 + 环境变量盐」组合而成，使不同用户即使密码相同也产生不同哈希（因为盐含用户名），同时避免为每个账号存随机盐字段。当 admins 表只有个位数到几十行时，per-user 随机盐的收益（抵抗彩虹表）远小于为此多一个字段与迁移路径的成本。
- **来源**：本轮用户确认
- **状态**：`user-confirmed`
- **是否阻塞**：是

### 决策 7：环境变量管理的生效语义

- **ID**：`D-012`、`D-014`
- **选择**：全部项可改，密钥掩码回显；保存后写入 DB 覆盖表并同步 `process.env`，接口标注哪些项需重启
- **理由**：P-005 已确认「DB 存覆盖值，启动时 DB 优先」，D-014 补齐运行期语义。同步写 `process.env` 让下次读取即拿到新值（评审管线的超时、并发数、分批预算都是每次评审读取），避免用户改完配置必须重启容器。启动期一次性绑定的值（`PORT`、`LOG_FILE`、`PI_CODING_AGENT_DIR`）无法热更新，接口需明确标注。密钥可写但掩码回显是用户明确选择，代价记入风险表。
- **来源**：proposal 台账 P-005 + 本轮用户确认
- **状态**：`user-confirmed`
- **是否阻塞**：是

### 决策 8：SQLite 并发与连接策略

- **ID**：`D-018`
- **选择**：单连接 + WAL + busy_timeout
- **理由**：Node 单线程事件循环下，同一时刻只有一个同步 SQL 在执行，`node:sqlite` 的 `DatabaseSync` 是同步 API，不存在 JS 层并发写冲突。`QUEUE_CONCURRENCY=5` 意味着最多 5 个评审并发，但它们写记录的时刻在事件循环上仍是串行的。WAL 提升读写并发（读不阻塞写），`busy_timeout=5000` 兜住多进程场景（如同时跑导入脚本）。每请求开连接会引入连接开销且更易触发 busy，不采用。
- **来源**：本轮用户确认 + `node:sqlite` 实测
- **状态**：`user-confirmed`
- **是否阻塞**：是

### Pre-write Confirmation Evidence

- Covered IDs: `D-001`, `D-002`, `D-003`, `D-004`, `D-005`, `D-006`, `D-007`, `D-008`, `D-009`, `D-010`, `D-011`, `D-012`, `D-013`, `D-014`, `D-015`, `D-016`, `D-017`, `D-018`
- Outstanding blocking decisions: `none`
- Explicit user authorization to write: 用户消息「确认方案并授权写入」，批准范围为 small form 的 `design/backend.md` 与 `design/frontend.md`，以及 metadata-only 的 `design/00-index.md`；同时批准 GitlabClient 端口扩展方式、SQLite 单连接 WAL 策略与四张表结构。无 conversion 或 removal 动作。

## 第二部分：技术方案详述

### 设计范围适用性

| 评审范围 | 要求 | Canonical owner section | 证据或不适用理由 |
| --- | --- | --- | --- |
| 架构主线 | 必填 | `#架构主线` | proposal 已确认；现有 `src/bootstrap.ts:44-70` 装配链 |
| 核心对象与职责 | 必填 | `#核心对象与职责` | domain 端口与 infrastructure 实现边界见 `src/domain/review-task.ts:60-71` |
| 数据模型 | 条件适用 | `#数据模型` | 适用：proposal 变更点 5-6、8、10、13 明确需要持久化 |
| 状态、并发与执行流程 | 条件适用 | `#状态、并发与执行流程` | 适用：评审管线新增行内评论发布与记录写入，涉及外部调用与失败降级 |
| 接口、权限与兼容边界 | 条件适用 | `#接口、权限与兼容边界` | 适用：新增五组管理 API 与 Bearer 鉴权 |
| 前端方案 | 条件适用 | `design/frontend.md` | 跨端 owner 在前端文档；本端只记录 API 契约供其消费 |
| 风险、迁移、发布、回滚与监控 | 必填 | `#风险、迁移、发布、回滚与监控` | Bearer 无状态化的代价、WAL 限制、镜像体积变化均需登记 |
| 验证方案 | 必填 | `#验证方案` | 现有验证入口 `npm run typecheck` 与 `npm test` |

### 架构主线

后端主线分三条，按评审请求的触发顺序衔接。

**评审主线（webhook 触发）**：GitLab 发送 `merge_request` 事件 → 现有 webhook 路由解析任务并入队（`src/interfaces/http/app.ts:39-82`，此路径不变）→ 评审管线在评审开始时先从数据库按项目取 prompt（`review-prompts` 表），数据库无记录时回落 `default` 记录，再回落 `default.yaml` 与 Markdown 兜底 → 拉取 MR 的 `/versions` 取最新 diff version 的三个 SHA，同时拉 `/changes` 得变更集 → 逐批评审，每批的 AI 输出按 JSON schema 解析（`D-006`）→ 汇总阶段合并各批结果 → 用 `parse_diff_lines` 计算的行号集校验每条 finding 的行号（`D-004`）→ 校验通过且 `reviewed_head_sha` 与当前 head 一致的 finding 逐条发行内评论，带 marker 幂等（D-005`）；不可定位或校验失败的 finding 并入汇总评论 → 汇总评论剔除已成功发行内评论的条目后发布 → 无论成败都写一条 `review_records` 明细。

**管理主线（前端触发）**：前端携带 Bearer 令牌请求 `/api/*` → 鉴权中间件比对令牌与 `admins` 表的密码哈希派生值 → 通过后进入五组路由之一 → 路由调用 domain 端口，端口由 `src/infrastructure/sqlite/` 的 `node:sqlite` 实现 → 结果以 JSON 返回。

**配置生效主线**：进程启动时先读 `process.env`，再读 `config_overrides` 表并覆盖到 `process.env`，使 DB 值优先（P-005）。运行期页面保存配置时同步写表与 `process.env`（`D-014`）。

复用现有代码的部分：webhook 解析、任务队列、GitLab 请求封装与错误语义、分批评审与汇总编排、规则渲染纯函数、配置读取的正整数与布尔校验。全部新增能力以「新增 domain 端口 + 新增 infrastructure 实现 + 新增路由」的方式接入，不改动既有评审主线的调用顺序。

### 核心对象与职责

| 对象/模块 | 职责 | 不负责 | 协作对象 | 证据 |
| --- | --- | --- | --- | --- |
| `GitlabClient`（扩展后） | 拉取 MR 变更、提交、diff version；发布汇总 note；发布与回读行内 discussion | 不解析 diff 行号，不构造 position 之外的业务判断 | `review-pipeline` 调用 | `src/domain/review-task.ts:67-71`；`D-017` |
| `parseDiffLines`（领域纯函数） | 逐 hunk 跟踪 `@@` 计数器，产出 added/removed/visible_new/visible_old 四组行号集 | 不发起任何 IO，不校验 finding | `review-pipeline` 调用 | 参考实现 `gitlab_mr_review.py:93-125` |
| `parseReviewJson`（领域纯函数） | 解析 AI 输出的 JSON，校验 `new_line`/`old_line` 互斥、路径非空、行号为正整数 | 不判断行号是否落在 diff 上（交 `parseDiffLines` 结果判断） | `review-pipeline` 调用 | `D-006`；参考实现 `review.schema.json` |
| `ReviewRecordRepository`（domain 端口） | 评审明细的写入与查询、统计聚合 | 不决定何时写入 | `review-pipeline` 写，管理 API 读 | `D-007` |
| `AdminRepository`（domain 端口） | 管理员账号的增删查、密码哈希校验 | 不生成令牌 | `auth` 路由、`admins` 路由 | `D-008`~`D-011` |
| `ConfigRepository`（domain 端口） | 配置覆盖值的读写与启动期应用 | 不校验配置值的合法性（复用 `shared/config.ts` 的校验函数） | `bootstrap` 启动、`config` 路由 | `D-012`、`D-014` |
| `PromptRepository`（domain 端口） | 按项目读 prompt、页面侧增删改查 | 不做 prompt 内容渲染 | `review-pipeline` 读，管理 API 读写 | `D-015`；现有 `src/infrastructure/rules/review-rules.ts:47-102` 行为迁移 |
| `hashPassword` / `verifyPassword`（shared 纯函数） | scrypt 加盐哈希与比对 | 不生成令牌 | `AdminRepository` 实现调用 | `D-010` |
| `issueToken` / `verifyToken`（shared 纯函数） | 生成随机令牌、比对令牌与账号 | 不做过期与踢下线（已明确不做） | `auth` 路由 | `D-008`、`D-009` |

### 后端模块设计

```
src/
├── domain/
│   ├── review-task.ts          修改：GitlabClient 端口新增 3 个方法；新增 DiffRefs、DiscussionPosition 类型
│   ├── inline-comment.ts       新增：parseDiffLines、parseReviewJson、buildPosition、marker（纯函数，零 IO）
│   ├── review-record.ts        新增：ReviewRecord 类型与 ReviewRecordRepository 端口
│   ├── admin.ts                新增：Admin 类型、AdminRepository 端口
│   ├── runtime-config.ts       新增：ConfigOverrideRepository 端口、可热更新项清单
│   └── review-prompt.ts        新增：StoredPrompt 类型与 PromptRepository 端口
├── application/
│   └── review-pipeline.ts      修改：prompt 改为按需读库；新增行内评论发布、汇总去重、记录写入编排
├── infrastructure/
│   ├── gitlab/gitlab-client.ts 修改：实现 versions、discussions 发布、discussions 回读
│   ├── sqlite/
│   │   ├── database.ts         新增：打开连接、建表、PRAGMA 设置
│   │   ├── review-record-repo.ts 新增
│   │   ├── admin-repo.ts       新增
│   │   ├── config-repo.ts      新增
│   │   └── prompt-repo.ts      新增
│   └── rules/review-rules.ts   修改：规则来源改为数据库，文件读取降级为初始导入与兜底
├── interfaces/http/
│   ├── app.ts                  修改：挂载 /api 路由组、鉴权中间件、静态资源
│   ├── auth-middleware.ts      新增：Bearer 令牌校验
│   └── api/
│       ├── auth.ts             新增：登录、登出、当前管理员
│       ├── admins.ts           新增：账号列表、新增、删除
│       ├── config.ts           新增：配置查询与更新
│       ├── prompts.ts          新增：prompt 列表、查询、新增、编辑、删除、导入
│       └── reviews.ts          新增：评审记录查询与统计
├── shared/
│   ├── config.ts               修改：新增 DB 路径、管理员引导、盐值配置项
│   ├── crypto.ts               新增：scrypt 哈希、令牌生成与比对
│   └── static-assets.ts        新增：静态资源托管与 SPA fallback
└── bootstrap.ts                修改：初始化数据库、注入仓储、挂载 API 与静态资源
```

`docker-compose.yml` 新增数据库卷；`scripts/import-prompts.ts` 新增一次性导入；`.env.example` 与 `README.md` 同步新配置项。

### 数据模型

技术栈为 `node:sqlite` 的 `DatabaseSync`（同步 API，无 ORM），因此以完整字段定义表作为唯一字段载体，不提供 ORM 模型代码。

#### 完整字段定义

**表 `review_records`**

| 字段 | 类型 | 必填/空值 | 默认值 | 关联/约束 | 证据 |
| --- | --- | --- | --- | --- | --- |
| `id` | INTEGER | 必填 | 自增 | PRIMARY KEY | `D-003` |
| `project_id` | INTEGER | 必填 | — | — | proposal 变更点 6 |
| `project_name` | TEXT | 必填 | — | — | proposal 变更点 6 |
| `mr_iid` | INTEGER | 必填 | — | — | proposal 变更点 6 |
| `committer_name` | TEXT | 必填 | — | — | proposal 变更点 6 |
| `change_count` | INTEGER | 必填 | — | — | proposal 变更点 6 |
| `batch_count` | INTEGER | 必填 | — | — | proposal 变更点 6 |
| `score` | INTEGER | 可空 | NULL | 无分数时为 NULL，与 0 分区分 | 现有 `parseReviewScore` 无匹配返回 0（`src/domain/review-rules.ts:27-35`），需区分「零分」与「未解析出分数」 |
| `duration_ms` | INTEGER | 必填 | — | — | proposal 变更点 6 |
| `result` | TEXT | 必填 | — | 取值 `success` / `failed` | proposal 变更点 6「最终结果（成功或失败原因）」 |
| `error_message` | TEXT | 可空 | NULL | 仅 `result=failed` 时有值 | proposal 变更点 6 |
| `comment_url` | TEXT | 可空 | NULL | 汇总评论发布后回填 | proposal 变更点 6「评论链接」 |
| `started_at` | INTEGER | 必填 | — | Unix 毫秒 | proposal 变更点 6 |
| `finished_at` | INTEGER | 必填 | — | Unix 毫秒 | proposal 变更点 6 |

**表 `admins`**

| 字段 | 类型 | 必填/空值 | 默认值 | 关联/约束 | 证据 |
| --- | --- | --- | --- | --- | --- |
| `id` | INTEGER | 必填 | 自增 | PRIMARY KEY | `D-011` |
| `username` | TEXT | 必填 | — | UNIQUE | `D-011`；proposal 变更点 9「校验用户名唯一与非空」 |
| `password_hash` | TEXT | 必填 | — | 格式 `scrypt$<saltHex>$<hashHex>` | `D-010` |
| `created_at` | INTEGER | 必填 | — | Unix 毫秒 | `D-011` |

**表 `config_overrides`**

| 字段 | 类型 | 必填/空值 | 默认值 | 关联/约束 | 证据 |
| --- | --- | --- | --- | --- | --- |
| `key` | TEXT | 必填 | — | PRIMARY KEY | `D-012` |
| `value` | TEXT | 可空 | NULL | 空串表示清空该覆盖、回落到环境变量 | `D-014` |
| `updated_at` | INTEGER | 必填 | — | Unix 毫秒 | `D-014` |

**表 `review_prompts`**

| 字段 | 类型 | 必填/空值 | 默认值 | 关联/约束 | 证据 |
| --- | --- | --- | --- | --- | --- |
| `id` | INTEGER | 必填 | 自增 | PRIMARY KEY | `D-015` |
| `repository` | TEXT | 必填 | — | UNIQUE，`default` 为保留值 | 现有匹配规则以 `default.yaml` 为全局默认（`src/infrastructure/rules/review-rules.ts:62-65`） |
| `system_prompt` | TEXT | 必填 | — | — | 现有 `RuleSet.systemPrompt`（`src/domain/review-rules.ts:11-13`） |
| `user_prompt` | TEXT | 必填 | — | 含 `{diffs_text}` / `{commits_text}` 占位符 | 现有 `RuleSet.userPrompt` |
| `wecom_webhook_url` | TEXT | 可空 | NULL | — | 现有 `RuleSet.wecomWebhookUrl` |
| `wecom_score_threshold` | INTEGER | 可空 | NULL | — | 现有 `RuleSet.wecomScoreThreshold` |
| `updated_at` | INTEGER | 必填 | — | Unix 毫秒 | `D-016` 语义：保存即生效 |

#### 字段与存储取舍

| 字段/数据 | 候选表示 | 最终选择 | 数据体积与读取方式 | 选择理由 | 证据 |
| --- | --- | --- | --- | --- | --- |
| `score` | INTEGER 存 0 表示无分数 / INTEGER 存 NULL | INTEGER + NULL | 单值读取，无额外开销 | 现有 `parseReviewScore` 无匹配时返回 0（`src/domain/review-rules.ts:27-35`），而 0 分与「未解析出分数」在统计上必须区分：前者应计入平均分，后者不应把平均值拉低 | `src/domain/review-rules.ts:27-35` |
| 时间字段 | ISO 字符串 / Unix 毫秒 INTEGER | INTEGER | 排序与范围过滤直接走索引 | Unix 毫秒可直接比较与排序，ISO 字符串需字典序比较；现有代码统一用 `Date.now()`（如 `src/application/review-pipeline.ts:46`），转换成本为零 | `src/application/review-pipeline.ts:46` |
| prompt 正文 | 单表 TEXT 列 / 独立表 + 外键 | 单表 TEXT 列 | 单条读，随评审一次性取出 | prompt 无版本历史需求（`D-015` 明确删除即删），拆表只增加一次 JOIN 而无收益 | `D-015` |
| 统计结果 | 物化汇总表 / 实时聚合 | 实时聚合 | 全表扫描 + GROUP BY | 写入频率为每 MR 一次，读取频率远低于写入；十万级记录下聚合仍在毫秒级，省掉双写一致性维护 | `D-007` |
| 密码哈希 | 纯哈希 / 带盐前缀的哈希串 | `scrypt$<saltHex>$<hashHex>` 单列 | 单值比对 | 盐内嵌于哈希串，校验时无需额外字段即可取出盐重算；固定盐由环境变量提供（`D-010`），不在库中存储 | `D-010` |
| 会话 | `sessions` 表 / 无状态令牌 | 无状态令牌 | 无存储 | 用户明确不要踢下线功能，最简实现不建表 | `D-009` |

#### 逻辑模型与物理存储

| 逻辑对象 | ORM/Schema 对象 | 物理表或存储 | 主键与关联键 | 证据 |
| --- | --- | --- | --- | --- |
| 评审明细 | 无 ORM，`DatabaseSync` 直接执行 SQL | `review_records` | `id` 自增主键，无外键（记录是历史快照，项目删除不影响记录） | `D-003` |
| 管理员账号 | 无 ORM | `admins` | `id` 自增主键，`username` 唯一 | `D-003` |
| 配置覆盖 | 无 ORM | `config_overrides` | `key` 文本主键 | `D-003` |
| 评审 prompt | 无 ORM | `review_prompts` | `id` 自增主键，`repository` 唯一 | `D-003` |

无 ORM 层：项目当前无任何持久化依赖，`node:sqlite` 是同步 API，四张表的 SQL 语句数量可控（每表 2-4 条）。引入 ORM 需要新增依赖且无法复用任何现有代码，收益不匹配。

#### 继承字段与重复存储结论

不适用。项目无 ORM 基类、manager 或 mixin 概念，四张表彼此独立，无继承字段，也不存在重复存储。`review_records` 冗余存储 `project_name` 而非关联 `projects` 表，是有意的快照设计——评审记录需在项目改名或迁移后仍反映当时的名称。

#### 索引、约束与软删除

| 索引 | 字段 | 服务的查询 |
| --- | --- | --- |
| `idx_reviews_started_at` | `started_at DESC` | 默认列表排序（最新在前） |
| `idx_reviews_project` | `project_id` | 按项目筛选 |
| `idx_reviews_committer` | `committer_name` | 按提交人筛选 |
| `admins.username` | UNIQUE | 登录时按用户名查、创建时查重 |
| `review_prompts.repository` | UNIQUE | 评审时按项目查 prompt |

约束：四张表均无外键（记录表是独立快照；prompt 与 admins 无关联）。软删除：不使用（`D-015` 已确认 prompt 删除即删；评审记录按 proposal 变更点 7 只读不提供删除）。

排序：列表默认按 `started_at DESC`，`created_at`/`updated_at` 仅作展示。

#### 查询模式与索引映射

| 查询模式 | 过滤/排序/关联字段 | 对应索引或访问路径 | 选择理由 | 证据 |
| --- | --- | --- | --- | --- |
| 评审列表（默认） | `ORDER BY started_at DESC LIMIT/OFFSET` | `idx_reviews_started_at` | 深分页时 OFFSET 效率下降，但记录量级下可接受；不引入游标分页以避免超出 proposal 范围 | proposal 变更点 7「支持分页」 |
| 评审列表（按项目） | `WHERE project_id = ? ORDER BY started_at DESC` | `idx_reviews_project` + 排序 | 单列索引后仍需排序；在十万级记录下排序代价可接受 | proposal 变更点 7 |
| 评审列表（按提交人） | `WHERE committer_name = ? ORDER BY started_at DESC` | `idx_reviews_committer` | 同上 | proposal 变更点 7 |
| 评审列表（时间范围） | `WHERE started_at BETWEEN ? AND ? ORDER BY started_at DESC` | `idx_reviews_started_at` | 范围扫描直接命中索引 | proposal 变更点 7 |
| 统计聚合 | `COUNT` / `COUNT(DISTINCT project_id)` / `COUNT(DISTINCT committer_name)` / `AVG(score)` / 按日 `GROUP BY` | 全表扫描 | 统计无过滤条件，索引无法加速全表聚合；数据量级下可接受 | `D-007` |
| 登录校验 | `WHERE username = ?` | `admins.username` UNIQUE | 唯一索引即查找路径 | `D-008` |
| prompt 读取 | `WHERE repository = ?` | `review_prompts.repository` UNIQUE | 评审热路径，每次评审一次查询 | `D-016` |
| 配置启动加载 | 全表扫描 | 全表扫描 | 配置项个位数，无需索引 | `D-014` |

#### 生命周期数据归属

评审记录（含失败记录）由 `ReviewRecordRepository` 持有，随评审管线的一次 `run` 产生一条，无状态机。prompt 的「生效/不生效」不是状态字段，而是记录存在与否——删除后由回落链接管（`D-015`）。管理员账号无启用/禁用状态，`D-009` 明确不实现踢下线，因此不存在需要建模的会话生命周期。

#### Migration 影响

首次启动执行 `CREATE TABLE IF NOT EXISTS`，无版本化迁移框架。schema 演进策略：新增列使用 `ALTER TABLE ... ADD COLUMN`（SQLite 支持且不锁表）；删列或改类型需重建表，属本期范围外。回滚时旧代码忽略新表即可，无需数据迁移。纯元数据变化（如索引增删）不产生迁移。

#### 技术栈专项结论

非 Django 项目，无 ORM 模型、migration state、manager/mixin 或 `verbose_name` 议题。对应结论：SQLite 的 `PRAGMA` 设置在建表时一次性执行（WAL、busy_timeout、外键开关）；`DatabaseSync` 为同步 API，仓储方法均为同步，Express 路由中直接调用即可，无需处理 Promise 包装。ExperimentalWarning（`D-003` 实测可见）在启动时通过一次 `process.emitWarning` 抑制或忽略，避免污染日志文件。

### 状态、并发与执行流程

评审管线的一次 `run` 按以下顺序执行，任一环节失败都写入失败记录后结束（沿用现有语义，如 `src/application/review-pipeline.ts:54-60`）：

1. 读取或创建评审记录（`result` 暂为 `success` 占位，结束时更新）
2. 按项目从 `review_prompts` 取 prompt；未命中取 `repository='default'`；再未命中回落 `default.yaml` 与 Markdown 兜底
3. 拉取 `/versions`（取 `versions[0]` 的三个 SHA）与 `/changes`
4. 分批评审，每批 AI 输出按 JSON schema 解析；解析失败的批次其结果整体并入汇总
5. 汇总各批结果
6. 用 `parseDiffLines` 计算的 added/removed 集校验每条 finding；校验通过且 `reviewed_head_sha` 等于当前 `head_sha` 的逐条发行内评论（带 marker 幂等）
7. 汇总评论剔除已成功发行内评论的 finding 后发布，记录 `comment_url`
8. 写回 `score`、`duration_ms`、`finished_at`

失败与降级规则：

| 环节失败 | 行为 |
| --- | --- |
| 拉取 versions 或 changes 失败 | 记失败记录，结束（与现有拉取失败语义一致） |
| 单批评审失败 | 记失败记录，结束（与现有语义一致，`src/application/review-pipeline.ts:94-102`） |
| 单条 finding 行号校验不通过 | 该条并入汇总评论，其余 finding 继续发行内评论 |
| `reviewed_head_sha` 与当前 head 不一致 | 全部 finding 并入汇总评论，不发行内评论 |
| 单条行内评论发布失败 | 该条并入汇总评论，记录错误日志，其余继续 |
| 发布后校验不通过 | 记 warn 日志，不重复发布（marker 保证下次跳过） |
| 汇总评论发布失败 | 记失败记录，结束 |

并发：`QUEUE_CONCURRENCY` 默认 5，最多 5 个 `run` 并发。它们在事件循环上交错执行，`DatabaseSync` 的同步调用天然串行（`D-018`）。评审进行中不持有数据库连接的事务——单条 INSERT 无需显式事务。行内评论发布为逐条串行，避免同一 MR 的多条评论并发写入 GitLab。

幂等边界：marker 以 `head_sha` 为前缀，MR 有新提交后 head 变化，marker 随之变化，历史评论不会被误判为已发布——这与参考实现语义一致（`gitlab_mr_review.py:269-270`）。

### 接口、权限与兼容边界

**鉴权**：除 `POST /api/auth/login` 与 `GET /health` 外，所有 `/api/*` 要求 `Authorization: Bearer <token>`。中间件比对令牌派生值与 `admins` 表；失败返回 401。webhook 路由 `/review/webhook` 保持现有鉴权方式不变（`X-Gitlab-Token` 请求头，`src/interfaces/http/app.ts:67-72`）。

**路由契约**：

| 方法与路径 | 请求 | 响应 | 说明 |
| --- | --- | --- | --- |
| `POST /api/auth/login` | `{username, password}` | `{token, username}` | 校验失败返回 401，不区分「用户不存在」与「密码错误」 |
| `POST /api/auth/logout` | 无 | `{ok:true}` | 无状态令牌，前端清除 localStorage 即可；接口仅为语义完整 |
| `GET /api/auth/me` | 无 | `{username}` | 前端启动时校验本地令牌是否仍有效 |
| `GET /api/admins` | 无 | `[{id, username, created_at}]` | 不返回密码哈希 |
| `POST /api/admins` | `{username, password}` | `{id, username}` | 用户名重复返回 409；密码长度不足返回 400 |
| `DELETE /api/admins/:id` | 无 | `{ok:true}` | 删自己或删最后一个管理员返回 400（`D-004` proposal P-004） |
| `GET /api/reviews` | query：`project_id`、`committer`、`from`、`to`、`page`、`page_size`、`sort` | `{items, total, page, page_size}` | 默认按 `started_at` 倒序 |
| `GET /api/reviews/stats` | query：`from`、`to` | `{total, projectCount, committerCount, avgScore, daily[]}` | 实时聚合（`D-007`） |
| `GET /api/config` | 无 | `{items:[{key, value, masked, hotReloadable}]}` | 密钥类字段 `value` 返回掩码、`masked=true` |
| `PUT /api/config` | `{items:[{key, value}]}` | `{items:[...], restartRequired:[...]}` | 写入 DB 并同步 `process.env`；返回需重启的键列表（`D-014`） |
| `GET /api/prompts` | 无 | `[{id, repository, updated_at, ...}]` | 列表不含完整 prompt 正文 |
| `GET /api/prompts/:repository` | 无 | 完整记录 | — |
| `POST /api/prompts` | `{repository, system_prompt, user_prompt, wecom_webhook_url?, wecom_score_threshold?}` | 完整记录 | `repository` 重复返回 409 |
| `PUT /api/prompts/:id` | 同上（不含 repository） | 完整记录 | 保存即生效（`D-016`） |
| `DELETE /api/prompts/:id` | 无 | `{ok:true}` | 删除后该项目回落 default（`D-015`） |
| `POST /api/prompts/import` | 无 | `{imported, skipped}` | 从 `prompts/rules/*.yaml` 导入；`repository` 已存在则跳过 |

**掩码规则**（`D-012`）：值长度大于 8 时显示前 4 位与后 4 位，中间以 `****` 替代；否则全掩码。掩码判定依据是键名是否包含 `KEY`、`SECRET`、`TOKEN`、`PASSWORD`。

**可热更新项清单**（`D-014`）：`REVIEW_TIMEOUT_MS`、`REVIEW_BATCH_MAX_TOKENS`、`QUEUE_CONCURRENCY`、`REVIEW_STYLE`、`GITLAB_API_TIMEOUT`、`GITLAB_INSECURE_TLS`、`LOG_LEVEL` 在下次读取时生效；`PORT`、`HOST`、`LOG_FILE`、`REVIEW_PROMPT_PATH`、`REVIEW_RULES_DIR`、`ADMIN_USERNAME`、`ADMIN_PASSWORD`、`LLMGW_API_KEY` 需重启（其中 `LLMGW_API_KEY` 还需 pi 读取，故列入重启项）。

**兼容边界**：既有 `GET /health` 与 `POST /review/webhook` 的请求与响应结构完全不变。静态资源托管使用独立路径前缀，不占用 `/api` 与 `/review`。新增数据库为纯增量，代码回滚后旧版本忽略新表即可继续运行。

### 风险、迁移、发布、回滚与监控

| 具体失败场景 | 影响 | 预防或处理 | 发布/回滚/监控安排 | 证据 |
| --- | --- | --- | --- | --- |
| 前端存在 XSS 漏洞，令牌被 `localStorage` 中的脚本读取 | 攻击者可获得管理员权限 | 严格避免 `v-html` 渲染未转义内容；依赖 Content-Security-Policy 头 | 上线后通过日志中的异常登录行为观察 | `D-008` 的已知代价 |
| 管理员改密码后旧令牌仍有效（无会话表、无过期） | 旧持有者可继续访问管理接口，最长到进程重启 | 改密码接口在调用后提示「旧令牌需重启后失效」 | 以进程重启作为令牌失效点 | `D-009` 的已知代价 |
| 页面写入的密钥值被回显或记录到日志 | 密钥泄露 | 读取接口掩码返回；日志只记录键名不记录值；写接口的日志脱敏 | 监控日志中是否出现疑似密钥片段 | `D-012` 的已知代价 |
| 数据库文件放在网络文件系统 | WAL 模式不支持，可能报磁盘 I/O 错误 | 部署文档明确 DB 卷必须是本地盘 | 启动时若 PRAGMA 返回非 wal 则记 warn | `D-018` |
| MR 在评审进行中产生新提交 | `reviewed_head_sha` 与当前 head 不一致，findings 全部降级进汇总 | 发布前校验 head 一致，不一致则不发行内评论 | 记录降级次数以便评估是否需调整评审时机 | 参考实现 `gitlab_mr_review.py:194-198` |
| 行内评论定位到相邻行（GitLab 接受 position 但锚点偏移） | 评论位置错误，误导开发者 | 发布后回读 discussions 校验行号与路径，不一致记 warn | 统计校验失败次数 | `D-005` |
| 首次启动时 `prompts/rules/` 中的 yaml 未导入数据库 | 所有项目回落到 `default.yaml` 或 Markdown 兜底，评审规则不是预期版本 | 启动日志打印 prompt 来源（数据库命中 / default / 兜底）；提供导入接口 | 上线检查项：确认日志中 prompt 来源分布 | `D-015` |
| 前端构建链使 Docker 镜像体积与构建时间显著增加 | 构建变慢、镜像变大 | 前端构建独立阶段并利用层缓存；依赖用 lockfile 固定 | 记录构建时长基线 | `D-016` |
| `node:sqlite` 仍是实验特性，Node 版本升级可能改变 API | 升级 Node 后持久化层可能失效 | 锁 Node 版本；升级时单独验证 `DatabaseSync` 行为 | CI 中固定 Node 版本运行测试 | `D-003` 实测警告 |

有意延后项：会话过期与踢下线（`D-009`）——简化为无状态令牌，不实现会话表与过期机制；上限为「令牌在进程重启前一直有效」；触发条件为出现「管理员离职后需立即撤销其访问」的明确需求；升级方向为增加 `sessions` 表并按需加入过期时间与吊销接口。游标分页（评审列表深分页）——简化为 OFFSET 分页；上限为单页查询在十万级记录内响应正常；触发条件为实测 OFFSET 超过 1000 页时响应超过 1 秒；升级方向为改用基于 `started_at` 与 `id` 的游标分页。

### 验证方案

| 验证项 | 命令或操作 | 预期结果 | 覆盖的设计结论 | 证据 owner |
| --- | --- | --- | --- | --- |
| 类型检查 | `npm run typecheck` | 退出码 0 | 端口扩展与新模块的类型契约 | 本节 |
| 单元测试 | `npm test` | 全部通过 | `parseDiffLines`、`parseReviewJson`、`buildPosition`、marker 生成、密码哈希与令牌、各仓储 CRUD | 本节 |
| diff 行号解析 | 单元测试覆盖新增行、删除行、上下文行、多 hunk、`+++`/`---` 头 | 行号集与手算一致 | `D-004` | 本节 |
| 行内评论发布 | 注入假 `fetch`，断言 `/discussions` 请求体含 `position_type`、`base_sha`、`start_sha`、`head_sha`、`old_path`、`new_path` 与 `new_line`/`old_line` | 请求体字段齐全且互斥 | `D-004`、`D-017` | 本节 |
| 幂等行为 | 假 `fetch` 预置含 marker 的 discussion，断言不重复 POST | 不发起重复发布 | `D-005` | 本节 |
| 发布后校验 | 假 `fetch` 返回行号不一致的 discussion，断言记 warn | 校验失败可观察 | `D-005` | 本节 |
| 评审记录落库 | 跑一次失败路径的管线，断言 `review_records` 有一条 `result=failed` 且 `error_message` 非空 | 失败也落记录 | 变更点 6 | 本节 |
| 统计聚合 | 插入若干条记录后调用统计查询，断言总数、去重项目数、平均分与手算一致 | 聚合结果正确 | `D-007` | 本节 |
| 管理员删除约束 | 删除自己、删除最后一个管理员，断言返回 400 | 两个约束都生效 | proposal P-004 | 本节 |
| 鉴权 | 无令牌、错误令牌访问 `/api/reviews`，断言 401 | 未认证被拒绝 | `D-008` | 本节 |
| 配置生效 | 更新 `REVIEW_TIMEOUT_MS`，断言 `process.env` 已同步且响应标注不需重启；更新 `PORT`，断言标注需重启 | 生效语义正确 | `D-014` | 本节 |
| prompt 热生效 | 通过 API 修改 prompt，断言下一次 `rules.resolve` 返回新内容 | 无需重启即生效 | `D-016` | 本节 |
| prompt 导入 | 用现有 `prompts/rules/*.yaml` 跑导入，断言记录数与文件数一致、`default` 记录存在 | 导入完整 | `D-015` | 本节 |
| 静态资源托管 | 构建前端后访问 `/`，断言返回 HTML 且任意前端路由回落到 index | SPA fallback 生效 | `D-016` | 本节 |
| 容器内持久化 | `docker compose up` 后重启容器，断言记录与账号仍在 | 持久卷生效 | 变更点 12 | 本节 |
| 注释自审 | 对照本次 diff 检查新增公开对象有契约说明、非显然逻辑有原因注释 | 符合工程质量契约 | 共享工程质量契约 | 本节 |
