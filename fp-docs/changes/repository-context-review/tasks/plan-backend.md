# 仓库上下文评审 Backend Implementation Plan

> **For agentic workers:** REQUIRED FLOW: Use `fp-execute` to implement this plan task-by-task. Only task markers use checkbox syntax; substeps are plain ordered instructions.

**Goal:** 实现默认关闭的项目级仓库上下文、共享规范、安全浅克隆和原管线兼容。

**Architecture:** 沿用现有分层；SQLite 保存配置；GitLab 固定版本快照；Git 对象只读端口；隔离 SDK 工具；管线统一生命周期。

**Tech Stack:** Node >=22.19.0、TypeScript ESM、原生 SQLite、Express 5、pi SDK 1.0.4；无新增第三方依赖。

## Global Constraints

- 输入解析：proposal 和 backend design 均为唯一 small form，无分片；[后端设计](<fp-docs/changes/repository-context-review/design/backend.md>) 是所有后端契约 owner。
- 用户最新授权“不需要再次询问我，直接使用你的最佳推荐，继续往下走”覆盖本计划和自动实施；不代表已逐项人工审阅。本次不自动提交、推送或操作真实业务数据。
- 关闭路径不克隆、不加仓库规范、不启用工具；新字段省略保留，旧数据全关；保留旧 Prompt 匹配及普通登录账号权限。
- 配置事务和幂等迁移必须在隔离 SQLite 测试库验证；不得打开真实 data 库。
- 复用任务 token，禁止放 URL、argv、日志、模型或持久文件。Git 只允许任务同源 HTTP(S)，固定 SHA，不检出/执行目标代码。
- 限额、生命周期、接口及回退严格采用后端设计；不得用未验证的静默降级替代失败处理。
- Engineering quality：`C:/Users/Lenovo/.dsh/skills/_shared/engineering-quality.md`；中文职责注释与非显然约束说明沿当前源码。后端 preset none；公共 Q01～Q05 只作为已加载工程检查参考，不套 Vue 规则到后端。
- 每任务执行 red → green → inline 自审；测试失败必须说明原因。Commit 步骤受独立授权限制，本轮只保留工作区改动和进度证据，不运行 git add/commit。

## File Structure

| Path | Action | Responsibility |
| --- | --- | --- |
| [database.ts](<src/infrastructure/sqlite/database.ts>)、[database.test.ts](<test/infrastructure/sqlite/database.test.ts>) | modify/test | 新表、补列、旧库升级 |
| [review-prompt.ts](<src/domain/review-prompt.ts>)、[prompt-repo.ts](<src/infrastructure/sqlite/prompt-repo.ts>)、[prompt-repo.test.ts](<test/infrastructure/sqlite/prompt-repo.test.ts>) | modify/test | 配置契约、事务、生命周期 |
| [prompts.ts](<src/interfaces/http/api/prompts.ts>)、[api.test.ts](<test/interfaces/http/api.test.ts>) | modify/test | 请求校验、响应、鉴权回归 |
| `src/domain/repository-context.ts` | create | 快照与受限读取/准备端口 |
| [review-task.ts](<src/domain/review-task.ts>)、[gitlab-client.ts](<src/infrastructure/gitlab/gitlab-client.ts>)、`test/infrastructure/gitlab/repository-snapshot.test.ts` | modify/create/test | 固定 MR diff 快照 |
| `src/infrastructure/git/git-runner.ts`、`test/infrastructure/git/git-runner.test.ts` | create/test | 无 shell 子进程、环境、取消与错误脱敏 |
| `src/infrastructure/git/repository-context.ts`、`test/infrastructure/git/repository-context.test.ts` | create/test | 浅克隆、固定对象、限额、只读访问与清理 |
| `src/infrastructure/pi/repository-tools.ts`、`test/infrastructure/pi/repository-tools.test.ts` | create/test | 三种模型工具与预算 |
| [reviewer.ts](<src/infrastructure/pi/reviewer.ts>)、[reviewer.test.ts](<test/infrastructure/pi/reviewer.test.ts>) | modify/test | 无发现上下文会话、取消等待 |
| [review-pipeline.ts](<src/application/review-pipeline.ts>)、`test/application/repository-context-pipeline.test.ts` | modify/create/test | 可选上下文编排 |
| [bootstrap.ts](<src/bootstrap.ts>)、[config.ts](<src/shared/config.ts>)、[Dockerfile](<Dockerfile>)、[README](<README.md>)、[配置样例](<.env.example>)、`test/shared/config.test.ts` | modify/test | 装配、超时、Git/CA 运行要求 |
| [build-openapi.ts](<scripts/build-openapi.ts>)、[openapi.json](<docs/openapi.json>)、`test/interfaces/http/prompt-openapi.test.ts` | modify/generate/test | 收尾时发现公开 API schema 缺少本次新字段；补齐同一配置接口的文档契约，不联网同步 Apifox |

## Backend Interface Ledger

| Interface | Owner Task | Contract | Consumers | Verification |
| --- | --- | --- | --- | --- |
| ProjectReviewSetting / Prompt 扩展 | backend-002 | `{project,repositoryContextEnabled}`；repositoryStandards；projectSettings；摘要 hasRepositoryStandards | API、pipeline、UI | 仓储测试 |
| PromptRepository.isRepositoryContextEnabled | backend-002 | 可选 `(fullName:string)=>boolean`；沿命中 Prompt 的最具体关联读取开关，兼容短名 | pipeline | 短名/精确/default/解绑 |
| PromptRepository.listProjectSettings | backend-002 | 已知项目当前状态列表，供 meta | API | meta 与详情一致 |
| POST/PUT 新字段 | backend-003 | repository_standards、project_settings；新字段省略保留/条目部分更新 | UI | 400/认证/保值 |
| RepositoryReviewSnapshot | backend-004 | `{changes,commits,refs,sourceProjectId,sourceBranch,repositoryUrl,gitlabUrl}`，同一固定版本 | provider、pipeline | 快照 fetch 替身 |
| GitlabClient.getRepositoryReviewSnapshot | backend-004 | 可选 `(projectId,iid,gitlabUrl?,gitlabToken?)=>Promise<RepositoryReviewSnapshot>` | pipeline | fork/变化/截断 |
| GitRunner / runGit | backend-005 | 参数数组 + `{cwd,env,signal,maxOutputBytes}` → stdout；错误已脱敏，取消等待 close | provider | 参数/取消/输出上限 |
| RepositoryProvider.prepare | backend-006 | `{repositoryUrl,gitlabUrl,sourceBranch,headSha,token,signal}` → `{access,dispose}` | pipeline | 本地合成仓库 |
| RepositoryReadAccess | backend-006 | headSha；`list({prefix?,query?,cursor?},signal?)`、`read({path,startLine?,limit?},signal?)`、`search({query,prefix?,cursor?},signal?)`；统一返回 `{text,truncated,nextCursor?}` | tools | 路径/分页/读取 |
| createRepositoryTools | backend-007 | `(access,signal)=>ToolDefinition[]`，仅 repo_list/read/search；每会话预算 | reviewer | 工具执行与计数 |
| ReviewInput / PiSessionFactory | backend-008 | 新增可选 repositoryContext:RepositoryReadAccess；PiSessionLike 增可选 abort():Promise<void> | pipeline、verifier | 旧替身兼容与取消 |
| PipelineDeps.repositoryProvider | backend-009 | 可选准备端口，关闭时不要求，开启缺失失败 | bootstrap | 管线替身 |
| Config.repositoryCloneTimeoutMs | backend-010 | 可选类型兼容旧配置；环境正整数，默认 120000 | bootstrap/provider | 配置测试 |

## Tasks

- [x] **Task backend-001: 为旧库与新库增加规范字段和项目设置表**

**Files:** Modify [database.ts](<src/infrastructure/sqlite/database.ts>); Test [database.test.ts](<test/infrastructure/sqlite/database.test.ts>)。
**Reasoning:** 配置必须先有默认关闭、可重复升级的持久化基础。
**Depends on:** None
**Interfaces:** Consumes openDatabase；Produces 后端设计新增表/列；Contract checks 默认空/0、重复升级保值。
**Step 1: Write the failing test**
```ts
const db = openDatabase(':memory:');
assert.equal(db.prepare("SELECT name FROM pragma_table_info('review_prompts') WHERE name='repository_standards'").get()?.name, 'repository_standards');
assert.equal(db.prepare('SELECT count(*) AS count FROM project_review_settings').get()?.count, 0);
```
另建临时旧 schema 文件库，插入旧 Prompt，打开两次断言正文不丢、新规范为空；首次升级后写新值，再次打开应保留。
**Step 2: Run test to verify it fails**：`node --test test/infrastructure/sqlite/database.test.ts`；预期缺列/缺表。
**Step 3: Write minimal implementation**：SCHEMA 新表与 NOT NULL 默认；migrate 事务内 addColumnIfMissing；异常回滚并保留既有迁移。写明 WAL 备份与默认关闭原因。
**Step 4: Run test to verify it passes**：同一命令；所有旧库/新库/幂等用例通过，inline 自审字段与设计一致。
**Step 5: Commit**：本轮无提交授权；保留改动，记录 red/green 与 owner checkbox，不执行 Git 提交。

- [x] **Task backend-002: 实现项目唯一开关、共享规范及事务生命周期**

**Files:** Modify [review-prompt.ts](<src/domain/review-prompt.ts>)、[prompt-repo.ts](<src/infrastructure/sqlite/prompt-repo.ts>); Test [prompt-repo.test.ts](<test/infrastructure/sqlite/prompt-repo.test.ts>)。
**Reasoning:** 同项目多关联只拥有一个状态，普通编辑不得重置开关。
**Depends on:** backend-001
**Interfaces:** Consumes 新 schema；Produces ProjectReviewSetting、新 Prompt 字段、isRepositoryContextEnabled/listProjectSettings；Contract checks 精确全名、部分更新、孤立清理。
**Step 1: Write the failing test**
```ts
const p = repo.create({ repository:'rules', projects:['group/a','group/b'], systemPrompt:'s', userPrompt:'u', repositoryStandards:'规范', projectSettings:[{project:'group/a',repositoryContextEnabled:true}] });
assert.equal(repo.isRepositoryContextEnabled!('group/a'), true);
assert.equal(repo.isRepositoryContextEnabled!('group/b'), false);
repo.update(p.id, {systemPrompt:'s2',userPrompt:'u2'});
assert.equal(repo.get(p.id)?.repositoryStandards, '规范');
```
加重复关联、大小写、短名可启用且不跨 Prompt 继承、default、最终解绑后重关联关闭、导入保值及故障触发器 rollback。
**Step 2: Run test to verify it fails**：`node --test test/infrastructure/sqlite/prompt-repo.test.ts`；预期新状态未保存或方法不存在。
**Step 3: Write minimal implementation**：领域校验集中定义；仓储 create/update/remove 包同步事务；返回完整项目状态；更新省略保留、显式空清除；清理孤立设置，查询时沿命中 Prompt 的最具体关联读取开关（兼容存量短名，精确优先）。
**Step 4: Run test to verify it passes**：同命令加 database 测试；断言列表不返回规范正文，旧匹配顺序/多关联仍兼容；自审事务错误不隐藏。
**Step 5: Commit**：仅记录工作区与进度，无 Git 提交。

- [x] **Task backend-003: 扩展 Prompt API 校验、响应与旧客户端保值**

**Files:** Modify [prompts.ts](<src/interfaces/http/api/prompts.ts>); Test [api.test.ts](<test/interfaces/http/api.test.ts>)。
**Reasoning:** API 是非法布尔、未知项目和旧客户端数据丢失的边界。
**Depends on:** backend-002
**Interfaces:** Consumes PromptRepository；Produces ledger 中新字段及 meta.projectSettings；Contract checks 原状态码/认证、32,000 字符、部分更新。
**Step 1: Write the failing test**
```ts
const response = await authed(base, token, '/api/prompts', {method:'POST',body:JSON.stringify({repository:'r',projects:['g/a'],system_prompt:'s',user_prompt:'u',repository_standards:'规范',project_settings:[{project:'g/a',repository_context_enabled:true}]})});
assert.equal((await response.json()).projectSettings[0].repositoryContextEnabled, true);
```
覆盖规范 null/超限、字符串布尔、重复/未知项目、default、缺 projects 更新保留、无 token 写操作 401 与普通登录账号可写。
**Step 2: Run test to verify it fails**：`node --test test/interfaces/http/api.test.ts`；预期新字段被忽略或非法输入未拒绝。
**Step 3: Write minimal implementation**：snake/camel 映射；用字段存在性区分省略与空；校验前不写库；meta 返回已知状态，保留旧 provider/通知语义。
**Step 4: Run test to verify it passes**：同命令；同步跑仓储测试，确认 400 不产生部分写入。
**Step 5: Commit**：仅记录工作区与进度，无 Git 提交。

- [x] **Task backend-004: 获取一致 MR diff 版本与源仓库快照**

**Files:** Create `src/domain/repository-context.ts`、`test/infrastructure/gitlab/repository-snapshot.test.ts`; Modify [review-task.ts](<src/domain/review-task.ts>)、[gitlab-client.ts](<src/infrastructure/gitlab/gitlab-client.ts>)。
**Reasoning:** 克隆分支和独立读取最新 refs 会错位，必须绑定版本化 diff。
**Depends on:** None
**Interfaces:** Produces RepositoryReviewSnapshot、RepositoryProvider/ReadAccess 类型与可选 getRepositoryReviewSnapshot；Consumes GitlabClient 现有 request/fetch 注入。
**Step 1: Write the failing test**
```ts
const snapshot = await client.getRepositoryReviewSnapshot!(7, 2, 'https://git.example', 'fixture-token');
assert.equal(snapshot.refs.headSha, head);
assert.equal(snapshot.sourceProjectId, 9);
assert.deepEqual(snapshot.changes, versionChanges);
```
用 fetch 路由替身明确 MR/版本列表/版本内容/源项目/commits/复核顺序；覆盖 fork、head 推进、缺版本、截断和异源 URL。
**Step 2: Run test to verify it fails**：`node --test test/infrastructure/gitlab/repository-snapshot.test.ts`；预期新方法不存在。
**Step 3: Write minimal implementation**：可选端口向后兼容；强校验所需字段，选与任务开始时 MR sha 匹配的固定版本；返回同版本 refs/changes；不复用存在契约差异的 getLatestHeadSha。
**Step 4: Run test to verify it passes**：新测试及 `node --test test/infrastructure/gitlab/gitlab-client.test.ts`；关闭路径现 API 契约不变。
**Step 5: Commit**：仅记录工作区与进度，无 Git 提交。

- [x] **Task backend-005: 安全执行 Git 子进程并处理取消与脱敏**

**Files:** Create `src/infrastructure/git/git-runner.ts`、`test/infrastructure/git/git-runner.test.ts`。
**Reasoning:** 网络凭据、参数、进程树和输出上限需要独立验证，不依赖真实仓库。
**Depends on:** backend-004
**Interfaces:** Produces GitRunner/runGit、可信子进程环境构造；Consumes AbortSignal；Contract checks shell false、argv 无 token、关闭后 settle。
**Step 1: Write the failing test**
```ts
assert(!JSON.stringify(args).includes(token));
assert(!env.GIT_TRACE);
assert.equal(env.GIT_TERMINAL_PROMPT, '0');
await assert.rejects(runGit(args,{cwd,env,signal,maxOutputBytes:8}), /输出|中断|失败/);
```
真实本地子进程/可控 spawn 替身验证超限、异常、abort、子进程树终止和敏感 stderr 不出现在错误。
**Step 2: Run test to verify it fails**：`node --test test/infrastructure/git/git-runner.test.ts`；预期新模块缺失。
**Step 3: Write minimal implementation**：参数数组、环境 allowlist、Git config 隔离、URL scoped 环境授权头；跨平台终止并等 close；stdout 有界，stderr 仅内存分类且不外泄。
**Step 4: Run test to verify it passes**：同命令，检查 abort 后无悬挂进程/计时器；写明环境凭据不提供 OS 同用户隔离。
**Step 5: Commit**：仅记录工作区与进度，无 Git 提交。

- [x] **Task backend-006: 准备固定 Git 对象并实现受限仓库访问**

**Files:** Create `src/infrastructure/git/repository-context.ts`、`test/infrastructure/git/repository-context.test.ts`。
**Reasoning:** 每任务浅克隆需要完整清理；模型文件读取必须不越界、不执行。
**Depends on:** backend-005
**Interfaces:** Produces createRepositoryProvider/prepare/access/dispose；Consumes GitRunner、域端口；Contract checks 后端限额与路径规则。
**Step 1: Write the failing test**
```ts
const handle = await provider.prepare(input);
assert.match((await handle.access.read({path:'src/a.ts'})).text, /fixture/);
await assert.rejects(handle.access.read({path:'../secret'}));
await handle.dispose();
assert.equal(existsSync(capturedTaskRoot), false);
```
合成本地仓库通过测试 runner 映射 transport，生产仍只许 HTTP(S)。加入分支推进后补 SHA、不可达 SHA、symlink/submodule/敏感文件/LFS/二进制/大文件、分页预算、准备失败清理、超时/超量及幂等 dispose。
**Step 2: Run test to verify it fails**：`node --test test/infrastructure/git/repository-context.test.ts`；预期新模块缺失。
**Step 3: Write minimal implementation**：唯一临时目录、--no-checkout 浅克隆、一次精确 fetch；解析 ls-tree 固定 blob 清单；中央路径筛选；list/read/literal-search 有界结果；总超时/磁盘检查与活动操作 drain 后清理。
**Step 4: Run test to verify it passes**：同命令及 runner 测试；验证文件内容来自真实 Git blob，不以 mock 替换核心读取。
**Step 5: Commit**：仅记录工作区与进度，无 Git 提交。

- [x] **Task backend-007: 将只读端口封装为三种有预算的模型工具**

**Files:** Create `src/infrastructure/pi/repository-tools.ts`、`test/infrastructure/pi/repository-tools.test.ts`。
**Reasoning:** 工具 schema 和预算是模型输入边界，不能让任意参数绕过只读端口。
**Depends on:** backend-006
**Interfaces:** Produces createRepositoryTools；Consumes RepositoryReadAccess；Contract checks 固定工具名、有效 schema、40 次/128,000 字符预算。
**Step 1: Write the failing test**
```ts
const tools = createRepositoryTools(access, signal);
assert.deepEqual(tools.map(t=>t.name).sort(), ['repo_list','repo_read','repo_search']);
assert(!JSON.stringify(tools.map(t=>t.parameters)).includes('token'));
```
直接执行工具，覆盖非法 query/path、截断、累计超量、取消，验证返回不含绝对目录。
**Step 2: Run test to verify it fails**：`node --test test/infrastructure/pi/repository-tools.test.ts`；预期新模块缺失。
**Step 3: Write minimal implementation**：使用 SDK 已安装的 TypeBox schema/ToolDefinition，闭包绑定 access；独立每会话计数；结果带截断说明，不引入执行工具。
**Step 4: Run test to verify it passes**：同命令和类型检查，检查工具描述明确源文件是数据而非指令。
**Step 5: Commit**：仅记录工作区与进度，无 Git 提交。

- [x] **Task backend-008: 隔离上下文 SDK 会话并修复取消创建竞态**

**Files:** Modify [reviewer.ts](<src/infrastructure/pi/reviewer.ts>)、[review-task.ts](<src/domain/review-task.ts>); Test [reviewer.test.ts](<test/infrastructure/pi/reviewer.test.ts>)。
**Reasoning:** 有工具的会话不能触发仓库/全局扩展发现；清理需要真实取消完成屏障。
**Depends on:** backend-007
**Interfaces:** Produces 可选 repositoryContext、无发现 ResourceLoader、可选 PiSessionLike.abort；Consumes tools、现有 PiSessionFactory/ModelRuntime。
**Step 1: Write the failing test**
```ts
const pending = reviewer.review({systemPrompt:'s',code:'diff',signal:controller.signal,repositoryContext:access});
controller.abort();
resolveFactory(session);
await assert.rejects(pending);
assert.equal(promptCount, 0);
assert.equal(disposeCount, 1);
```
验证空 cwd、静态 loader getters、实际仅三种有效工具、没有扩展/package 副作用，以及既有无上下文输入/默认模型兼容。
**Step 2: Run test to verify it fails**：`node --test test/infrastructure/pi/reviewer.test.ts`；预期创建途中 abort 仍 prompt 或未传上下文。
**Step 3: Write minimal implementation**：上下文会话使用内存安全 settings 和静态 loader；显式工具 allowlist/MCP denylist；安全默认模型字段复制；abort 后 await SDK idle 再 dispose，覆盖初始化和成功结束竞态。
**Step 4: Run test to verify it passes**：reviewer/tool 测试与 `npm run typecheck`；旧测试替身不要求新增必填方法。
**Step 5: Commit**：仅记录工作区与进度，无 Git 提交。

- [x] **Task backend-009: 接入评审配置快照、仓库规范与完整清理**

**Files:** Modify [review-pipeline.ts](<src/application/review-pipeline.ts>); Create `test/application/repository-context-pipeline.test.ts`。
**Reasoning:** 管线决定开启/关闭、克隆次数、规范生效和失败记录，必须保持原评论/通知行为。
**Depends on:** backend-003, backend-004, backend-006, backend-008
**Interfaces:** Produces PipelineDeps.repositoryProvider；Consumes 精确开关、固定快照、prepare/reviewer；Contract checks 关闭不调用、失败不降级。
**Step 1: Write the failing test**
```ts
await pipeline.run(task);
assert.equal(prepareCalls, 1);
assert.equal(reviews[0].repositoryContext, access);
assert.match(reviews[0].systemPrompt, /仓库规范/);
assert.equal(disposeCalls, 1);
```
参数化覆盖准备失败/全批失败/汇总失败/回写失败/记录异常；关闭旧输出完全不变；配置在 run 开始快照，批次重试不重复克隆。
**Step 2: Run test to verify it fails**：`node --test test/application/repository-context-pipeline.test.ts`；预期未准备/未传规范。
**Step 3: Write minimal implementation**：在现有管线最小插入分支和外层 finally，不重写行内算法；汇总有规范无工具；原输出契约最后追加；准备失败写 failed，错误脱敏。
**Step 4: Run test to verify it passes**：新测试及 `node --test test/application/review-pipeline.test.ts test/application/prompt-source.test.ts`；所有已有重试/通知用例继续通过。
**Step 5: Commit**：仅记录工作区与进度，无 Git 提交。

- [x] **Task backend-010: 装配运行能力并验证部署配置与全量回归**

**Files:** Modify [bootstrap.ts](<src/bootstrap.ts>)、[config.ts](<src/shared/config.ts>)、[Dockerfile](<Dockerfile>)、[README](<README.md>)、[配置样例](<.env.example>)、[config.test.ts](<test/shared/config.test.ts>)；收尾补齐 [build-openapi.ts](<scripts/build-openapi.ts>)、生成的 [openapi.json](<docs/openapi.json>) 与 [schema 测试](<test/interfaces/http/prompt-openapi.test.ts>)，原因见 File Structure。
**Reasoning:** 本机 Git 不代表容器具备 Git，装配和运维限制必须随功能交付。
**Depends on:** backend-009
**Interfaces:** Consumes createRepositoryProvider；Produces repositoryCloneTimeoutMs 与 bootstrap 注入；Contract checks 默认 120000、非法值拒绝、旧配置兼容。
**Step 1: Write the failing test**
```ts
assert.equal(loadConfig({AUTH_SALT:'test'}).repositoryCloneTimeoutMs, 120000);
assert.throws(()=>loadConfig({AUTH_SALT:'test',REPOSITORY_CLONE_TIMEOUT_MS:'0'}));
```
按现 config 测试实际函数名/必需环境构造应用，不改变已有字段要求；增加 runner Docker Git/CA 的配置检查。
**Step 2: Run test to verify it fails**：`node --test test/shared/config.test.ts`；预期缺克隆超时配置。
**Step 3: Write minimal implementation**：bootstrap 注入 provider，runner 包增加 git/ca-certificates；说明 token 权限、名称级状态、限额、失败处理、WAL 一致备份、旧版本回退与重新升级，不执行部署。
**Step 4: Run test to verify it passes**：`npm test`、`npm run typecheck`；检查所有任务的注释、安全边界和 diff；记录外部 GitLab/模型/容器未验证。
**Step 5: Commit**：仅记录工作区与进度，无 Git 提交。

## Coverage Matrix

| Source | Requirement / Boundary | Tasks | Verification |
| --- | --- | --- | --- |
| 提案 P-001/P-007；D-002～D-005 | 项目开关、默认关闭、数据/API/权限/生命周期 | backend-001～backend-003 | sqlite 与 api 测试 |
| 提案 P-005/P-006；D-017 | 共享规范选填、关闭不改变 Prompt | backend-002、backend-003、backend-009 | 仓储/API/管线测试 |
| 提案 P-002/P-003/P-004；D-006/D-007 | 固定版本、fork、token、浅克隆、失败即终止 | backend-004～backend-006、backend-009 | snapshot/Git/pipeline 测试 |
| D-008/D-009/D-010 | 工具白名单、无执行、路径/文件/预算安全 | backend-005～backend-008 | Git/tools/reviewer 测试 |
| D-011 | 每任务一次准备、取消、所有出口清理 | backend-005、backend-006、backend-008、backend-009 | abort/故障用例 |
| D-012 | 增量迁移、备份与回退 | backend-001、backend-002、backend-010 | 旧库测试与文档检查 |
| D-016；原有功能兼容 | 装配、配置、注释和全量回归 | backend-010 | npm test、npm run typecheck |

无后端设计缺口。执行时发现实际 SDK/GitLab 契约不符，回到对应设计 owner 做定点修订并记录委托依据，不擅自降级安全或范围。
