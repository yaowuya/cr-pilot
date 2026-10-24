# 仓库上下文评审 — Prompt 页面设计

保留 `/prompts` 入口及现有功能，把共享规则与项目执行方式分开。用户可以在同一条 Prompt 中为不同项目设置不同开关，并维护一份选填的仓库规范。数据与安全契约由 [后端设计](<fp-docs/changes/repository-context-review/design/backend.md>) 独占。

## 第一部分：架构决策

### Decision Ledger

| ID | Decision | Source | Blocking | Status | Evidence / explicit confirmation |
| --- | --- | --- | --- | --- | --- |
| D-001 | 沿项目 UI 规范和相邻页面推导视觉，不使用 Figma/截图 | 本会话问题 D-001；[前端设置](<fp-docs/settings/frontend.md>) | yes | `user-confirmed` | D-001：用户明确选择“按现有 UI 规范和相邻页面推导（推荐）”。 |
| D-013 | 保留列表与编辑弹窗，表单分为项目、Prompt、仓库规范、模型通知四区 | 本会话自主推进授权；[现页面](<web/src/views/PromptsView.vue#L1-L185>) | yes | `user-confirmed` | D-013：依据“不需要再次询问我，直接使用你的最佳推荐，继续往下走”选择分组弹窗，非逐项人工答复。 |
| D-014 | 局部表单草稿、加载归属、防重复保存、失败保留、关闭未保存提醒 | 本会话自主推进授权；F02/F03/F06 和现 API client | yes | `user-confirmed` | D-014：依据自主推进授权选择可靠的编辑生命周期，不新增全局状态库。 |

### 选择理由与取舍

采用“列表 + 分组弹窗”，不增加独立配置路由。与继续堆成长表单相比，分组减少滚动和概念混淆；与全新详情页相比，保留现有编辑流程，改动范围更小。库内 `el-tabs` 只是信息分组，不另造组件系统；项目设置使用现有 `el-switch`、标签、表单及提示组件。

复用 [PromptEditor](<web/src/components/PromptEditor.vue>)，只增加必要的表单校验 prop 和禁用传递，不把仓库规范塞进原双字段组件。新增小型纯函数模块处理规范化、初始草稿和请求序列化，供原生 Node 测试；它服务真实的状态/保值边界，不做通用表单框架。

### Pre-write Confirmation Evidence

- Covered IDs: `D-001`, `D-013`, `D-014`
- Outstanding blocking decisions: `none`
- Explicit user authorization to write: 2026-10-23 本会话，D-001 明确选择现有 UI 规范；后续用户原文“不需要再次询问我，直接使用你的最佳推荐，继续往下走”，授权代理选择最佳布局、交互、small form 并写入 [前端设计](<fp-docs/changes/repository-context-review/design/frontend.md>)，自主继续后续流程。未伪称用户逐节审阅。
- form、完整路径和索引的跨端决策由 [后端 D-015](<fp-docs/changes/repository-context-review/design/backend.md>) 唯一持有；无转换、覆盖或移除。

## 第二部分：技术方案详述

### 设计范围适用性

| 评审范围 | 要求 | Canonical owner section | 证据或不适用理由 |
| --- | --- | --- | --- |
| 架构主线 | 必填 | #架构主线 | 提案要求配置界面和现有功能兼容 |
| 核心对象与职责 | 必填 | #核心对象与职责 | 现有页面、编辑器与 API client |
| 数据模型 | 不适用 | N/A | 持久化模型与接口字段由后端唯一维护；本端只管理草稿 |
| 状态、并发与执行流程 | 适用 | #状态并发与执行流程 | 异步加载、编辑、保存和关闭 |
| 接口、权限与兼容边界 | 适用 | #接口权限与兼容边界 | 保留 /prompts 及现有认证 |
| 前端方案 | 适用 | #前端设计 | D-001、D-013、D-014 |
| 风险、迁移、发布、回滚与监控 | 必填 | #风险迁移发布回滚与监控 | 旧响应、竞态、长内容与窄屏 |
| 验证方案 | 必填 | #验证方案 | 源码/行为/运行时视觉分开验证 |

### 架构主线

页面加载列表，展示关联项目、仓库上下文启用数量、规范是否填写以及原模型和通知信息。用户新建或编辑时加载详情与下拉建议，在同一个草稿中调整项目开关、共享文本和原有配置，点击唯一主按钮保存。

项目开关统一在“项目与执行”区域编辑，不在列表提供立即生效的裸开关，避免误触和部分保存。列表增加“仓库设置”入口按钮，打开同一编辑弹窗并定位项目区域；“编辑”默认进入评审 Prompt。所有改动仍由保存一次提交。

### 核心对象与职责

| 对象/模块 | 职责 | 不负责 | 协作对象 | 证据 |
| --- | --- | --- | --- | --- |
| PromptsView | 列表、编辑生命周期、表单分组、提交与反馈 | 直接访问 SQLite/Git/token | API client、PromptEditor | [现页面](<web/src/views/PromptsView.vue>) |
| PromptEditor | system/user 两个字段和占位符说明 | 项目设置、仓库规范、网络请求 | 父表单 | [现组件](<web/src/components/PromptEditor.vue#L39-L51>) |
| prompt-form（新增纯模块） | 默认草稿、项目设置归一化、校验和序列化 | Vue 全局状态、网络与副作用 | 页面、Node 测试 | D-014 |
| API client | Bearer、JSON、401 跳转和错误格式 | 页面加载归属 | 页面 | [client.ts](<web/src/api/client.ts#L61-L127>) |
| types | 详情与摘要的新增可选兼容字段 | 持久化逻辑 | 页面、client | [types.ts](<web/src/types.ts#L54-L94>) |

### 状态、并发与执行流程

- 列表区分别表达加载、真实空列表、错误重试，不把请求失败伪装成空状态。刷新按钮和导入按钮有独立 loading 与重复进入拦截。
- 编辑加载使用递增请求序号。打开另一项、打开新建、关闭或卸载后，旧响应不得覆盖当前草稿或重新弹窗。详情未成功时禁止保存，不用空默认值覆盖服务端数据。
- 元数据失败仍允许手工输入项目全名，但展示可重试提示；既有已选厂商/模型不因建议加载失败而被清空。默认状态不是“没有配置”。
- 草稿以稳定项目名称为 key；去重规则与后端一致。GET /meta 的 projectSettings 提供已知项目当前状态，新增关联按此初始化；真正新项目默认关闭。meta 未加载成功时，新加入项目的开关显示“状态待加载”并禁用，允许重试或只保存关联，不能用 false 覆盖全局状态。已加载详情中的既有关联仍按详情状态编辑。
- project_settings 只提交用户实际改变的项目条目，避免载入过期表单后把未操作项目的开关覆盖。现有项目仅切换开关后才标记 dirty；删除项目按 projects 最终值处理。名称变化视为删除旧关联、新增关闭，不隐式转移启用状态。
- 保存前用 `el-form.validate()` 验证并定位首个错误所在分组；校验期间也防重复进入。校验成功生成不可变 payload，再发请求；saving 时禁用输入、关闭和重复提交。
- 成功后关闭并刷新列表；若刷新失败，明确“保存成功但列表刷新失败”，不能误报保存失败。失败保留草稿并显示可重试错误。
- 关闭有未保存修改时，使用 Element Plus 确认是否放弃；取消不丢内容。没有改动或保存成功不额外询问。此为产品交互，不是开发流程确认。
- 删除弹窗文案包含 Prompt 名和影响：关联项目可能回落 default，最后一个关联删除将关闭其仓库上下文。删除请求防重，失败保留列表。

### 接口、权限与兼容边界

继续调用 [client.ts](<web/src/api/client.ts>) 的原有方法，不绕过 Bearer 认证。请求新字段、部分更新、默认状态与长度限制严格遵循 [后端接口契约](<fp-docs/changes/repository-context-review/design/backend.md#接口权限与兼容边界>)。

只扩展 [types.ts](<web/src/types.ts>) 中的 Prompt 类型；读取旧响应缺新字段时映射为空规范和全关，不影响旧字段。但上线必须后端先支持新增字段，再部署前端，不能声称旧后端会保存它们。

路由保持 `/prompts`，不加 requiresAdmin，不改变普通账号权限；401 交统一 client，403/400/409 在页面反馈。前端禁用不代替后端参数校验。default 可以维护规范正文，但没有项目开关，并提示其不会自动开启未配置项目。

### 前端设计

#### 页面与组件

列表继续复用 el-card/el-table，保留名称、关联项目、模型、企微推送和更新时间；新增紧凑的“仓库上下文”状态，展示 `已开启 X / Y`、全关或 default 不适用，不在摘要请求获取规范正文。操作区保留编辑/删除，并增加“仓库设置”文字按钮。

编辑弹窗保留现有 900px 最大宽度与 5vh 顶距，宽度限制为视口减去两侧已有 16px 间距；正文有界滚动，底部取消/保存保持可达。四个标签分组：

1. **项目与执行**：名称、关联项目输入；逐项目开关与状态文字；短名匹配规则、共享项目状态、token 读权限、失败终止说明。无项目时显示空态。短名与完整路径都可开启，只有含非法字符的项目名才禁用并说明原因。
2. **评审 Prompt**：复用双字段编辑器，明确 system=评审角色和要求，user=本次变更模板；保留占位符说明。
3. **仓库规范**：独立多行文本，标题标注“关联项目共享·选填”；说明仅在开启上下文时生效，建议覆盖架构、接口、数据、安全、日志、测试和性能。显示字数与后端上限，不自动填充未确认的规范正文。
4. **模型与通知**：原厂商、模型、企微阈值和 Webhook，字段语义不变。

#### Visual Source

- 类型：UI/UX spec + existing code。
- 来源：[frontend settings](<fp-docs/settings/frontend.md>)、[prototype-style](<fp-docs/settings/prototype-style.md>)、[PromptsView](<web/src/views/PromptsView.vue>)、[ProvidersView](<web/src/views/ProvidersView.vue#L1-L24>)、[AdminLayout](<web/src/layouts/AdminLayout.vue#L410-L445>) 和 [全局样式](<web/src/styles/index.css#L160-L239>)。
- 可信边界：组件、token、已有间距与 768px 断点已从源码核实。没有 Figma、用户截图或像素级验收基准；实现后需检查真实渲染，不把源码推导说成视觉验收。

#### UI/UX Settings Source

- Settings read：[frontend](<fp-docs/settings/frontend.md>)、[prototype-style](<fp-docs/settings/prototype-style.md>)、[agent](<fp-docs/settings/agent.md>)。
- Existing references：本节 Visual Source 所列文件，以及 [PromptEditor](<web/src/components/PromptEditor.vue#L54-L85>) 与 [API client](<web/src/api/client.ts>)。
- Confirmed tokens/components：Element Plus；现有 `--el-color-primary`、`--el-text-color-*`、`--el-bg-color*`、`--el-border-color*`、`--el-border-radius-base`、`--app-content-padding`；不新建品牌颜色。
- Confirmed UX rules：共享规范 F01～F07、保存防重、错误保留、字段标签、键盘可操作、危险动作确认、关闭未保存提醒。
- Unknowns requiring user confirmation：none；布局与交互依据明确委托选定，运行时视觉是否符合预期仍需验证。

#### UI 组件树与 Figma 解析映射

| 设计区域/节点 | 目标 DOM/组件层级 | 项目组件 | 布局策略 | 关键 token/尺寸 | 备注 |
| --- | --- | --- | --- | --- | --- |
| 页面头部 | page-container → page-header → 标题/操作 | 现有类、el-button/el-icon | Flex，窄屏换行 | 页面 gap 16px、操作 gap 8px、标题 20px/600，源自全局样式 | 保留导入/新建，新增刷新复用 ProvidersView |
| 列表 | el-card → el-table → 状态/操作 | 表格、标签、tooltip、popconfirm | 表格内部滚动，长名截断 | 13px 表格、20px 卡片 padding、语义状态色 | 不制造页面横向滚动 |
| 编辑壳 | el-dialog → el-form → el-tabs → 分组 | Element Plus 原生组件 | 弹窗 flex column，正文滚动 | 原 900px/5vh；窄屏两侧 16px；分区 gap 16px | 768px 以下表单单列 |
| 项目设置 | 项目列表 → 名称/状态/开关 | el-select、el-switch、el-tag、el-alert | Flex 换行，名称 min-width:0 | gap 8px/16px，背景/边框沿现有 token | 同项目跨 Prompt 共享状态提示 |
| Prompt | 分组 → PromptEditor | 既有组件 | 纵向表单 | 原 textarea 9 行，13px 等宽、1.6 行高 | 原占位符保留 |
| 仓库规范 | 标题/说明 → textarea/字数 | el-input、el-alert | 纵向，垂直可调整高度 | 复用 PromptEditor 字体、行高和现有 9 行 | 不渲染不可信 HTML/Markdown |
| 模型与通知 | el-row/el-col → form items | 现有 select/input | 桌面多列，窄屏单列 | 既有 gutter 16px | 不引入新状态库或模型组件 |
| 底部动作 | dialog footer → 取消/保存 | el-button | 右对齐，窄屏保持可达 | 现有主次按钮、gap 8px | 保存 loading 与禁用同步 |

#### Visual Checks

- [ ] 亮暗主题下，新增标签、开关、提示和文本框均沿语义 token，无硬编码品牌色。来源：全局样式与 F04。
- [ ] 页面头部保留 16px 分区/8px 操作间距，标题 20px；窄屏操作换行而非挤出视口。来源：全局样式、AdminLayout 768px 断点。
- [ ] 桌面弹窗最大 900px、5vh 顶距；窄屏两侧至少 16px；长规范滚动时保存按钮可达。来源：现 PromptsView、AdminLayout 和 D-013 布局决策。
- [ ] 关联长项目名、多个项目、全关/部分开启/default 均能读出状态，不只靠颜色。来源：现标签模式与 F06。
- [ ] System/User Prompt、仓库规范和项目开关各有独立标题与作用范围提示。来源：提案 P-001、P-005。
- [ ] 切换分组不丢草稿；保存错误定位到相应分组且保留输入；键盘可以操作标签、开关与按钮。来源：F03/F06、D-014。
- [ ] 初始加载、无数据、列表失败、详情失败、meta 失败和保存失败视觉不同，并提供适当重试。来源：F03/F06。
- [ ] 开关文字说明包含“保存后生效”“需要仓库读取权限”“拉取失败终止”；短名可正常开启，只有非法名称才禁用并说明原因。来源：后端契约和提案。
- [ ] 原有导入、删除确认、模型/通知设置和主题导航未丢失。来源：现 PromptsView、ProvidersView。

### 风险、迁移、发布、回滚与监控

| 具体失败场景 | 影响 | 预防或处理 | 发布/回滚/监控安排 | 证据 |
| --- | --- | --- | --- | --- |
| 旧详情覆盖新编辑会话 | 配错项目或覆盖正文 | 请求序号与关闭/卸载失效 | 异步乱序测试，浏览器复核 | D-014 |
| 列表失败显示空态 | 用户误认为无配置 | 独立 error 状态和重试 | 不清空已加载列表 | F03/F06 |
| 新后端未部署 | 新字段被忽略 | 后端先上线，同版本静态资产 | 回退页面不自动删除新配置 | 后端发布契约 |
| 同项目多 Prompt 关联 | 用户误认为开关仅影响当前 Prompt | 明确全局项目状态，提交实际变更条目 | 后端按同一键返回状态 | D-002/D-005 |
| 标签内错误或窄屏长内容 | 错误不可见、无法保存 | 定位错误分组、正文滚动、单列布局 | Visual Checks 独立记录证据 | D-013/D-014 |

无需新增数据迁移或路由迁移；数据迁移完全由后端拥有。有意延后：不引入前端测试框架；当前可用 Node 测试验证纯草稿/序列化与异步守卫，组件交互使用隔离浏览器走查。若后续要求 CI 持续覆盖组件/键盘/视觉，则单独引入受批准的组件/E2E 工具，不用静态源码断言冒充浏览器通过。

### 验证方案

| 验证项 | 命令或操作 | 预期结果 | 覆盖设计 | 证据 owner |
| --- | --- | --- | --- | --- |
| 纯逻辑 | Node 测试新增 prompt-form 测试 | 缺新字段兼容、独立开关、只提交 dirty 项、增删项目、规范限额 | D-014、接口契约 | 本节 |
| 类型/构建 | `npm run typecheck`、`npm run build:frontend` | Vue 模板、props、类型和生产静态资源可构建 | 全页面 | 本节 |
| 隔离浏览器 | 合成 API 数据；普通/窄屏和亮/暗主题执行 Visual Checks | 可见状态与交互符合设计；无真实保存/通知 | Visual Checks | 本节 |
| 回归 | 新建/编辑/导入/删除/厂商模型/企微字段流程 | 旧功能保留，无重复提交或过期响应覆盖 | 提案其他功能不变 | 本节 |

没有可用浏览器时明确列出未验证项，不安装新依赖或连接真实业务后端来补证。新增/实质修改代码同步遵循 F01～F07 和共享工程质量注释要求。
