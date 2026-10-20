# FeaturePilot Prototype Style

## Usage

- 明确选择生成或更新原型时读取本文件；它只定义视觉与交互约束，不授权创建基座、修改生产入口或调用真实业务服务。
- 目标应用为 `web`，生产根为 [web](<web/>)。渲染模式尚未选择：默认建议 `static-modular`；需要真实 Vue / Element Plus 运行时才选择 `project-native`，两者均使用 Mock 数据。
- 模式、componentMap、网络隔离与证据要求沿插件 `skills/_shared/prototype-contract.md`；原型需求和权限场景仍须当前需求确认。

## Visual Sources

- 令牌、排版与通用页面样式：[index.css](<web/src/styles/index.css>)。
- 外壳、导航和响应式布局：[AdminLayout.vue](<web/src/layouts/AdminLayout.vue>)。
- 组件库及覆盖顺序：[main.ts](<web/src/main.ts>)；图表主题行为参考 [ChartCard.vue](<web/src/components/ChartCard.vue>)。
- Confidence: 当前源码核实；本轮未做浏览器或截图比对。未提供权威 Figma、截图或已批准原型。

## Page Skeleton and Layout

- 外壳为左侧品牌/菜单、右侧顶栏与内容区。顶栏包含折叠开关、面包屑、主题切换和用户菜单，内容区独立滚动。
- 侧栏宽度沿 `--app-sidebar-width` / `--app-sidebar-collapsed-width`（当前 224px / 72px），顶栏高度沿 `--app-logo-height`（当前 60px）。
- 内容区使用 `--app-content-padding`（当前 24px）；页面沿 `.page-container`、`.page-header` 与 `.page-header__actions`，按既有标题/说明/右侧操作层级组织。
- 当前断点为 768px：窄屏收起侧栏并隐藏部分文字/面包屑，内容内边距改为 16px。目标页面表格溢出和更小视口方案须另行核对，不推定完整移动端支持。

## Color, Typography, and Spacing

数值仅作当前视觉基线；生成前核对源码变量，避免把本文件中的快照当作独立 token 源。

- Primary colors: `--el-color-primary` 当前亮色 `#5b5bd6`、暗色 `#818cf8`；按钮、链接、选中态和焦点态沿组件语义变量。
- Text colors: 沿 `--el-text-color-primary/regular/secondary`。亮色三级为 `#273142` / `#526077` / `#7a879c`，暗色为 `#f1f5f9` / `#cbd5e1` / `#94a3b8`。
- Backgrounds/borders: 沿 `--el-bg-color`、`--el-bg-color-page`、`--el-border-color*` 与 `--app-*`；当前亮色页底 `#f6f7fb`、内容白色，暗色页底 `#0b1120`、内容 `#151e30`。
- Font stack: 沿全局 Inter、系统 UI 与中文回退字体栈；正文当前 14px，页面标题 20px / 600，说明与表格 13px。
- Spacing scale: 页面间距当前 16px、操作区间距 8px、卡片内容 20px；复用既有变量/类，不新增另一套间距体系。
- 圆角沿 `--el-border-radius-base/small`（当前 8px / 6px），过渡沿 `--app-transition`（当前 0.2s）。

## Component Patterns

- Buttons: 保留 Element Plus 的主次与危险操作语义、图标间距及主题状态；固定视觉放样式层，运行时尺寸按实际需要绑定。
- Forms: 沿目标生产页面的 Element Plus 表单布局与校验交互；字段范围、必填和提交结果由当前需求确认，失败保留输入。
- Tables: 沿全局表格的主题边框、浅色表头/hover 和字号；筛选、分页、列结构和空态以目标页面及已批准需求为准。
- Dialogs/drawers: 复用目标页面现有组件和样式。全局统一宽度、抽屉边界和复杂表单布局尚未确认，记为 Unknown。
- Empty/loading/error states: 用合成场景展示已确认的加载、空、失败、无权限和成功状态；未演示的状态不能声称已验收。
- 图表跟随亮/暗主题和容器尺寸；真实组件模式复用现有图表封装与释放机制，静态模式保留视觉语义并登记映射。

## Interaction and Copy Rules

- 必需交互由当前需求范围决定；外壳相关场景应覆盖侧栏、主题和导航，业务操作只产生可观察的 Mock 结果。
- 提交/删除等操作展示 loading、防重复进入、成功和失败反馈；破坏性操作确认目标及影响，失败时保留可恢复状态。
- 权限场景显式区分隐藏、禁用和服务端拒绝；前端展示不能替代后端权限证明，真实鉴权细则见 [后端设置](<fp-docs/settings/backend.md>)。
- 文案以现有简明中文为基线，明确说明操作对象、结果和可恢复动作；图标操作保留可访问名称。
- 验证亮/暗主题、普通/窄屏、滚动和浮层；仅源码读取不构成视觉验收。

## Unknowns

- 权威设计稿、截图基线、视觉验收视口与误差容限：Unknown。
- 全局弹窗/抽屉尺寸、完整移动端策略、需覆盖的业务异常和角色矩阵：Unknown，随具体需求确认。
- 原型用途、模式、基座登记和预览入口：尚未授权或初始化；本设置不代替其独立决策。
