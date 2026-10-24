# 仓库上下文评审 Frontend Plan

> **For agentic workers:** REQUIRED FLOW: Use `fp-execute` task-by-task. Only task markers use checkbox syntax.

## Global Constraints

- 依据唯一 small form [前端设计](<fp-docs/changes/repository-context-review/design/frontend.md>)，以及后端唯一接口 owner；不创建 split 目录。
- 用户明确授权“不需要再次询问我，直接使用你的最佳推荐，继续往下走”，本计划自主采用推荐并继续；不伪造逐项人工确认，不自动提交/推送。
- Vue 3、Element Plus、既有 api client/types/scoped CSS；不新增状态框架、测试依赖或路由。
- 项目开关统一且部分更新；规范共享、选填、32,000 字符；旧响应缺字段兼容；普通登录账号权限保持。
- 保留现有 token 与 768px 断点，桌面最大 900px 弹窗，间距来自现有 8/16/20px 规则；不发明品牌色。
- Engineering quality：`C:/Users/Lenovo/.dsh/skills/_shared/engineering-quality.md`、`code-standards/common.md`、`code-standards/vue.md`；F01～F07 仅适用于 web。
- 验证命令：`node --test test/web/prompt-form.test.ts`、`npm run typecheck`、`npm run build:frontend`。现有全局 `playwright-cli` 0.1.22 已通过 --version/--help 验证，本机 Chrome/Edge 已存在；无需安装依赖或浏览器。
- 视觉来源按用户 D-001 采用 UI 规范与现有源码，没有 Figma/原始参考图。像素对比的 reference.png 不得伪造，严格视觉证据记 CANNOT_VERIFY；这不冒充静态/功能/真实浏览器验证失败，也不冒充视觉通过。
- 必需真实 E2E 不用 mock/intercept、业务数据 seed、localStorage 注入或绕 UI 写 API。使用独立临时实例和正常初始化的测试账号，业务配置经 UI 创建/删除；不连接真实业务库或外部 GitLab/模型。
- Commit 步骤本轮只记录工作区证据，不运行 git add/commit。

## File Structure

| Path | Action | Responsibility |
| --- | --- | --- |
| [types.ts](<web/src/types.ts>) | modify | 新详情/摘要/meta 字段 |
| `web/src/views/prompt-form.ts`、`test/web/prompt-form.test.ts` | create/test | 草稿、部分开关更新、校验与异步归属辅助 |
| [PromptsView.vue](<web/src/views/PromptsView.vue>) | modify | 列表、分组弹窗和可靠编辑生命周期 |
| [PromptEditor.vue](<web/src/components/PromptEditor.vue>) | modify | 必要的表单 prop/禁用传递，保留双字段职责 |
| `scripts/verify-repository-context-ui.ts` | create | 使用真实应用组件启动独立临时验证实例，不 seed 业务配置 |
| 当前变更 `.fp-execute/visual/`、`.fp-execute/e2e/` | evidence | 分离视觉/浏览器业务证据，不能取代源任务 checkbox |

## 1. Page goal and visual contract

提供清晰的项目仓库设置入口，将共享 Prompt、共享规范和项目开关区分。保留新建、编辑、导入、删除、模型、通知和主题导航。

### 1.1 Figma source and browser capability resolution

- UI design source: `no trustworthy Figma UI design`；用户明确选择现有 UI 规范/相邻代码。
- Prototype usage: `FUNCTION_SCOPE_ONLY`；本轮不创建原型，不用运行截图冒充设计参考。
- Browser capability: `local playwright-cli`，0.1.22；浏览器安装已存在，启动实际验证在页面可运行后进行。
- Completion vocabulary: 缺 reference.png 的严格视觉结果为 `CANNOT_VERIFY`；必须与真实 UI 行为和构建证据分开，不虚构 VISUAL_REVIEW_PASS 或 archive-ready。

### 1.2 Capability and preservation mapping

没有 Figma 来源，FIGCAP/PRES 专属台账不适用；直接按提案与现页面逐项覆盖。新增配置和原有 CRUD/模型/通知由 frontend-002 唯一负责，纯数据转换由 frontend-001 负责。

## 2. Frontend Interface and Visual Contract

| Contract | Owner Task | Exact shape / behavior | Consumers | Verification |
| --- | --- | --- | --- | --- |
| PromptDraft/createPromptDraft | frontend-001 | 原表单字段 + repositoryStandards、project 状态及 dirty 集合；缺字段空/关 | 页面 | Node 状态测试 |
| buildPromptPayload | frontend-001 | projects 全量、规范字符串、project_settings 仅 dirty 项，其余旧字段不变 | 保存 | 精确 payload 断言 |
| validatePromptDraft | frontend-001 | 必填原字段、规范长度、全名开关限制；返回可定位分组的错误 | 表单 | 边界测试 |
| request generation guard | frontend-001 | 编辑意图编号；只有最新意图写入，关闭/卸载失效 | 页面 | 乱序 promise 测试 |
| /prompts 编辑 UI | frontend-002 | 四分组、项目开关文字说明、默认规则、加载/错误/保存/关闭反馈 | 用户 | real browser + build |
| 视觉与交互 | frontend-002 | 前端设计唯一 Visual Source/组件树/Visual Checks | 页面 | 下方证据 manifest |

### 2.1 Component tree and template outline

page-container → header/actions → error/empty/table → el-dialog → el-form → el-tabs（项目与执行、评审 Prompt、仓库规范、模型与通知）→ footer。复用 PromptEditor 与既有 Element Plus 控件；列表“仓库设置”打开项目分组。

### 2.2 State/API/interaction design

局部 ref/reactive 草稿，详情加载成功后才可保存；meta 失败时新项目状态待加载而非误写 false。请求序号防止过期响应，dirty 项部分更新防止未改配置被覆盖。saving 防重复，失败保留，关闭未保存确认。

### 2.3 Style and responsive design

只采用 [设计映射](<fp-docs/changes/repository-context-review/design/frontend.md#ui-组件树与-figma-解析映射>) 中现有类/token/尺寸；窄屏单列、长项目名换行或截断、表格内滚动，底部保存可达。

### 2.4 Visual and UX checks

完整执行 [Visual Checks](<fp-docs/changes/repository-context-review/design/frontend.md#visual-checks>)；没有原始参考图时记录缺口，不把浏览器截图相互比较当设计保真证据。

### 2.5 Visual Evidence Manifest

Evidence root 为当前变更 `.fp-execute/visual/frontend-002/`。每个 case 的 manifest.md 记录实际执行时间、代码版本和文件证据；缺 reference 不创建假的 reference.png。

| Case ID | Approved design source | Figma node | revision/time | Frame/variant | variables / Auto Layout / assets | Runtime route | Scenario/state | Viewport | DPR | Locale | Theme | Deterministic non-sensitive fixture | Reference path | Current path | Diff path / missing diff | Mask | Acceptance rule | Command/tool | Failure class | Result |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| desktop | 前端 D-001/组件映射 | N/A | 2026-10-23 设计 | 列表/项目分组/规范分组 | 现有 CSS token | 隔离实例 /prompts | 默认/部分开启/保存失败 | 1440x900 | 1 | zh-CN | light/dark | 通过 UI 创建 crp-e2e/group-a 与 group-b 配置，无真实代码或凭据 | 缺失：无设计参考图 | .fp-execute/visual/frontend-002/desktop/current.png | missing diff：无原始参考 | 无 | 标签/说明完整、无页面溢出、保存可达；不做像素通过声明 | playwright-cli -s=crp-context screenshot | core visual reference missing | CANNOT_VERIFY |
| narrow | 前端 D-001/768px 规则 | N/A | 2026-10-23 设计 | 窄屏长内容/错误 | 同上 | 隔离实例 /prompts | 单列/长项目名/规范滚动 | 390x844 | 1 | zh-CN | light/dark | 同 desktop 的 UI 创建配置 | 缺失：无设计参考图 | .fp-execute/visual/frontend-002/narrow/current.png | missing diff：无原始参考 | 无 | 无横向页面溢出，正文滚动且按钮可达 | playwright-cli -s=crp-context resize 390 844 | core visual reference missing | CANNOT_VERIFY |

### 2.6 UI/E2E Delivery Contract

| Task ID | Case ID | Source-derived condition / requirement reference | UI Delivery Level | Runtime route reference / E2E route | E2E Applicability | Required lifecycle path / stage evidence | Coverage matrix | N/A / BLOCKED rationale |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| frontend-002 | desktop | 提案 P-001/P-005/P-006/P-007、前端状态/接口契约及原 CRUD | business-flow | desktop route | REQUIRED | SOURCE_READY → STATIC_UI_READY → VISUAL_REVIEW_PASS → INTERACTION_READY → FRONTEND_E2E_PASS；逐阶段真实证据 | .fp-execute/e2e/frontend-002/desktop/coverage-matrix.md | 严格视觉参考缺失为 BLOCKED；不能用构建或 E2E 替代。代码/行为验证仍独立记录实际结果。 |
| frontend-002 | narrow | 前端 Visual Checks 窄屏/键盘/滚动/错误 | business-flow | narrow route | REQUIRED | 同上，窄屏独立证据 | .fp-execute/e2e/frontend-002/narrow/coverage-matrix.md | 参考图缺失同样 BLOCKED；无法安全触发的真实异常亦如实记 BLOCKED。 |

真实浏览器验证记录 command、environment、destination、起止时间、attempts、test IDs、artifacts、coverage matrix、cleanup，以及 `Mocked Core API: false`。不以未获得的视觉通过状态推进归档，最终报告保留这一流程证据限制。

## 3. Task breakdown

- [x] **Task frontend-001: 定义兼容的 Prompt 草稿与差量保存逻辑**

**Files:** Modify [types.ts](<web/src/types.ts>); Create `web/src/views/prompt-form.ts`、`test/web/prompt-form.test.ts`。
**Reasoning:** 将部分开关更新、默认值和过期请求守卫做成可离线验证的纯逻辑，页面不重复实现规则。
**Depends on:** backend-003
**Interfaces:** Consumes 新 API 详情/meta；Produces createPromptDraft/buildPromptPayload/validatePromptDraft 及 generation guard；Contract checks 旧响应、新项目、共享状态、dirty-only。
**Capability / Preservation Ownership:** FIGCAP/PRES None；本任务不拥有 UI case，验证数据转换边界。
**Step 1: Write the failing test**
```ts
const draft = createPromptDraft(detail);
assert.equal(draft.repositoryStandards, '');
assert.deepEqual(buildPromptPayload(draft).project_settings, []);
assert.equal(validatePromptDraft({...draft,repositoryStandards:'x'.repeat(32001)}).length > 0, true);
```
增加两个项目只修改一项、删关联清 dirty、缺 meta 不假定关闭、旧响应、非法项目名校验与短名可开启，以及乱序意图测试。
**Step 2: Run test to verify it fails**：`node --test test/web/prompt-form.test.ts`；预期新模块缺失。
**Step 3: Write minimal implementation**：仅依赖类型与纯 TS；不创建新 store，不运行请求。
**Template Outline:** 无 DOM，向 frontend-002 提供 typed state。
**Script/State Outline:** 明确 source snapshot 与 editable draft，序列化只包含实际变化的 project 设置；校验返回 field/group/message。
**Style Outline:** 无 CSS，不产生视觉变更。
**Visual / UX Checks:** UI 不适用；不能以本测试声称页面交互已通过。
**UI/E2E Lifecycle and Evidence:** 本任务仅非 UI 数据层；实际 UI/E2E 由 frontend-002 唯一拥有。
**Step 4: Run test to verify it passes**：同命令、`npm run typecheck`；自审与后端字段一致。
**Step 5: Commit**：仅记录工作区与进度，无 Git 提交。

- [ ] **Task frontend-002: 实现项目仓库设置入口、分组编辑及运行验证**

**Files:** Modify [PromptsView.vue](<web/src/views/PromptsView.vue>)、[PromptEditor.vue](<web/src/components/PromptEditor.vue>); Create `scripts/verify-repository-context-ui.ts`; Test `test/web/prompt-form.test.ts` 与本任务视觉/E2E 目录。
**Reasoning:** 交付可用配置页面，保留原功能并防止异步误覆盖和误触保存。
**Depends on:** frontend-001, backend-010
**Interfaces:** Consumes 草稿 helpers、原 api client、后端 CRUD/meta；Produces 分组页面和测试实例；Contract checks 四分组、项目全名独立开关、规范可空、原功能/权限保留。
**Capability / Preservation Ownership:** FIGCAP/PRES None；提案前端与原 CRUD/通知/模型功能均由本任务负责。Browser replay：`playwright-cli -s=crp-context open <隔离实例输出URL>/prompts`，后续 snapshot/fill/click/reload；不调用 route 或注入状态。
**Step 1: Write the failing test**：先扩充 helper 的 async/validation 用例并运行 red；在旧页面用浏览器检查“仓库设置”入口及规范字段不存在，记录实际基线而非用文本搜索冒充交互测试。
**Step 2: Run test to verify it fails**：`node --test test/web/prompt-form.test.ts` 以及页面基线；预期新配置无法操作。
**Step 3: Write minimal implementation**：使用已确认组件与类型，表单保存/导入/删除防重、加载归属和关闭保护同步实现。
**Template Outline:** page-header/actions → error/table → el-dialog/el-form/el-tabs → 项目列表与开关、PromptEditor、规范 textarea、原模型通知 → footer。每个字段有 label，tab 可键盘操作。
**Script/State Outline:** 多种 loading/error 独立；请求序号；使用 dirty-only payload；校验失败定位 tab；保存失败保留草稿；成功与刷新失败分别提示。测试实例使用临时路径和真实 app/router/repo，不读取工作区 .env/data，不连模型，不 seed 业务配置。
**Style Outline:** scoped CSS、既有 token、8/16px gap、900px 最大弹窗和 768px 断点；底部动作可达、长名称不撑破页面。
**Visual / UX Checks:** 执行本计划 desktop/narrow 与设计所有检查项；按实际记录 reference 缺失、current 截图、无 diff 原因。
**UI/E2E Lifecycle and Evidence:** 使用上述两个 case 的独立 manifests/coverage；严格视觉缺失不标通过。真实业务 UI 验证创建两个项目、只开一项、填写/清空规范、保存刷新保值、取消不保存、关闭保留规范、删除最后关联关闭、原模型通知字段保留、登出后无权限。失败/竞态可用真实浏览器 offline 条件，不能拦截伪造响应。
**Step 4: Run test to verify it passes**：`node --test test/web/prompt-form.test.ts`、`npm run typecheck`、`npm run build:frontend`。启动 `node scripts/verify-repository-context-ui.ts` 为 managed background job，收集实际 URL；Playwright 仅操作本实例，测试完 UI 删除记录、关闭浏览器并终止该 job。记录严格视觉/真实异常未覆盖项，不因此伪称完整验收。
**Step 5: Commit**：仅记录工作区、验证和进度；若所需 UI 生命周期证据仍 BLOCKED，不把本任务完整交付标记为完成，不建议归档。

## Coverage Matrix

| Source | Requirement / preservation / visual boundary | Tasks | Verification |
| --- | --- | --- | --- |
| P-001/P-007、D-013 | 独立开关、默认关闭、项目归属清晰 | frontend-001、frontend-002 | Node payload 测试、desktop 实际保存重开 |
| P-005/P-006 | 共享规范与原 Prompt 分离，可空且关闭不删 | frontend-001、frontend-002 | 字段测试、浏览器保存/关闭/重新打开 |
| D-014/F03/F06 | 失败保留、重复提交、过期响应、加载/空/错误 | frontend-001、frontend-002 | 原生状态测试与真实 offline/交互证据 |
| D-001/F04、Visual Checks | 主题、窄屏、长内容和布局 | frontend-002 | current 截图；reference 缺失如实 CANNOT_VERIFY |
| 提案其他功能不变 | 导入、CRUD、模型/通知、认证与路由 | frontend-002 | UI 回放、真实 API/persistence；未安全覆盖项 BLOCKED |
| UI/E2E contract | 独立证据与清理 | frontend-002 | 每 case coverage/manifest、Mocked Core API:false、cleanup |
