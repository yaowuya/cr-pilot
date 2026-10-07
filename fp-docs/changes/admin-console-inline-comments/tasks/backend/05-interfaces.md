# Backend Interface Ledger

本文件是后端接口账本的唯一 owner。每个任务的 `**Interfaces:**` 必须与本表一致；后续任务只能消费本表已有接口、现有代码中的接口，或由自己任务明确创建的接口，不得临时发明未声明的函数、字段或路由。

## Ledger

| Interface | Owner Task | Contract | Consumers | Verification |
| --- | --- | --- | --- | --- |
| `parseDiffLines(diff: string): DiffLineSets` | `backend-001` | 返回 `{added:Set<number>, removed:Set<number>, visibleNew:Set<number>, visibleOld:Set<number>}` | `backend-016` | `test/domain/inline-comment.test.ts` diff 行号解析 |
| `parseReviewJson(text: string): ParsedReview \| null` | `backend-002` | 返回 `{reviewedHeadSha, summaryBody, findings:[{id,severity,path,body,lineKey,line}]}`；校验失败返回 `null` | `backend-016` | `test/domain/inline-comment.test.ts` JSON 解析 |
| `buildMarker(headSha: string, itemId: string): string` | `backend-002` | 返回 `<!-- marker:{headSha}:{itemId} -->` | `backend-016` | `test/domain/inline-comment.test.ts` marker |
| `buildPosition(input): DiscussionPosition` | `backend-002` | 返回 `{position_type:"text", base_sha, start_sha, head_sha, old_path, new_path, new_line\|old_line}` | `backend-015`, `backend-016` | `test/domain/inline-comment.test.ts` position |
| `hashPassword(plain: string, salt: string): string` | `backend-003` | 返回 `scrypt$<saltHex>$<hashHex>` | `backend-007` | `test/shared/crypto.test.ts` 哈希 |
| `verifyPassword(plain: string, salt: string, stored: string): boolean` | `backend-003` | 定长比较，返回布尔 | `backend-019` | `test/shared/crypto.test.ts` 校验 |
| `generateToken(): string` | `backend-003` | 返回 32 字节随机串的 hex | `test/shared/crypto.test.ts` | `test/shared/crypto.test.ts` 令牌 |
| `deriveToken(username: string, salt: string): string` | `backend-003` | 由用户名与盐派生确定性令牌 | `backend-014`, `backend-019` | `test/shared/crypto.test.ts` 派生 |
| `openDatabase(path: string): DatabaseSync` | `backend-004` | 打开连接、设置 WAL/busy_timeout、建四表 | `backend-005`~`backend-008`, `backend-020` | `test/infrastructure/sqlite/database.test.ts` |
| `createReviewRecordRepository(db): ReviewRecordRepository` | `backend-005` | `insert` / `getList` / `getStats` 三个同步方法 | `backend-013`, `backend-020` | `test/infrastructure/sqlite/review-record-repo.test.ts` |
| `createAdminRepository(db, salt): AdminRepository` | `backend-006` | `create` / `list` / `delete` / `findByUsername` / `ensureInitialAdmin` / `count` | `backend-014`, `backend-018`, `backend-020` | `test/infrastructure/sqlite/admin-repo.test.ts` |
| `createConfigRepository(db): ConfigRepository` | `backend-007` | `list` / `setAll` / `clear` | `backend-021`, `backend-020` | `test/infrastructure/sqlite/config-repo.test.ts` |
| `createPromptRepository(db): PromptRepository` | `backend-008` | `resolve` / `list` / `get` / `create` / `update` / `remove` / `importFromDir` | `backend-013`, `backend-022` | `test/infrastructure/sqlite/prompt-repo.test.ts` |
| `RESTART_REQUIRED_KEYS: ReadonlySet<string>` | `backend-007` | 需重启才生效的键集合 | `backend-021` | `test/interfaces/http/api.test.ts` 标注需重启 |
| `GitlabClient.getMergeRequestVersions(pid, iid, url?, token?): Promise<DiffRefs>` | `backend-015` | 返回 `{baseSha, startSha, headSha}`，取 `versions[0]` | `backend-016` | `test/infrastructure/gitlab/gitlab-client.test.ts` versions |
| `GitlabClient.postDiscussion(pid, iid, body, position, url?, token?): Promise<Discussion>` | `backend-015` | POST `/discussions`，请求体含 `body` 与 `position` | `backend-016` | `test/infrastructure/gitlab/gitlab-client.test.ts` discussions |
| `GitlabClient.getDiscussions(pid, iid, url?, token?): Promise<Discussion[]>` | `backend-015` | GET `/discussions`，需处理分页 | `backend-016` | `test/infrastructure/gitlab/gitlab-client.test.ts` discussions 回读 |
| `ReviewRecordRepository.insert(record)` | `backend-005` | 写一条明细；失败记录 `result="failed"` 且 `errorMessage` 非空 | `backend-013` | `test/application/review-pipeline.test.ts` 失败也落记录 |
| `PromptRepository.resolve(repositoryFullName?)` | `backend-008` | 按「项目全名 → default」回落，未命中返回 `undefined` | `backend-013`, `backend-023` | `test/infrastructure/sqlite/prompt-repo.test.ts` |
| `POST /api/auth/login` | `backend-019` | 入 `{username, password}`；出 `{token, username}`；失败 401 且响应体不区分原因 | 前端 `api/client.ts` | `test/interfaces/http/api.test.ts` 登录 |
| `GET /api/auth/me` | `backend-019` | 出 `{username}` | 前端路由守卫 | `test/interfaces/http/api.test.ts` me |
| `POST /api/auth/logout` | `backend-019` | 出 `{ok:true}` | 前端退出登录 | `test/interfaces/http/api.test.ts` logout |
| `GET /api/admins` | `backend-018` | 出 `[{id, username, createdAt}]`，不含密码哈希 | 前端 AdminsView | `test/interfaces/http/api.test.ts` 管理员 |
| `POST /api/admins` | `backend-018` | 入 `{username, password}`；重复 409；密码过短 400 | 前端 AdminsView | `test/interfaces/http/api.test.ts` 管理员 |
| `DELETE /api/admins/:id` | `backend-018` | 删自己 400；删最后一个管理员 400 | 前端 AdminsView | `test/interfaces/http/api.test.ts` 删除约束 |
| `GET /api/reviews` | `backend-020` | 出 `{items,total,page,pageSize}`；`pageSize` 上限 200，非法参数 400 | 前端 ReviewsView | `test/interfaces/http/api.test.ts` 分页 |
| `GET /api/reviews/stats` | `backend-020` | 出 `{total,projectCount,committerCount,avgScore,daily[]}` | 前端 ReviewsView | `test/interfaces/http/api.test.ts` 统计 |
| `GET /api/config` | `backend-021` | 出 `{items:[{key,value,masked,restartRequired}]}`；密钥掩码 | 前端 ConfigView | `test/interfaces/http/api.test.ts` 掩码 |
| `PUT /api/config` | `backend-021` | 入 `{items:[{key,value}]}`；同步 `process.env`；出 `{items, restartRequired[]}` | 前端 ConfigView | `test/interfaces/http/api.test.ts` 立即生效 |
| `GET /api/prompts` | `backend-022` | 出摘要列表，不含完整正文 | 前端 PromptsView | `test/interfaces/http/api.test.ts` prompt 列表 |
| `GET /api/prompts/:id` | `backend-022` | 出完整记录 | 前端 PromptsView | 同上 |
| `POST /api/prompts` | `backend-022` | `repository` 重复 409 | 前端 PromptsView | 同上 |
| `PUT /api/prompts/:id` | `backend-022` | 保存即生效 | 前端 PromptsView | 同上 |
| `DELETE /api/prompts/:id` | `backend-022` | 删除后 resolve 回落 default | 前端 PromptsView | `test::删除项目 prompt 后 resolve 回落 default` |
| `POST /api/prompts/import` | `backend-022` | 出 `{imported, skipped}` | 运维一次性导入 | `test/interfaces/http/api.test.ts` 导入 |
| `createAuthMiddleware(deps): RequestHandler` | `backend-014` | 校验 Bearer 令牌，无效返回 401 | 所有 `/api/*` 路由 | `test::无令牌访问管理接口返回 401` |
| `AppConfig` 新增字段 | `backend-012` | `dbPath` / `adminUsername` / `adminPassword` / `authSalt` | `backend-020`, 各仓储 | `test/shared/config.test.ts` |
| `applyConfigOverrides(env, overrides): void` | `backend-012` | 把 DB 覆盖写入环境变量（DB 优先） | `backend-020` | `test::启动时数据库覆盖值优先于环境变量` |

## Contract Checks

- 所有 `/api/*` 除登录外必须携带 `Authorization: Bearer <token>`；无令牌、错误令牌均返回 401。
- `GET /api/config` 的掩码规则：键名含 `KEY`/`SECRET`/`TOKEN`/`PASSWORD` 时，值长度大于 8 显示前 4 与后 4，中间 `****`；否则全掩码。
- SPA fallback 只处理非 `/api`、非 `/review` 前缀的未匹配路径；未匹配 API 返回 404 JSON。
- `reviewed_head_sha` 与当前 `head_sha` 不一致时，全部 finding 并入汇总评论，不发行内评论。
- `score` 为 `NULL` 表示未解析出分数，不计入 `avgScore`。
