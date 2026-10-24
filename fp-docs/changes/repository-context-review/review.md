# 仓库上下文评审 — 开发设计评审

## 评审结论

**设计充分性通过，可以进入计划。** 双端设计覆盖配置归属、精确版本、受限读取、资源生命周期、页面状态和验证边界。通过不等于实现或真实环境验证通过；GitLab 固定版本接口、SDK 有效工具集和取消后的进程释放是实现阶段的重点证据。

用户已授权代理自主采用最佳推荐并继续，无需再次询问。决策中明确区分人工选择与委托选择，没有把委托伪称为逐项答复。

| 评审面 | 结论 | 设计依据 |
| --- | --- | --- |
| 决策 | 共 17 项；写入前阻塞项 17、非阻塞项 0；全部终态且无重复 ID | [后端台账](<fp-docs/changes/repository-context-review/design/backend.md#decision-ledger>)、[前端台账](<fp-docs/changes/repository-context-review/design/frontend.md#decision-ledger>) |
| 数据 | 增量字段与独立项目设置表，旧数据默认关闭 | [数据模型](<fp-docs/changes/repository-context-review/design/backend.md#数据模型>) |
| 接口 | 原 Prompt API 兼容扩展，新增字段保值与原子保存 | [接口边界](<fp-docs/changes/repository-context-review/design/backend.md#接口权限与兼容边界>) |
| 前端 | 保留入口与列表，分组编辑并防止过期响应覆盖 | [前端方案](<fp-docs/changes/repository-context-review/design/frontend.md#前端设计>) |
| 不做事项 | 不扫描无关历史问题、不执行目标代码、不建设长期缓存或改造账号体系 | [架构主线](<fp-docs/changes/repository-context-review/design/backend.md#架构主线>) |

## 业务和技术主线

保存配置后，下一次任务读取自己的配置快照。关闭项目仍使用原 diff 路径；开启项目先取得一致的 MR 版本，再浅克隆并固定提交，供批次评审查阅相关文件。准备失败即终止；模型批次与汇总仍遵守原有输出和通知链路，所有结束路径都释放临时资源。

新复杂度集中在 Git 准备和只读访问两个边界，它们分别服务外部 IO 隔离和模型能力限制。沿用现有分层、SQLite、队列、SDK 和 Element Plus，没有为了未来需求增加缓存平台或插件体系。

## 核心对象与职责

| 对象/模块 | 职责 | 不负责 | 协作对象 | 设计依据 |
| --- | --- | --- | --- | --- |
| PromptRepository | 原子配置与项目开关查询 | 网络和评审 | API、管线 | [核心对象](<fp-docs/changes/repository-context-review/design/backend.md#核心对象与职责>) |
| GitlabClient / RepositoryProvider | 一致版本元数据与仓库准备 | 页面与评审结论 | 管线 | [执行流程](<fp-docs/changes/repository-context-review/design/backend.md#状态并发与执行流程>) |
| RepositoryReadAccess / PiReviewer | 固定对象有界读取与会话隔离 | 任意执行、任意路径读取 | 模型自定义工具 | [安全契约](<fp-docs/changes/repository-context-review/design/backend.md#git-与读取安全契约>) |
| PromptsView / prompt-form | 草稿、分组、差量设置和可靠反馈 | 服务端权限保障 | 现有 client/editor | [前端对象](<fp-docs/changes/repository-context-review/design/frontend.md#核心对象与职责>) |

## 数据模型评审

### 完整字段定义

以下字段事实摘自后端唯一 owner，不额外生成模型代码。

| 字段 | 类型 | 必填/空值 | 默认值 | 关联/约束 | 设计依据 |
| --- | --- | --- | --- | --- | --- |
| review_prompts.repository_standards | TEXT | NOT NULL；允许空字符串 | '' | 每条 Prompt 一份，应用限制 32,000 字符 | [字段定义](<fp-docs/changes/repository-context-review/design/backend.md#完整字段定义>) |
| project_review_settings.project | TEXT | NOT NULL | 无 | PRIMARY KEY；保存 trim/toLowerCase 配置键（短名或相对全名） | 同上 |
| project_review_settings.repository_context_enabled | INTEGER | NOT NULL | 0 | CHECK IN (0,1) | 同上 |
| project_review_settings.updated_at | INTEGER | NOT NULL | 无 | Unix 毫秒，仅设置实际改变时更新 | 同上 |

### 物理存储、继承与重复存储

| 逻辑对象 | 物理表/存储 | 继承字段来源 | 主键与关联键 | 重复存储结论 |
| --- | --- | --- | --- | --- |
| 规范 | review_prompts | 无 ORM 继承 | 原 Prompt id | 不复制到项目 |
| 开关 | project_review_settings | 无 | 归一化项目全名 | 多 Prompt 共享同一项目状态 |
| 评审仓库 | 随机临时目录 | 无 | 每任务独立 | 不跨任务共享凭据或目录 |

### 字段与存储取舍

| 字段或存储选择 | 最终方案 | 主要取舍 | 项目证据 |
| --- | --- | --- | --- |
| 规范文本 | 单段 TEXT | 无分项查询需求；列表不给正文 | [存储取舍](<fp-docs/changes/repository-context-review/design/backend.md#字段与存储取舍>) |
| 开关归属 | 项目设置表 | 比关联列多一张表，但不产生同项目多状态 | [生命周期](<fp-docs/changes/repository-context-review/design/backend.md#生命周期数据归属>) |

### 查询模式与索引映射、约束与迁移

| 查询模式 | 过滤/排序/关联字段 | 索引或访问路径 | 设计依据 |
| --- | --- | --- | --- |
| 是否启用 | 归一化完整项目键 | 新表主键 | [索引映射](<fp-docs/changes/repository-context-review/design/backend.md#查询模式与索引映射>) |
| Prompt 详情 | prompt_id → projects → 项目设置 | 既有关联访问加新主键查询 | 同上 |
| 最后解绑清理 | 受影响项目剩余关联 | 配置写入时归一化检查 | 同上 |

不新增项目全局唯一关联，不改变原 Prompt 多对多行为。没有软删除；迁移必须保留旧数据并可重复运行，多表修改必须原子提交。

## 状态、并发和执行流程

评审的关键状态是配置快照、MR 快照、仓库准备、批次/汇总、回写和资源释放。重点核对“分支在准备期间推进”与“取消发生在会话创建期间”的交错：前者不得混用 SHA，后者必须等真正停止才清理。前端则以请求序号保护当前编辑意图，并只提交实际改动的项目开关。[执行 owner](<fp-docs/changes/repository-context-review/design/backend.md#状态并发与执行流程>)、[页面状态 owner](<fp-docs/changes/repository-context-review/design/frontend.md#状态并发与执行流程>)。

## 接口、权限和旧入口隔离

| 接口/入口 | 主键或资源 | 权限 | 兼容或隔离边界 | 设计依据 |
| --- | --- | --- | --- | --- |
| Prompt CRUD/meta | Prompt id、完整项目名 | 现有登录认证 | 新字段可选；省略保留；default 不创建启用项 | [API owner](<fp-docs/changes/repository-context-review/design/backend.md#接口权限与兼容边界>) |
| GitLab snapshot | 任务实例、MR、版本、源项目 | 当前任务 token | 固定版本；禁止跨 origin 携凭据 | [Git 契约](<fp-docs/changes/repository-context-review/design/backend.md#git-与读取安全契约>) |
| 模型工具 | 固定树内的相对路径/游标 | 只读能力白名单 | 无 shell/write、无扩展发现、无任意文件系统访问 | [SDK 隔离](<fp-docs/changes/repository-context-review/design/backend.md#sdk-隔离>) |

## 前端方案

页面保持 `/prompts`，将项目执行方式、原 Prompt、仓库规范与模型通知分组。共享规则和独立开关的区别必须在文字与状态中明确，不能只靠颜色。长项目名、规范、窄屏和亮暗主题由 [Visual Checks](<fp-docs/changes/repository-context-review/design/frontend.md#visual-checks>) 验证；没有设计稿，不声称像素级还原。

## 主要风险、迁移、发布和验证

### 主要风险

| 具体失败场景 | 影响 | 预防或处理 | 设计依据 |
| --- | --- | --- | --- |
| diff 与克隆提交错位 | 产生错误评审证据 | 固定版本和完整 SHA，不可得即失败 | [状态流程](<fp-docs/changes/repository-context-review/design/backend.md#状态并发与执行流程>) |
| 不可信仓库配置或路径 | 执行/读取越界 | 无 checkout、无发现 loader、清单 blob 读取 | [安全契约](<fp-docs/changes/repository-context-review/design/backend.md#git-与读取安全契约>) |
| 超大仓库或取消残留 | 磁盘与进程资源泄漏 | 有界准备、终止等待、finally、清理日志 | [限额](<fp-docs/changes/repository-context-review/design/backend.md#限额与只读接口>) |
| 关联删除后残留状态 | 重关联意外开启 | 最后关联删除时清理；再次升级检查有效关联 | [生命周期](<fp-docs/changes/repository-context-review/design/backend.md#生命周期数据归属>) |
| 同名项目跨实例 | 配置无法区分两个项目 | 明示名称级配置边界，仓库与 token 不跨任务共享 | [风险 owner](<fp-docs/changes/repository-context-review/design/backend.md#风险迁移发布回滚与监控>) |

长期仓库缓存和前端测试框架暂不引入。重访条件分别是实测克隆成为队列瓶颈，以及需要 CI 持续覆盖组件/视觉；设计已经记录升级方向，不能用这项简化削减安全或状态验证。

### 迁移与发布

停写并制作一致性备份后部署后端和静态前端，默认全关再小范围开启。旧后端不会管理新状态，回退前应关闭开关；不自动删表或恢复真实数据库。Git/CA 需要进入 runner 镜像，实际容器构建与企业 GitLab token scope 必须区别于离线测试证据。

### 验证清单

- [ ] 旧库升级、重复升级、开关保值、最后解绑、事务故障和认证 API 测试通过。
- [ ] 固定版本/fork/分支推进、浅 fetch、Git 参数/环境、超时/限额/清理的离线测试通过。
- [ ] 工具越界、敏感路径、软链接、二进制、截断预算和有效 SDK 工具集有直接证据。
- [ ] 管线开启/关闭、重试、汇总/回写失败及清理回归通过。
- [ ] 前端纯状态测试、类型检查、构建和可用环境下的 Visual Checks 有独立记录。
- [ ] 新增对象的契约注释、安全原因与延后边界和实际实现一致；没有真实环境证据的项目明确标注未验证。

## 评审顺序与抽查路径

1. 先看 [固定版本与清理流程](<fp-docs/changes/repository-context-review/design/backend.md#状态并发与执行流程>)，避免“拉了代码但版本不对”。
2. 再看 [Git 安全](<fp-docs/changes/repository-context-review/design/backend.md#git-与读取安全契约>) 和 [SDK 隔离](<fp-docs/changes/repository-context-review/design/backend.md#sdk-隔离>)，防止只读工具背后仍执行扩展。
3. 核对 [数据与生命周期](<fp-docs/changes/repository-context-review/design/backend.md#数据模型>)，尤其重复关联、解绑、default 和旧客户端。
4. 最后看 [页面状态](<fp-docs/changes/repository-context-review/design/frontend.md#状态并发与执行流程>) 与 Visual Checks。

建议实现后抽查 [review-pipeline.ts](<src/application/review-pipeline.ts>)、[reviewer.ts](<src/infrastructure/pi/reviewer.ts>)、[prompt-repo.ts](<src/infrastructure/sqlite/prompt-repo.ts>) 和 [PromptsView.vue](<web/src/views/PromptsView.vue>) 的相关 diff；本次设计评审未重新扫描代码或声称代码已完成。

## 评审结论记录

- [x] 通过：设计完整，可以进入计划阶段；继续推进依据用户明确自主执行授权。
- [ ] 有条件通过：本次未采用此结论；真实环境验证风险已列入执行证据要求。
- [ ] 退回修改：本次无需要退回的设计缺口。

## 设计入口

- [design/00-index.md](<fp-docs/changes/repository-context-review/design/00-index.md>)
