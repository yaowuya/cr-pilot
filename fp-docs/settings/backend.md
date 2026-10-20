# FeaturePilot Backend Settings

## Backend Framework and Source Locations

- Framework: Node `>=22.19.0`、TypeScript / ESM、Express `^5.1.0`、pi SDK `1.0.4`；依赖与启动入口见 [package.json](<package.json>)，组合根为 [bootstrap.ts](<src/bootstrap.ts>)。
- Source roots: 根应用的 `src/`；HTTP 位于 `src/interfaces/http/`，应用用例位于 `src/application/`，领域模型/端口位于 `src/domain/`，外部实现位于 `src/infrastructure/`，横切能力位于 `src/shared/`。
- API/router locations: [app.ts](<src/interfaces/http/app.ts>) 组合路由并注入后台入队函数；管理模块沿当前路由文件核对，不引入本项目不存在的 Django / DRF 分层。

## Code Standards

- Built-in preset: `none`。
- Rule resources: `N/A`；此 Node / Express 应用不匹配 Django 内置规范。
- Applies to: 仓库根后端 `src/` 与对应 `test/`；依赖证据为 [package.json](<package.json>)，实际入口为 [bootstrap.ts](<src/bootstrap.ts>)，严格类型约束见 [tsconfig.json](<tsconfig.json>)。前端 Vue preset 只适用于 `web/`。
- Project rule sources: [README](<README.md#L5-L32>) 的分层与依赖方向；本轮未发现独立客户代码规范文件。
- Confirmed overrides: `none`。非 Django 不代表豁免共享工程质量要求；未确认的项目政策保留为 Unknown。

## API / Service / Data Patterns

- Controller/service patterns: HTTP 校验、映射任务并入队；application 编排，domain 持有纯规则与端口，infrastructure 实现 IO，组合根注入。沿已有层次扩展，避免仅为小需求补建抽象层。
- Request/response/error envelope: 当前 [HTTP 入口](<src/interfaces/http/app.ts>) 接受 JSON（上限 2mb），错误样本为 `{error: string}` 并使用对应 HTTP 状态；成功体按端点定义，不能统一假设 `code/data` 信封。
- Webhook: `POST /review/webhook` 校验 MR 事件及必需字段，成功入队即返回 200 与 message，不等待评审完成；未知路由为 404，输入类错误保留 4xx，其余异常为 500。
- Data model/schema/migration conventions: [database.ts](<src/infrastructure/sqlite/database.ts>) 使用 Node 内置 SQLite / DatabaseSync，无 ORM。启动时幂等建表，并按现有表结构补充列；沿真实升级逻辑验证旧库兼容，不假定有外部 migration 框架。
- 数据库启用 WAL、外键与 busy timeout，须位于本地盘；本轮只读取 schema，不读取真实数据库或样本数据。涉及 schema 的改动须单独明确备份、迁移和回退边界。

## Auth / Permissions / Isolation

- Auth/session model: 管理 API 沿 [auth-middleware.ts](<src/interfaces/http/auth-middleware.ts>) 使用 Bearer token；当前按用户名和部署盐派生并与账号库核对，身份写入 `res.locals`，缺失/无效 token 为 401。令牌期限、刷新与撤销策略尚未完整核实。
- Permission/action naming: [组合根](<src/bootstrap.ts>) 以 `ADMIN_USERNAME` 确定管理员，仅账号管理路由额外注入 requireAdmin（不足为 403）；不能写成所有管理 API 都仅管理员可用。新增端点需验证普通账号及逐动作权限。
- Multi-tenant / workspace / project / account isolation: `Unknown`；项目绑定和规则选择不等于租户或逐资源授权，不套用 SaaS RBAC 假设。
- Webhook 凭据边界: `X-Gitlab-Instance` / `X-Gitlab-Token` 派生任务级实例与 GitLab 访问凭据。HTTP 仅要求 token 非空，不与全局 webhook secret 比对；来源校验由部署层承担，不能把收到 token 描述为已验证 GitLab 来源。
- 沿任务传递实例 URL / token，避免跨实例复用全局凭据。来源允许列表、URL/TLS 边界和完整 fallback 行为在相关集成改动前核实；不将真实 token 写进文档或日志。

## Jobs / Operations / Observability

- Background job patterns: [queue.ts](<src/shared/queue.ts>) 是进程内 Promise 槽队列，不持久化、不重试，重启会丢失排队任务；异常记日志并释放槽。并发和超时以当前 [config.ts](<src/shared/config.ts>) 为准。
- [评审管线](<src/application/review-pipeline.ts>) 按批评审后汇总，单批与汇总各自超时，而非整条任务共享总 deadline。拉取、单批、汇总和最终回写的捕获分支尝试记 failed 并结束。
- 行内评论可在最终汇总回写失败前已发布，记录 insert 也可能失败；外部副作用不是原子事务，不承诺所有异常必落库或全局幂等。定位/版本/单条发布失败沿现有降级分支处理。
- 企微推送在最终评论回写后执行；推送失败仅日志，不撤销已完成回写。提交人账号提及仍须满足部署确认的 GitLab username / 企微 userid 对应关系。
- Audit/logging expectations: 复用结构化 logger，记录项目/MR 与失败阶段，不记录凭据、完整 payload 或真实敏感数据。审计留存、日志轮转和完整脱敏范围为 Unknown，不从少量日志样本推定已完备。
- Deployment/migration notes: [启动入口](<src/bootstrap.ts>) 先装载环境配置，再应用数据库覆盖并重读；空 `AUTH_SALT` 会拒绝启动。模型配置导出、密钥环境变量引用与配置生效时机按当前实现核实；服务启动和部署不是初始化文档授权的一部分。

## Backend Validation Expectations

- Backend test command/pattern: 命令以 [package.json](<package.json>) 为准：`npm test`（Node test runner）、`npm run typecheck`（同时包含前后端）。测试按 domain / application / infrastructure / interfaces / shared 分域，外部 API 与通知边界使用替身或隔离环境。
- 本轮只核对脚本和源码，未运行测试/构建、未测覆盖率；脚本存在不等于验证通过。
- Data/security negative-test expectations: 按改动范围覆盖非法 JSON/超限、缺/无效认证、普通账号越权、跨项目或实例信息混用、旧库升级幂等、队列异常槽释放、回写失败与行内降级；真实副作用需独立核对授权。

## Unknowns

- 各管理端点完整请求响应、登录契约、密码策略、令牌生命周期和逐资源隔离：需在相关改动前沿当前路由/仓储核实。
- webhook 来源防护、实例 URL / TLS 校验、密钥静态加密、备份恢复及日志留存：Unknown，不能当成已有保障。
- LLM 配置精确优先级涉及 prompt、项目绑定和默认解析分支；当前注释与可见控制流存在差异，本轮不固化旧注释顺序，后续变更时核实实际解析实现。
