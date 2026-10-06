# cr-pilot 对接 GitLab — 技术方案设计

本设计只覆盖后端。方案主线是：GitLab MR webhook 触发 → 后台串行队列 → 拉取变更 → 按仓库规则分批评审 → 二次汇总 → 评论回写 GitLab。

## 第一部分：架构决策

### Decision Ledger

| ID | Decision | Source | Blocking | Status | Evidence / explicit confirmation |
| --- | --- | --- | --- | --- | --- |
| D-001 | GitLab API 客户端用全局 fetch（undici），零新增直接依赖 | user answer | yes | `user-confirmed` | `D-001: selected 「全局 fetch / undici（推荐）」; user message 本次会话 D-001 确认中用户明确选择该选项` |
| D-002 | 引入 `yaml` 包解析仓库规则 | user answer | yes | `user-confirmed` | `D-002: selected 「引入 yaml 包（推荐）」; user message 本次会话 D-002 确认中用户明确选择该选项` |
| D-003 | 后台全局串行队列 | user answer | yes | `user-confirmed` | `D-003: selected 「全局串行队列（推荐）」; user message 本次会话 D-003 确认中用户明确选择该选项` |
| D-004 | 每批一个独立 pi 会话 | user answer | yes | `user-confirmed` | `D-004: selected 「每批一个独立会话（推荐）」; user message 本次会话 D-004 确认中用户明确选择该选项` |
| D-005 | 分批用字符数估算 token（字符数/4 + 15% 余量） | user answer | yes | `user-confirmed` | `D-005: selected 「字符数估算（推荐）」; user message 本次会话 D-005 确认中用户明确选择该选项` |
| D-006 | small form，仅后端，`design/00-index.md` + `design/backend.md` | user answer | yes | `user-confirmed` | `D-006: selected 「small form + 仅后端（推荐）」; user message 本次会话 D-006 确认中用户明确选择该选项` |

### 决策 1：GitLab API 客户端用全局 fetch

- **ID**：`D-001`
- **选择**：`src/gitlab-client.ts` 用全局 `fetch`，不新增 HTTP 依赖；内网自签名证书用 `GITLAB_INSECURE_TLS=1` 环境变量开关，实现时通过 undici `dispatcher` 关闭证书校验（undici 是 pi SDK 传递依赖，与 Node fetch 同源，不需要提升为直接依赖）。
- **理由**：undici 已在依赖树（pi SDK 直接依赖 `undici@8.10.2`），全局 fetch 就是它。为 3 个 GET/POST 调用引入第二个 HTTP 栈没有当前必要性；参考项目的 `requests` + `verify=False` 说明内网自签名是实际存在的场景，因此保留一个显式的不安全开关而不是默认跳过校验。
- **来源**：`D-001` 用户确认；参考项目 `biz/platforms/gitlab/webhook_handler.py:92` 的 `verify=False` 是内网证书场景的证据。
- **状态**：`user-confirmed`
- **是否阻塞**：是

### 决策 2：yaml 包解析仓库规则

- **ID**：`D-002`
- **选择**：新增直接依赖 `yaml@^2`，`src/rules.ts` 用它解析 `prompts/rules/*.yaml`。
- **理由**：Node 无内置 YAML 解析。仓库规则的 `system_prompt`/`user_prompt` 是多行 `|-` 块，缩进是 YAML 最常见的出错点，自写解析器会在注释、引号、冒号上反复咬人，测试成本反而高于引入一个纯 JS、零依赖、TS 友好的成熟解析器。`yaml@2.9.0` 已在 pi SDK 的传递依赖中，提升为直接依赖零新增下载。
- **来源**：`D-002` 用户确认；`P-003` 确认 YAML 规则目录。
- **状态**：`user-confirmed`
- **是否阻塞**：是

### 决策 3：后台全局串行队列

- **ID**：`D-003`
- **选择**：`src/queue.ts` 维护一条 promise 链，任务按到达顺序串行执行；webhook 处理函数把任务入队后立即返回。
- **理由**：一个 MR 任务 = 1 次拉取 + N 次模型评审 + 1 次汇总 + 1 次回写。串行保证任意时刻只有一次模型调用在跑，不会打爆模型配额与 GitLab API；与已确认的「内存队列、重启丢任务」边界一致。并发上限的取舍此前已作为有意延后项记录（上一次变更的并发限制项），本次延续。
- **来源**：`D-003` 用户确认；`P-005` 确认「立即 200 + 后台处理」。
- **状态**：`user-confirmed`
- **是否阻塞**：是

### 决策 4：每批一个独立 pi 会话

- **ID**：`D-004`
- **选择**：`src/pipeline.ts` 对每个批次、以及最后的汇总，各新建一个 pi 内存会话，会话间零共享。
- **理由**：延续已确认的隔离原则（`review-webhook` 变更的 D-002）——评审上下文只应有「prompt + 当批内容」。会话内多轮会让第 N 批看见前 N-1 批的代码与结论，稀释注意力；汇总若复用旧会话，记忆里已混入全部批内容，语义混乱。会话创建开销相对模型 30 秒评审可忽略。现有 `reviewer.ts` 已是每请求一会话，适配层零改动。
- **来源**：`D-004` 用户确认；`reviewer.ts:createPiReviewer` 现状。
- **状态**：`user-confirmed`
- **是否阻塞**：是

### 决策 5：字符数估算 token

- **ID**：`D-005`
- **选择**：`estimateTokens(text) = Math.ceil(text.length / 4)`，分批预算用 `REVIEW_BATCH_MAX_TOKENS` 的 85% 作为安全阈值。
- **理由**：代码约 3-4 字符/token，按 4 估算偏保守——批只会偏小不会超预算，永不爆上下文。内网模型 `gpt-5.6-terra` 的词表未必与 OpenAI 一致，引入 js-tiktoken 的精确计数收益打折，多一个带词表的依赖不值。估算误差全部落在「批更小」的安全方向。
- **来源**：`D-005` 用户确认；参考项目 `biz/utils/code_reviewer.py:216-321` 的分批结构与 `biz/utils/token_util.py` 的存在性。
- **状态**：`user-confirmed`
- **是否阻塞**：是

### 决策 6：设计 form 与目标路径

- **ID**：`D-006`
- **选择**：small form，写入 `design/00-index.md` 与 `design/backend.md`；不生成前端设计；无 overwrite/conversion/removal。
- **理由**：预计两份文件远低于 500 行 / 30,000 字符；本次无 UI 范围。
- **来源**：`D-006` 用户确认。
- **状态**：`user-confirmed`
- **是否阻塞**：是

### Pre-write Confirmation Evidence

- Covered IDs: `D-001`, `D-002`, `D-003`, `D-004`, `D-005`, `D-006`
- Outstanding blocking decisions: `none`
- Explicit user authorization to write: 用户逐项确认 `D-001`〜`D-006`，随后明确授权「确认并按 P-001〜P-006 写入（不保留旧接口）」。据此按 small form 写入 `design/00-index.md` 与 `design/backend.md`。

## 第二部分：技术方案详述

### 设计范围适用性

| 评审范围 | 要求 | Canonical owner section | 证据或不适用理由 |
| --- | --- | --- | --- |
| 架构主线 | 必填 | `#架构主线` | proposal What Changes；`D-001`〜`D-005` |
| 核心对象与职责 | 必填 | `#核心对象与职责` | `D-001`〜`D-005` 确定的模块边界 |
| 数据模型 | 条件适用 | `N/A` | 无持久化：队列在内存（P-005、D-003），规则文件是配置不是数据模型 |
| 状态、并发与执行流程 | 条件适用 | `#状态并发与执行流程` | 后台队列、分批/汇总、回写是本次主体（`D-003`、`D-004`、`D-005`） |
| 接口、权限与兼容边界 | 条件适用 | `#接口权限与兼容边界` | webhook 契约与来源校验是本次主体（`P-006`） |
| 前端方案 | 条件适用 | `N/A` | proposal 无 UI 范围 |
| 风险、迁移、发布、回滚与监控 | 必填 | `#风险迁移发布回滚与监控` | 后台丢任务、GitLab 重试、评论幂等 |
| 验证方案 | 必填 | `#验证方案` | `D-001`〜`D-005` 的可执行验证 |

### 架构主线

GitLab 推送 MR webhook 到 `POST /review/webhook`。处理顺序如下。

1. **来源校验**：`X-Gitlab-Token` 与 `GITLAB_WEBHOOK_SECRET` 比对；不匹配返回 401，不进入队列。
2. **事件分派**：`object_kind` 为 `merge_request` 时提取 `project_id`、`object_attributes.iid` 与动作，组装任务入队，**立即返回 200**；其余事件返回 400。
3. **后台串行处理**（队列中依次执行）：
   - 用 GitLab 客户端拉取 MR 变更（`/changes`，空变更时最多重试 3 次）与提交信息（`/commits`）。
   - 用仓库规则加载器按 `path_with_namespace` 解析本项目的 prompt（仓库规则 > default.yaml > `prompts/review.md` 兜底）。
   - 把变更文本按 token 预算分批；逐批用独立 pi 会话评审；各批结果拼接后，再用一个独立会话汇总成一份最终评论。
   - 用 GitLab 客户端把汇总评论 POST 到 MR `/notes`。
4. **失败收束**：拉取失败、评审失败、汇总失败都记录日志并结束该任务（不重投）；回写失败记录日志。

**最简单可行方案**就是这条链：不引入持久化、不引入重试框架、不引入 worker 线程——全局串行 promise 链 + 现有 pi 适配层复用。新增依赖只有 `yaml`；新增抽象只有 GitLab 客户端、队列、规则加载、管线四个单职责模块。

### 核心对象与职责

| 对象/模块 | 职责 | 不负责 | 协作对象 | 证据 |
| --- | --- | --- | --- | --- |
| `src/config.ts` | 读取环境变量并补齐默认值，新增 GitLab 与分批配置 | 业务判断 | `server.ts`、`pipeline.ts` | `P-001`、proposal What Changes 1/3/6 |
| `src/rules.ts` | 加载 `prompts/rules/` 目录，按 `path_with_namespace` 匹配仓库规则，渲染 `{diffs_text}`/`{commits_text}` 占位符 | 不评审、不拉取 | `pipeline.ts` | `P-003`、`D-002` |
| `src/gitlab-client.ts` | 拉取 MR 变更与提交、回写评论；处理 TLS 开关与超时 | 不评审、不解析规则 | `pipeline.ts`、`queue.ts` | `D-001`、proposal What Changes 3 |
| `src/queue.ts` | 全局串行队列：入队任务按序执行 | 不做任务持久化、不重试 | `app.ts`、`pipeline.ts` | `D-003` |
| `src/pipeline.ts` | 编排「分批 → 逐批评审 → 汇总」，输出最终评论 | 不直接调 HTTP、不解析规则 | `gitlab-client.ts`、`rules.ts`、`reviewer.ts` | `D-004`、`D-005`、proposal What Changes 6 |
| `src/reviewer.ts` | 单个 pi 会话评审（现状保持），被 pipeline 复用 | 不分批、不汇总 | `pipeline.ts` | `D-004` |
| `src/app.ts` | webhook 路由：校验、分派、入队、立即返回 | 不做评审、不回写 | `queue.ts` | `P-005`、proposal What Changes 2 |
| `src/server.ts` | 装配配置、队列、客户端与管线并监听 | 业务逻辑 | 全部 | `D-003`、`D-006` |

`src/pipeline.ts` 是唯一的编排接缝：它只依赖上面各模块的接口，测试可以注入假的 GitLab 客户端与假的 Reviewer 来覆盖全链路而不打真实模型与 GitLab。

### 后端模块设计

```text
cr-pilot/
├── package.json              # 修改：新增 yaml 依赖；端口相关文档
├── prompts/
│   ├── review.md             # 保留：无 YAML 规则时的兜底 system prompt
│   └── rules/
│       ├── default.yaml      # 新增：全局默认规则（system_prompt + user_prompt）
│       └── <repo>.yaml       # 新增（可选）：每仓库一份，含 repository: 字段
├── src/
│   ├── config.ts             # 修改：PORT 默认 5001；新增 GITLAB_URL / GITLAB_TOKEN /
│   │                         #   GITLAB_WEBHOOK_SECRET / GITLAB_INSECURE_TLS / GITLAB_API_TIMEOUT /
│   │                         #   REVIEW_BATCH_MAX_TOKENS / REVIEW_RULES_DIR
│   ├── rules.ts              # 新增：规则加载、仓库匹配、prompt 渲染
│   ├── gitlab-client.ts      # 新增：GitLab API 客户端
│   ├── queue.ts              # 新增：内存串行队列
│   ├── pipeline.ts           # 新增：分批 / 逐批评审 / 汇总编排
│   ├── app.ts                # 修改：webhook 校验与分派
│   ├── reviewer.ts           # 基本不变：供 pipeline 复用
│   ├── prompt.ts             # 修改：读取 YAML 规则的兜底 Markdown 读取可保留，或并入 rules.ts
│   ├── logger.ts             # 不变
│   └── server.ts             # 修改：装配队列与管线
└── test/
    ├── rules.test.ts         # 新增：规则加载与匹配
    ├── gitlab-client.test.ts # 新增：客户端（fake fetch）
    ├── pipeline.test.ts      # 新增：分批 / 汇总编排
    ├── queue.test.ts         # 新增：串行语义
    └── app.test.ts           # 修改：webhook 契约
```

### 状态、并发与执行流程

**状态**：队列中每个任务有三种状态：`pending`（已入队未开始）→ `running`（正在处理）→ `done/failed`。状态只存在于队列内存中，进程重启即消失（已确认边界）。

**并发**：全局串行——同一时刻最多一个任务在跑。任务内部按「分批 → 逐批评审 → 汇总」顺序执行，批次之间不并发（模型配额保护）。

**执行顺序与失败收束**：拉取失败 → 记日志、任务结束；单批评审失败 → 记日志、整条任务结束（不跳过该批继续，因为汇总会缺失该批上下文）；汇总失败 → 记日志、任务结束；回写失败 → 记日志。所有失败都不重投、不阻塞队列后续任务。

**可观察结果**：逐步日志（队列接收、拉取、分批数量、每批耗时、汇总耗时、回写 HTTP 状态）；webhook 侧永远立即 200（或 401/400）。

### 接口、权限与兼容边界

**路由**：`POST /review/webhook`。

**请求**：GitLab `merge_request` webhook payload（含 `object_kind`、`project_id`、`project.path_with_namespace`、`object_attributes.iid/action/source_branch/target_branch`、`object_attributes.source/target project id`）。请求头 `X-Gitlab-Token` 必须匹配 `GITLAB_WEBHOOK_SECRET`。

**响应**：`merge_request` 事件 → `200 {"message": "..."}`；secret 不匹配 → `401`；其它 `object_kind` → `400`。

**兼容边界**：原「请求体传 code 同步返回评审」形态停止支持；本接口不再接受 `{"code": ...}`。

**配置**：

| 环境变量 | 默认值 | 作用 |
| --- | --- | --- |
| `PORT` | `5001` | 监听端口 |
| `HOST` | `127.0.0.1` | 监听地址 |
| `GITLAB_URL` | 无（必填） | GitLab 实例地址，如 `https://code.cwoa.net` |
| `GITLAB_TOKEN` | 无（必填） | 访问令牌（拉 diff / commits、回写评论） |
| `GITLAB_WEBHOOK_SECRET` | 无（必填） | webhook 来源校验 secret |
| `GITLAB_INSECURE_TLS` | `0` | 为 `1` 时跳过 TLS 证书校验（内网自签名） |
| `GITLAB_API_TIMEOUT` | `15000` | GitLab API 单次请求超时毫秒 |
| `REVIEW_BATCH_MAX_TOKENS` | `6000` | 单批 token 预算 |
| `REVIEW_RULES_DIR` | `prompts/rules` | 仓库规则目录 |
| `LOG_LEVEL` | `info` | 日志级别 |

### 风险、迁移、发布、回滚与监控

| 具体失败场景 | 影响 | 预防或处理 | 发布/回滚/监控安排 | 证据 |
| --- | --- | --- | --- | --- |
| 后台任务在进程重启时丢失 | 该次 MR 收不到评论 | 已确认边界；文档写明「重启丢任务」 | 通过日志确认任务是否入队 | `P-005`、`D-003` |
| GitLab webhook 超时重试 | 同一 MR 被多次入队，可能发多条评论 | 立即返回 200 降低超时概率；无幂等（已确认不做） | 观察同一 iid 的重复处理日志 | `P-005`、Out of Scope |
| 内网自签名证书导致拉取失败 | 任务全部失败 | `GITLAB_INSECURE_TLS=1` 开关 | 拉取失败日志含 HTTP 错误 | `D-001` |
| 某仓库无规则且 default 缺失 | 用 `prompts/review.md` 兜底 | 三层兜底链 | 规则解析日志 | `P-003` |
| token 估算偏差导致单批过大 | 极端情况下可能超模型上下文 | 按字符/4 估算 + 85% 阈值，偏保守 | 分批日志记录每批字符数 | `D-005` |
| GitLab token 泄露 | 评论可被伪造 | token 只从环境变量读取，日志不打 token | 日志审查 | `P-006` |

**有意延后项**

- **并发上限**：串行队列即上限为 1。触发条件：出现 MR 排队超过可接受时长；升级方向：引入并发上限参数。
- **任务持久化**：内存队列。触发条件：出现「重启丢评审」的实际投诉；升级方向：引入持久化队列（如文件/数据库）。
- **评论幂等**：无去重。触发条件：GitLab 重试导致重复评论；升级方向：按 MR iid + 事件去重（内存 Set 或 MR 评论查询）。

三项均不削减当前已承诺的验收。

### 验证方案

| 验证项 | 命令或操作 | 预期结果 | 覆盖的设计结论 | 证据 owner |
| --- | --- | --- | --- | --- |
| 类型检查 | `npm run typecheck` | 退出码 0 | 全部 | 本节 |
| 单元与接口测试 | `npm test` | 全部通过 | 全部 | 本节 |
| 队列串行语义 | `test/queue.test.ts` | 两个任务串行执行、顺序保持 | `D-003` | 本节 |
| 规则匹配 | `test/rules.test.ts` | 仓库规则 > default > md 兜底；占位符渲染 | `D-002`、`P-003` | 本节 |
| GitLab 客户端 | `test/gitlab-client.test.ts`（fake fetch） | changes/commits/notes 三接口的 URL、头、重试 | `D-001` | 本节 |
| 分批与汇总 | `test/pipeline.test.ts` | 分批预算、批序拼接、汇总调用参数 | `D-004`、`D-005` | 本节 |
| webhook 契约 | `test/app.test.ts` | 401/400/200 + 入队 | `P-005`、`P-006` | 本节 |
| 真实 MR 端到端 | 配置真实 GitLab 后推送测试 MR | 评论出现在 MR 上 | 全链路 | 本节 |
| 注释自审 | 对照 `engineering-quality` | 公开对象有契约说明 | 契约要求 | 本节 |

真实 MR 端到端需要可用的 `GITLAB_TOKEN` 与 `GITLAB_WEBHOOK_SECRET`，由用户环境提供。
