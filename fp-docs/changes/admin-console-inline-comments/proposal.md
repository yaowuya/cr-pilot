# GitLab 行内评论与管理控制台

## Why

当前 cr-pilot 把 AI 评审作为一个整体 Markdown 评论回写到 MR，开发者必须自己在 diff 里逐条比对才能找到问题出在哪一行。同时，评审产生的数据完全散失：项目、提交人、评审次数、评分和耗时都没有留存，运维侧无法回答「谁在提交、评了多少次、分数如何、什么时候发生的」，也无法在不登录服务器的情况下调整配置和管理使用者。

这两点共同指向同一个缺口：服务需要既能精确定位问题，又能沉淀数据并提供一个受控的管理入口。本次改动同时补齐行内评论、数据留存和管理 API 三块能力。

## What Changes

### 1. 评审 prompt 增加机器可读结构化输出块

各仓库规则文件的 system prompt 增加约定：每个问题额外输出一个结构化块，包含文件路径、新文件行号、问题描述和建议代码。解析器按该结构提取「文件 + 行号 + 内容」三元组。无法解析出结构化块时，本批次问题全部降级进汇总评论，不丢弃内容。

### 2. 新增 GitLab 行内评论发布能力

`GitlabClient` 端口新增发布行内评论的方法，实现走 GitLab Discussions API，按文件与行号定位到 diff 上的具体行。解析成功的每个问题发一条行内评论。发布失败按批次降级：把该条问题的文本并入汇总评论，其余行内评论继续发布，不因单条失败中断整个评审。

### 3. 行内评论与汇总评论并行发布

保留现有汇总评论（总体评分加上无法定位到行的问题），同时发布行内评论。开发者在 diff 上直接看到可定位的问题，同时保留一个总体评分视图。汇总评论需要剔除已成功发行内评论的条目，避免同一问题重复出现两次。

### 4. 评审结构化解析作为领域纯逻辑

新增领域层纯函数：解析 AI 输出的结构化块，并把「文件路径 + 行号」映射到变更集中的合法 diff 行号。映射不成立（路径不存在、行号越界、指向删除行）时返回不可定位，交由调用方降级进汇总。领域层保持零 IO。

### 5. 新增 SQLite 持久化层

新增 domain 端口（评审记录、配置覆盖、管理员账号、会话），infrastructure 用 Node 22 内置的 `node:sqlite` 实现，零新增依赖。启动时建表并启用 WAL 模式。数据库文件路径由环境变量配置，容器部署时挂载到宿主机持久卷。

### 6. 每次评审落一条明细记录

评审管线在开始和结束时写入一条明细：项目 ID 与全名、MR 编号、提交人、变更文件数、批次数、AI 评分、评论链接、开始与结束时间、耗时、最终结果（成功或失败原因）。任一环节失败也要落记录，失败原因写入结果字段。

### 7. 新增评审记录查询 API

`GET /api/reviews` 支持按项目、提交人、时间范围筛选，支持分页与排序，返回明细列表。`GET /api/reviews/stats` 返回基础统计：总评审次数、涉及项目数、提交人数、平均分与时间趋势。全部记录只读，不提供写接口。

### 8. 新增管理员账号体系与登录接口

管理员账号存于数据库，密码用 Node 内置 `node:crypto` 的 scrypt 加盐哈希存储，不引入外部认证依赖。提供登录、登出、查询当前管理员三个接口。会话使用服务端存储的随机会话标识，Cookie 为 HttpOnly。首次启动时若管理员表为空，用环境变量里的初始账号密码创建首个管理员。

### 9. 新增管理员账号管理接口

提供账号列表、新增、删除三个接口。新增账号时校验用户名唯一与非空，密码满足最小长度。删除时禁止删除当前登录的管理员，也禁止删除最后一个管理员。两个约束冲突时以「禁止删除当前登录账号」优先并返回明确错误。

### 10. 新增环境变量管理接口

环境变量覆盖值存于数据库表。启动时加载覆盖值并应用到环境变量，使数据库值优先于进程环境变量。提供查询与更新两个接口：查询返回当前生效配置，密钥类字段掩码显示；更新写入覆盖表，并在响应中说明「需重启后完全生效」。进程内立即生效的可热更新项（如并发数）在应用时被读取，其余项保持启动时读取语义。

### 11. 管理 API 统一鉴权

除登录接口与健康检查外，所有管理类 API 要求携带有效会话，未认证统一返回 401。webhook 接收接口保持现有鉴权方式不变。

### 12. 部署配置补充数据库卷与前端构建

`docker-compose.yml` 新增 SQLite 数据目录的持久卷挂载，目录属主与运行用户一致。新增数据库路径与会话相关的环境变量配置项。`Dockerfile` 新增前端构建阶段。同步更新 `.env.example` 与 README。

### 13. prompt 全部存入数据库并提供管理接口

各项目的评审 prompt 不再以文件为唯一来源，改为存入 SQLite：系统提示、用户提示模板、绑定的 GitLab 项目、企微 webhook 与评分阈值。提供接口覆盖列表、按项目查询、新增、编辑与删除，并提供一次性导入能力，把现有 `prompts/rules/*.yaml` 导入数据库。数据库为空时仍回落到 `default.yaml` 与 Markdown 兜底，保证首次启动即可评审。

### 14. prompt 修改在下一次评审立即生效

评审规则不再在启动时一次性快照，而是在每次评审开始时按项目从数据库读取当前 prompt。管理页面保存后，下一次评审直接使用新版本，无需重启容器。

### 15. 新增内置管理前端

新增 `frontend/` 目录，采用 Vue 3 与 Vite 构建，UI 组件库选用 Element Plus。包含五个管理模块：管理员登录、评审记录与统计、prompt 管理、环境变量管理、管理员账号管理。前端构建产物由 Express 作为静态资源托管，登录会话依赖后端下发的 HttpOnly Cookie，无需处理令牌存储。

## Capabilities

### New Capabilities

- `gitlab-inline-comment`: 把评审问题按文件与行号定位到 MR diff 上发布行内评论，解析失败时降级进汇总评论不丢内容。
- `review-record`: 每次评审落一条含项目、提交人、评分、耗时与结果的明细记录，可筛选分页查询。
- `review-statistics`: 基于评审明细返回总次数、涉及项目数、提交人数、平均分与时间趋势的基础统计。
- `admin-account`: 管理员账号的登录会话与账号增删管理，密码加盐哈希存储，删除受最后账号与自删约束。
- `runtime-config-management`: 环境变量覆盖值存于数据库并在启动时优先生效，支持查询与更新，密钥字段掩码返回。
- `review-prompt-management`: 按 GitLab 项目管理评审 prompt 的增删改查，支持从 yaml 一次性导入，保存后下一次评审立即生效。
- `admin-console-ui`: 内置 Vue 3 管理前端，含登录、评审记录与统计、prompt 管理、环境变量管理与管理员账号五个模块。

### Modified Capabilities

- `gitlab-mr-review`: 评审结果除汇总评论外新增行内评论发布，汇总评论需剔除已发行内评论的条目以避免重复。
- `review-pipeline`: 评审管线新增结构化解析、行内评论发布与评审记录写入编排，任一环节失败均落失败记录。
- `review-rules`: 规则来源从启动时读取 yaml 文件改为每次评审从数据库读取，yaml 降级为初始导入源与兜底。

## Out of Scope

- 对 GitLab Discussions API 的外部文档研究。设计阶段如需精确字段核对，另行单独申请研究授权。
- 多实例部署与高可用、请求限流、CSRF 防护、操作审计日志等生产级加固。
- 评审结果的历史趋势图表与可视化分析，管理前端只提供数值与列表呈现。
- 管理员密码找回与邮件通知，仅支持通过管理接口重置。
- 评审记录与 prompt 的删除归档之外的批量导入导出能力。
- 前端页面的国际化与多主题切换。

## Impact

- `src/domain/review-task.ts` - GitlabClient 端口新增行内评论发布方法；新增结构化问题与行号映射的领域模型。
- `src/domain/` - 新增评审记录、配置覆盖、管理员账号、会话与 prompt 的领域模型与端口，以及结构化解析纯函数。
- `src/application/review-pipeline.ts` - 新增结构化解析、行内评论发布、汇总评论去重与评审记录写入的编排；失败路径也要落记录。
- `src/infrastructure/gitlab/gitlab-client.ts` - 实现 Discussions API 调用，复用现有请求封装与错误语义。
- `src/infrastructure/sqlite/` - 新增基于 `node:sqlite` 的持久化适配器，实现全部新增领域端口。
- `src/infrastructure/rules/review-rules.ts` - 规则来源从启动时读文件改为每次评审读数据库，文件读取降级为初始导入与兜底。
- `src/interfaces/http/app.ts` - 挂载管理 API 路由、鉴权中间件与前端静态资源；webhook 路由保持不变。
- `src/interfaces/http/api/` - 新增 reviews、auth、admins、config、prompts 五组路由与各自的入参校验。
- `src/shared/config.ts` - 新增数据库文件路径配置项；加载顺序调整为「进程环境变量 → 数据库覆盖值」，使数据库优先。
- `src/bootstrap.ts` - 组合根新增数据库初始化、仓储注入、管理 API 与前端静态挂载装配。
- `frontend/` - 新增 Vue 3 与 Vite 前端工程：五个管理页面、路由、Element Plus 主题与 API 客户端；产物输出到后端可托管目录。
- `package.json` - 新增前端构建依赖与 `build:frontend`、`dev:frontend` 脚本。
- `Dockerfile` - 新增前端构建阶段并把构建产物拷入 runner 镜像。
- `scripts/` - 新增一次性 prompt 导入脚本，把现有 yaml 导入数据库。
- `prompts/rules/*.yaml` - 全部规则文件的 system prompt 增加结构化输出块约定；该目录被 gitignore，服务器部署需手动同步后导入。
- `docker-compose.yml` - 新增 SQLite 数据目录持久卷挂载。
- `.env.example`、`README.md` - 补充数据库路径、初始管理员账号等新配置项与 API 说明。

### Handoff Decision Ledger

| ID | Decision | Source | Blocking | Status | Evidence / explicit confirmation |
| --- | --- | --- | --- | --- | --- |
| P-001 | 行内评论内容来源：prompt 输出结构化块，解析后发行内评论 | user answer | yes | `user-confirmed` | selected A「prompt 输出结构化块，解析后发行内评论」；用户消息「A. prompt 输出结构化块，解析后发行内评论（推荐）」 |
| P-002 | 行内与汇总评论共存：两者都发 | user answer | yes | `user-confirmed` | selected A「两者都发：行内评论 + 汇总评论」；用户消息「A. 两者都发：行内评论 + 汇总评论（推荐）」 |
| P-003 | 评审记录：每次评审一条明细 + 基础统计 | user answer | yes | `user-confirmed` | selected A「每次评审一条明细记录 + 基础统计」；用户消息「A. 每次评审一条明细记录 + 基础统计（推荐）」 |
| P-004 | 管理员删除约束：禁止删除最后一个管理员，禁止删除自己 | user answer | yes | `user-confirmed` | selected A「禁止删除最后一个管理员，且禁止删除自己」；用户消息「A. 禁止删除最后一个管理员，且禁止删除自己（推荐）」 |
| P-005 | 环境变量管理：DB 存覆盖值，启动时 DB 优先 | user answer | yes | `user-confirmed` | selected B「数据库存覆盖值，启动时 DB 优先」；用户消息「B. 数据库存覆盖值，启动时 DB 优先」 |
| P-006 | 管理页面交付：后端 API 与内置前端一并交付（初版曾选前端独立部署，已被 P-017 取代） | user answer | yes | `user-confirmed` | selected B「本仓库内置 Vue3 + Vite 前端，一同交付」；用户消息「B. 本仓库内置 Vue3 + Vite 前端，一同交付」 |
| P-007 | 管理员范围：完整登录体系 | user answer | yes | `user-confirmed` | selected A「完整登录体系」；用户消息「A. 完整登录体系」 |
| P-008 | 流程路由：走完整 fp-start 流程 | user answer | yes | `user-confirmed` | selected 完整流程；用户消息「1」（对 quick/full 选项的确认） |
| P-009 | 数据库选型：SQLite，用 Node 22 内置 node:sqlite，零新增依赖 | user request + `package.json` engines | yes | `user-confirmed` | 用户消息「数据库存请选择一个轻量的，比如sqlite」；`package.json` 要求 node>=22.19.0，内置 node:sqlite 可用 |
| P-010 | 当前无行内评论能力，GitlabClient 仅 3 个方法且只发汇总 note | `src/domain/review-task.ts:67-71`、`src/infrastructure/gitlab/gitlab-client.ts:114-122` | no | `code-verified` | 端口签名与实现路径均为当前代码事实 |
| P-011 | 当前配置为启动时一次性读取环境变量，进程运行期间不可变 | `src/shared/config.ts:53-69` | no | `code-verified` | `loadConfig` 直接读 `process.env` 并返回快照 |
| P-012 | 当前无鉴权中间件与任何持久化层 | `src/interfaces/http/app.ts:30-98`、`package.json` | no | `code-verified` | 路由仅 2 条；依赖仅 express、yaml、pi-coding-agent |
| P-013 | 单一组合根，所有新增装配集中在 bootstrap | `src/bootstrap.ts:44-70` | no | `code-verified` | `main()` 内完成 queue/client/rules/reviewer/pipeline 的构建与注入 |
| P-014 | SQLite 数据需新增持久卷挂载，目录属主与运行用户一致 | `docker-compose.yml:21-26` | no | `code-verified` | 现有 `/data/logs/cr-pilot:/app/logs` 已确立非 root 运行下的卷挂载模式 |
| P-015 | prompt 存储位置：全部存入 SQLite，yaml 文件仅作初始导入与兜底 | user answer | yes | `user-confirmed` | selected A「全部存入 SQLite，文件仅作初始导入」；用户消息「A. 全部存入 SQLite，文件仅作初始导入（推荐）」 |
| P-016 | prompt 生效时机：保存后立即生效，下次评审即用新版本 | user answer | yes | `user-confirmed` | selected A「保存后立即生效，下次评审就用新 prompt」；用户消息「A. 保存后立即生效，下次评审就用新 prompt（推荐）」 |
| P-017 | 前端技术栈：Vue 3 + Vite + Element Plus，构建产物由 Express 静态托管 | user answer | yes | `user-confirmed` | selected B「本仓库内置 Vue3 + Vite 前端，一同交付」；用户消息「B. 本仓库内置 Vue3 + Vite 前端，一同交付」 |
| P-018 | 当前 prompt 以 `prompts/rules/*.yaml` 组织，启动时一次性读入内存匹配器 | `src/infrastructure/rules/review-rules.ts:47-102` | no | `code-verified` | `loadReviewRules` 在启动时遍历目录并构建 `repositoryRules` 映射 |
| P-019 | 规则文件按 `repository` 字段匹配项目全名或短项目名，`default.yaml` 为全局默认 | `src/infrastructure/rules/review-rules.ts:62-100` | no | `code-verified` | 匹配优先级：仓库规则 > `default.yaml` > Markdown 兜底 |

### Pre-write Confirmation Evidence

- Covered IDs: `P-001`, `P-002`, `P-003`, `P-004`, `P-005`, `P-006`, `P-007`, `P-008`, `P-009`, `P-010`, `P-011`, `P-012`, `P-013`, `P-014`, `P-015`, `P-016`, `P-017`, `P-018`, `P-019`
- Outstanding blocking decisions: `none`
- Explicit user authorization to write: 初次授权为用户确认「确认并按 P-001~P-014 写入 proposal.md」，范围为 slug `admin-console-inline-comments` 的 small form `fp-docs/changes/admin-console-inline-comments/proposal.md`。本次修订授权为用户消息「确认」，对应修订范围为追加变更点 13 至 15、修订 P-006 交付形态为内置前端一并交付、新增 P-015 至 P-019，并移除 Out of Scope 中「前端管理页面本身」一条。无 overwrite、conversion 或 removal 动作，仅在既有 canonical small form 内追加与修订。
