# 项目可选仓库上下文评审与共享仓库规范

## Why

当前评审把 MR 的变更片段分批交给模型，缺少相关实现、调用方和测试上下文。模型难以判断跨文件约束，也容易把已有实现误认为缺失能力。

本次改动让项目按需开启仓库上下文评审，并在 Prompt 页面独立维护更完整的仓库代码规范。评审对象仍是本次 MR，不扩展为全仓历史问题扫描。未开启的项目保持原有行为。

当前实现依据：

- [评审管线](<src/application/review-pipeline.ts#L400-L492>) 拉取 MR 变更和提交摘要，再渲染为模型输入。
- [模型会话](<src/infrastructure/pi/reviewer.ts#L176-L186>) 使用 `noTools: "all"`，因此单独增加克隆操作不能让模型利用仓库上下文。
- [Prompt 模型](<src/domain/review-prompt.ts#L12-L35>) 支持一条 Prompt 关联多个项目，需要区分项目开关与共享规范的归属。

## What Changes

### 1. 在 Prompt 页面按项目开启仓库上下文

每个项目独立保存“拉取仓库进行 Review”的开关。同一条 Prompt 关联的项目可以采用不同状态，开启一个项目不会连带开启其他项目。

旧数据、新项目及未配置项目默认关闭。保存只影响后续开始的评审，不追溯执行历史 MR。全局 default Prompt 不会自动替未明确配置的项目开启拉取。

验收要点：

- 同一条 Prompt 关联两个项目时，可以只为其中一个开启仓库上下文。
- 关闭状态不克隆仓库，也不引入新增的仓库读取权限要求。
- 保存并重新进入页面后，可以准确看到各项目的开关状态。
- 已有 Prompt 的关联、解析和兜底规则保持兼容，不因新增开关改变其他配置的生效方式。

### 2. 用单分支浅克隆补充本次 MR 的上下文

开启后，服务获取本次 MR 对应的源仓库和版本，再提供给模型按需读取。采用用户示例的快速拉取策略：`git clone --progress --branch <源分支> --single-branch --depth 1`。示例中的固定仓库地址和目标目录不作为产品配置写死。

拉取凭据复用当前任务携带的 GitLab token，不新增账号密码管理。部署方需要保证该 token 具备仓库读取权限。

模型可以查阅与变更相关的实现、调用方和测试，以判断本次变更。仓库内容是待分析材料，不是可执行指令；不得执行或修改被评审代码，也不得把整仓无关内容无差别塞入模型输入。

验收要点：

- 获取的代码与本次 MR 所评审的版本一致，不能把分支变化后的其他版本当成本次上下文。
- 模型能够实际读取相关仓库文件，而非只收到一个不可访问的本地路径。
- 只读边界、任务隔离和资源释放在技术设计中给出可验证方案。
- 凭据不进入模型输入、可见配置返回或日志。
- 仓库拉取失败、超时或无法取得对应版本时，终止本次 Review 并记录失败；不静默降级为仅评审 diff。

### 3. 增加与现有 Prompt 分离的共享仓库规范

每条 Prompt 增加一份独立的仓库代码规范，供其关联项目共享。规范与现有 system prompt、user prompt 分开展示和保存，不能用一个大文本字段替代三者的职责。

仓库规范描述整个仓库应遵循的要求，而非仅描述一段 diff 的输出方式。内容可以覆盖架构与模块边界、命名约定、接口契约、数据与事务、安全与权限、日志、测试和性能等方面。

规范选填。已开启仓库上下文的项目在规范留空时仍可评审，并继续遵循原有 Prompt。关闭仓库上下文的项目保持原有评审行为，不因其他关联项目填写了规范而改变模式。

验收要点：

- 同一条 Prompt 关联的已开启项目使用同一份仓库规范，无需逐项目复制。
- 修改仓库规范不会覆盖 system prompt 或 user prompt。
- 规范留空不阻止启用；关闭仓库上下文后也不需要删除规范内容。
- 使用仓库规范时，仍保留管线要求的评论输出结构与行内定位契约。

### 4. 调整 Prompt 页面的信息组织

围绕“共享评审规则”和“项目执行方式”重新组织页面，让项目开关、原有 Prompt 与仓库规范的区别清晰可见。页面需要提示 token 权限要求、默认关闭和拉取失败即终止的行为。

保留现有项目关联、模型选择、通知设置、Prompt 增删改和导入能力。具体组件、布局和交互在前端设计阶段确认，使用现有 Vue 与 Element Plus 技术栈，不扩展为其他页面的整体改版。

验收要点：

- 用户能分辨哪些配置由关联项目共享，哪些配置仅影响某个项目。
- 对规范为空、项目未关联、加载失败和保存失败给出明确反馈。
- 防止重复提交和误触影响其他项目；兼顾窄屏、滚动及亮暗主题。

## Capabilities

### New Capabilities

- `project-repository-context-review`：项目可明确开启仓库上下文，用单分支浅克隆和受限只读访问辅助 MR 评审。
- `shared-repository-standards`：同一条 Prompt 的关联项目共享独立、可选的仓库代码规范。

### Modified Capabilities

- `prompt-management`：Prompt 页面同时表达共享规则与项目级执行方式，保留原有配置能力。
- `merge-request-review`：开启项目在原有变更评审流程中增加仓库准备与上下文读取；关闭项目保持现状。

## Out of Scope

- 全仓历史问题扫描，或把未改动且与本次 MR 无关的问题作为此次新增评审目标。
- 执行被评审仓库的脚本、自动修复代码、提交修改或触发目标项目部署。
- 新增 Git 用户名密码管理、独立凭据管理页面或改造现有账号权限体系。
- 重做其他管理页面，或改变现有模型选择、评论回写、行内定位和通知业务规则。
- 在提案阶段确定 SDK 工具接口、数据库字段、超时数值或具体页面组件；这些属于后续设计。

## Impact

### 当前实现与预计改动边界

| 模块 | 当前证据 | 预计影响 |
| --- | --- | --- |
| Prompt 领域模型 | [review-prompt.ts:12–81](<src/domain/review-prompt.ts#L12-L81>) | 增加共享仓库规范及项目开关所需契约，保持原有字段兼容 |
| 配置持久化 | [prompt-repo.ts:159–188](<src/infrastructure/sqlite/prompt-repo.ts#L159-L188>) | 保存新配置并处理旧数据默认关闭；保留现有 Prompt 解析逻辑 |
| 管理 API | [prompts.ts:136–204](<src/interfaces/http/api/prompts.ts#L136-L204>) | 扩展读取、保存和参数校验；凭据不作为页面新增字段 |
| 评审任务与管线 | [review-task.ts:49–110](<src/domain/review-task.ts#L49-L110>)、[review-pipeline.ts:400–492](<src/application/review-pipeline.ts#L400-L492>) | 解析模式、准备正确版本的仓库、处理失败与清理，并传递只读上下文 |
| 模型执行适配 | [reviewer.ts:48–80](<src/infrastructure/pi/reviewer.ts#L48-L80>)、[reviewer.ts:176–186](<src/infrastructure/pi/reviewer.ts#L176-L186>) | 在保持资源隔离的前提下增加受限只读能力，不直接开放通用执行工具 |
| Prompt 页面 | [PromptsView.vue:91–185](<web/src/views/PromptsView.vue#L91-L185>) | 重组共享规则与项目设置，补充状态和失败反馈 |
| 验证 | [管线测试](<test/application/review-pipeline.test.ts>)、[Prompt 仓储测试](<test/infrastructure/sqlite/prompt-repo.test.ts>)、[模型适配测试](<test/infrastructure/pi/reviewer.test.ts>) | 覆盖开启与关闭、共享规则、旧库兼容、版本与失败边界、只读隔离和原有功能回归 |

预计涉及配置存储与升级，但不在提案中预设表结构。设计阶段必须明确升级、备份和回退边界，保证旧项目仍默认关闭。

### 主要风险与后续设计输入

- **仓库访问权限**：现有 GitLab API token 是否能克隆取决于权限范围；开启功能前需要清楚提示。
- **版本一致性**：MR 分支可能继续推进，源仓库也可能不同于目标仓库；需要获取并核对本次评审对应的代码。
- **运行环境与资源**：运行环境需要可用的 Git；大仓库、并发任务、超时和临时目录清理需要受控。
- **只读安全**：不能因为提供上下文而允许访问服务凭据、仓库外文件或执行仓库内容。
- **配置生命周期**：项目关联变更、Prompt 删除及 default 兜底时如何保留或停用开关，需要在设计阶段明确，不能误开启其他项目。

本阶段未运行测试、构建或真实仓库拉取。现有验证入口为 [package.json:10–15](<package.json#L10-L15>) 中的 `npm test`、`npm run typecheck` 和 `npm run build:frontend`；脚本存在不代表验证已经通过。

### Handoff Decision Ledger

| ID | Decision | Source | Blocking | Status | Evidence / explicit confirmation |
| --- | --- | --- | --- | --- | --- |
| P-001 | 每个项目独立控制仓库上下文开关 | 2026-10-23 本会话，问题 `P-001` 的用户选择 | yes | `user-confirmed` | P-001：用户选择“每个项目独立开关（推荐）”，而非同一 Prompt 的关联项目共用开关。 |
| P-002 | 评审本次 MR 变更，按需读取全仓上下文 | 2026-10-23 本会话，问题 `P-002` 的用户选择 | yes | `user-confirmed` | P-002：用户选择“评审本次变更，按需读取全仓上下文（推荐）”，未选择整个仓库全面审查。 |
| P-003 | 拉取复用当前任务的 GitLab token | 2026-10-23 本会话，问题 `P-003` 的用户选择 | yes | `user-confirmed` | P-003：用户选择“复用当前任务的 GitLab token（推荐）”，不新增部署用户名密码或逐项目独立凭据。 |
| P-004 | 拉取失败、超时或版本不可用时终止本次评审并记录失败 | 2026-10-23 本会话，问题 `P-004` 的用户选择 | yes | `user-confirmed` | P-004：用户选择“终止本次 Review 并记录失败（推荐）”，不采用仅评审 diff 的降级方式。 |
| P-005 | 仓库规范由同一条 Prompt 的关联项目共享 | 2026-10-23 本会话，问题 `P-005` 的用户选择 | yes | `user-confirmed` | P-005：用户选择“同一 Prompt 下的项目共享”，而非每个项目独立维护规范。 |
| P-006 | 仓库规范选填，留空也能开启仓库上下文 | 2026-10-23 本会话，问题 `P-006` 的用户选择 | yes | `user-confirmed` | P-006：用户选择“选填，留空也能开启（推荐）”，留空时继续遵循现有 Prompt。 |
| P-007 | 所有项目默认关闭，仅手动开启项目的后续评审生效 | 2026-10-23 本会话，问题 `P-007` 的用户选择 | yes | `user-confirmed` | P-007：用户选择“默认关闭，逐项目明确开启（推荐）”；问题明确包含 default Prompt 不自动替未配置项目开启拉取。 |
| P-008 | 使用 slug `repository-context-review`，新建 small form 提案，不覆盖或迁移 | 2026-10-23 本会话，问题 `P-008` 的用户选择及写入前路径检查 | yes | `user-confirmed` | P-008：用户选择“采用该名称和单文件提案（推荐）”；目标为本文件，写入前检查确认目标变更目录及两种 proposal form 均不存在。 |

### Pre-write Confirmation Evidence

- Covered IDs: `P-001`, `P-002`, `P-003`, `P-004`, `P-005`, `P-006`, `P-007`, `P-008`
- Outstanding blocking decisions: `none`
- Explicit user authorization to write: 2026-10-23 本会话，用户对 `proposal-write-authorization` 选择“授权按上述内容写入提案（推荐）”。该问题明确授权按已展示的 Why / What Changes / Out of Scope / Impact 摘要与 P-001～P-008，新建 [proposal.md](<fp-docs/changes/repository-context-review/proposal.md>)；仅创建本提案，不修改业务代码，不提前生成设计或任务计划。
- Canonical representation: `small`；唯一入口为 [proposal.md](<fp-docs/changes/repository-context-review/proposal.md>)；无分片、覆盖、转换或移除动作。
- Branch: `feat/repository-context-review`，从干净的 `main` 工作区创建；未提交或推送代码。
- Post-write artifact confirmation: 2026-10-23 本会话，用户对 `proposal-postwrite-confirmation` 选择“确认提案，进入技术设计（推荐）”。本提案写入后确认门禁已通过；该确认不授权跳过设计和任务计划的确认门禁。
