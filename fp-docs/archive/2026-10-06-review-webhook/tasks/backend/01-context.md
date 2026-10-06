# pi 驱动的代码评审 Webhook 服务 Backend Implementation Plan

> **For agentic workers:** REQUIRED FLOW: Use `fp-execute` to implement this plan task-by-task. Only task markers use checkbox (`- [ ] **Task backend-NNN: ...**`) syntax for tracking; substeps are plain ordered instructions.

**Goal:** 交付一个同步 HTTP 服务，接收代码与 GitLab payload，读取自定义 prompt，在进程内调用 pi 完成一次评审并返回评论文本。

**Architecture:** 单进程 Express 5 应用，无持久化、无队列、无跨请求状态。请求经五步主线处理：校验入参、组装上下文、读取 prompt、调用 pi 适配层、映射状态码返回。pi 适配层是全设计唯一的并发推理点，用隔离工作目录、关闭全部项目资源发现、`noTools: "all"` 与内存会话把评审上下文限制为「prompt 文件 + 请求里的代码」。

**Tech Stack:** Node.js 22.19（原生类型剥离，无构建步骤）、TypeScript 5.9（仅类型检查）、Express 5、`@earendil-works/pi-coding-agent@1.0.4`、Node 内置 `node:test`。

## Global Constraints

- Node.js 版本下限 `>=22.19.0`，与 pi SDK 的 `engines` 一致；不使用构建步骤，`node` 直接执行 `.ts`。
- 相对导入必须显式写 `.ts` 扩展名；禁止 `enum`、`namespace` 与构造器参数属性（实测报错 `TypeScript enum is not supported in strip-only mode`）。`tsconfig.json` 用 `erasableSyntaxOnly: true` 强制。
- pi SDK 选项必须按已核实签名使用：`noTools` 取值是 `"all" | "builtin"`；`DefaultResourceLoaderOptions` 的 `cwd` 与 `agentDir` 必填；`session.model` 类型是 `Model<any> | undefined`，取 `id` 使用。
- 接口契约固定：`POST /review/webhook`，状态码 200 / 400 / 500 / 502 / 504，错误体恒为 `{"error": string}`，成功体恒为 `{"review": string, "model": string, "duration_ms": number}`。
- 不新增第三方运行时依赖，只允许 `express` 与 `@earendil-works/pi-coding-agent`；测试不得引入测试框架。
- 不调用 GitLab；不引入数据库、缓存、队列或鉴权。
- 有意延后项与简化边界见 `design/backend.md#风险迁移发布回滚与监控`，不得在实现中擅自削减或提前实现。
- Engineering quality: `${CLAUDE_PLUGIN_ROOT}/skills/_shared/engineering-quality.md`；本项目是新建仓库，没有既有 docstring/lint 约定，因此采用中文注释与 TSDoc，公开导出对象必须有职责与契约说明，非显然约束（类型剥离限制、pi 隔离原因、超时释放顺序、状态码映射）必须在实现附近解释原因；不拆独立的「补注释」任务。

## File Structure

| Path | Action | Responsibility |
| --- | --- | --- |
| `package.json` | create | npm 元数据、依赖与 start / test / typecheck 三条脚本 |
| `tsconfig.json` | create | 类型检查配置，开启 `erasableSyntaxOnly` 与 `allowImportingTsExtensions` |
| `.gitignore` | create | 忽略 `node_modules` 与日志 |
| `prompts/review.md` | create | 默认评审 prompt，整体作为 pi 的 system prompt |
| `src/config.ts` | create | 环境变量读取、默认值与非法值快速失败 |
| `src/prompt.ts` | create | prompt 文件读取与错误类型 |
| `src/gitlab.ts` | create | GitLab payload 识别与元数据文本提取 |
| `src/reviewer.ts` | create | `Reviewer` 契约、隔离工作目录、loader 选项构造与 pi 适配层 |
| `src/app.ts` | create | Express 应用工厂、路由与错误响应 |
| `src/server.ts` | create | 装配配置与依赖、监听端口、直接执行入口 |
| `test/config.test.ts` | test | 配置默认值与非法值用例 |
| `test/prompt.test.ts` | test | prompt 读取的成功与失败用例 |
| `test/gitlab.test.ts` | test | payload 识别与两类事件提取用例 |
| `test/reviewer.test.ts` | test | 隔离配置、消息组装、会话释放与中断用例 |
| `test/app.test.ts` | test | 五种状态码与响应体形状用例 |
| `test/server.test.ts` | test | 监听与关闭用例 |
| `README.md` | modify | 安装、配置、运行与前置条件说明 |

