# GitLab 行内评论与管理控制台 Backend Implementation Plan

> **For agentic workers:** REQUIRED FLOW: Use `fp-execute` to implement this plan task-by-task. Only task markers use checkbox (`- [ ] **Task backend-NNN: ...**`) syntax for tracking; substeps are plain ordered instructions.

**Goal:** 为 cr-pilot 增加 GitLab 行内评论发布能力、SQLite 持久化、管理员登录与账号管理、环境变量管理、评审记录查询统计五组后端能力，为内置 Vue 前端提供 JSON API。

**Architecture:** 沿用现有 ports & adapters 分层。domain 层新增五个纯逻辑模块与四个端口，infrastructure 用 Node 22 内置 `node:sqlite` 的 `DatabaseSync` 实现四个仓储，GitLab 客户端在现有 `GitlabClient` 端口上扩展 3 个方法。application 层评审管线新增结构化解析、行内评论发布与记录写入编排。interfaces 层新增五组路由、Bearer 鉴权中间件与静态资源托管。组合根 `src/bootstrap.ts` 集中装配。

**Tech Stack:** Node.js 22.19+（原生 TypeScript 类型剥离）、Express 5、`node:sqlite`（内置）、`node:crypto`（scrypt/randomBytes）、`yaml` 2.9、`@earendil-works/pi-coding-agent` 1.0.4、`node:test`。**不新增任何运行时依赖。**

## Global Constraints

- 依赖约束：不得新增任何 npm 运行时依赖。持久化用内置 `node:sqlite`，密码哈希与令牌用内置 `node:crypto`。依据 `design/backend.md#逻辑模型与物理存储`（引入 ORM 无任何现有代码可复用）。
- 运行时约束：`node:sqlite` 为实验特性（本地实测输出 `ExperimentalWarning`），启动时需处理该警告避免污染日志文件。依据 `design/backend.md#决策 8` 与 `D-003`。
- 分层约束：domain 层零 IO，纯函数与端口声明；infrastructure 实现 domain 端口；interfaces 不直接触碰 infrastructure 实现。依据 `src/domain/review-task.ts:1-7`。
- 组合根约束：所有新增装配集中在 `src/bootstrap.ts` 的 `main()`，不在模块顶层建立连接或注册全局状态。依据 `src/bootstrap.ts:44-70`。
- SQL 约束：`node:sqlite` 的 `DatabaseSync` 是同步 API，仓储方法均为同步；Express 路由中直接调用，不做 Promise 包装。依据 `design/backend.md#技术栈专项结论`。
- 数据约束：`score` 字段用 `NULL` 表示「未解析出分数」，与 0 分区分。依据 `design/backend.md#字段与存储取舍`（现有 `parseReviewScore` 无匹配返回 0，见 `src/domain/review-rules.ts:27-35`）。
- 时间约束：所有时间字段存 Unix 毫秒 INTEGER。依据 `design/backend.md#字段与存储取舍`（现有代码统一用 `Date.now()`）。
- 鉴权约束：除 `POST /api/auth/login` 与 `GET /health` 外，所有 `/api/*` 要求 `Authorization: Bearer <token>`；失败返回 401。webhook 路由 `/review/webhook` 鉴权方式不变。依据 `design/backend.md#接口、权限与兼容边界`。
- 密钥约束：`GET /api/config` 的密钥类字段（键名含 `KEY`/`SECRET`/`TOKEN`/`PASSWORD`）返回掩码；日志只记录键名不记录值。依据 `design/backend.md#接口、权限与兼容边界` 与 `D-012`。
- 兼容约束：`GET /health` 与 `POST /review/webhook` 的请求与响应结构完全不变；SPA fallback 必须排除 `/api` 与 `/review` 前缀，未匹配的 API 路径返回 404 JSON 而非 HTML。依据 `design/backend.md#接口、权限与兼容边界` 与 `design/frontend.md#架构主线`。
- 降级约束：行内评论发布失败、finding 行号校验不通过、`reviewed_head_sha` 与当前 head 不一致时，均降级为并入汇总评论，不丢弃内容，也不中断其他 finding 的发布。依据 `design/backend.md#状态、并发与执行流程`。
- 幂等约束：每条发布的评论正文尾部必须追加 `<!-- marker:{head_sha}:{id} -->`；发布前跳过已含相同 marker 的项。依据 `design/backend.md#决策 2`。
- 注释约定：新增公开函数、类、端口与非显然逻辑必须有中文 docstring 或注释，说明职责与取舍原因；不逐行翻译代码。依据 `${CLAUDE_PLUGIN_ROOT}/skills/_shared/engineering-quality.md` 与项目现有中文 docstring 风格（如 `src/domain/review-task.ts:60-66`）。
- 测试约定：使用 `node:test` + `node:assert/strict`；文件路径与源码同构（`test/<layer>/<module>.test.ts`）；HTTP 与 GitLab 客户端测试沿用现有 `jsonResponse` / `trackFetch` / `makeClient` 辅助模式（见 `test/infrastructure/gitlab/gitlab-client.test.ts:8-35`）。
- 命令约束：单文件测试用显式文件路径，不用目录参数（Node 22.19 下 `node --test <dir>` 会失败）。全量用 `npm test`。

## File Structure

| Path | Action | Responsibility |
| --- | --- | --- |
| `src/domain/inline-comment.ts` | create | diff 行号解析、AI 输出 JSON 解析、position 构造、marker 生成（纯函数，零 IO） |
| `src/domain/review-record.ts` | create | 评审明细类型与 `ReviewRecordRepository` 端口 |
| `src/domain/admin.ts` | create | 管理员类型与 `AdminRepository` 端口 |
| `src/domain/runtime-config.ts` | create | 配置覆盖端口与可热更新项清单 |
| `src/domain/review-prompt.ts` | create | StoredPrompt 类型与 `PromptRepository` 端口 |
| `src/domain/review-task.ts` | modify | `GitlabClient` 端口新增 3 个方法与 `DiffRefs` 类型 |
| `src/shared/crypto.ts` | create | scrypt 哈希/校验、令牌生成/派生 |
| `src/shared/config.ts` | modify | 新增 DB 路径、管理员引导、盐值配置项 |
| `src/infrastructure/sqlite/database.ts` | create | 打开连接、建表、PRAGMA 设置、ExperimentalWarning 处理 |
| `src/infrastructure/sqlite/review-record-repo.ts` | create | `ReviewRecordRepository` 实现 |
| `src/infrastructure/sqlite/admin-repo.ts` | create | `AdminRepository` 实现 |
| `src/infrastructure/sqlite/config-repo.ts` | create | `ConfigRepository` 实现 |
| `src/infrastructure/sqlite/prompt-repo.ts` | create | `PromptRepository` 实现 |
| `src/infrastructure/gitlab/gitlab-client.ts` | modify | 实现 versions、discussions 发布与回读 |
| `src/application/review-pipeline.ts` | modify | prompt 改按需读库；新增行内评论发布、汇总去重、记录写入编排 |
| `src/infrastructure/rules/review-rules.ts` | modify | 规则来源改为数据库，文件读取降级为初始导入与兜底 |
| `src/interfaces/http/auth-middleware.ts` | create | Bearer 令牌校验 |
| `src/interfaces/http/static-assets.ts` | create | 静态资源托管与 SPA fallback |
| `src/interfaces/http/api/auth.ts` | create | 登录、登出、当前管理员路由 |
| `src/interfaces/http/api/admins.ts` | create | 管理员账号路由 |
| `src/interfaces/http/api/config.ts` | create | 环境变量路由 |
| `src/interfaces/http/api/prompts.ts` | create | prompt 管理路由 |
| `src/interfaces/http/api/reviews.ts` | create | 评审记录与统计路由 |
| `src/interfaces/http/app.ts` | modify | 挂载 API 路由组、鉴权中间件、静态资源 |
| `src/bootstrap.ts` | modify | 初始化数据库、注入仓储、挂载 API 与静态资源 |
| `scripts/import-prompts.ts` | create | 一次性把 `prompts/rules/*.yaml` 导入数据库 |
| `test/domain/inline-comment.test.ts` | create | diff 解析、JSON 解析、position 与 marker |
| `test/shared/crypto.test.ts` | create | 哈希与令牌 |
| `test/shared/config.test.ts` | modify | 新增配置项断言 |
| `test/infrastructure/sqlite/database.test.ts` | create | 建表与 PRAGMA 断言 |
| `test/infrastructure/sqlite/review-record-repo.test.ts` | create | 明细 CRUD 与统计 |
| `test/infrastructure/sqlite/admin-repo.test.ts` | create | 账号 CRUD 与唯一约束 |
| `test/infrastructure/sqlite/config-repo.test.ts` | create | 覆盖值读写 |
| `test/infrastructure/sqlite/prompt-repo.test.ts` | create | prompt 解析与导入 |
| `test/infrastructure/gitlab/gitlab-client.test.ts` | modify | 新增三方法的请求与错误断言 |
| `test/application/review-pipeline.test.ts` | modify | 行内评论编排、降级、记录写入 |
| `test/interfaces/http/api.test.ts` | create | 五组路由与鉴权 |
| `test/interfaces/http/app.test.ts` | modify | SPA fallback 隔离 |
| `test/infrastructure/rules/review-rules.test.ts` | modify | 数据库优先回落链 |
