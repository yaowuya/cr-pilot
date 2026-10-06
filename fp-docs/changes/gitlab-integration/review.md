# cr-pilot 对接 GitLab — 开发设计评审

## 评审结论

建议**有条件通过**。设计把 GitLab 闭环压成一条主线：webhook 校验 → 立即 200 → 后台串行队列 → 拉取变更 → 仓库规则分批评审 → 二次汇总 → 回写评论。六个架构决策全部终态，与已确认的 proposal 范围一致。

需要评审者确认的条件有两条，都不阻塞进入计划阶段，但必须在实现前表态。第一，旧「纯代码同步接口」在本变更后被 GitLab webhook 形态替代，之前 Apifox 里那种 `{"code": ...}` 请求会失效。第二，后台队列在内存中，服务重启会丢正在排队的评审，且同一 MR 事件被 GitLab 重试时会发多条评论——这是已确认的边界，不是缺陷，但评审时要确认产品上接受。

| 评审面 | 结论 | 设计依据 |
| --- | --- | --- |
| 决策 | 共 6 项；阻塞 6 / 非阻塞 0；全部终态 | `design/backend.md` 第一部分 |
| 数据 | 无持久化，队列与状态都在内存 | `design/backend.md#设计范围适用性` 数据模型行 |
| 接口 | `POST /review/webhook` 改为 GitLab 事件入口，新增 401/400 | `design/backend.md#接口权限与兼容边界` |
| 前端 | 无前端范围 | `design/00-index.md` |
| 不做事项 | 不处理 push、不做行内评论、无持久化队列、单实例、无幂等去重、旧接口不保留 | `proposal.md#out-of-scope` |

## 业务和技术主线

触发来自 GitLab 的 MR webhook。处理顺序：校验 `X-Gitlab-Token` → 按 `object_kind` 分派 → `merge_request` 入队并立即 200 → 队列串行处理「拉 changes/commits → 按仓库匹配规则 → 分批逐批评审 → 汇总 → POST notes 回写」。

失败收束互斥：401（secret 不匹配）、400（非 merge_request 事件）、拉取失败/单批失败/汇总失败/回写失败各自记日志后结束该任务，不重投、不阻塞后续任务。

最简单可行方案就是这条链：全局串行 promise 链 + 现有 pi 适配层复用。新增依赖只有 `yaml`；新增抽象只有 GitLab 客户端、队列、规则加载、管线四个单职责模块。复用点明确：`reviewer.ts` 零改动（每请求一会话，天然匹配每批一会话的决策）。

## 核心对象与职责

| 对象/模块 | 职责 | 不负责 | 协作对象 | 设计依据 |
| --- | --- | --- | --- | --- |
| `src/config.ts` | 读取环境变量并补默认值 | 业务判断 | `server.ts`、`pipeline.ts` | `P-001` |
| `src/rules.ts` | 加载规则目录、按仓库匹配、渲染占位符 | 评审、拉取 | `pipeline.ts` | `D-002`、`P-003` |
| `src/gitlab-client.ts` | 拉 changes/commits、回写 notes，处理 TLS 与超时 | 评审、规则解析 | `pipeline.ts` | `D-001` |
| `src/queue.ts` | 全局串行队列 | 持久化、重试 | `app.ts`、`pipeline.ts` | `D-003` |
| `src/pipeline.ts` | 编排分批/逐批评审/汇总 | 直接 HTTP、规则解析 | 三个模块 | `D-004`、`D-005` |
| `src/reviewer.ts` | 单个 pi 会话评审（现状保持） | 分批、汇总 | `pipeline.ts` | `D-004` |
| `src/app.ts` | webhook 校验、分派、入队 | 评审、回写 | `queue.ts` | `P-005` |
| `src/server.ts` | 装配与监听 | 业务逻辑 | 全部 | `D-003` |

`src/pipeline.ts` 是唯一编排接缝：测试可注入假 GitLab 客户端与假 Reviewer 覆盖全链路，不打真实模型与 GitLab。

## 状态、并发和执行流程

状态只存在于队列内存：`pending → running → done/failed`，重启即消失。并发是全局串行：同一时刻最多一个任务在跑，批次之间不并发（模型配额保护）。失败一律记日志、任务结束、不重投、不阻塞后续任务。可观察结果：webhook 侧永远立即 200/401/400；后台逐步日志（队列接收、拉取、分批数量、每批耗时、汇总耗时、回写状态码）。

评审时要确认两点：一是串行队列与「立即 200」配合后，webhook 不会因后台处理变慢而超时；二是任务内部「单批失败即整条任务结束」的语义（不跳过该批继续）是否可接受——这是为了让汇总永远拥有全部批次的上下文。

## 接口、权限和旧入口隔离

| 接口/入口 | 主键或资源 | 权限 | 兼容或隔离边界 | 设计依据 |
| --- | --- | --- | --- | --- |
| `POST /review/webhook` | 无资源标识；`project_id` + MR `iid` 为任务标识 | `X-Gitlab-Token` 匹配 `GITLAB_WEBHOOK_SECRET` | 旧「纯代码」形态停止支持，本接口只接受 GitLab 事件 | `P-005`、`P-006` |

配置新增七项（`GITLAB_URL`/`GITLAB_TOKEN`/`GITLAB_WEBHOOK_SECRET`/`GITLAB_INSECURE_TLS`/`GITLAB_API_TIMEOUT`/`REVIEW_BATCH_MAX_TOKENS`/`REVIEW_RULES_DIR`），端口默认改为 5001。

需要评审者特别注意兼容边界：旧接口的调用方（如 Apifox 里的 `{"code": ...}` 请求）在本变更后拿到的是 401/400。这是已确认的设计边界而非缺陷，但它是本次最容易被误认为 bug 的行为。

## 主要风险、迁移、发布和验证

### 主要风险

| 具体失败场景 | 影响 | 预防或处理 | 设计依据 |
| --- | --- | --- | --- |
| 后台任务在进程重启时丢失 | 该次 MR 收不到评论 | 已确认边界，文档写明 | `P-005`、`D-003` |
| GitLab webhook 超时重试 | 同一 MR 多次入队，可能多条评论 | 立即 200；无幂等（已确认不做） | `P-005`、Out of Scope |
| 内网自签名证书 | 拉取全部失败 | `GITLAB_INSECURE_TLS=1` 开关 | `D-001` |
| 规则缺失 | 无 prompt 可用 | 三层兜底链（仓库 > default > md） | `P-003` |
| token 估算偏差 | 单批超模型上下文 | 字符/4 + 85% 阈值，偏保守 | `D-005` |
| GitLab token 泄露 | 评论可被伪造 | token 只从环境变量读取，日志不打 token | `P-006` |

有意延后项三项，均在设计唯一 owner 中记录内容、理由、适用上限、可验证升级触发条件与升级方向：并发上限（串行即 1，触发条件是 MR 排队超时，升级方向是并发参数）、任务持久化（内存队列，触发条件是「重启丢评审」投诉，升级方向是持久化队列）、评论幂等（无去重，触发条件是重试导致重复评论，升级方向是按 iid+事件去重）。评审时要确认这三项都没有削减当前验收。

### 迁移与发布

无 schema 变化、无数据迁移。发布即首次部署，回滚即停掉进程。上线后需要观察的信号：拉取失败与回写失败日志的出现比例——前者指向 token/证书/TLS 配置，后者指向 GitLab 权限。

### 验证清单

- [ ] `npm run typecheck` 退出码为 0；覆盖全部决策。
- [ ] `npm test` 全部通过；覆盖 `D-001`〜`D-005`。
- [ ] `test/queue.test.ts` 验证两个任务串行执行、顺序保持；覆盖 `D-003`。
- [ ] `test/rules.test.ts` 验证仓库规则 > default > md 兜底，占位符渲染；覆盖 `D-002`、`P-003`。
- [ ] `test/gitlab-client.test.ts`（fake fetch）验证 changes/commits/notes 的 URL、请求头、重试；覆盖 `D-001`。
- [ ] `test/pipeline.test.ts` 验证分批预算、批序拼接、汇总调用参数；覆盖 `D-004`、`D-005`。
- [ ] `test/app.test.ts` 验证 401/400/200 与入队行为；覆盖 `P-005`、`P-006`。
- [ ] 真实 MR 端到端：配置真实 GitLab 后推送测试 MR，评论出现在 MR 上；覆盖全链路。需要 `GITLAB_TOKEN` 与 `GITLAB_WEBHOOK_SECRET`。
- [ ] 注释自审：对照 `engineering-quality` 检查新增与改变行为的公开对象；覆盖契约要求。

## 评审顺序与抽查路径

1. 先看 `design/backend.md#接口权限与兼容边界`，因为旧接口被替代、secret 校验、端口改 5001 这三件事最容易被调用方当成故障。
2. 再看 `design/backend.md#状态并发与执行流程`，重点核串行队列与「单批失败整任务结束」语义是否与产品预期一致。
3. 然后看 `design/backend.md#决策 4` 与 `#决策 5`，确认「每批一会话 + 字符估算」的评审质量与成本权衡。
4. 最后看 `design/backend.md#验证方案`，确认七个自动化验证项都有对应用例，且真实 MR 端到端标注了环境前置。

- 建议抽查：`proposal.md` 的 Out of Scope 与 `design/backend.md#风险迁移发布回滚与监控` 的延后项，确认边界一致，没有把已排除的能力（push 事件、行内评论、幂等）重新引入。

## 评审结论记录

- [ ] 通过：设计完整，可以进入计划阶段。
- [ ] 有条件通过：需要先确认「旧纯代码接口不保留」与「重启丢任务 + 可能重复评论」两条边界。
- [ ] 退回修改：需要返回 `fp-brainstorm` 的精确章节。

## 设计入口

- `design/00-index.md`
