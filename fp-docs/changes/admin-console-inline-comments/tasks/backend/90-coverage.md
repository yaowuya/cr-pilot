# Coverage Matrix

本矩阵证明 proposal 的后端范围、design-backend 的全部决策与后端边界检查都被任务覆盖。

## Proposal 覆盖

| Source | Requirement / Boundary | Tasks | Verification |
| --- | --- | --- | --- |
| proposal.md | 变更点 1 prompt 增加机器可读结构化输出块 | `backend-002`, `backend-021` | `node --test test/domain/inline-comment.test.ts` |
| proposal.md | 变更点 2 GitLab 行内评论发布能力 | `backend-015`, `backend-011` | `node --test test/infrastructure/gitlab/gitlab-client.test.ts`、`test/application/review-pipeline.test.ts` |
| proposal.md | 变更点 3 行内与汇总并行、汇总去重 | `backend-011` | `test::行号不在 diff 变更行上的 finding 并入汇总而非发行内评论` |
| proposal.md | 变更点 4 结构化解析作为领域纯逻辑 | `backend-001`, `backend-002` | `node --test test/domain/inline-comment.test.ts` |
| proposal.md | 变更点 5 SQLite 持久化层 | `backend-004`, `backend-005`, `backend-006`, `backend-007`, `backend-008` | `node --test test/infrastructure/sqlite/database.test.ts` 等五个文件 |
| proposal.md | 变更点 6 每次评审落明细（失败也落） | `backend-005`, `backend-009` | `test::评审失败时仍写入失败记录` |
| proposal.md | 变更点 7 记录查询与统计 API | `backend-019` | `test::GET /api/reviews 返回分页结构，非法 pageSize 返回 400` |
| proposal.md | 变更点 8 管理员账号与登录接口 | `backend-003`, `backend-006`, `backend-017` | `test::登录成功返回令牌，失败返回 401 且不区分原因` |
| proposal.md | 变更点 9 账号管理接口与删除约束 | `backend-018` | `test::删除自己与删除最后一个管理员均返回 400` |
| proposal.md | 变更点 10 环境变量管理接口 | `backend-007`, `backend-020` | `test::密钥字段掩码返回，更新同步 process.env 并标注需重启项` |
| proposal.md | 变更点 11 管理 API 统一鉴权 | `backend-014` | `test::无令牌与错误令牌访问管理接口均返回 401` |
| proposal.md | 变更点 12 部署配置补充数据库卷 | `backend-023` | `docker compose config` 卷存在 + 容器重启数据仍在 |
| proposal.md | 变更点 13 prompt 入库与管理接口 | `backend-008`, `backend-021` | `test::删除项目 prompt 后该仓库回落 default` |
| proposal.md | 变更点 14 prompt 热生效 | `backend-010`, `backend-021` | `test::数据库命中 prompt 时不使用 yaml 规则` |
| proposal.md | 变更点 15 内置管理前端 | 后端侧契约由 `backend-017`~`backend-022` 提供；前端任务见 `tasks/plan-frontend.md` | `node --test test/interfaces/http/api.test.ts` |

## Design 决策覆盖

| Source | Requirement / Boundary | Tasks | Verification |
| --- | --- | --- | --- |
| design/backend.md | `D-001` 分层方向 interfaces → application → domain | 全部任务的 File 划分 | `npm run typecheck`（domain 层无 infrastructure 导入） |
| design/backend.md | `D-002` 组合根单点装配 | `backend-023` | 静态核对 `src/bootstrap.ts` 无散落装配 |
| design/backend.md | `D-003` `node:sqlite` 可用且需处理 ExperimentalWarning | `backend-004` | `test::openDatabase 建四张表并启用 WAL` |
| design/backend.md | `D-004` 行内评论定位对齐参考实现 | `backend-001`, `backend-015`, `backend-011` | `test::parseDiffLines 区分新增行与删除行`、`test::getMergeRequestVersions 取最新 diff version 的三个 SHA` |
| design/backend.md | `D-005` 幂等 marker + 发布后校验 | `backend-002`, `backend-011`, `backend-016` | `test::已含 marker 的 finding 不重复发布` |
| design/backend.md | `D-006` AI 输出 JSON schema | `backend-002` | `test::parseReviewJson 解析 findings 并强制 new_line/old_line 互斥` |
| design/backend.md | `D-007` 单表明细 + 实时聚合 | `backend-005` | `test::insert 后 getList 可按项目筛选，getStats 忽略 null 分数` |
| design/backend.md | `D-008` Bearer 令牌 + 前端 localStorage | `backend-014`, `backend-017` | `test::有效令牌可访问管理接口` |
| design/backend.md | `D-009` 无状态令牌，不做踢下线 | `backend-003`, `backend-014` | `test::generateToken 每次不同，deriveToken 确定性` |
| design/backend.md | `D-010` scrypt + SHA256(用户名+固定盐) | `backend-003` | `test::hashPassword 产出 scrypt$盐$哈希 且同输入稳定` |
| design/backend.md | `D-011` 环境变量引导首个管理员 | `backend-006`, `backend-012`, `backend-023` | `test::ensureInitialAdmin 仅在无账号时创建` |
| design/backend.md | `D-012` 配置全部可改、密钥掩码 | `backend-020` | `test::密钥字段掩码返回，更新同步 process.env 并标注需重启项` |
| design/backend.md | `D-013` 视觉来源按 Element Plus 推导 | 前端侧 owner（`design/frontend.md`） | 前端 Visual Checks 逐项核对 |
| design/backend.md | `D-014` 立即生效 + 标注需重启项 | `backend-007`, `backend-012`, `backend-020` | `test::RESTART_REQUIRED_KEYS 含启动期与 pi 读取的键，不含日志级别` |
| design/backend.md | `D-015` prompt 删除即删回落 default | `backend-008`, `backend-021` | `test::remove 后该仓库回落 default` |
| design/backend.md | `D-016` 前端产物 `web/dist` + SPA fallback | `backend-022` | `test::SPA fallback 排除 /api 与 /review 前缀` |
| design/backend.md | `D-017` GitlabClient 端口扩展 3 方法 | `backend-015` | `test::postDiscussion 发送 body 与 position` |
| design/backend.md | `D-018` 单连接 + WAL + busy_timeout | `backend-004` | `test::openDatabase 建四张表并启用 WAL` |

## Backend Boundary 检查

| Backend boundary | 实际涉及内容 | Tasks | Verification |
| --- | --- | --- | --- |
| 数据模型与迁移 | 四张表、索引、WAL、无版本化迁移 | `backend-004`~`backend-008` | `node --test test/infrastructure/sqlite/database.test.ts` 与四个仓储测试 |
| service/business logic | 评审记录写入、prompt 解析、行内评论发布编排 | `backend-009`, `backend-010`, `backend-011`, `backend-016` | `node --test test/application/review-pipeline.test.ts` |
| serializer/schema | AI 输出 JSON 解析、HTTP 入参校验、响应形状 | `backend-002`, `backend-018`, `backend-019`, `backend-020`, `backend-021` | `test::parseReviewJson`、`test::非法 pageSize 返回 400` |
| ViewSet/API action | 五组 `/api` 路由共 17 条端点 | `backend-017`~`backend-021` | `node --test test/interfaces/http/api.test.ts` |
| URL/router | 路由注册与 SPA fallback 前缀隔离 | `backend-014`, `backend-022` | `test::SPA fallback 排除 /api 与 /review 前缀` |
| IAM/permission | Bearer 鉴权、管理员删除约束 | `backend-014`, `backend-018` | `test::无令牌与错误令牌访问管理接口均返回 401`、`test::删除自己与删除最后一个管理员均返回 400` |
| 外部服务调用 | GitLab versions / discussions API | `backend-015`, `backend-011`, `backend-016` | `node --test test/infrastructure/gitlab/gitlab-client.test.ts` |
| 单元测试 | 每个任务的 Step 1/Step 2 失败测试 | 全部任务 | `npm test` |
| 负向测试 | 越界行号、非法令牌、重复用户名、删除约束、head 不一致 | `backend-011`, `backend-014`, `backend-016`, `backend-018`, `backend-019` | 对应任务的 Step 1 用例 |
| 注释自审 | 新增公开对象契约说明与取舍原因 | 全部任务的 Step 4 自审段 | 对照 `${CLAUDE_PLUGIN_ROOT}/skills/_shared/engineering-quality.md` |

## 设计缺口

无。proposal 的 15 个变更点与 design-backend 的 18 项决策全部映射到任务。
