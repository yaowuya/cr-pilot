# GitLab 行内评论与管理控制台 — 开发设计评审

## 评审结论

**建议结论：有条件通过。** 设计的架构主线、数据模型、接口契约与前端方案完整，18 项决策全部终态且有确认凭据，行内评论的定位、幂等与校验机制直接复用已验证的参考实现（`D-02-canway/01-code/auto-ops` 的 code-review skill），技术风险可控。

需在计划或实现前确认的条件有三项：一是既有 `prompts/rules/*.yaml` 迁移到数据库的落地时序（未导入将导致所有项目回落到默认 prompt）；二是 Bearer 无状态令牌带来的「改密码后旧令牌需重启才失效」需在管理页面显式提示；三是前端构建链使 Docker 镜像体积与构建时间增加，需确认构建时长可接受。

| 评审面 | 结论 | 设计依据 |
| --- | --- | --- |
| 决策 | 共 18 项；阻塞 12 / 非阻塞 6；全部终态 | `design/backend.md#第一部分：架构决策`、`design/frontend.md#第一部分：架构决策` |
| 数据 | 新增 SQLite 四张表（评审明细、管理员、配置覆盖、评审 prompt） | `design/backend.md#数据模型` |
| 接口 | GitlabClient 端口新增 3 个方法；新增五组 `/api/*` 管理接口 | `design/backend.md#接口、权限与兼容边界` |
| 前端 | 新增 Vue 3 + Vite + Element Plus 管理前端，五个页面 | `design/frontend.md#页面与路由` |
| 不做事项 | 前端页面不含趋势图表；不做 CSRF/限流/审计日志；不做软删除与物化汇总表 | `proposal.md#out-of-scope`、`design/backend.md#风险、迁移、发布、回滚与监控` |

## 业务和技术主线

**评审主线**：GitLab `merge_request` 事件触发 → webhook 路由解析入队 → 评审管线按项目从数据库取 prompt（未命中回落 default，再回落 yaml 与 Markdown）→ 拉取 `/versions` 取最新 diff version 的三个 SHA 与 `/changes` 变更集 → 分批评审，每批 AI 输出按 JSON schema 解析 → 汇总各批 → 校验每条 finding 的行号是否落在 diff 变更行上且 `reviewed_head_sha` 与当前 head 一致 → 校验通过的逐条发行内评论（带 marker 幂等），其余并入汇总 → 汇总评论剔除已发行内评论的条目后发布 → 无论成败落一条评审明细。

**管理主线**：前端携带 Bearer 令牌请求 `/api/*` → 中间件比对令牌与 admins 表 → 五组路由之一 → domain 端口 → `node:sqlite` 实现 → JSON 返回。

**配置生效主线**：进程启动时先读环境变量再读数据库覆盖表（数据库优先）；运行期页面保存时同步写表与 `process.env`，下次读取即生效。

**最简可行方案与复用点**：设计对三类新增复杂度给出了当前必要性证据——行内评论未选择「AI 直接输出 SHA」而是由服务端取 versions，理由是 SHA 属版本信息不可由模型推导（`design/backend.md#决策 1`）；持久化未引入 ORM，理由是四张表 SQL 数量可控且无任何现有 ORM 代码可复用（`design/backend.md#逻辑模型与物理存储`）；会话未建表，理由是用户明确不要踢下线功能（`design/backend.md#决策 5`）。既有 webhook 解析、任务队列、GitLab 请求封装、规则渲染纯函数、配置校验函数全部复用，既有评审主线调用顺序不变。

## 核心对象与职责

| 对象/模块 | 职责 | 不负责 | 协作对象 | 设计依据 |
| --- | --- | --- | --- | --- |
| `GitlabClient`（扩展后） | 拉取变更、提交、diff version；发布汇总 note；发布与回读行内 discussion | 不解析 diff 行号，不做业务判断 | `review-pipeline` 调用 | `design/backend.md#核心对象与职责` |
| `parseDiffLines`（纯函数） | 逐 hunk 跟踪计数器，产出 added/removed/visible 行号集 | 不发起 IO，不校验 finding | `review-pipeline` 调用 | `design/backend.md#核心对象与职责` |
| `parseReviewJson`（纯函数） | 解析 AI 输出的 JSON，校验字段与行号互斥 | 不判断行号是否落在 diff 上 | `review-pipeline` 调用 | `design/backend.md#核心对象与职责` |
| `ReviewRecordRepository` | 评审明细写入、查询、统计聚合 | 不决定何时写入 | 管线写，管理 API 读 | `design/backend.md#核心对象与职责` |
| `AdminRepository` | 管理员增删查、密码哈希校验 | 不生成令牌 | auth/admins 路由 | `design/backend.md#核心对象与职责` |
| `ConfigRepository` | 配置覆盖值读写与启动期应用 | 不校验值合法性 | bootstrap、config 路由 | `design/backend.md#核心对象与职责` |
| `PromptRepository` | 按项目读 prompt、页面侧增删改查 | 不做内容渲染 | 管线读，管理 API 读写 | `design/backend.md#核心对象与职责` |
| `web/src/api/client.ts` | 统一 fetch：附加令牌、解析 JSON、401 跳登录 | 不含业务逻辑、不缓存 | 所有前端页面 | `design/frontend.md#核心对象与职责` |
| `web/src/stores/auth.ts` | 持有令牌与当前管理员 | 不存业务数据 | 路由守卫、布局 | `design/frontend.md#核心对象与职责` |
| `PromptEditor.vue` | prompt 双栏编辑与占位符提示 | 不校验业务语义 | PromptsView | `design/frontend.md#核心对象与职责` |

## 数据模型评审

技术栈为 `node:sqlite` 的 `DatabaseSync`，无 ORM，故采用完整字段定义表。

### 完整字段定义

**`review_records`**

| 字段 | 类型 | 必填/空值 | 默认值 | 关联/约束 | 设计依据 |
| --- | --- | --- | --- | --- | --- |
| `id` | INTEGER | 必填 | 自增 | PRIMARY KEY | `design/backend.md#完整字段定义` |
| `project_id` | INTEGER | 必填 | — | — | 同上 |
| `project_name` | TEXT | 必填 | — | — | 同上 |
| `mr_iid` | INTEGER | 必填 | — | — | 同上 |
| `committer_name` | TEXT | 必填 | — | — | 同上 |
| `change_count` | INTEGER | 必填 | — | — | 同上 |
| `batch_count` | INTEGER | 必填 | — | — | 同上 |
| `score` | INTEGER | 可空 | NULL | NULL 表示未解析出分数，与 0 分区分 | 同上 |
| `duration_ms` | INTEGER | 必填 | — | — | 同上 |
| `result` | TEXT | 必填 | — | 取值 `success` / `failed` | 同上 |
| `error_message` | TEXT | 可空 | NULL | 仅失败时有值 | 同上 |
| `comment_url` | TEXT | 可空 | NULL | 汇总评论发布后回填 | 同上 |
| `started_at` | INTEGER | 必填 | — | Unix 毫秒 | 同上 |
| `finished_at` | INTEGER | 必填 | — | Unix 毫秒 | 同上 |

**`admins`**：`id` INTEGER 自增主键；`username` TEXT 必填 UNIQUE；`password_hash` TEXT 必填，格式 `scrypt$<saltHex>$<hashHex>`；`created_at` INTEGER 必填。

**`config_overrides`**：`key` TEXT 主键；`value` TEXT 可空（空串表示清空覆盖、回落环境变量）；`updated_at` INTEGER 必填。

**`review_prompts`**：`id` INTEGER 自增主键；`repository` TEXT 必填 UNIQUE（`default` 为保留值）；`system_prompt` TEXT 必填；`user_prompt` TEXT 必填（含 `{diffs_text}` / `{commits_text}` 占位符）；`wecom_webhook_url` TEXT 可空；`wecom_score_threshold` INTEGER 可空；`updated_at` INTEGER 必填。

### 物理存储、继承与重复存储

| 逻辑对象 | 物理表/存储 | 继承字段来源 | 主键与关联键 | 重复存储结论 |
| --- | --- | --- | --- | --- |
| 评审明细 | `review_records` | 无（无 ORM 基类） | `id` 自增主键，无外键 | `project_name` 冗余存储为有意的历史快照，项目改名或迁移后仍反映当时名称 |
| 管理员账号 | `admins` | 无 | `id` 自增主键，`username` 唯一 | 无重复存储 |
| 配置覆盖 | `config_overrides` | 无 | `key` 文本主键 | 无重复存储 |
| 评审 prompt | `review_prompts` | 无 | `id` 自增主键，`repository` 唯一 | 无重复存储 |

### 字段与存储取舍

| 字段或存储选择 | 最终方案 | 主要取舍 | 项目证据 |
| --- | --- | --- | --- |
| `score` 零分与无分数的区分 | INTEGER + NULL | 现有 `parseReviewScore` 无匹配返回 0（`src/domain/review-rules.ts:27-35`）；若直接存 0，未解析出分数的记录会拉低平均分 | `design/backend.md#字段与存储取舍` |
| 时间字段表示 | INTEGER（Unix 毫秒） | 可直接比较与排序走索引；现有代码统一用 `Date.now()`，转换成本为零 | 同上 |
| prompt 正文存储 | 单表 TEXT 列 | 无版本历史需求，拆表只增一次 JOIN 无收益 | 同上 |
| 统计结果 | SQL 实时聚合 | 写入频率为每 MR 一次、读取频率更低；省掉物化表的双写一致性维护 | 同上 |
| 密码哈希 | `scrypt$盐$哈希` 单列 | 盐内嵌哈希串，校验时无需额外字段；固定盐由环境变量提供，不入库 | 同上 |
| 会话存储 | 无状态令牌，无表 | 用户明确不要踢下线；代价是令牌在进程重启前一直有效 | `design/backend.md#决策 5` |

### 查询模式与索引映射、约束与迁移

| 查询模式 | 过滤/排序/关联字段 | 索引或访问路径 | 设计依据 |
| --- | --- | --- | --- |
| 评审列表（默认） | `ORDER BY started_at DESC` + LIMIT/OFFSET | `idx_reviews_started_at` | `design/backend.md#查询模式与索引映射` |
| 评审列表（按项目） | `WHERE project_id` + 排序 | `idx_reviews_project` | 同上 |
| 评审列表（按提交人） | `WHERE committer_name` + 排序 | `idx_reviews_committer` | 同上 |
| 评审列表（时间范围） | `WHERE started_at BETWEEN` + 排序 | `idx_reviews_started_at` | 同上 |
| 统计聚合 | COUNT / COUNT DISTINCT / AVG / 按日 GROUP BY | 全表扫描 | 同上 |
| 登录校验 | `WHERE username` | `admins.username` UNIQUE | 同上 |
| prompt 读取（评审热路径） | `WHERE repository` | `review_prompts.repository` UNIQUE | 同上 |
| 配置启动加载 | 全表 | 全表扫描（配置项个位数） | 同上 |

四张表均无外键；不使用软删除（prompt 删除即删、评审记录只读）。Migration：首次启动 `CREATE TABLE IF NOT EXISTS`，新增列用 `ALTER TABLE ADD COLUMN`；无版本化迁移框架，回滚时旧代码忽略新表即可。

## 状态、并发和执行流程

一次 `run` 按八步顺序执行，任一环节失败写失败记录后结束，失败语义沿用现有实现（`src/application/review-pipeline.ts:54-60`、`:94-102`）。降级规则分层设计：行号校验不通过的单条 finding 并入汇总评论；`reviewed_head_sha` 不一致则全部并入汇总；单条行内评论发布失败仅影响该条；发布后校验不通过记 warn 且 marker 保证下次跳过。

并发：`QUEUE_CONCURRENCY=5` 最多 5 个评审并发，但 `DatabaseSync` 是同步 API，在事件循环上串行执行，WAL + busy_timeout 覆盖多进程场景。行内评论逐条串行发布，避免同一 MR 并发写入 GitLab。

幂等边界：marker 以 `head_sha` 为前缀，MR 有新提交后 head 变化，历史评论不会被误判为已发布。

## 接口、权限和旧入口隔离

| 接口/入口 | 主键或资源 | 权限 | 兼容或隔离边界 | 设计依据 |
| --- | --- | --- | --- | --- |
| `GET /health` | 无 | 公开 | 结构不变 | `design/backend.md#接口、权限与兼容边界` |
| `POST /review/webhook` | MR 事件 | `X-Gitlab-Token` 请求头 | 结构与鉴权方式不变 | 同上 |
| `POST /api/auth/login` | 用户名 | 无（凭密码换取令牌） | 新增；失败不区分用户不存在与密码错误 | 同上 |
| `GET /api/auth/me` `POST /api/auth/logout` | 当前管理员 | Bearer 令牌 | 新增；logout 为语义完整，无状态令牌由前端清除 | 同上 |
| `GET/POST/DELETE /api/admins` | 账号 id | Bearer 令牌 | 新增；删自己或删最后一个管理员返回 400 | 同上 |
| `GET /api/reviews` `/api/reviews/stats` | 评审记录 | Bearer 令牌 | 新增；只读，无写接口 | 同上 |
| `GET/PUT /api/config` | 配置键 | Bearer 令牌 | 新增；密钥字段掩码返回，响应标注需重启的键 | 同上 |
| `GET/POST/PUT/DELETE /api/prompts`、`POST /api/prompts/import` | prompt id / repository | Bearer 令牌 | 新增；保存即生效，删除回落 default | 同上 |
| 静态资源 `/` 与 SPA fallback | 前端路由 | 公开 | 显式排除 `/api` 与 `/review` 前缀，未匹配 API 返回 404 JSON | `design/frontend.md#架构主线` |

## 前端方案

五个页面：登录、评审记录（含统计卡片）、prompt 管理、环境变量、管理员账号。路由用 history 模式配合 Express SPA fallback；守卫在 `beforeEach` 调用 `ensureAuth()`，无令牌或 401 跳登录。

状态管理用组合式函数加模块级单例（仅令牌与用户名两个状态），不引入 Pinia；页面数据用局部 `ref`/`reactive`，管理页面间无共享数据。组件全部复用 Element Plus，唯一自建 `PromptEditor.vue` 承载双栏编辑与占位符提示（Element Plus 无对应组件）。

视觉来源为 Element Plus 默认主题规范（`D-013`）——项目无 Figma、无截图、无 `fp-docs/settings/frontend.md`、无既有前端页面，因此不存在可继承的视觉基准，关键尺寸（侧边栏 200px、顶栏 60px、菜单项 56px、表格行高 40px、编辑对话框 800px）均取组件库默认值，设计层不自定义覆盖。Visual Checks 共九项，覆盖布局、表格三态、密钥掩码、删除二次确认与路由守卫，全部可执行。

## 主要风险、迁移、发布和验证

### 主要风险

| 具体失败场景 | 影响 | 预防或处理 | 设计依据 |
| --- | --- | --- | --- |
| 前端存在 XSS，令牌被 localStorage 中脚本读取 | 攻击者获得管理员权限 | 避免 `v-html` 渲染未转义内容；不引入来源不明依赖 | `design/backend.md#风险、迁移、发布、回滚与监控` |
| 管理员改密码后旧令牌仍有效 | 旧持有者可继续访问，最长到进程重启 | 改密码接口提示「旧令牌需重启后失效」 | 同上 |
| 页面写入的密钥值被回显或记入日志 | 密钥泄露 | 读取掩码返回；日志只记键名；写接口日志脱敏 | 同上 |
| 数据库文件放在网络文件系统 | WAL 不支持，可能报磁盘 I/O 错误 | 部署文档明确 DB 卷必须本地盘；启动时校验 PRAGMA 返回 | 同上 |
| MR 在评审进行中产生新提交 | findings 全部降级进汇总，不发行内评论 | 发布前校验 head 一致 | 同上 |
| 行内评论锚定到相邻行 | 评论位置误导开发者 | 发布后回读 discussions 校验行号与路径 | 同上 |
| 首次部署未导入 yaml prompt | 所有项目回落默认，评审规则非预期版本 | 启动日志打印 prompt 来源；提供导入接口 | 同上 |
| 前端构建链使镜像体积与构建时间增加 | 构建变慢、镜像变大 | 前端构建独立阶段并利用层缓存；lockfile 固定版本 | 同上 |
| `node:sqlite` 仍是实验特性 | Node 升级可能使持久化层失效 | 锁 Node 版本；升级时单独验证 | 同上 |

有意延后两项：会话过期与踢下线（上限为令牌在进程重启前有效；触发条件为出现「需立即撤销离职管理员访问」的明确需求；升级方向为增加 `sessions` 表并按需加入过期与吊销接口）；游标分页（上限为 OFFSET 分页在十万级记录内响应正常；触发条件为实测超过 1000 页时响应超过 1 秒；升级方向为基于 `started_at` 与 `id` 的游标分页）。两项均不削减当前验收、安全、权限隔离与数据一致性。

### 迁移与发布

Schema 无版本化迁移，首次启动建表；回滚时旧代码忽略新表即可，无数据迁移。发布顺序为单镜像一次 `docker compose up -d --build`（前后端同镜像交付）。监控信号：启动横幅的 prompt 来源分布、行内评论校验失败次数、降级次数、异常登录行为。

### 验证清单

- [ ] `npm run typecheck` 退出码 0；`npm test` 全部通过；`npm run build:frontend` 产出 `web/dist/index.html`（`design/backend.md#验证方案`、`design/frontend.md#验证方案`）
- [ ] diff 行号解析单元测试覆盖新增/删除/上下文行、多 hunk、`+++`/`---` 头，结果与手算一致（`design/backend.md#验证方案`）
- [ ] 注入假 fetch 断言 `/discussions` 请求体含 `position_type`、三个 SHA、`old_path`、`new_path` 与互斥的 `new_line`/`old_line`（同上）
- [ ] 预置含 marker 的 discussion 时不重复 POST；回读行号不一致时记 warn（`design/backend.md#验证方案`）
- [ ] 跑失败路径管线后 `review_records` 有一条 `result=failed` 且 `error_message` 非空（同上）
- [ ] 统计聚合的总项目数、去重提交人数、平均分与手算一致（`design/backend.md#验证方案`）
- [ ] 删除自己与删除最后一个管理员均返回 400；无令牌与错误令牌访问 `/api/reviews` 返回 401（`design/backend.md#验证方案`）
- [ ] 更新 `REVIEW_TIMEOUT_MS` 后 `process.env` 已同步且标注不需重启；更新 `PORT` 时标注需重启（`design/backend.md#验证方案`）
- [ ] 通过 API 修改 prompt 后下一次 `rules.resolve` 返回新内容，无需重启（`design/backend.md#验证方案`）
- [ ] 用现有 `prompts/rules/*.yaml` 导入，记录数与文件数一致且 `default` 记录存在（`design/backend.md#验证方案`）
- [ ] 容器重启后评审记录与管理员账号仍在（`design/backend.md#验证方案`）
- [ ] 访问 `/api/not-exist` 返回 404 JSON 而非 HTML；`/` 与任意前端路由均返回 `index.html`（`design/frontend.md#验证方案`）
- [ ] 未登录访问 `/reviews` 跳登录，登录后放行；无效令牌触发 401 并跳登录（`design/frontend.md#验证方案`）
- [ ] 逐项执行 Visual Checks 九项（`design/frontend.md#视觉契约`）
- [ ] 对照本次 diff 自审：新增公开对象有契约说明、非显然逻辑有原因注释、附近旧注释已同步（`${CLAUDE_PLUGIN_ROOT}/skills/_shared/engineering-quality.md`）

## 评审顺序与抽查路径

1. **状态、并发和执行流程**——行内评论的降级分层（单条失败、head 不一致、校验不通过）是否可接受，直接决定线上表现；且 MR 评审期间产生新提交是高频场景。锚点：`design/backend.md#状态、并发与执行流程`。
2. **数据模型评审**——`score` 的 NULL 语义与统计口径、`project_name` 冗余快照、索引与查询模式映射是否匹配真实使用规模。锚点：`design/backend.md#数据模型`。
3. **接口、权限和旧入口隔离**——17 条路由的鉴权覆盖、SPA fallback 与 `/api` 前缀隔离、掩码规则是否遗漏敏感键。锚点：`design/backend.md#接口、权限与兼容边界`。
4. **前端方案**——视觉基准完全依赖组件库默认（无项目内规范可继承），需确认可接受；另需确认 `ensureAuth` 守卫与 401 处理的边界。锚点：`design/frontend.md#视觉契约`。

- 建议抽查：`D-02-canway/01-code/auto-ops/.claude/skills/code-review/scripts/gitlab_mr_review.py:93-125`（diff 行号解析，对应 `D-004`）
- 建议抽查：`D-02-canway/01-code/auto-ops/.claude/skills/code-review/scripts/gitlab_mr_review.py:332-343`（position 构造，对应 `D-004`）
- 建议抽查：`D-02-canway/01-code/auto-ops/.claude/skills/code-review/scripts/gitlab_mr_review.py:361-394`（发布后校验，对应 `D-005`）
- 建议抽查：`src/domain/review-rules.ts:27-35`（`parseReviewScore` 返回 0 的语义，对应 `score` 字段的 NULL 设计）

## 评审结论记录

- [ ] 通过：设计完整，可以进入计划阶段。
- [ ] 有条件通过：需在计划阶段确认既有 yaml prompt 的导入时序与前端构建时长可接受，并在实现时落实改密码后的令牌失效提示。
- [ ] 退回修改：无。

## 设计入口

- `design/00-index.md`
