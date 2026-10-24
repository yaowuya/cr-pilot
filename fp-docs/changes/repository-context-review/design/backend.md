# 仓库上下文评审 — 后端技术设计

本设计扩展现有 MR 评审管线：项目明确开启后，获取固定版本的仓库，只向模型提供受限的只读工具。关闭时保留现有 diff 评审路径。范围依据为已通过写入后确认的 [提案](<fp-docs/changes/repository-context-review/proposal.md>)。

## 第一部分：架构决策

### 授权与方案比较

用户在本会话明确要求：“不需要再次询问我，直接使用你的最佳推荐，继续往下走”。因此，D-001 之后的新决策由代理依据这次委托选择，并自主完成设计、计划和实现；不再逐节等待答复。下表的 `user-confirmed` 表示用户明确授予选择权，不表示用户逐项人工选中了每个实现细节。写入及继续推进也以此最新指令为依据，不伪造逐项答复。

| 方案 | 能力与代价 | 结论 |
| --- | --- | --- |
| 拉取目录后沿用无工具会话 | 改动少，但模型无法读取目录，不能满足上下文验收 | 不采用 |
| 每任务浅克隆、固定 Git 对象、三种受限读取工具 | 无长期共享仓库；增加 Git 适配和只读端口，支持测试隔离和明确清理 | 采用，满足当前需求的最简单完整方案 |
| 长期仓库缓存与检索索引 | 可降低重复克隆成本，但增加锁、失效、版本回收与跨任务隔离 | 当前无性能证据，不采用 |

### Decision Ledger

| ID | Decision | Source | Blocking | Status | Evidence / explicit confirmation |
| --- | --- | --- | --- | --- | --- |
| D-002 | 独立项目配置表保存开关；规范保存在 Prompt | 本会话自主推进授权；[表结构](<src/infrastructure/sqlite/database.ts#L48-L63>) | yes | `user-confirmed` | D-002：依据“直接使用你的最佳推荐”选择项目唯一状态，避免多 Prompt 关联产生不同开关；属于委托选择。 |
| D-003 | 最后一个精确关联删除时清除开关，重新关联默认关闭 | 本会话自主推进授权；提案 P-007 | yes | `user-confirmed` | D-003：依据自主推进授权采用安全关闭生命周期；未声称存在单独用户答复。 |
| D-004 | 开关沿命中 Prompt 的最具体关联读取，兼容存量短项目名 | 本会话自主推进授权；实现反馈 E-001（用户截图报告开关无法开启）；[既有解析](<src/infrastructure/sqlite/prompt-repo.ts#L159-L188>) | yes | `user-confirmed` | D-004：初版“仅完整路径可开启”被真实旧数据证伪（存量配置全是 `auto-ops` 等短名，开关全部禁用），按用户截图反馈改为兼容短名；仓库地址仍取 MR 源项目 API，绝不用配置名拼 URL。 |
| D-005 | 扩展原 Prompt API，新增字段省略保留，项目条目采用部分更新 | 本会话自主推进授权；[路由](<src/interfaces/http/api/prompts.ts#L136-L204>) | yes | `user-confirmed` | D-005：依据自主推进授权选择兼容扩展、原子保存和严格新字段校验。 |
| D-006 | 开启路径使用固定 diff version 与 head SHA，源仓库从 MR 元数据确认 | 本会话自主推进授权；提案 P-002、P-004 | yes | `user-confirmed` | D-006：依据自主推进授权选择版本快照；不同版本不能拼成一次评审。 |
| D-007 | 无工作树浅克隆；同源 HTTP(S) URL、环境内授权头、不跟随重定向 | 本会话自主推进授权；提案 P-003 | yes | `user-confirmed` | D-007：依据自主推进授权选择凭据不入 URL、参数、日志或模型的 Git 方式。 |
| D-008 | 从固定提交 Git 对象提供 list/read/search，拒绝符号链接、敏感文件和二进制 | 本会话自主推进授权；提案只读边界 | yes | `user-confirmed` | D-008：依据自主推进授权选择三种有界工具，不开放 shell/edit/write。 |
| D-009 | 克隆、磁盘、索引、读取和工具输出均设硬上限 | 本会话自主推进授权；提案资源风险 | yes | `user-confirmed` | D-009：依据自主推进授权采用下文具体限额；限额失败明确报告，不伪装完整读取。 |
| D-010 | 新上下文会话保持空 cwd，采用无发现资源加载器与内存 settings | 本会话自主推进授权；[SDK 接口](<node_modules/@earendil-works/pi-coding-agent/dist/core/sdk.d.ts#L26-L58>) | yes | `user-confirmed` | D-010：依据自主推进授权选择白名单工具及无扩展加载，防止仓库配置触发执行。 |
| D-011 | 每任务只准备一次仓库，批次复用，所有退出路径等待终止并清理 | 本会话自主推进授权；[管线](<src/application/review-pipeline.ts#L464-L575>) | yes | `user-confirmed` | D-011：依据自主推进授权选择 try/finally 生命周期，保留原有批次重试和汇总。 |
| D-012 | 增量加表加列；停写一致性备份；不自动执行破坏性回退 | 本会话自主推进授权；[数据库初始化](<src/infrastructure/sqlite/database.ts#L152-L190>) | yes | `user-confirmed` | D-012：依据自主推进授权选择可重复迁移和旧数据全关；只验证隔离测试库。 |
| D-015 | 双端 small form 加直接索引，无覆盖、迁移或删除 | 本会话自主推进授权；当前 slug 的路径检查 | yes | `user-confirmed` | D-015：依据自主推进授权新建 design/00-index.md、design/backend.md、design/frontend.md；所有目标原先不存在。 |
| D-016 | 原生 Node 测试、类型检查与前端构建，外部副作用使用隔离替身 | 本会话自主推进授权；[脚本](<package.json#L10-L15>) | yes | `user-confirmed` | D-016：依据自主推进授权选择现有验证工具；不要求真实 GitLab、模型调用或部署作为本地验证前提。 |
| D-017 | 仓库规范仅在开启路径加入批次及汇总；输出契约由管线最终追加 | 本会话自主推进授权；提案 P-005、P-006 | yes | `user-confirmed` | D-017：依据自主推进授权选择分区提示与明确优先级，关闭不改变旧 Prompt。 |

### Pre-write Confirmation Evidence

- Covered IDs: `D-002`, `D-003`, `D-004`, `D-005`, `D-006`, `D-007`, `D-008`, `D-009`, `D-010`, `D-011`, `D-012`, `D-015`, `D-016`, `D-017`
- Outstanding blocking decisions: `none`
- Explicit user authorization to write: 2026-10-23 本会话原文“不需要再次询问我，直接使用你的最佳推荐，继续往下走”。代理据此选择上表推荐、本文各节和 small form，写入本文件及 [设计索引](<fp-docs/changes/repository-context-review/design/00-index.md>)、[前端设计](<fp-docs/changes/repository-context-review/design/frontend.md>)；没有转换或移除动作。此为明确委托，不是虚构的逐节或逐 ID 人工确认。
- 上游已确认：提案 P-001～P-008 及 `proposal-postwrite-confirmation`；视觉 D-001 由前端 owner 持有。

## 第二部分：技术方案详述

### 设计范围适用性

| 评审范围 | 要求 | Canonical owner section | 证据或不适用理由 |
| --- | --- | --- | --- |
| 架构主线 | 必填 | #架构主线 | 提案中的可选上下文评审 |
| 核心对象与职责 | 必填 | #核心对象与职责 | 现有分层、管线与 Reviewer 端口 |
| 数据模型 | 适用 | #数据模型 | 新增项目开关与仓库规范 |
| 状态、并发与执行流程 | 适用 | #状态并发与执行流程 | 克隆和模型会话拥有外部资源 |
| 接口、权限与兼容边界 | 适用 | #接口权限与兼容边界 | Prompt 管理 API 与 GitLab API |
| 前端方案 | 不适用 | N/A | 由前端设计独占，本端只定义接口 |
| 风险、迁移、发布、回滚与监控 | 必填 | #风险迁移发布回滚与监控 | 凭据、版本、磁盘和升级风险 |
| 验证方案 | 必填 | #验证方案 | 原生 Node 测试和类型检查 |

### 架构主线

沿用 `interfaces → application → domain` 依赖方向，IO 仍由 infrastructure 实现、bootstrap 注入。HTTP 保存配置；管线开始时读取一次 Prompt 与项目开关，形成该任务的配置快照。关闭走原有流程；开启则取得固定 MR 版本、准备仓库、分批评审、汇总、回写与通知，最后释放仓库。

新增两个真正需要隔离的边界：Git 仓库准备端口隔离子进程/网络/磁盘，仓库读取端口限制模型能力并支持无网络测试。不增加缓存服务、插件注册框架、后台清理守护进程或第二套任务队列。

### 核心对象与职责

| 对象/模块 | 职责 | 不负责 | 协作对象 | 证据 |
| --- | --- | --- | --- | --- |
| PromptRepository | 原子保存 Prompt、关联和项目设置；返回精确启用状态 | Git、模型调用 | API、pipeline | [现有仓储](<src/infrastructure/sqlite/prompt-repo.ts>) |
| GitlabClient | 提供固定版本 diff、refs 和源仓库元数据 | 克隆、文件读取 | pipeline | [现有 API](<src/infrastructure/gitlab/gitlab-client.ts#L130-L189>) |
| RepositoryProvider（新增端口） | 根据可信快照准备只读仓库能力，返回幂等 dispose | Prompt 解析、评审输出 | Git adapter、pipeline | D-007～D-011 |
| RepositoryReadAccess（新增端口） | 返回有界 list/read/search 结果 | 暴露绝对路径、凭据、执行接口 | 模型自定义工具 | D-008 |
| ReviewPipeline | 配置快照、版本一致性、生命周期、原有结果处理 | Git 命令实现 | 上述端口 | [管线](<src/application/review-pipeline.ts#L352-L693>) |
| PiReviewer | 选择模型、无发现会话、工具白名单、取消等待 | 获取 token、选择源仓库 | read access | [会话接口](<src/infrastructure/pi/reviewer.ts#L26-L46>) |

### 后端模块设计

- 新增 `src/domain/repository-context.ts`：快照、准备输入、只读访问、分页/截断结果与资源释放契约。公开对象写明职责、限额和异常语义。
- 新增 `src/infrastructure/git/repository-context.ts`：安全 Git 参数与环境、临时裸数据目录、固定提交树、限额、进程终止与清理。
- 新增 `src/infrastructure/pi/repository-tools.ts`：只将域端口封装为 `repo_list`、`repo_read`、`repo_search`；输入 schema 使用 SDK 已有依赖，不引入新包。
- 修改 [review-task.ts](<src/domain/review-task.ts>)、[reviewer.ts](<src/infrastructure/pi/reviewer.ts>) 和 [review-pipeline.ts](<src/application/review-pipeline.ts>)：可选能力注入，关闭与未注入路径保持原行为。
- 修改 [review-prompt.ts](<src/domain/review-prompt.ts>)、[database.ts](<src/infrastructure/sqlite/database.ts>)、[prompt-repo.ts](<src/infrastructure/sqlite/prompt-repo.ts>)、[prompts.ts](<src/interfaces/http/api/prompts.ts>)：配置契约、迁移及校验。
- 修改 [bootstrap.ts](<src/bootstrap.ts>)、[config.ts](<src/shared/config.ts>)、[Dockerfile](<Dockerfile>)、[README](<README.md>) 及配置样例：装配、克隆超时和 Git 运行要求；不启动实际服务或构建容器。

### 数据模型

#### 完整字段定义

本表是新增存储字段的唯一详细定义，不再重复 SQL 模型代码。旧字段保持原定义。

| 字段 | 类型 | 必填/空值 | 默认值 | 关联/约束 | 证据 |
| --- | --- | --- | --- | --- | --- |
| review_prompts.repository_standards | TEXT | NOT NULL；允许空字符串 | '' | 每条 Prompt 一份，应用限制 32,000 字符 | D-002、D-009；提案 P-005、P-006 |
| project_review_settings.project | TEXT | NOT NULL | 无 | PRIMARY KEY；保存 trim/toLowerCase 配置键（短名或相对全名） | D-002、D-004 |
| project_review_settings.repository_context_enabled | INTEGER | NOT NULL | 0 | CHECK IN (0,1) | D-002；提案 P-007 |
| project_review_settings.updated_at | INTEGER | NOT NULL | 无 | Unix 毫秒，仅设置实际改变时更新 | D-002、D-003 |

#### 字段与存储取舍

| 字段/数据 | 候选表示 | 最终选择 | 数据体积与读取方式 | 选择理由 | 证据 |
| --- | --- | --- | --- | --- | --- |
| 仓库规范 | TEXT / JSON 分项 / 外部文件 | TEXT | 详情和评审按 Prompt 读取；列表只给是否填写 | 自由文本规范，无分项查询需求 | P-005、D-002 |
| 项目开关 | 关联行列 / 独立项目表 | 独立项目表 | 精确项目键一次查询；列表按关联返回状态 | 同项目可关联多 Prompt，不能存在互相矛盾的开关 | [既有重复关联测试](<test/infrastructure/sqlite/prompt-repo.test.ts#L201-L206>) |

#### 逻辑模型与物理存储

| 逻辑对象 | ORM/Schema 对象 | 物理表或存储 | 主键与关联键 | 证据 |
| --- | --- | --- | --- | --- |
| 共享评审规则 | StoredPrompt / PromptInput | review_prompts | id；沿用 prompt_projects 关联 | [领域模型](<src/domain/review-prompt.ts#L12-L61>) |
| 项目执行设置 | ProjectReviewSetting | project_review_settings | 完整路径字符串；不外键到任一 Prompt | D-002 |
| 临时仓库 | RepositoryProvider 返回的 handle | 系统临时目录下任务唯一目录 | 随机目录；不持久化 token | D-007、D-011 |

#### 继承字段与重复存储结论

项目使用原生 DatabaseSync，无 ORM、基类、manager 或 mixin。规范不复制进每个项目；项目开关不复制进关联表。现有审计时间 updated_at 不新增另一份 Prompt 时间字段。

#### 索引、约束与软删除

新表仅需主键索引，查询不按布尔值过滤排序，不增加布尔索引。旧 prompt_projects 的复合主键、project 索引和 ON DELETE CASCADE 保留，不加 project 唯一约束，不改变多对多模型。硬删除沿现状；没有软删除或发布/草稿状态。

#### 查询模式与索引映射

| 查询模式 | 过滤/排序/关联字段 | 对应索引或访问路径 | 选择理由 | 证据 |
| --- | --- | --- | --- | --- |
| 任务是否开启 | MR 全名 → 命中 Prompt 的关联键（精确或后缀，最长优先） | 复用既有 resolve 访问路径，再按最佳匹配键查新表主键 | 兼容存量短名，且不跨 Prompt 继承开关 | D-004 |
| 详情/摘要项目设置 | Prompt 的 projects → 精确项目键 | 既有关联按 prompt_id 访问，新表按主键访问 | 配置集合小，复用现有读取，不引入缓存 | [仓储](<src/infrastructure/sqlite/prompt-repo.ts#L64-L105>) |
| 最后一次解绑清理 | 受影响的 project → 剩余关联 | 既有关联扫描并使用同一归一化函数判等 | 保持旧大小写/空白兼容；只在配置写入时执行 | D-003 |

#### 生命周期数据归属

项目开关跨 Prompt 共享。修改某条 Prompt 的项目设置会更新同一项目的全局名称级状态，页面明确提示。关联仍存在时普通保存保留开关；最后一个关联移除时删除设置行；重新关联没有设置则关闭。删除 Prompt 同事务清理孤立设置。default 没有关联，不允许借 default 创建启用项。

同名项目在不同 GitLab 实例仍共享名称级配置，这是当前产品身份模型的边界，不宣称租户隔离。实际拉取始终使用任务实例、源项目与该任务 token，不共享仓库或凭据。新增启用接受合法项目短名或相对路径（至少一段）；拒绝 URL、空段、`.`、`..`、反斜杠、控制字符和选项前缀。存量短名直接可用，无需先补全完整路径；匹配规则见上表，精确或更长的关联优先。

#### Migration 影响

新库和旧库都得到相同字段/默认值；旧数据规范为空、新表无记录，因此不会自动开启。沿 `PRAGMA table_info` + `ALTER TABLE ADD COLUMN` 方式幂等补列，新表用 IF NOT EXISTS；本次迁移用事务避免半完成。新表无必要的 Prompt 外键，应用在配置事务中维护关联存在性。

#### 技术栈专项结论

DatabaseSync 同步单连接不等于多语句原子。create/update/remove 必须用同步事务包住本体、关联、设置和孤立清理；异常 rollback。导入单条记录同样原子，已存在的 Prompt 仍跳过，不覆盖规范或开关。不引入 ORM 或 migration 框架。

### 状态、并发与执行流程

1. `run()` 开始即解析 Prompt、共享规范和精确项目开关，后续不再查动态配置；配置读取失败明确记失败，不静默开启/关闭。
2. **关闭**：继续当前 changes/commits/version 调用、分批、重试、汇总、行内评论和通知，不准备仓库、不传读取工具、不追加规范。
3. **开启**：调用新增可选端口 `getRepositoryReviewSnapshot`。读取 MR 详情的 source_project_id、source_branch、sha，再取与该 sha 一致的版本条目及 `/versions/:version_id` 内容。使用该版本的 diffs、base/start/head refs；获取源项目的 http_url_to_repo。最后复核 MR 身份和 head 未变化；变化则本次失败，不混用数据。提交摘要也在此固定窗口内读取。
4. 快照缺必要字段、diff 溢出/被截断、版本不一致、源项目无权限或实例 URL 非法均在模型调用前失败。fork 从源项目拉取，不从目标项目猜路径；源分支来自 MR API，不信任 shell 字符串拼接。
5. RepositoryProvider 以独立总超时准备仓库：`clone --progress --single-branch --depth 1 --no-tags --no-checkout --branch=<branch> -- <url> <tempRepo>`。不用 sparse checkout，也不递归 submodule。核对 HEAD；不等于预期 SHA 时仅额外浅 fetch 一次该 SHA，随后用完整 SHA 解析 commit/tree；不可得即失败。
6. 批次沿原有重试策略执行，同一次 MR 共享只读 handle；每次模型会话独立工具预算。规范非空才加入命名分区；只读安全提示固定追加，行内结构契约最后追加。汇总加入同一规范，但不开放仓库工具，不再次克隆。
7. 成功后沿原有行内回写、总评、通知、记录路径。仓库准备失败不发布不完整评审。任务外层 `finally` 释放 handle，覆盖空变更、批次失败、汇总失败、评论失败和记录写入异常。
8. abort 后先终止 Git 子进程并等待 close，模型会话调用并等待 SDK abort，再 dispose；会话创建期间取消也在创建完成后立即终止，不能漏挂监听。清理应幂等；清理异常日志单独报告，不遮盖原始失败或撤销已发评论。

#### Git 与读取安全契约

Git 调用使用 spawn/execFile 参数数组，`shell:false`。完整 SHA 校验为 Git 十六进制对象 ID，分支拒绝控制字符和非法 ref。仓库 URL 必须无 userinfo/query/fragment，协议仅 HTTP(S)，与任务有效 GitLab 实例同 origin；HTTP 仅兼容已明确使用 HTTP 的实例，并在文档提示传输风险。禁止重定向，不将 token 发往 API 返回的其他域名。

凭据通过子进程专用环境内的 URL 限定 Authorization Basic 头注入，用户名为 oauth2；不放命令参数、remote URL、配置文件或模型。清除继承的 Git/SSH/trace/config 注入变量，禁全局/系统配置、凭据助手和交互；空模板与 hooks 目录、禁 fsmonitor、禁非 HTTP(S) 协议。Git stderr 只用于内存分类，错误对外用固定分类文案，不输出原文或 headers。TLS 校验默认开启；仅沿用显式部署 `GITLAB_INSECURE_TLS` 选择并保留风险提示，不自动降级。

不检出工作树。从固定树的 `git ls-tree -r -l -z <sha>` 构建受限清单，仅读取普通 blob（100644/100755）。symlink、submodule、目录和清单外路径不可读。`repo_read`/`repo_search` 只用清单中的对象 ID 调用 `git cat-file blob`，不把模型路径交给文件系统或任意 Git revision；因此 `../`、绝对路径和符号链接不能越界。

拒绝读取 `.git`、`.pi`、`.ssh`、`.aws`、`.env` 与 `.env.*`、`.npmrc`、`.netrc`、`.pypirc`、私钥/证书容器及常见 credentials/secret 文件；跳过 node_modules、vendor、dist、build、coverage 等生成或依赖目录。UTF-8 解码失败、含 NUL 或 Git LFS 指针时返回不可用原因；不自动安装 LFS 或下载子模块。路径过滤保护常见敏感文件，但不承诺识别任意源码中硬编码的密钥，部署方仍需具备把项目源码交给模型的权限。

#### 限额与只读接口

以下是本次委托选定的初始安全边界，不声称来自性能实测。实现以导出常量和可注入测试参数表达；不为每项增加页面设置。

| 边界 | 限额及行为 |
| --- | --- |
| 准备总超时 | 默认 120,000 ms；新增环境 `REPOSITORY_CLONE_TIMEOUT_MS` 可配置正整数，涵盖 clone、补 fetch 和索引 |
| 仓库数据 | 默认 512 MiB；clone/fetch 过程中有界周期检查，超限终止并清理；可能有一次采样间隔的超量，不宣称硬磁盘配额 |
| 文件清单 | 最多 50,000 普通文件；索引输出也设字节上限；超出准备失败，不静默截断 |
| 单文件 | 最多 256 KiB；大文件读取返回明确拒绝，避免模型输入无限膨胀 |
| list | 可选路径前缀/名称片段、cursor；最多 200 条，返回 nextCursor/truncated |
| read | 清单路径、1-based startLine、最多 200 行；输出最多 16,000 字符并说明截断 |
| search | 字面量非空 query，最长 200 字符；可选路径前缀、cursor；每次最多 200 文件/4 MiB、50 命中、16,000 字符；返回扫描游标与截断原因 |
| 模型会话 | 最多 40 次仓库工具调用、累计 128,000 字符工具输出；达到预算显式报告，模型不得声称已遍历全部代码 |
| 仓库规范 | 最多 32,000 字符；空白规范按空串保存；API 严格校验，UI 同上限 |

所有工具使用当前会话与任务取消信号；长循环定期检查取消。模型只能看相对路径、行号、内容和截断说明，看不到临时绝对路径、URL 凭据或 Git 配置。

#### SDK 隔离

新上下文模式保持空 SDK cwd，并使用实现 `ResourceLoader` 最小接口的无发现加载器：system prompt 显式提供；扩展、skills、模板、主题、AGENTS 和 append prompt 均为空，reload 不执行发现。使用 `SettingsManager.inMemory()` 和 `SessionManager.inMemory()`，模型认证仍由既有受信 agentDir/ModelRuntime 提供。

内存 settings 只复制受信服务端配置中的默认 provider/model、thinking 等模型选择字段，保持旧默认选择；不得复制 packages、extensions、MCP 或 defaultTools。显式传入 provider/model 时仍沿原有优先级。

`createAgentSession` 明确设置 `tools: ["repo_list", "repo_read", "repo_search"]`、`excludeTools: ["mcp__*"]` 和对应 customTools；不能只给现有 `noTools:"all"` 添加 customTools。SDK 原生工具、MCP、扩展不得出现在有效工具列表。旧无上下文会话可保留既有加载方式，避免影响现有模型设置；任何共享取消修复均做回归。

证据：[SDK 工具与 settings 接口](<node_modules/@earendil-works/pi-coding-agent/dist/core/sdk.d.ts#L26-L58>)、[ResourceLoader 接口](<node_modules/@earendil-works/pi-coding-agent/dist/core/resource-loader.d.ts#L32-L62>)。DefaultResourceLoader 会执行资源包 resolve，不能仅把 cwd 改成仓库后认为安全。

### 接口、权限与兼容边界

继续使用原 `/api/prompts` CRUD，统一 Bearer 认证；普通已登录账号仍可管理，不能突然改为管理员专属。错误格式仍为 `{error:string}`，新增类型/范围/非法关联错误 400；原有 401、404、409 保持。

| 方向 | 新字段 | 精确语义 |
| --- | --- | --- |
| POST/PUT | `repository_standards?: string` | 创建省略为空；更新省略保留；显式空串清空；非字符串或超限拒绝 |
| POST/PUT | `project_settings?: {project:string, repository_context_enabled:boolean}[]` | 部分更新；省略整个字段或某项目条目保留旧值；新增项目未提供设置默认关 |
| 详情 | `repositoryStandards: string` | 完整规范，不改变原 systemPrompt/userPrompt |
| 详情/列表 | `projectSettings: {project:string, repositoryContextEnabled:boolean}[]` | 对该 Prompt 的全部关联返回设置，未开启为 false；短名与完整路径同等可启用 |
| 列表 | `hasRepositoryStandards: boolean` | 不返回规范正文，避免列表体积变大 |
| GET /meta | `projectSettings: {project:string, repositoryContextEnabled:boolean}[]` | 所有已知关联项目的当前状态；供新增关联显示，不包含规范正文或凭据 |

project_settings 项目必须属于保存后的 projects；归一化重复条目、非布尔值、未知项目或 default 非空条目一律拒绝。旧 projects 字符串数组/逗号串兼容；PUT 缺 projects 透传 undefined 保留关联，显式 [] 才解绑，修正当前路由把缺字段变 [] 的损失行为。既有可选模型/通知字段语义不顺手改写。

一次事务完成本体、关联、部分设置、孤立清理。新增关联只能读取同一完整项目已有状态，不会因为别的项目启用而开启。允许某项目同时关联多 Prompt，沿旧 resolve 选择规则；开关不随被选中的 Prompt 改变，共享规范仍取实际命中的 Prompt。

GitlabClient 新增 snapshot 方法可选，以兼容现有替身；仅开启路径要求它存在，缺失时明确失败。新增 RepositoryProvider 与 PromptRepository 查询方法同样在关闭路径不强制触发。前端请求字段与验证 owner 为本节，布局详见 [前端设计](<fp-docs/changes/repository-context-review/design/frontend.md>)。

### 风险、迁移、发布、回滚与监控

| 具体失败场景 | 影响 | 预防或处理 | 发布/回滚/监控安排 | 证据 |
| --- | --- | --- | --- | --- |
| token 无 Git 读取权限、Git 不可用、网络超时 | 开启项目评审失败 | 准备阶段失败即记录，不降级 | Docker runner 安装 git 与 CA；记录阶段/耗时/错误分类，不含凭据 | P-003、P-004 |
| 分支推进、fork 或 GitLab diff 截断 | 代码与 MR 不符或遗漏 | 固定版本内容和 SHA，必要字段/完整性校验 | 不发布伪完整结果；版本日志只记 SHA 与项目/MR | D-006 |
| 源码含提示注入、软链接或隐藏配置 | 越界读取或执行 | Git 对象清单、无发现 loader、工具白名单 | 负向测试，不把提示语当唯一防线 | D-008、D-010 |
| 多表保存中途失败 | 部分配置落库 | 同步事务回滚 | 故障注入验证原值不变 | D-005、D-012 |
| 准备超量或取消未结束 | 磁盘残留、进程继续运行 | 有界监控、kill 后等 close、finally 清理 | 清理失败单独告警；系统强杀无法保证 finally，部署需清理遗留前缀目录 | D-009、D-011 |
| 升级/回退时数据丢失或状态复活 | 配置不一致 | 停止写入并关闭连接后制作一致性备份 | 不自动复制运行中的单个 DB 文件；不自动 DROP；回退前关闭新开关 | D-012 |
| 同名项目跨实例共享配置 | 两实例同名项目同时生效 | 明确名称级配置；实际任务与凭据不共享 | 跨实例精细设置属于后续身份模型改造，不冒充隔离保障 | D-004 |

发布顺序：备份 → 部署含 Git 的后端与新静态前端 → 幂等升级 → 验证默认关闭 → 选择授权项目开启。回退旧二进制忽略新表/列，但旧代码不会维护孤立设置；再次升级需清除无关联设置并只对仍有全名关联的项目返回启用。恢复数据库备份会同时丢失备份后写入，必须在停写窗口人工决定。

有意简化：不做持久仓库缓存，当前每 MR 独立克隆并复用其批次。适用上限为上文时限和数据限额；当实测同仓库克隆持续占主要耗时、导致队列延迟目标无法满足时，再设计按实例/仓库/版本隔离的缓存与锁。不得为了省代码取消现有安全边界。

### 验证方案

| 验证项 | 命令或操作 | 预期结果 | 覆盖结论 | 证据 owner |
| --- | --- | --- | --- | --- |
| DB/仓储/API | Node 原生测试对应 sqlite 与 http 测试 | 旧库升级两次、字段保值、独立开关、共享规范、孤立清理、事务失败、认证和 400/404/409 | D-002～D-005、D-012 | 本节 |
| GitLab 快照 | fetch 替身覆盖 fork、固定版本、变动 head、缺字段、截断、异源 URL | 只接受完整匹配版本，不发真实请求 | D-006 | 本节 |
| Git 准备 | 合成临时本地 Git 仓库配合可注入 transport/runner | 浅克隆参数、SHA 补取、凭据无泄漏、超时/超量/失败清理；生产不开放 file 协议 | D-007、D-009、D-011 | 本节 |
| 读取工具 | 合成 blob、软链接/submodule/敏感文件/二进制/大文件/异常路径 | 不越界、不执行、分页与预算真实可见 | D-008、D-009 | 本节 |
| SDK | 假 session + 对真实 SDK 类型/选项的离线验证 | 有效工具仅三种，空 cwd，无资源发现，取消等待后释放 | D-010、D-011 | 本节 |
| 管线回归 | `node --test test/application/review-pipeline.test.ts` 及新增 context 用例 | 关闭不拉取/无工具；开启只准备一次；所有退出清理，输出契约仍在 | D-011、D-017 | 本节 |
| 全量静态与回归 | `npm test`、`npm run typecheck`、`npm run build:frontend` | 无新增回归；失败须定位而非忽略 | D-016 | 本节 |

不访问真实凭据、业务数据库或 GitLab/模型。真实网络、容器构建和部署未验证时单独报告，不将单测等同真实环境通过。实现与测试同步写职责/安全注释，并在每个任务内自审 Q01～Q05；Vue 规范仅适用于 web。
