# pi 驱动的代码评审 Webhook 服务 — 技术方案设计

本设计只覆盖后端。方案主线是：一个 Express 服务接收代码，读取自定义 prompt，在进程内调用 pi 得到评审文本，同步返回。

## 第一部分：架构决策

### Decision Ledger

| ID | Decision | Source | Blocking | Status | Evidence / explicit confirmation |
| --- | --- | --- | --- | --- | --- |
| D-001 | HTTP 层使用 Express 5 | user answer | yes | `user-confirmed` | `D-001: selected 「Express 5（推荐）」; user message 本次会话 D-001 确认中用户明确选择该选项` |
| D-002 | pi 会话隔离：专用空白临时目录作 cwd + 双 system prompt 覆盖 + `noTools` | user answer | yes | `user-confirmed` | `D-002: selected 「隔离工作目录 + 双 prompt 覆盖 + 无工具（推荐）」; user message 本次会话 D-002 确认中用户明确选择该选项` |
| D-003 | 固定超时 + 分状态码（400 / 502 / 504） | user answer | yes | `user-confirmed` | `D-003: selected 「固定超时 + 分状态码（推荐）」; user message 本次会话 D-003 确认中用户明确选择该选项` |
| D-004 | 识别 GitLab payload 取其元数据作上下文，代码一律由请求体提供 | user answer | yes | `user-confirmed` | `D-004: selected 「识别 GitLab payload，元数据当上下文，代码仍由请求体提供（推荐）」; user message 本次会话 D-004 确认中用户明确选择该选项` |
| D-005 | 测试用 Node 内置 node:test，pi 适配层以注入假实现替换 | user answer | yes | `user-confirmed` | `D-005: selected 「node:test + pi 适配层注入假实现（推荐）」; user message 本次会话 D-005 确认中用户明确选择该选项` |
| D-006 | 设计采用 small form，仅后端端，路径为 `design/00-index.md` 与 `design/backend.md` | user delegated | yes | `user-confirmed` | `D-006: selected 由用户授权后的最小可行判定 — small form + 仅后端; user message 用户明确授权「请用自己的最佳推荐，完成任务，不需要我再次回答」` |

### 决策 1：HTTP 层使用 Express 5

- **ID**：`D-001`
- **选择**：Express 5，通过 `express.json({ limit: "2mb" })` 解析请求体。
- **理由**：接口只有一条路由，但请求体解析、JSON 解析失败、404 与统一错误响应是必须做的事。Express 5 把这四件事变成现成能力，直接基于 `node:http` 实现反而要手写更多代码，且不能少写任何验收项。选择 Express 5 而非 Fastify，是因为本次没有 schema 校验或性能瓶颈证据，Fastify 的 schema 机制对单接口属于无依据复杂度。
- **来源**：`D-001` 用户确认；proposal `P-001` 确认技术栈为 Node.js 22 + TypeScript。
- **状态**：`user-confirmed`
- **是否阻塞**：是

### 决策 2：pi 会话隔离

- **ID**：`D-002`
- **选择**：适配层在系统临时目录下创建一个空目录作为 pi 的 `cwd`，向 `DefaultResourceLoader` 传 `cwd`、`agentDir: getAgentDir()`、`noContextFiles: true`、`noSkills: true`、`noPromptTemplates: true`、`systemPromptOverride: () => <prompt 全文>` 与 `appendSystemPromptOverride: () => []`；再以 `createAgentSession({ resourceLoader, sessionManager: SessionManager.inMemory(), noTools: "all", cwd })` 建会话。
- **理由**：proposal 的风险 ① 已记录 pi 会按工作目录发现 `AGENTS.md`、skills 等项目资源并混入系统提示，而待评审代码来自请求体、与本地仓库无关。换掉 `cwd` 一次性排除项目级设置、扩展与项目信任解析；三个 `no*` 开关是 SDK 针对同一关注点的显式入口，各一行即可把上下文文件、skills 与 prompt 模板也关掉。`agentDir` 仍取 `getAgentDir()`，模型凭证照常可用。`appendSystemPromptOverride: () => []` 是必需的，pi 官方 SDK 示例注明否则会自动附加 `~/.pi/agent` 或 `<cwd>/.pi` 下的 `APPEND_SYSTEM.md`（来源：pi 仓库 `packages/coding-agent/examples/sdk/03-custom-prompt.ts`）。
- **实现核对**：以上选项名与取值均取自实际安装的 `@earendil-works/pi-coding-agent@1.0.4` 类型声明（`dist/core/resource-loader.d.ts` 的 `DefaultResourceLoaderOptions`、`dist/core/sdk.d.ts` 的 `CreateAgentSessionOptions`、`dist/core/session-manager.d.ts` 的 `SessionManager.inMemory`）。`noTools` 的合法值是 `"all" | "builtin"` 而不是布尔值；`DefaultResourceLoaderOptions.cwd` 与 `agentDir` 均为必填。
- **来源**：`D-002` 用户确认；proposal 风险 ①。
- **状态**：`user-confirmed`
- **是否阻塞**：是

### 决策 3：超时与失败返回契约

- **ID**：`D-003`
- **选择**：单次评审超时默认 120 秒，可由环境变量覆盖；请求体不合法返回 400，pi 调用异常或返回空文本返回 502，超时返回 504，成功返回 200，错误体统一为 `{"error": string}`。
- **理由**：同步返回要求连接被占用 30 秒到 120 秒。不设上限时一次卡住的评审会永久占住连接，调用方也无从判断是否重试。实现只需 `AbortSignal.timeout()` 加一次会话释放，不引入队列、重试或状态存储。
- **来源**：`D-003` 用户确认；proposal `P-005` 确认同步返回。
- **状态**：`user-confirmed`
- **是否阻塞**：是
- **补充**：prompt 文件读不到属于服务端配置错误，返回 500。它不属于 `D-003` 的三类评审失败，但调用方同样需要可区分的信号，故一并记录在此。

### 决策 4：GitLab payload 处理边界

- **ID**：`D-004`
- **选择**：请求体带 `object_kind` 时按 GitLab payload 处理。`merge_request` 从 `object_attributes` 取 `iid`、`title`、`description`、`source_branch`、`target_branch`、`action`；`push` 取 `ref` 以及每个 commit 的 `message` 与 `added`、`modified`、`removed` 文件列表。提取结果拼成上下文文本。代码一律来自请求体 `code` 字段。
- **理由**：已核实 GitLab webhook payload 不含代码 diff。官方文档的 push 事件示例中，`commits[]` 只有 `id`、`message`、`title`、`timestamp`、`url`、`author` 与文件路径列表；MR 事件的 `object_attributes` 同理只有元数据。参考项目 AI-CodeReview 因此在 `biz/platforms/gitlab/webhook_handler.py:88` 与 `:280` 额外调用 GitLab 只读 API 才拿得到 diff。因此 MVP 只能让 payload 贡献上下文，代码由请求体提供；服务端不调用 GitLab，也没有网络依赖。
- **来源**：`D-004` 用户确认；GitLab 官方 webhook 事件文档；参考项目 `biz/platforms/gitlab/webhook_handler.py:88`、`:280`。
- **状态**：`user-confirmed`
- **是否阻塞**：是

### 决策 5：测试策略

- **ID**：`D-005`
- **选择**：测试运行器用 Node 内置 `node --test`，不引入测试框架依赖。pi 适配层导出接口并以参数注入，测试替换为假实现；接口层用 `app.listen(0)` 加 `fetch` 打真实 Express 应用。
- **理由**：已实测 Node v22.19.0 可直接执行 `.ts` 测试文件并支持跨文件 `.ts` 导入，因此不需要 tsx、vitest 或 jest。把适配层做成可注入，就能在不调用模型、不需要凭证的前提下覆盖全部状态码分支，测试可离线重复运行。
- **来源**：`D-005` 用户确认；本机 Node v22.19.0 类型剥离实测。
- **状态**：`user-confirmed`
- **是否阻塞**：是
- **约束**：类型剥离只支持可擦除语法。相对导入必须显式写 `.ts` 扩展名；`enum`、`namespace` 与构造器参数属性不可用（实测报错 `TypeScript enum is not supported in strip-only mode`）。`tsconfig.json` 启用 `erasableSyntaxOnly` 在类型检查阶段强制该约束。

### 决策 6：设计 form 与目标路径

- **ID**：`D-006`
- **选择**：后端采用 small form，写入 `design/backend.md`；`design/00-index.md` 只登记端映射。不生成前端设计入口。不涉及任何 overwrite、conversion 或 obsolete path 移除。
- **理由**：预计后端设计不超过 500 行与 30,000 字符，按 artifact-layout 契约默认选 small form。本次变更无 UI 范围，故只有后端一个端。
- **来源**：`D-006` 用户授权后的判定；proposal 的 What Changes 与 Out of Scope。
- **状态**：`user-confirmed`
- **是否阻塞**：是

### Pre-write Confirmation Evidence

- Covered IDs: `D-001`, `D-002`, `D-003`, `D-004`, `D-005`, `D-006`
- Outstanding blocking decisions: `none`
- Explicit user authorization to write: 用户先逐项确认 `D-001`〜`D-005`，随后明确授权「请用自己的最佳推荐，完成任务，不需要我再次回答」。据此按 small form 写入 `design/00-index.md` 与 `design/backend.md`，无需转换或移除任何既有路径。

## 第二部分：技术方案详述

### 设计范围适用性

| 评审范围 | 要求 | Canonical owner section | 证据或不适用理由 |
| --- | --- | --- | --- |
| 架构主线 | 必填 | `#架构主线` | proposal What Changes；`D-001`、`D-002` |
| 核心对象与职责 | 必填 | `#核心对象与职责` | `D-001`〜`D-005` 确定的模块边界 |
| 数据模型 | 条件适用 | `N/A` | 本次变更不引入任何持久化：评审同步返回、无结果存储（proposal Out of Scope 明确不做数据库与历史记录），pi 会话使用 `SessionManager.inMemory()`（`D-002`） |
| 状态、并发与执行流程 | 条件适用 | `#状态并发与执行流程` | 每个请求有独立会话、超时与失败收束需要明确（`D-002`、`D-003`） |
| 接口、权限与兼容边界 | 条件适用 | `#接口权限与兼容边界` | 对外 HTTP 契约是本次交付主体（proposal What Changes 第 2 点；`D-003`、`D-004`） |
| 前端方案 | 条件适用 | `N/A` | proposal 无任何 UI 产物；`design/00-index.md` 只登记后端端 |
| 风险、迁移、发布、回滚与监控 | 必填 | `#风险迁移发布回滚与监控` | proposal 风险 ① 与 ②；`D-002`、`D-003` |
| 验证方案 | 必填 | `#验证方案` | `D-005` 确定的测试策略 |

### 架构主线

请求先进入 Express 的 JSON 解析中间件，再由唯一路由处理。处理顺序固定为五步。

1. 校验请求体是 JSON 对象且 `code` 是非空字符串，否则返回 400。
2. 组装上下文：取可选的 `context` 字段；请求体含 `object_kind` 时，再解析 GitLab payload 元数据并追加。
3. 从磁盘读取 prompt 文件全文，读不到或内容为空返回 500。
4. 把 prompt 作为 pi 的 system prompt、把上下文与代码作为用户消息，交给 pi 适配层；适配层用一个隔离的空白工作目录、无工具、内存会话执行一次评审。
5. 取最终助手文本。文本为空返回 502；超时返回 504；成功返回 200 与 `{"review", "model", "duration_ms"}`。

最简单可行方案就是这条链路本身：全部逻辑是同步的，没有队列、没有缓存、没有数据库、没有跨请求共享状态。新增的依赖只有 Express 5 与 pi SDK 本身；新增的配置只有端口、监听地址、prompt 路径与超时四项。

有意延后的能力统一记录在 `#风险迁移发布回滚与监控`，这里不重复。

### 核心对象与职责

| 对象/模块 | 职责 | 不负责 | 协作对象 | 证据 |
| --- | --- | --- | --- | --- |
| `src/config.ts` | 读取环境变量并补齐默认值，产出不可变配置对象 | 不做校验之外的业务判断，不读文件内容 | `src/server.ts` | `D-001` |
| `src/prompt.ts` | 读取 prompt 文件并返回去空白后的全文 | 不解析 prompt 语法，不做模板渲染 | `src/app.ts` | proposal `P-004` |
| `src/gitlab.ts` | 判断是否 GitLab payload，并抽取元数据文本 | 不调用 GitLab，不提取代码 | `src/app.ts` | `D-004` |
| `src/reviewer.ts` | 定义 `Reviewer` 接口并实现基于 pi SDK 的适配层 | 不决定 prompt 内容，不做 HTTP 处理，不做重试 | `src/app.ts` | `D-002`、`D-005` |
| `src/app.ts` | 组装 Express 应用、实现 `POST /review/webhook`、统一错误响应 | 不监听端口，不创建隔离目录 | `src/server.ts`、`src/reviewer.ts` | `D-001`、`D-003` |
| `src/server.ts` | 读取配置、创建适配层与应用并监听端口 | 不承载业务逻辑 | 全部模块 | `D-001` |

`Reviewer` 是唯一被注入替换的接缝，其契约草图如下。抽出这个接口不是为了将来扩展，而是 `D-005` 直接要求的测试接缝：不替换它就无法在不调用模型的前提下覆盖 502 与 504 分支。

```ts
/** 一次评审的输入。systemPrompt 是 prompt 文件全文，code 是待评审内容。 */
export interface ReviewInput {
  systemPrompt: string;
  code: string;
  context?: string;
  signal: AbortSignal;
}

/** 评审结果。model 取自实际会话，便于调用方确认真正生效的模型。 */
export interface ReviewResult {
  text: string;
  model: string;
}

/**
 * 评审执行者。实现方负责创建与释放 pi 会话；
 * signal 中断时以中断错误结束，由调用方翻译为 504。
 */
export interface Reviewer {
  review(input: ReviewInput): Promise<ReviewResult>;
}
```

### 后端模块设计

```text
cr-pilot/
├── package.json          # 依赖与 scripts：start / test / typecheck
├── tsconfig.json         # 类型检查配置，开启 erasableSyntaxOnly
├── .gitignore            # 忽略 node_modules 与评审运行产物
├── README.md             # 修改：安装、配置与本地运行说明
├── prompts/
│   └── review.md         # 自定义评审 prompt，整体作为 pi 的 system prompt
├── src/
│   ├── config.ts         # 环境变量与默认值
│   ├── prompt.ts         # prompt 文件读取
│   ├── gitlab.ts         # GitLab payload 识别与元数据提取
│   ├── reviewer.ts       # Reviewer 接口与 pi SDK 适配层
│   ├── app.ts            # Express 应用工厂与路由
│   └── server.ts         # 进程入口
└── test/
    ├── gitlab.test.ts    # payload 识别与元数据提取
    ├── prompt.test.ts    # prompt 读取的成功与失败路径
    └── app.test.ts       # 五个状态码分支与响应体形状
```

不复用既有代码，因为仓库当前除 `README.md` 外为空。`src/` 与 `test/` 分离，是为了让 `node --test` 的默认发现规则不去碰业务源码。

`package.json` 的 scripts 固定为三条：`start` 运行 `node src/server.ts`，`test` 运行 `node --test test/`，`typecheck` 运行 `tsc --noEmit`。项目不设构建步骤，因为 Node 22.19 的原生类型剥离可以直接执行 TypeScript。

### 状态、并发与执行流程

**状态**：服务本身无状态。一次评审的全部状态都活在单个请求的局部变量与一个 pi 内存会话里，请求结束即释放，进程重启不丢任何需要保留的数据。

**并发**：Express 并发处理请求，每个请求创建并使用自己的 pi 会话，会话之间不共享可变状态。隔离工作目录在适配层构造时创建一次，进程生命周期内复用，避免每请求产生临时目录。目录由 `mkdtemp` 创建在系统临时目录下，进程退出后由操作系统回收。

**执行顺序与失败收束**：入参校验失败立即返回 400，不读文件、不调 pi。prompt 读取失败返回 500，不调 pi。pi 阶段的三类结局互斥：正常拿到非空文本返回 200；抛错或文本为空返回 502；`AbortSignal` 触发返回 504。

**超时处理**：路由用 `AbortSignal.timeout(timeoutMs)` 生成信号并传给适配层。适配层注册一次性的 abort 监听，触发时释放会话，`session.prompt()` 随即以中断结束。会话释放在 `finally` 中用标志位保证只执行一次，避免信号与正常结束重复释放。

**可观察结果**：成功响应带 `duration_ms`，可据此判断单次评审耗时；失败响应的 `error` 字段区分三类原因。

### 接口、权限与兼容边界

**路由**：`POST /review/webhook`。

**请求**：`Content-Type: application/json`，请求体为 JSON 对象。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `code` | string | 是 | 待评审的代码或 diff 文本，去空白后不得为空 |
| `context` | string | 否 | 额外上下文，与 GitLab 元数据拼接后一起送 pi |
| `object_kind` | string | 否 | 存在时按 GitLab payload 处理并追加元数据上下文 |

**响应**：

| 状态码 | 触发条件 | 响应体 |
| --- | --- | --- |
| 200 | 评审成功且文本非空 | `{"review": string, "model": string, "duration_ms": number}` |
| 400 | 请求体不是 JSON 对象，或 `code` 缺失/非字符串/去空白后为空 | `{"error": string}` |
| 500 | prompt 文件不存在、不可读或内容为空 | `{"error": string}` |
| 502 | pi 调用抛错，或返回文本去空白后为空 | `{"error": string}` |
| 504 | 超过 `REVIEW_TIMEOUT_MS` | `{"error": string}` |

其余路径与方法由 Express 默认 404 与 405 处理，响应体同样为 JSON。`404` 与 `405` 不在 `D-003` 的三类评审失败内，仅为统一 JSON 错误形状而存在。

**权限**：按 proposal `P-006`，接口不校验调用方身份。默认监听 `127.0.0.1`，只有改 `HOST` 环境变量才会对外暴露。这是本次唯一的安全边界，不叠加其他机制。

**兼容边界**：GitLab payload 是「上下文来源」，不是「代码来源」。GitLab 原生 webhook 单独打本接口会因为请求体没有 `code` 而返回 400，错误信息会写明这一点。这是 `D-004` 已确认的边界，不是缺陷。

**配置项**：

| 环境变量 | 默认值 | 作用 |
| --- | --- | --- |
| `PORT` | `3000` | 监听端口 |
| `HOST` | `127.0.0.1` | 监听地址 |
| `REVIEW_PROMPT_PATH` | `prompts/review.md` | prompt 文件路径 |
| `REVIEW_TIMEOUT_MS` | `120000` | 单次评审超时毫秒数 |

评审模型不作为本服务的配置项。`CreateAgentSessionOptions.model` 的类型是 `Model<any>` 对象而不是字符串标识，要按环境变量选模型就得引入 pi 的模型注册表解析链路，对 MVP 属于无依据复杂度。模型改由 pi 自身设置决定（`~/.pi/agent/settings.json`），实际生效值通过响应的 `model` 字段回显，取值来自 `session.model?.id`。

### 风险、迁移、发布、回滚与监控

| 具体失败场景 | 影响 | 预防或处理 | 发布/回滚/监控安排 | 证据 |
| --- | --- | --- | --- | --- |
| pi 按工作目录发现项目资源，把 `AGENTS.md`、skills 或 `APPEND_SYSTEM.md` 混进系统提示 | 评审结论被无关上下文污染，且难以察觉 | 用空白临时目录作 `cwd`，并覆盖两处 system prompt 来源，同时关闭全部工具 | 验证方案中比对注入的 system prompt 与 prompt 文件内容是否一致 | `D-002`；pi SDK 示例 `03-custom-prompt.ts` |
| pi SDK 版本升级导致会话或资源加载接口变化 | 适配层编译失败或评审行为改变 | 适配层是唯一接触 pi SDK 的模块，接口面收在一个文件内 | `npm run typecheck` 与 `npm test` 在升级后必须全绿才可发布 | `D-002`、`D-005` |
| 同步等待期间 GitLab 原生 webhook 因约 10 秒超时而重试 | 同一变更被重复评审，浪费模型额度 | 本次不把 GitLab 原生 webhook 作为使用方式；接口文档写明 | 若出现重复评审记录，按下方延后项升级 | proposal 风险 ②；`D-004` |
| 进程内没有可用的 pi 模型凭证 | 每次评审都返回 502 | 启动时不做凭证探测，避免拉起额外依赖；由 README 写明前置条件 | 502 连续出现即视为凭证或模型配置问题 | proposal Impact 运行前置 |
| 接口无鉴权且被改绑到外网 | 任何能访问端口的人都能消耗模型额度 | 默认只绑 `127.0.0.1`；改 `HOST` 属于使用者显式决定 | README 中标注风险 | proposal `P-006` |

**有意延后项**

- **并发上限**：当前不做限流。理由是本接口供单机自用，没有并发压力证据。适用上限是同时进行的评审数不超过所用模型的并发配额。可验证的重访触发条件为出现并发排队、模型侧 429 或超时比例明显上升。升级方向是加一个信号量限制同时在跑的评审数。
- **GitLab 只读 API 拉取 diff 与异步评审**：当前不做。理由是本 MVP 的代码来源是请求体，且已确认同步返回。适用上限是调用方能接受 120 秒内的同步等待。可验证的重访触发条件是希望由 GitLab 原生 webhook 直接触发评审。升级方向是新增 GitLab 客户端与结果查询接口，并把评审改为异步执行。
- **评审模型选择**：当前不提供按请求或按环境选模型的配置。理由是 `CreateAgentSessionOptions.model` 要的是 `Model<any>` 对象，按字符串选模型需要引入 pi 的模型注册表解析链路。适用上限是全局共用 pi 自身设置里的那一个模型。可验证的重访触发条件是需要为不同仓库或不同评审等级使用不同模型。升级方向是接入 pi 的模型解析能力并新增模型配置项。

三项都不削减当前已承诺的验收、隔离或安全边界。

### 验证方案

| 验证项 | 命令或操作 | 预期结果 | 覆盖的设计结论 | 证据 owner |
| --- | --- | --- | --- | --- |
| 类型检查 | `npm run typecheck` | 退出码 0，无类型错误 | `D-005` 类型剥离约束 | 本节 |
| 单元与接口测试 | `npm test` | 全部用例通过 | `D-001`、`D-003`、`D-004`、`D-005` | 本节 |
| 入参边界 | `npm test` 中 app 用例 | 非对象体、缺 `code`、空 `code` 均返回 400 | `D-003` | 本节 |
| 成功路径 | `npm test` 中 app 用例 | 返回 200，响应体含非空 `review`、`model` 与数字 `duration_ms` | `D-001`、`D-003` | 本节 |
| pi 失败路径 | `npm test` 中 app 用例，假实现抛错或返回空串 | 返回 502 | `D-003` | 本节 |
| 超时路径 | `npm test` 中 app 用例，假实现挂起到超时 | 返回 504，且假实现收到已中断的信号 | `D-003` | 本节 |
| prompt 缺失路径 | `npm test` 中 app 用例，指向不存在的 prompt 路径 | 返回 500 | `D-003` 补充 | 本节 |
| GitLab 元数据 | `npm test` 中 gitlab 用例 | MR 与 push 两类 payload 均能提取标题、分支、提交信息与文件路径；非 payload 返回空 | `D-004` | 本节 |
| prompt 读取 | `npm test` 中 prompt 用例 | 正常文件返回去空白全文；文件缺失或空文件抛出可识别错误 | proposal `P-004` | 本节 |
| 手工冒烟 | 启动服务后 `curl` 提交一段代码 | 返回 200 与评审文本 | 全链路 | 本节 |
| 隔离生效 | 在 `cwd` 放入 `AGENTS.md` 后启动并评审一次 | 评审结果不体现该文件内容 | `D-002` | 本节 |
| 注释自审 | 对照 `engineering-quality` 契约检查本次新增与改变行为的对象 | 公开对象有契约说明，非显然约束有原因注释 | 契约要求 | 本节 |

手工冒烟与隔离核验需要可用的 pi 模型凭证；缺少凭证时按未验证如实报告，不以测试通过替代。
