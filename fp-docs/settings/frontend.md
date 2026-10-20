# FeaturePilot Frontend Settings

## Frontend Framework and Source Locations

- Framework: Vue `^3.5.13`、TypeScript、Vue Router `^4.5.0`，构建器为 Vite `^6.0.7`。版本为 [依赖声明范围](<web/package.json>)，不是对当前安装版本的额外验证。
- Source roots: appRoot 为 [web](<web/>)，入口为 [main.ts](<web/src/main.ts>)，布局为 [AdminLayout.vue](<web/src/layouts/AdminLayout.vue>)，页面位于 `web/src/views/`。
- Route locations: [router/index.ts](<web/src/router/index.ts>) 使用 history 模式与页面懒加载；生产访问依赖后端 SPA fallback，新增路由须同时核对刷新与直达行为。

## Code Standards

- Built-in preset: `vue`。
- Rule resources: `skills/_shared/code-standards/common.md` + `skills/_shared/code-standards/vue.md`；均为已安装 FeaturePilot 插件相对路径，不是消费者仓库路径。
- Applies to: 仅 `web/`；直接依赖证据为 [package.json](<web/package.json>)，实际入口为 [main.ts](<web/src/main.ts>)，构建证据为 [vite.config.ts](<web/vite.config.ts>)。按 Vue 3 / Vite 6 能力适配，不扩大到根目录 Express 后端。
- Project rule sources: `none`（本轮未发现独立客户代码规范文件）；运行和部署说明另见 [README](<README.md>)。
- Confirmed overrides: `none`。存量写法不自动构成规则豁免；新代码和实质修改范围按当前规范核对，不顺手改写无关存量。

## Component Library and Imports

- Library: Element Plus `^2.9.1`、图标包 `@element-plus/icons-vue`，具体能力以 [依赖声明](<web/package.json>) 与当前组件用法为准。
- Import patterns: [入口](<web/src/main.ts>) 全量注册 Element Plus 与中文语言包，库 CSS 先于自定义全局 CSS；避免引入第二套组件或状态框架来替代现有能力。
- Component prefix: 沿现有 `el-*` 组件标签；自有组件、属性和事件名核对真实导出与调用方。
- 布局、主题和图表优先复用已有实现，例如 [AdminLayout](<web/src/layouts/AdminLayout.vue>) 与 [ChartCard](<web/src/components/ChartCard.vue>)；新增抽象需有实际复用依据。

## Routing, State and API

- 登录和共享身份状态沿 [auth.ts](<web/src/stores/auth.ts>)，主题状态沿 [theme.ts](<web/src/stores/theme.ts>)；本轮没有批准引入 Pinia、Vuex 或其他状态层。
- 页面请求统一经过 [API client](<web/src/api/client.ts>)。当前封装附加 Bearer token、序列化 JSON，成功时返回端点原始 JSON；错误为含 `status` / `message` 的对象，后端错误文案读取 `error` 字段。不要额外假定 `code/data` 信封。
- 401 会清除本地 token 并只触发一次登录回跳；页面仍需按实际失败状态提供反馈。当前 token 存于 localStorage，这是实现现状，不代表其安全设计已经获批。
- [路由守卫](<web/src/router/index.ts>) 对非公开路由执行身份确认，`requiresAdmin` 限制账号管理入口。隐藏菜单或路由回跳不替代后端授权。

## Design Tokens and Styling

- Token/style sources: [index.css](<web/src/styles/index.css>) 是全局主题、排版和通用页面类入口；组件复用真实 `--el-*` 与 `--app-*` 变量，局部样式沿既有 scoped CSS。
- Layout/responsive rules: 沿现有管理外壳、页面标题/操作区和卡片结构；[布局](<web/src/layouts/AdminLayout.vue>) 已有 768px 窄屏断点，不由此推定完整移动端支持。
- 主题基于根元素 `dark` 类；初始化和切换沿 [theme.ts](<web/src/stores/theme.ts>)。新增图表和浮层同时检查亮/暗主题与容器尺寸。
- 原型视觉基线见 [prototype-style.md](<fp-docs/settings/prototype-style.md>)，实际数值仍以当前生产样式为准。

## Figma / Screenshot Handling

- Design sources: 当前以生产源码为基线；权威 Figma、截图基线和像素级误差阈值为 `Unknown`。
- Mapping rules: 收到具体设计稿后先核对现有组件、token 和状态映射；未提供视觉证据时不宣称已完成视觉验收。

## Prototype Base Reference

- Selected app and root: `web` / `web/`。
- Base manifest: 尚未初始化；基座用途、模式和写入范围需另行批准。
- Source/build/preview rules: 沿插件 `skills/_shared/prototype-contract.md`。默认建议 `static-modular`；仅在明确选择真实组件运行时采用 `project-native`，不自动安装依赖或连接真实业务后端。

## Preview and Visual Verification

- 命令取自 [根包配置](<package.json>) 与 [前端包配置](<web/package.json>)：`npm run dev:frontend`、`npm run build:frontend`、`npm run typecheck`。本轮初始化未执行这些命令。
- 开发预览默认 5173；[Vite 配置](<web/vite.config.ts>) 将 `/api` 与 `^/review/` 代理到 5001。启动或交互验证前确认目标服务与数据安全，避免把真实业务写入当成 Mock。
- 构建输出为仓库根 `dist/`，不是 `web/dist/`；生产托管、资源加载、路由直达和刷新应一起核对。
- Browser/visual checks: 按本次需求验证正常、加载、空、错误、无权限、重复提交及竞态；样式覆盖亮/暗、普通/窄屏、滚动和浮层。浏览器、网络和真实服务证据与静态检查分开报告。

## Unknowns

- localStorage 中凭据的存储策略、会话生命周期和风险接受范围尚未获单独确认，涉及鉴权调整时与后端一起核实。
- Figma、视觉验收视口、完整移动适配和前端独立自动化测试门禁：Unknown；不为本次初始化安装工具。
- 存量页面的品牌色及异步防重实现未全面审查；相关页面发生实质修改时按 F03 / F04 复核，本轮不自动登记覆盖或修复业务代码。
