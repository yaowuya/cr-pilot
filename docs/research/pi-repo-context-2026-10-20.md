# 技术调研：让评审看到仓库代码（pi skill 支持面 + 有界上下文方案）

- 调研时间：2026-10-20
- 代码基线：`8b5ace0`（`https://github.com/yaowuya/cr-pilot.git`）
- 依赖版本：`@earendil-works/pi-coding-agent@1.0.4`（`package.json:21`）
- 结论状态：**方案可行，推荐 A→B→C 三步走；不建议直接把仓库全量塞进 prompt，也不建议仅靠 skill 解决**

---

## 0. 一句话回答

**pi 支持 skill，但当前项目主动关掉了它，而且 skill 不是这个需求的答案。**

- 当前代码在 `src/infrastructure/pi/reviewer.ts:76` 显式设置 `noSkills: true`，所以线上评审**没有 skill 能力**。
- 但 `noSkills: true` 并不等于"skill 被彻底禁用"：SDK 仍会加载通过 `additionalSkillPaths` 显式注入的技能（`dist/core/resource-loader.js:420-424`、`skills.d.ts:58-62`）。也就是说"要开"随时能开。
- 即便开了，skill 的作用是**告诉模型怎么做**（注入方法论），解决不了"评审时看不到仓库代码"这个根本问题。后者是**上下文供给**问题，必须靠"拿到代码 + 有界地喂给模型"解决。

真正可行的路线是：**拉分支到本地工作区 → 服务端生成紧凑"仓库地图" → 给 pi 挂只读工具（read/grep/find/ls）让它按需取数 → 用步数/超时/工具额度做硬预算**。SDK 恰好把这几件事都开放了。

---

## 1. 当前项目是怎么调用 pi 的（事实基线）

| 事实 | 证据 |
|---|---|
| 组合根创建评审执行者并注入流水线 | `src/bootstrap.ts:137`、`src/bootstrap.ts:202-213` |
| 流水线按批调用评审，再调一次汇总 | `src/application/review-pipeline.ts:292-300`、`:325-332` |
| 评审执行者为每次调用新建会话、用完释放 | `src/infrastructure/pi/reviewer.ts:111-159` |
| 工作目录是**空临时目录**（隔离项目级发现） | `src/infrastructure/pi/reviewer.ts:55-57` |
| 资源加载器关掉上下文文件、skill、prompt 模板 | `src/infrastructure/pi/reviewer.ts:67-81` |
| 会话显式传 `noTools: "all"`，**不给任何工具** | `src/infrastructure/pi/reviewer.ts:176-186` |
| 用户消息 = 请求体里的 diff 文本 | `src/application/review-pipeline.ts:281-289`、`src/infrastructure/pi/reviewer.ts:93-99` |
| GitLab 客户端只有 changes/commits/versions/discussions/notes，**没有任何仓库文件或分支能力** | `src/infrastructure/gitlab/gitlab-client.ts:105-235` |

**结论**：现在的评审是"闭卷考试"——只有这一批 diff，看不到任何仓库其它文件。这是刻意设计（`reviewer.ts:48-54` 的注释说明评审对象来自请求体而非本地仓库），不是你漏了配置。

---

## 2. 问题一：pi 支持 skill 吗？当前项目支持吗？

### 2.1 pi 的 skill 机制（事实）

| 问题 | 结论 | 证据 |
|---|---|---|
| skill 形态 | 目录 + `SKILL.md`，frontmatter 支持 `name` / `description` / `disable-model-invocation` | `dist/core/skills.d.ts:3-16` |
| 发现规则 | 目录里有 `SKILL.md` 就当作 skill 根且不再递归；否则加载该层直接 `.md` 子文件，并递归子目录找 `SKILL.md` | `dist/core/skills.d.ts:27-35` |
| 从哪加载 | `cwd`（项目级）+ `agentDir`（全局）+ `skillPaths`（显式） | `dist/core/skills.d.ts:48-62` |
| 进入上下文的方式 | **渐进式披露**：system prompt 里每条 skill 只有 `name` + `description` + `location` 三行 XML，正文永不进提示，靠模型自己 `read` | `dist/core/skills.d.ts:36-47`、`dist/core/skills.js:278-303` |
| **无工具时 skills 段不生成** | `readers = ["read","bash"]`；工具集里既无 `read` 也无 `bash` 时 `skillFileReadTool` 为 `undefined`，**整个 skills 段被跳过** | `dist/core/system-prompt.js:101-109` |
| `noSkills: true` 的精确语义 | **只关"发现的 + settings 配置的" skill**；`additionalSkillPaths` 仍加载（`skillPaths` 非空时不走空结果分支），且 `skillsOverride` **始终被调用**，即使路径为空 | `dist/core/resource-loader.js:420-424`、`:620-633` |
| 编程注入 | 最佳是 `skillsOverride`（可返回虚构 `filePath` 的 `Skill[]`）；其次 `additionalSkillPaths`。**没有 `addSkill`/`registerSkill`** | `dist/core/resource-loader.d.ts:76`、`:90-96`；`examples/sdk/04-skills.ts:18-37` |
| 加载硬性要求 | `description` 缺失 → **整条 skill 不加载**；`name` 可省，回退父目录名 | `dist/core/skills.js:231-252` |
| `allowed-tools` | **运行时不生效**（全 dist 搜索 0 命中）；`loadSkillFromFile` 只读 `name`/`description`/`disable-model-invocation` | `dist/core/skills.js:243-263`；`docs/skills.md:78` |
| 项目信任 | 只门控项目级 skill；**空 cwd 不触发信任提示**（无可信资源时直接 trusted=true），用户级 skill 照常加载 | `dist/core/project-trust.js:21`、`trust-manager.js:151-170` |

### 2.2 当前项目：事实上不支持，但一改就支持

- **事实**：`src/infrastructure/pi/reviewer.ts:76` 写死 `noSkills: true`；同时 `:77` 关掉 prompt 模板、`:75` 关掉上下文文件、`:78-79` 覆盖 system prompt。四者共同保证"评审上下文里只有 prompt 文件与请求里的代码"。
- **事实**：这不是能力缺失，是隔离选择。`reviewer.ts:60-66` 的注释明确写了三个 `no*` 开关的意图。
- **推断**：要启用只需在 `buildLoaderOptions` 去掉 `noSkills`（或改为 `additionalSkillPaths` 注入指定技能目录），**不需要改 SDK 调用方式**。

### 2.3 但 skill 解决不了你的核心问题（判断）

- **事实**：skill 注入的是"方法论/流程说明"的索引，进入 system prompt；它本身不携带仓库代码。
- **事实（比"读不到正文"更严重）**：`noTools: "all"` 下工具集里既无 `read` 也无 `bash`，`system-prompt.js:101-109` 会**整段跳过 skills 渲染**。也就是说，当前配置下即使把 `noSkills` 改为 `false`，**skill 索引本身也不会出现在提示里**——必须先给工具，skill 才会生效。这一点在改造顺序上很关键：**工具在前，skill 在后**。
- **判断**：skill 适合做"评审方法沉淀"（团队检查清单、某框架坑位清单），不适合做"仓库上下文获取"。**把这两件事分开看，方案才不会走偏。**

---

## 3. 问题二：怎么让评审看到仓库代码，又不烧 token？

### 3.1 先量化问题（为什么"全量"必然不可行）

- **事实**：单批预算默认 120000 tokens（`src/shared/config.ts:68`），且该预算是**给 diff 的**，已经用于切批（`review-pipeline.ts:276`）。
- **推断**：一个中等仓库源码轻松上百万 tokens，全量注入会直接撑爆上下文，且费用与延迟都不可接受。**所以"有界"不是优化项，是硬约束。**

### 3.2 SDK 已提供的四类抓手（事实）

| 抓手 | 精确签名/枚举 | 证据 | 用途 |
|---|---|---|---|
| 工具白名单 | `tools?: string[]`（支持 `*` 通配），另有 `excludeTools?: string[]` | `dist/core/sdk.d.ts:45`、`:50` | 只放行只读工具 |
| 关内置保留自定义 | `noTools?: "all" \| "builtin"` | `dist/core/sdk.d.ts:33` | `"builtin"` = 关掉 read/bash/edit/write 内置默认，但保留扩展/自定义工具 |
| 只读工具集 | `createReadOnlyTools(cwd, options)` / `createReadTool` / `createGrepTool` / `createFindTool` / `createLsTool` | `dist/core/tools/index.d.ts:38-42`、`:52-53` | 直接拿现成只读工具，无需自研 |
| 工具名枚举 | 内置工具**共 8 个**：`"read" \| "bash" \| "powershell" \| "edit" \| "write" \| "grep" \| "find" \| "ls"`。**没有 `web_search`、没有 `todo`**，`glob` 的等价物是 `find` | `dist/core/tools/index.d.ts:23`、`:38` | 白名单写死只读四件套；只有 `read`/`grep`/`find`/`ls` 是只读，`bash`/`powershell` 可写 |
| 工具调用拦截 | 扩展 `tool_call` 钩子返回 `{ block: true, reason, terminate }` | `dist/core/extensions/types.d.ts:1054-1063` | 唯一可用的路径守卫/配额执行点 |

补充约束（事实）：
- `read` 工具自带截断（`TruncationResult`），`grep` 有 `limit` 与 `matchLimitReached`（`dist/core/tools/read.d.ts:29-31`、`dist/core/tools/grep.d.ts:5-23`），天然限制单次读取量。
- 会话有 `abort(): Promise<void>`、`getContextUsage()`、`messages`（`dist/core/agent-session.d.ts:628`、`:867`、`:453`），可做超时与观测。
- 自动压缩（compaction）存在且有阈值/溢出两条触发路径（`dist/core/agent-session.d.ts:710-746`）。

### 3.3 推荐方案：三层有界上下文（A 必做，B 建议，C 可选）

#### 层 A：仓库工作区（前提）

获取分支代码，落到本地目录，作为 pi 的 `cwd`：

- 方式一（推荐）：`git clone --depth 1 --branch <source_branch> --single-branch <repo_url> <workspace>`，用完删除。优点：真实文件树、`.gitignore` 生效、`grep`/`find` 是原生速度。
- 方式二：GitLab Archive API 下载 tar.gz 解包。优点：不依赖 git 二进制；缺点：无 `.git`，增量/历史不可用。
- **事实**：当前 GitLab 客户端只做 HTTP API 调用（`gitlab-client.ts:60-80`），仓库 URL 可从 webhook 的 `project.git_http_url` 或 API 取，需要新增一个端口方法。
- **风险**：私有仓库需要凭据。复用现有的 `X-Gitlab-Token`（每次 webhook 携带，见 `app.ts:83-88`）拼进 clone URL 或使用 `GIT_ASKPASS`/`http.extraHeader`，**不要把 token 写进磁盘或日志**。
- **风险**：大仓库 clone 慢/占磁盘。建议 `--depth 1` + 并发上限 + 临时目录配额 + 后台清理（当前队列并发默认 5，见 `config.ts:71`）。

#### 层 B：服务端"仓库地图"（控 token 的关键）

**不要把仓库代码喂给模型，喂"索引"。** 在服务端用代码算出一份紧凑的结构化摘要，作为 system prompt 的一部分：

1. **文件清单 + 行数**（只保留被 diff 触及的文件 + 其同目录兄弟文件 + 必要的顶层目录树，而不是全仓文件列表）。
2. **依赖关系**：从 diff 的 import/require 语句出发，做 1-2 跳的静态解析，拿到"直接相关文件"集合。
3. **符号位置索引**：对相关文件提取导出符号 + 行号（正则/AST 都行），只给"符号 → 文件:行"，不给正文。
4. **同目录约定文件**：`README`、`package.json`、`tsconfig`、以及 diff 文件同目录的相邻实现（通常 3-5 个）。

- **推断**：这份地图通常可控制在 2k-8k tokens，与 diff 预算（120k）相比可忽略；而它把"模型瞎猜"变成"模型知道去哪找"。
- **实现位置**：`run()` 里拉完 changes 之后、切批之前（`review-pipeline.ts:219-277` 之间），产出 `repoContext` 并随批注入 user message 或 system prompt。

#### 层 C：只读工具探索（把"按需"交给模型）

给会话挂 4 个只读工具，让模型自己决定读哪个文件：

```ts
// 实际装配（已逐项对签名核实）
const guard = (pi: ExtensionAPI) => {
  // ① 路径守卫：pi 自身不做任何路径包含校验，必须自己写
  pi.on("tool_call", (event) => {
    if (!["read", "grep", "find", "ls"].includes(event.toolName)) {
      return { block: true, reason: "tool not allowed" };
    }
    const p = event.input?.path as string | undefined;
    if (p && !realpathSync(resolve(workspace, p)).startsWith(realpathSync(workspace) + sep)) {
      return { block: true, reason: "path outside workspace" };
    }
  });
  // ② 步数上限：pi 没有 maxSteps，turn_end 返回 continue:false 是干净的阻断点
  pi.on("turn_end", (event) => {
    if (event.turnIndex >= maxTurns) return { continue: false };
  });
};

const loader = new DefaultResourceLoader({
  cwd: workspace,                    // 不再是空目录
  agentDir,
  noContextFiles: true,              // 仍不读 AGENTS.md 等
  noSkills: true,                    // skill 仍关闭（见 §5）
  noPromptTemplates: true,
  systemPrompt,                      // 注意：systemPrompt 在 loader 选项里，不在 createAgentSession 里
  extensionFactories: [guard],       // 守卫以扩展形式注入
});
await loader.reload();

const { session } = await createAgentSession({
  cwd: workspace,
  agentDir,
  resourceLoader: loader,
  sessionManager: SessionManager.inMemory(workspace),
  model: await resolveModel(agentDir, provider, model),
  noTools: "builtin",                     // 关掉内置默认工具
  tools: ["read", "grep", "find", "ls"],  // 只放行只读四件套
});
```

- **⚠️ `systemPrompt` 不在 `createAgentSession` 选项里**：`CreateAgentSessionOptions` 的 14 个字段中没有它（`sdk.d.ts:10-61`），必须通过 loader 的 `systemPrompt` / `systemPromptOverride` 设置（`resource-loader.d.ts:87`、`:122`）。现有代码用的是 `systemPromptOverride`（`reviewer.ts:80`），改造时保持同样路子即可，不要试图传进 `createAgentSession`。
- **⚠️ `noTools` 与 `tools` 同时传时，`tools` 说了算**：`sdk.js:146` 是 `options.tools ?? (options.noTools === "all" ? [] : undefined)`——只要给了 `tools`，`noTools` 就不参与 `allowedToolNames` 计算；`:149` 的初始激活集也优先用 `tools`。所以 `noTools: "builtin"` + `tools: [...]` 是安全的组合，但别指望 `noTools` 能兜住白名单。
- **⚠️ 取消只有会话级**：`CreateAgentSessionOptions` 与 `PromptOptions` 都**没有** `signal` 字段（`sdk.d.ts:10-61`、`agent-session.d.ts:169-181`），外部 `AbortSignal` 必须自己桥接成 `session.abort()`；工具级取消通过 `execute()` 的第 3 个参数（`AbortSignal | undefined`）下发。现有 `reviewer.ts:142` 的做法是"abort 时直接 dispose 会话"，这在单轮纯文本调用下没问题，**但加了工具循环后必须改为 `await session.abort()` 再 dispose**，否则会打断循环清理。
- **⚠️ 陷阱（已核实）**：`tools` 白名单**同时过滤 `customTools` 与扩展注册的工具**——`allCustomTools` 在组装后会 `.filter(tool => this._isAllowedTool(tool.definition.name))`（`dist/core/agent-session.js:2811-2817`，判定见 `:1114-1120`）。因此若你既传 `tools: ["read","grep","find","ls"]` 又注册自定义的计数包装工具，**包装工具会被静默丢弃**。两种正确写法：① 把包装工具名字加进 `tools` 白名单；② 不包工具，改用扩展 `tool_call` 钩子做计数与拦截。
- **⚠️ 无沙箱（已核实）**：SDK **没有** `allowedPaths` / `canUseTool` / `toolPermissions`，也没有内置路径守卫；工具用 `resolveToCwd` 解析路径但不做包含校验（`dist/core/tools/path-utils.js`）。**`cwd` 只是约定，不是牢笼**——绝对路径与 `..` 都不拦，`read({path:"C:\\Users\\...\\.ssh\\id_rsa"})` 会被照读。唯一的强制手段是扩展 `tool_call` 钩子返回 `{ block: true }`（`dist/core/extensions/types.d.ts:1054-1063`），且必须用 `fs.realpath` 防符号链接穿越。因此这条风险不能指望 SDK，只能靠自写守卫 + 工作区剔除。
- **事实**：`createReadOnlyTools` / `createReadOnlyToolDefinitions` 就是 read/grep/find/ls 的现成实现（`tools/index.d.ts:38-42`、`tools/index.js:81-88`），无需自研；内置工具仅 8 个，`bash`/`powershell` 等同任意命令执行，**绝不可进入白名单**。

#### 层 D：预算硬约束（保证"不失控"）

| 约束 | 手段 | 证据 |
|---|---|---|
| 单次会话时长 | 现有 `AbortSignal.timeout(timeoutMs)` 继续生效，但**必须桥接成 `session.abort()`**（SDK 不接受外部 signal） | `review-pipeline.ts:297`、`reviewer.ts:138-142` |
| 工具调用步数 | **SDK 无 `maxSteps`/`maxToolCalls`/`maxTurns`/`maxIterations`（已全目录搜索确认不存在）**，内部是 `while(true)` 循环，`PromptOptions` 也不含步数字段。必须自己数：`turn_end` 返回 `{ continue: false }`（`BoundaryResult`），或 `tool_call` 返回 `{ block: true, terminate: true }`（`terminate` 仅在批内全部结果为 true 时早停）。若改用包装工具计数，**必须把包装工具名写进 `tools` 白名单**（否则被静默过滤，见层 C 陷阱） | `dist/core/agent-session.d.ts:169-181`、`:527`；`extensions/types.d.ts:761-764`、`:795-802`、`:1054-1063`；`pi-agent-core/dist/agent-loop.js:87-90` |
| 会话级取消 | `abort()` 是**会话级**，返回 Promise；`CreateAgentSessionOptions` 与 `PromptOptions` 均**无** signal 字段，工具级取消通过 `execute()` 第 3 参数 AbortSignal 下发 | `dist/core/agent-session.d.ts:628`、`extensions/types.d.ts:441-499`（`:494`） |
| 上下文膨胀 | 自动 compaction **默认开启**（`enabled: true`、`reserveTokens: 16384`、`keepRecentTokens: 20000`），触发条件 `contextTokens > contextWindow - reserveTokens`；单文件 `read` 截断到 2000 行 / 50KB | `compaction/compaction.js:53-57`、`:173-177`；`tools/truncate.js:10-11` |
| 观测 | **`session.getSessionStats()`**（含 `tokens{input,output,cacheRead,cacheWrite,total}` + `cost` + `contextUsage`）、`getContextUsage()`、`session.messages`。**不存在 `getUsage()`** | `agent-session.d.ts:195-212`、`:866`、`:867`、`:453`；`pi-ai/dist/types.d.ts:291-312` |
| 订阅方式 | `session.subscribe(listener)` 返回退订函数；**没有 `session.on()`，也没有 `session.events`**。带 `turnIndex` 的 `turn_end` 属于**扩展**事件系统（`pi.on`），不是 `subscribe` | `agent-session.d.ts:372`、`extensions/types.d.ts:795-802` |

- **最关键的一条**：pi 1.0.4 **没有任何"烧到 X token 就停"的闸门**。`compaction.reserveTokens` 是给模型响应预留的空间，**不是**预算上限。因此步数、路径、token 三道闸门**全部要自己写**（用扩展钩子 + `getSessionStats()` 轮询 + `abort()`）。
- **工程建议**：新增配置项 `REVIEW_REPO_CONTEXT`（`off` / `map` / `map+tools`）、`REVIEW_REPO_TOOL_MAX_CALLS`（默认 8-12）、`REVIEW_REPO_MAX_FILES`（地图文件数上限）、`REVIEW_CLONE_TIMEOUT_MS`。全部走既有 `loadConfig` 模式（`src/shared/config.ts:85-107`）。

---

## 4. 落地步骤（最小改动、可回滚）

1. **端口层**：`domain/review-task.ts` 的 `GitlabClient` 增加 `getRepositoryArchive` 或让新端口 `RepositoryWorkspace` 独立；`infrastructure/repository/` 新增 clone 适配器（实现 `prepare(branch) → { cwd, dispose }`）。
2. **应用层**：`review-pipeline.ts` 在 `changes` 拉取成功后调用工作区准备，产出 `repContext`；失败时**降级为现有行为**（不阻断评审）。
3. **地图构建**：新增 `domain/repo-context.ts` 纯函数（文件筛选、import 解析、符号索引），保持可单测（与现有 `domain/*` 风格一致）。
4. **评审器**：`reviewer.ts` 的 `createRealSession` 增加 `workspace` 参数与 `tools` 白名单；`PiSessionLike` 增加可选的工具调用计数/用量读取。
5. **预算与清理**：`finally` 里 `dispose()` 工作区；超时/失败路径同样清理。
6. **开关与灰度**：默认 `off`，按项目（`task.fullName`）或规则集配置开启，先在小仓库验证 token 与效果。

---

## 5. 关于 skill 的建议

- **不建议**用 skill 承载"仓库上下文"：它进入 system prompt 且正文依赖 read 工具，等价于"多一层间接"，不如直接给只读工具。
- **建议**（可选，第二期）用 skill 承载"评审方法论"：例如各框架的常见缺陷清单、团队评审口径。用 `additionalSkillPaths` 指向一个受控目录（例如 `<agentDir>/skills`），**不要**放开项目级默认发现，避免被评审仓库自带的 skill 影响。
- **事实依据**：`additionalSkillPaths` 在 `noSkills: true` 下依然生效（`resource-loader.js:420-424`），因此可以做到"只加载我们指定的 skill"；若要完全内存化，用 `skillsOverride` 直接返回 `Skill[]`（路径为空也会被调用，`:620-633`）。
- **⚠️ 前置条件**：skill 只有在工具集包含 `read` 或 `bash` 时才会渲染进提示（`system-prompt.js:101-109`）。所以在层 C（只读工具）落地之前，开 skill 是无效的——**先上工具，再上 skill**。
- **⚠️ 注意**：`allowed-tools` frontmatter **运行时不生效**（全 dist 搜索 0 命中，仅文档标注 Experimental）。想限制 skill 能用哪些工具，只能靠会话级 `tools` 白名单，或自己写 `tool_call` 守卫。

---

## 6. 风险与未知

| 类型 | 内容 |
|---|---|
| 风险 | 私有仓库克隆凭据处理不当会泄露 token；必须避免写入磁盘/日志，建议 `http.extraHeader` 短生命周期使用 |
| 风险 | 大仓库克隆耗时与磁盘占用；需要超时、并发上限、清理策略，否则会拖垮队列（当前并发 5） |
| 风险 | 只读工具仍可读工作区内任意文件（含误提交的 `.env`），且**绝对路径与 `..` 不受任何内置约束**；必须在 clone 后剔除敏感文件并自写 `tool_call` 路径守卫 |
| 风险 | 工具循环会让单次评审的延迟与费用上升；必须默认关闭 + 按项目灰度 |
| 风险 | 模型可能"读了很多但没读到点上"，反而降低评审质量；地图（层 B）比工具（层 C）更稳定，建议先上 B 再加 C |
| 风险 | pi 1.0.4 **无预算闸门**，步数/路径/token 三道限制全需自行实现；漏掉任何一道都可能造成费用或安全问题 |
| 未知 | 供应商模型对多轮工具调用的支持差异（是否需要 function calling 能力）；需在目标厂商上实测 |
| 未知 | 现有 `batchMaxTokens` 与仓库地图共享预算时的最优切分比例；需实测确定 |

---

## 7. 直接回答原始三问

1. **pi 支持 skill 吗？** 支持。目录 + `SKILL.md`，渐进式披露（提示里只有 name/description/location），正文由模型按需 `read`（`skills.d.ts:3-47`、`skills.js:278-303`）。
2. **当前项目调用 pi 时支持 skill 吗？** 不支持，而且是**双重关闭**——`reviewer.ts:76` 显式 `noSkills: true`；更关键的是 `noTools: "all"` 让工具集里既无 `read` 也无 `bash`，而 `system-prompt.js:101-109` 在无这两种工具时**整段不渲染 skills**。所以即便把 `noSkills` 改成 `false`，skill 依然不会出现在提示里，**必须先给工具**。
3. **能否拉分支后基于仓库评审而全量不烧 token？** 能。用"克隆分支 + 服务端紧凑地图 + 只读工具白名单 + 自写步数/路径/token 守卫"四件套；地图保底、工具体增效、预算保安全。**但必须清楚：pi 只提供计量与钩子，不提供预算闸门，三道守卫都要自己写。**

---

## 附：证据索引（全部来自本仓库与已安装 SDK）

- 评审调用链：`src/bootstrap.ts:137`、`src/application/review-pipeline.ts:292-300`、`:325-332`
- 会话装配与隔离：`src/infrastructure/pi/reviewer.ts:55-57`、`:67-81`、`:111-159`、`:162-188`
- 无工具：`src/infrastructure/pi/reviewer.ts:185`（`noTools: "all"`）
- 配置默认值：`src/shared/config.ts:66-74`（超时 20 分钟、单批 120k tokens、并发 5）
- GitLab 能力边界：`src/infrastructure/gitlab/gitlab-client.ts:105-235`
- SDK 会话选项（14 字段，无 signal/maxSteps/systemPrompt）：`node_modules/@earendil-works/pi-coding-agent/dist/core/sdk.d.ts:10-61`；工具解析优先级 `dist/core/sdk.js:145-149`
- SDK 只读工具（8 个内置，read/grep/find/ls 只读）：`.../dist/core/tools/index.d.ts:23`、`:38-42`、`.../dist/core/tools/index.js:81-88`
- SDK 工具过滤坑：`.../dist/core/agent-session.js:1114-1120`、`:2811-2817`
- SDK 无路径守卫：`.../dist/core/tools/path-utils.js`；唯一拦截点 `.../dist/core/extensions/types.d.ts:1054-1063`
- SDK skill：`.../dist/core/skills.d.ts:3-62`；渐进式披露 `.../dist/core/skills.js:278-303`；加载硬性要求 `:231-252`
- SDK 无工具则不渲染 skills：`.../dist/core/system-prompt.js:101-109`
- SDK skill 注入：`.../dist/core/resource-loader.d.ts:76`、`:90-96`；`examples/sdk/04-skills.ts:18-37`
- SDK skill 工具限制不生效：`.../dist/core/skills.js:243-263`（全 dist 搜索 `allowed-tools` 0 命中）
- SDK 资源加载器：`.../dist/core/resource-loader.d.ts:70-96`、`.../dist/core/resource-loader.js:420-424`、`:620-632`
- SDK 会话可观测：`.../dist/core/agent-session.d.ts:195-212`、`:372`、`:453`、`:527`、`:628`、`:866-867`
- SDK 压缩默认值：`.../dist/core/compaction/compaction.js:53-57`、`:173-177`
- SDK 循环无上限：`@earendil-works/pi-agent-core/dist/agent-loop.js:87-90`、`:465-466`
