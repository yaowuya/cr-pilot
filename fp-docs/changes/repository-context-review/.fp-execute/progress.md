# Execution Progress

Plan files:
- [后端唯一任务 owner](<fp-docs/changes/repository-context-review/tasks/plan-backend.md>)：small，backend-001～backend-010，无分片。
- [前端唯一任务 owner](<fp-docs/changes/repository-context-review/tasks/plan-frontend.md>)：small，frontend-001～frontend-002，无分片。
- [双端派生总览](<fp-docs/changes/repository-context-review/tasks/00-overview.md>)。

Base SHA: 20e1afede84ae29f9c3db203755fc247543c7cb5
Branch: feat/repository-context-review
Execution: fp-execute，automationMode=full；用户明确委托采用最佳推荐继续，不再询问；不自动提交或推送。

## Completed

- backend-001（owner: [后端计划](<fp-docs/changes/repository-context-review/tasks/plan-backend.md>)）：未提交，工作区相对 Base SHA；`node --test test/infrastructure/sqlite/database.test.ts` red 4 pass/2 fail（缺新列/默认值），green 6/6；inline 自审确认事务升级、NOT NULL/CHECK、旧值保留和必要注释。

- backend-002（owner: 后端计划）：未提交；仓储测试 red 16 pass/6 fail（新字段/方法/校验/事务缺失），green 与数据库测试合计 28/28；`npm run typecheck`、`git diff --check` 通过。inline 自审覆盖名称级唯一状态、短名不启用、普通保存保值、default、孤立清理和 rollback；公开契约与安全原因已注释。

- backend-003（owner: 后端计划）：未提交；新增 API 测试 red 0/3，green API+SQLite 合计 56/56。一次 typecheck 暴露新增测试 JSON 为 unknown，已补具体响应类型并重跑通过；相关 API 3/3 再通过，git diff --check 通过。inline 自审已检查新字段 400、保值、普通账号权限、meta 与无正文摘要。

- backend-004（owner: 后端计划）：未提交；snapshot 5 个用例 red 均因方法缺失，green 新旧 GitLab 测试 19/19（旧测试含两次既有 20 秒等待）；npm run typecheck 与 git diff --check 通过。inline 自审确认 fixed-version diffs/commits/refs、fork 源仓库、前后 MR 复核、截断失败、同源 URL/跳转和错误脱敏。

- backend-005（owner: 后端计划）：未提交；red 因 Git runner 模块不存在，green 5/5；真实可信 Node 子进程验证无 shell 参数传递、stdout/stderr 超限、取消后等待 close、退出/ENOENT 脱敏；环境测试确认不继承模型密钥/Git注入/代理凭据，授权头只在 URL 限定环境。npm run typecheck 与 git diff --check 通过，inline 自审已完成。

- backend-006（owner: 后端计划）：未提交；red 为 provider 模块缺失，green Git 读取及 runner 11/11；真实 Git fixture 验证 shallow/no-checkout、旧 SHA 补取、blob 文本、敏感/链接/LFS/二进制/大文件拒绝、分页、超量/失败/超时及 drain 后清理。类型检查已通过；inline 自审核对无工作树执行与目录幂等释放，生产只允许同源 HTTP(S)。

- backend-007（owner: 后端计划）：未提交；red 模块缺失；green 3/3，类型检查通过。inline 自审发现 SDK details 不一定进入模型文本，已把截断/游标/剩余调用写入实际 text 且计入预算；固定工具名、schema、次数/累计字符和双取消信号均已验证。

- backend-008（owner: 后端计划）：未提交；red 缺 buildRepositorySessionOptions，green SDK/reviewer/tools 12/12；实际 SDK 离线创建会话验证激活工具恰为三种，无扩展/包加载，内存 settings 仅模型默认值；初始化期间取消等待 abort 后释放、不调用 prompt。类型检查与 diff --check 通过（Git 提示既有 CRLF 归一化，不是错误）。旧 loader 误导说明已定点修正，未改变旧无上下文全局行为。

- backend-009（owner: 后端计划）：未提交；red 新上下文管线 2 pass/9 fail，green 与旧管线/来源测试合计 90/90；typecheck 通过。配置在外部 await 前快照，开启只用固定版本、一次 prepare、批次带只读能力、汇总无工具、规范仅开启生效；失败各出口和落库异常均清理。inline 自审未改写原评论/通知算法。

- backend-010（owner: 后端计划）：未提交；配置 red 15 pass/2 fail，green 17/17。bootstrap 已注入 provider、runner 镜像加 Git/CA、配置样例与 README 说明启用/限制/备份/回退。`npm test` 后台 job win-bash-af4c8e8eff984ef5 已收集，467/467 通过（41s）；typecheck 通过。inline 自审覆盖装配与部署依赖，未执行容器构建或真实 GitLab/模型。局部缩进脚本首次因 CRLF 标记匹配失败未写文件，已修正并执行成功、diff --check 通过。

- frontend-001（owner: 前端计划）：未提交；red prompt-form 模块缺失，green 6/6；npm run typecheck 通过。inline 自审确认旧响应默认空/关、meta 未知不写 false、只提交 dirty 条目、删除清 dirty、必填/全名/长度校验与异步 generation 失效；纯逻辑无 UI 通过声明。

## Blocked

- frontend-002 严格视觉证据：用户选择现有 UI 规范与源码推导，没有原始参考图；不能伪造 reference.png 或 VISUAL_REVIEW_PASS。实施及可用验证按各阶段如实记录，此限制不影响独立后端任务。

## Notes

- Pre-flight：两端计划结构、12 个唯一 task owners、依赖存在性/无环、跨端 2 条边及派生计数校验通过；无业务范围或接口冲突。
- 已使用 fp-plan-backend 与 fp-plan-frontend；未跳过任一端。设计和计划的自主采用依据为用户原文“不需要再次询问我，直接使用你的最佳推荐，继续往下走”，不伪称逐项人工确认。
- 浏览器能力：现有 playwright-cli 0.1.22，Chrome/Edge 文件存在；仅执行 --version/--help，尚未启动服务/浏览器。
- 源码写入前工作区只有本次流程文档；CodeGraph 状态 ready，首次源码/测试写入后立即 dirty-after-write，不再查询。
- 测试仅隔离临时/内存库和合成数据；不读 .env/data，不调用真实 GitLab/模型/通知。

## Execution Log

### 当前收尾状态

- 后端 10/10、前端数据层 1/1 完成；frontend-002 源码已实现、类型/构建及真实功能回放有证据，但 owner checkbox 保持未完成。
- 最终功能回归（文档 schema 补齐前）`npm test` 473/473，通过日志见 [final-tests.log](<fp-docs/changes/repository-context-review/.fp-execute/final-tests.log>)；后台 job win-bash-533ff9ad3e3744f7 已收集。
- 公开 OpenAPI 收尾发现新字段未登记，定点扩展既有 schema/generator；新增 schema 测试 red 缺 maxLength，生成后 green 1/1；`npm run build:openapi`、`npm run typecheck`、`git diff --check` 通过，未运行 Apifox 同步。backend-010 曾为此补充重新打开，已验证后恢复完成。
- frontend-002：旧页面基线确认无仓库设置；新页面已完成真实 UI 创建/保存/重载、独立开关、可空规范、关闭保留、部分项目共享状态、取消、断网保值、双击防重、CDP 真实延迟/请求归属、短名禁用、字数边界、窄屏键盘/保存及正常删除。没有请求 mock、业务数据 seed、token 注入或绕过 UI 的写入。
- UI 只在独立临时真实 Express/SQLite 实例运行；原业务库/.env 未读取。真实模型/GitLab/通知/容器构建仍未验证。
- UI stable replay 输出见 [replay-output.log](<fp-docs/changes/repository-context-review/.fp-execute/e2e/frontend-002/desktop/replay-output.log>)；两个案例的 [desktop coverage](<fp-docs/changes/repository-context-review/.fp-execute/e2e/frontend-002/desktop/coverage-matrix.md>)、[narrow coverage](<fp-docs/changes/repository-context-review/.fp-execute/e2e/frontend-002/narrow/coverage-matrix.md>) 分别记录 covered/BLOCKED。
- 独立只读视觉代理 50343f59-4fb5-49e4-9e52-2e40d40195e6 已返回 desktop/narrow 均 CANNOT_VERIFY，见 [视觉检查](<fp-docs/changes/repository-context-review/.fp-execute/visual/review.md>)。无原始 reference，不能伪造 VISUAL_REVIEW_PASS，未启动 fp-final-review 或归档。
- 所有测试业务记录均经 UI 删除，随后只读 SQLite 核实三表空；浏览器已关闭，UI job win-bash-630b903ad72d46f9 已终止并收集，专属目录删除，4768 端口关闭。无仍需要保留的验证服务。

## Historical Task Log

### backend-001 — 开始

已读取唯一 task owner、数据库实现和现有测试。默认值/旧库升级/重复升级保值完成 red→green；6/6 通过。首次测试写入已将 CodeGraph 标记 dirty-after-write，后续只用当前源文件搜索。

### backend-002 — 开始

已读取领域接口、仓储 create/update/remove/import 和关联解析实现。新增 6 个行为/负向用例完成 red→green；合计 28/28，类型检查通过。

### backend-003 — 开始

现 API 配置读写/非法字段/省略保值/权限完成 red→green，数据库+仓储+API 56/56。

### backend-004 — 完成

新增固定版本域端口与 GitLab snapshot。官方 [MR API 文档](<https://docs.gitlab.com/api/merge_requests/#retrieve-a-merge-request-diff-version>) 在 2026-10-23 核实 version 详情含 commits/diffs/real_size/state，使用该 commits 而不是另取动态 /commits，进一步减少版本混用。网页获取工具截断后通过同一公共页面的有界章节提取核实；未发送仓库内容或凭据。真实部署 GitLab 仍未调用。

### backend-005 — 开始

Git runner 已完成 red→green 5/5；原生进程验证通过，未访问外部仓库。

### backend-006 — 开始

准备构造合成本地 Git 仓库（网络 transport 仅在测试 runner 中映射为 file），验证实际固定 blob 读取、分支推进补 SHA、路径/文件限额和全部清理。生产继续只允许同源 HTTP(S)。

### 最新验证与交接

- 当前源码最终验证：`npm run typecheck` 通过；`npm test` **474/474** 通过，见 [verified-current-tests.log](<fp-docs/changes/repository-context-review/.fp-execute/verified-current-tests.log>)；`git diff --check` 通过。该次验证已覆盖等待磁盘监控停止后再次核对取消信号的收尾修正。
- `npm run build:frontend` 通过；只出现既有大 chunk 提示，无构建失败。`npm run build:openapi` 与新增 schema 测试通过，无 Apifox/外部同步。
- Lead 已检查配置/存储/API、管线/模型装配的最终 diff（管线因 try/finally 缩进较多，用忽略空白 diff 核实行为范围）；新增 Git/读取/tool 实现已逐任务 inline 自审并经实际 Git blob 与子进程测试。这里只是 inline 自审，不冒称独立最终评审。
- 结构核验：16 个当前变更 Markdown 均在 500 行/30,000 字符以内；D-001～D-017 各有唯一 owner；12 个任务无重复/环，owner checkbox 为 11 完成、frontend-002 未完成；overview 派生计数一致，没有 dual/historical form。
- CodeGraph：沿本次已核实的 CLI 1.6.2，在源码写入后未查询；收尾已执行一次 `codegraph sync D:\01-code\cr-pilot --quiet`，退出 0，未再运行 status，未修改 manifest 或提交索引。
- 早先 Notes 中“尚未启动服务/浏览器”是启动时能力快照；当前服务/浏览器已经完成真实验证并全部清理，见上方收尾状态与 E2E manifests。
- 所有后台 job 均已收集，验证服务已终止；没有待等待的子代理。当前目标保持 active，未标完成：代码与主要验证已交付，但严格视觉源和覆盖矩阵中的剩余 E2E 分支尚未满足，未进入 fp-final-review，不建议 fp-archive。

### 自动续轮 2～3：恢复、追加验证与停止边界

- 续轮 2 的 Windows Job runner 在宿主中断时报告 exit 1073807364，扩展回放输出为空，不能计为通过；重启后旧 job 不在当前 job ledger。确认旧端口 13093 不可达，检查专属临时库仅有 1 条厂商测试数据后删除该已停止的专属临时目录，未触碰工作区业务库。
- 续轮 3 新建真实临时实例 14644（job win-bash-c9847a1d8fc34dc1），扩展回放三次结束：第 1 次异步 Vue 路由守卫导致脚本未正常登录；第 2 次 Element Plus 只读 select 内部输入被 placeholder 覆盖，定位方式错误；第 3 次重入时列表请求未就绪，脚本未看到已有厂商，触发真实重复创建 409，停在新增厂商弹窗。它们都是诊断/回放证据缺口，不伪装成当前产品的已验证缺陷，也不声明对应 E2E 分支覆盖。
- 遵守最多三次诊断限制，没有运行第四次功能回放。两条厂商记录和普通账号均通过正常 UI 删除；只读 SQLite 核实 review_prompts、prompt_projects、project_review_settings、llm_providers 为 0，admins 只剩标准初始化账号。浏览器已关闭，验证 job 终止并收集，14644 端口不可达，专属目录已删除。
- [扩展脚本](<fp-docs/changes/repository-context-review/.fp-execute/e2e/frontend-002/desktop/extended-replay.js>)、[attempt 1](<fp-docs/changes/repository-context-review/.fp-execute/e2e/frontend-002/desktop/extended-output-round3.log>)、[attempt 2](<fp-docs/changes/repository-context-review/.fp-execute/e2e/frontend-002/desktop/extended-attempt2.log>)、[attempt 3](<fp-docs/changes/repository-context-review/.fp-execute/e2e/frontend-002/desktop/extended-attempt3.log>)、[清理输出](<fp-docs/changes/repository-context-review/.fp-execute/e2e/frontend-002/desktop/extended-cleanup.log>) 均已保存。coverage 中原 BLOCKED 分支未据此改为 covered。
- 补充后端独立验证：在既有 [Git 仓库测试](<test/infrastructure/git/repository-context.test.ts>) 中使用真实本机 git-http-backend 提供 Smart HTTP；未替换客户端 runner/transport，未访问远端。实际 clone 请求均带 URL 限定 Basic 头；验证 depth=1、固定 blob、config 不含授权信息及目录释放。定向用例通过，无产品源码改动。
- 追加测试后 `npm run typecheck` 通过，[round3-typecheck.log](<fp-docs/changes/repository-context-review/.fp-execute/round3-typecheck.log>)；`npm test` **475/475** 通过，[round3-tests.log](<fp-docs/changes/repository-context-review/.fp-execute/round3-tests.log>)。后台 job win-bash-b2fc0e54ff81405f 已收集，退出 0。
- frontend-002 仍停在 STATIC_UI_READY / BLOCKED。原始 reference 的缺失已跨连续 3 个目标续轮保持不变，不能自动制造受信参考；独立视觉检查已是 CANNOT_VERIFY，扩展 UI 回放也已达到三次诊断边界。保留任务未完成，不运行 fp-final-review，不归档，不提交/推送。
- 本轮收尾 `git diff --check` 通过；新增测试写入后未查询代码图，执行一次 `codegraph sync D:\01-code\cr-pilot --quiet` 退出 0，未再次 status。当前 16 个 Markdown 文件均符合大小限制，仍为 11/12 task checkbox 完成且无 canonical conflict。

### 用户反馈缺陷 E-001：短项目名无法开启仓库拉取（已修复）

- 用户提供页面截图并报告“无法开启拉代码的按钮”。截图中 5 个项目全是存量短名（auto-ops、auto-ops-platform、auto-screenshot、cw-auto-ops、ops-node-server），开关全部呈禁用态，并显示“请使用完整路径 namespace/project 才能开启”。
- 复现：先在页面层建立红测 `canEnableRepositoryContext('auto-ops') === true`，实测返回 false。根因是初版把“至少两段路径”当作开启前提，同时后端 `validateProjectSettings` 与仓储 `readEnabled/writeSettings/activeProjectKeys` 也用同一规则过滤，构成三层不一致风险：若只放开前端，保存仍会 400、读取仍返回关闭。
- 修复：配置键改为“合法项目名或相对路径”（仍拒绝 URL、`..`、空段、反斜杠、控制字符、选项前缀）；开关读取改为沿**命中 Prompt 的最具体关联**取值——精确或更长关联优先，避免一条规则的短名开启被另一条规则继承。仓库地址仍只来自 MR 源项目 API，配置名从不参与拼接，因此短名不会拉错仓库。
- 回归覆盖：页面 5 个存量短名可开启；后端短名保存、普通保存保值、最后解绑清理、重关联默认关闭、精确/更长关联优先、default 不启用；管线在真实 MR 全名（`g/a`）下用短名配置开启并仍使用修快照返回的仓库 URL，另一关闭短名不触发拉取；API 正向短名保存 + meta 状态一致；非法路径仍 400。同步修正 README、设计/计划/评审文档与 OpenAPI 描述，使其不再声称“必须先补完整路径”。
- 真实页面验证：隔离实例 10369 中，5 个短名开关 `aria-disabled=false`，逐个开启后保存返回 `repositoryContextEnabled: true` 共 5/5，列表显示“已开启 5 / 5”，reload 后重开全部仍为 true。随后通过正常 UI 删除该 Prompt，只读 SQLite 核实 review_prompts/prompt_projects/project_review_settings/llm_providers 均为 0；浏览器关闭、job 终止、临时目录删除、端口不可达。
- 验证命令：`npm run typecheck` 通过；`npm test` **482/482** 通过（[short-name-tests.log](<fp-docs/changes/repository-context-review/.fp-execute/short-name-tests.log>)）；`npm run build:frontend` 通过（[short-name-build.log](<fp-docs/changes/repository-context-review/.fp-execute/short-name-build.log>)）；`npm run build:openapi` 与 schema 测试通过；`git diff --check` 通过。
- 说明：该修复只解决“存量短名不能开启”的功能缺陷，**不改变** frontend-002 因缺少可信视觉参考而 BLOCKED 的结论，也不据此宣称最终评审通过或归档就绪。

### 用户需求 E-002：除 default 外 Prompt 名称可修改（已实现）

- 现状核实：编辑弹窗中名称输入在 `editingId !== null` 时被禁用，仓储 `update` 也不写 `repository` 列，因此旧实现只能读取不能改名。
- 实现：`PromptRepository.update` 接受可选 `repository`；省略时保留原名（兼容只改正文的旧客户端）。名称经 `normalizePromptName` 去空白校验，空值或超过 200 字符返回 400。`default` 名称不可修改，也不允许把其他 Prompt 改名为 `default`（两者都返回 400）。改名与正文、关联、仓库开关在同一事务内完成；新名称撞上已有 Prompt 由唯一约束回滚并返回 409，不会出现正文已改而名称未改的半完成状态。
- 页面：名称输入移到标签页之外，编辑时始终可见；新增“可修改；保存后列表名称随之更新”提示，`default` 单独提示不可修改。保存成功后重新加载列表，显示新名称。
- 回归覆盖：仓储层改名保留 id、关联、规范与项目开关；重名整笔回滚；空名/超长名拒绝；default 改名双向拒绝；API 改名 200、重名 409、省略名称保值、default 受保护；前端名称校验；OpenAPI `PromptUpdateRequest` 增加可选 `repository`（maxLength 200）并写明 default 例外与 409。
- 真实页面验证（隔离实例 1180）：名称输入可编辑；改名为“重命名丁”后列表立即显示新名称，`reload` 后仍保持；改名为已存在的“占用名称乙”返回真实 409 且提示“prompt 占用名称乙 已存在”，输入框保留草稿、放弃后原名不变；`default` 名称输入不可编辑并显示说明。随后三个测试 Prompt 全部经正常 UI 删除，只读 SQLite 核实三表为 0；浏览器关闭、job 终止、临时目录删除、端口不可达。
- 验证命令：`npm run typecheck` 通过；`npm test` **486/486** 通过（[rename-tests.log](<fp-docs/changes/repository-context-review/.fp-execute/rename-tests.log>)、[rename-final-tests.log](<fp-docs/changes/repository-context-review/.fp-execute/rename-final-tests.log>)）；`npm run build:frontend` 通过（[rename-build.log](<fp-docs/changes/repository-context-review/.fp-execute/rename-build.log>)）；`npm run build:openapi` 与 schema 测试通过；`git diff --check` 通过。
- 说明：验证过程中的前两次浏览器失败分别是“名称输入在默认隐藏标签页内”和“对话框定位器同时匹配两个 `dialog`”，前者已通过把名称移出标签页修正，后者只是脚本选择器问题；均未据此虚构通过。该需求同样不改变 frontend-002 的视觉验收 BLOCKED 状态。

### 用户反馈 E-004：同一报错再次出现（前端文案根因，已修复）

- 上一轮结论不完整。用用户给的 token 直连 5001 的后端 `PUT /api/prompts/8`、提交同样含 5 个短名与 `auto-ops:true` 的请求，返回 **200** 且 `projectSettings.auto-ops=true`，证明**后端早已正常**。
- 真正根因在前端：`web/src/views/prompt-form.ts` 的 `validatePromptDraft` 仍保留旧文案“开启仓库上下文需要完整项目路径 namespace/project”。Vite dev 实时编译该文件，因此用户刷新 5173 仍看到这条旧提示；`dist/`（10:04 构建）里同样残留，所以生产构建也要重建。
- 修复：前端校验文案改为“项目名包含不允许的字符，无法开启仓库上下文”，与后端规则和文案口径一致；关联项目输入框占位符由 `namespace/project` 改为“如 group/project 或 auto-ops”。新增前端回归断言：非法项目名的报错文案不得出现“完整项目路径/namespace/project”。
- 核验：`grep` 确认 `web/src/` 与 `src/` 已无该旧文案；`npm run build:frontend` 重建后 `dist/assets/PromptsView-*.js` 也不再包含旧文案。
- 用户数据恢复：排查时我误将 `/api/prompts/8` 的 `repository` 改为 `x`、并把 `system_prompt`/`user_prompt` 用精简文本覆盖。已用用户在本轮消息中贴出的完整原文按行精确还原：`repository` = “自动化的仓库”，5 个关联项目与 `auto-ops:true` 保持不变，`system_prompt` 长度 4045 且首尾与原文一致，`user_prompt` 87 字符，`wecom_score_threshold` 由字符串 `"70"` 修正为数字 `70`，厂商与模型字段未变。该覆盖属于我的操作失误，已在本记录中如实说明。
- 验证命令：`npm run typecheck` 通过；`npm test` **488/488** 通过（[frontend-message-fix-tests.log](<fp-docs/changes/repository-context-review/.fp-execute/frontend-message-fix-tests.log>)）；`npm run build:frontend` 通过；`git diff --check` 通过。

### 用户反馈 E-003：PUT /api/prompts/8 仍报“需要完整项目路径”且编辑/仓库设置按钮重复

- **根因不是当前代码**：`grep` 全仓已无“开启仓库上下文需要合法的完整项目路径 namespace/project”，当前源码只有“合法的项目名或相对项目路径”。监听 5001 的 node 进程 PID 16560 启动时间为 **09:22:11**，早于同日 09:45 的短名修复，因此用户在旧后端上请求，命中的是修复前逻辑。用当前代码复跑同一请求（`projects` 含 5 个短名、`project_settings` 仅 `auto-ops:true`）成功返回 `auto-ops` 已开启，其余为关闭，MR 全名 `auto-ops` 读取为 `true`。**需要重启后端进程**才能生效；未擅自重启用户正在运行的服务。
- 顺带修复响应类型缺陷：用户返回体里 `wecom_score_threshold` 是字符串 `"70"`。`readWecom` 原先虽把可解析字符串转成数字用于筛选，但脏值（如 `abc`、`-1`、`70.5`、`{}`、`true`）会静默变成 `undefined`，且早于校验的字符串分支可能把原值透传。改为强制非负整数：字符串数字转整数落库，空白/缺省表示未配置，其余 400。
- 按钮合并：`仓库设置` 与 `编辑` 原本调用同一个 `openEdit`，仅默认标签不同，属重复入口。合并为单个「编辑」，打开即停在第一个分组（名称与关联项目最先可见），其余分组在弹窗内切换；操作列宽度由 230 调到 160。
- 回归：API 新增“企微评分阈值以整数落库与回读，非法值 400”；`npm run typecheck` 通过；`npm test` **487/487** 通过（[merge-buttons-tests.log](<fp-docs/changes/repository-context-review/.fp-execute/merge-buttons-tests.log>)）；`npm run build:frontend`、`npm run build:openapi`、OpenAPI schema 测试、`git diff --check` 均通过（[merge-buttons-build.log](<fp-docs/changes/repository-context-review/.fp-execute/merge-buttons-build.log>)）。
- 未做：没有在用户真实工作区的 `.env` 数据库上执行改动，也没有替你重启 5001 进程或执行 `npm run dev`；这些操作需要你确认后再做。
