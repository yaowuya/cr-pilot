# Execution Progress

Plan files:
- `tasks/backend/00-index.md` (split; fragments 01-context, 05-interfaces, 10/15/20/30/40/50 tasks, 90-coverage)
- `tasks/frontend/00-index.md` (split; fragments 01-context, 05-interfaces, 10/20 tasks, 90-coverage)
- `tasks/00-overview.md` (two-end derived progress)

Base SHA: 4b7b028

## Completed

### 前端（6/6）

- frontend-001 (owner `tasks/frontend/10-foundation-tasks.md`): Vite + Vue3 + Element Plus 工程骨架、tsconfig、构建脚本、Dockerfile 前端构建阶段；`npm run build:frontend` 产出 `web/dist`
- frontend-002、003 (owner `tasks/frontend/10-foundation-tasks.md`、`tasks/frontend/20-page-tasks.md`): API 客户端、登录页、路由守卫、后台骨架、评审记录页；E2E 证据 `.fp-execute/e2e/frontend-002/login-flow/`、`frontend-003/reviews-query/`
- frontend-004 (owner `tasks/frontend/20-page-tasks.md`): prompt 管理页；E2E 证据 `.fp-execute/e2e/frontend-004/prompt-edit/`
- frontend-005 (owner `tasks/frontend/20-page-tasks.md`): 环境变量管理页；E2E 证据 `.fp-execute/e2e/frontend-005/config-edit/`
- frontend-006 (owner `tasks/frontend/20-page-tasks.md`): 管理员账号管理页；E2E 证据 `.fp-execute/e2e/frontend-006/admin-crud/`

### 前端 UI 生命周期门禁

5 个 UI case 均为 `interactive` 或 `business-flow`，`E2E Applicability: REQUIRED`，`Mocked Core API: false`：

| Case | SOURCE_READY | STATIC_UI_READY | VISUAL_REVIEW_PASS | INTERACTION_READY | FRONTEND_E2E_PASS |
| --- | --- | --- | --- | --- | --- |
| `frontend-002/login-flow` | ✅ | ✅ | `CANNOT_VERIFY`（D-019 无视觉基准） | ✅ | ✅ |
| `frontend-003/reviews-query` | ✅ | ✅ | `CANNOT_VERIFY` | ✅ | ✅ |
| `frontend-004/prompt-edit` | ✅ | ✅ | `CANNOT_VERIFY` | ✅ | ✅（修复 1 次后通过） |
| `frontend-005/config-edit` | ✅ | ✅ | `CANNOT_VERIFY` | ✅ | ✅ |
| `frontend-006/admin-crud` | ✅ | ✅ | `CANNOT_VERIFY` | ✅ | ✅ |

真实浏览器：全局 `playwright-cli`（版本 0.1.19），无需新增依赖或下载浏览器，未触发 `BROWSER_CAPABILITY_GATE`。
全部用例通过 UI 触达真实 API 与真实 SQLite，无 mock、无路由拦截、无 fixture、无 seed。测试数据均已清理。

### 后端（23/23）

- backend-001、002 (owner `tasks/backend/10-domain-foundation-tasks.md`): commits 419bf10; `node --test test/domain/inline-comment.test.ts` 10/10; inline 自审 clean
- backend-003、004 (owner `tasks/backend/15-crypto-persistence-tasks.md`): commit 230d685; crypto 6/6、database 4/4
- backend-005~008 (owner `tasks/backend/20-persistence-tasks.md`): commit 6481eb0; 四仓储 29 个用例全通过
- backend-009~012 (owner `tasks/backend/30-pipeline-tasks.md`): commit c0743fd; review-pipeline 31/31
- backend-013~016 (owner `tasks/backend/40-gitlab-inline-comment-tasks.md`): commits b8445e7、c0743fd; gitlab-client 14/14
- backend-017~023 (owner `tasks/backend/50-http-api-tasks.md`): commit ec45144; api 16/16、config 11/11

### 后端集成验证

- `npm run typecheck`：退出码 0
- `npm test`：167/167 通过
- 真实启动冒烟测试（`node src/bootstrap.ts`，独立端口与临时库）：
  - 启动横幅显示数据库路径、配置覆盖项数、模型密钥已配置
  - 管理员引导创建成功（账号数=1）
  - `GET /health` → 200
  - 未认证 `GET /api/reviews` → 401
  - 登录 → 令牌长度 32、用户名正确
  - 带令牌 `GET /api/reviews` → `{items:[],total:0,page:1,pageSize:20}`
  - 带令牌 `GET /api/config` → 70 个配置项，其中 3 个密钥类被掩码
- `node scripts/import-prompts.ts`：首跑导入 6 条、跳过 1 条；二跑导入 0 条（幂等验证通过）

## 偏差与决策记录

1. **`hashPassword` / `verifyPassword` 签名调整**（执行期发现）：计划写的是
   `hashPassword(plain, salt)` 与 `verifyPassword(plain, salt, stored)`。实现时发现
   `D-010` 的公式需要「用户名」与「部署盐」两个不同值，且校验时盐内嵌于哈希串、
   不需要额外参数。已改为 `hashPassword(plain, username, deploymentSalt)` 与
   `verifyPassword(plain, stored)`，并同步更新 `tasks/backend/05-interfaces.md`。
   附带结论：轮换部署盐不会让既有密码失效（有意行为）。
2. **`node:sqlite` 实验警告**：实测 `process.on("warning")` 监听无法阻止 Node 在
   导入阶段写入 stderr，唯一静默方式是覆盖 `process.emitWarning`（影响面过大）。
   决定保留警告，按 `D-003` 的验证要求执行，并在代码注释记录该结论。
3. **`me` 接口要求鉴权**：计划未明确；若不鉴权则永远返回空用户名，前端无法用它
   校验本地令牌。已在 `AuthRouterDeps` 增加可选 `authMiddleware` 仅作用于 `/me`。
4. **webhook 解析补提取提交人**：proposal 要求记录提交人，`MergeRequestTask` 新增
   `committerName`（取自 `payload.user.name`），缺失时为空串不拒绝请求。
5. **四仓储共用一个连接**：`openDatabase` 在 bootstrap 调用一次，四个仓储共享
   `DatabaseSync` 实例（`D-018` 单连接语义）。

## Blocked

- None（无 UI 核心缺口、无未完成 required E2E、无 mock 违规）

## 最终验证

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck`（含前端 `vue-tsc`） | 退出码 0 |
| `npm test` | 168/168 通过 |
| `npm run build:frontend` | 产出 `web/dist`，构建成功 |
| `node scripts/import-prompts.ts` | 首跑导入 6 条、二跑 0 条（幂等） |
| 真实启动冒烟 | 启动、引导管理员、401、登录、记录查询、密钥掩码全部正常 |
| 浏览器 E2E（5 case） | 全部 `FRONTEND_E2E_PASS` |

## Notes

- 后端全部完成后，`web/dist` 尚未构建，启动日志会提示「未找到前端构建产物，跳过静态资源托管」——这是预期行为，前端任务完成后消失。
- 前端任务（frontend-001~006）尚未开始，其中 5 个 case 为 `interactive`/`business-flow`，需真实浏览器 E2E。
- 视觉证据按 `D-019` 记为 `CANNOT_VERIFY`（项目无 Figma、无截图、无既有页面）。
