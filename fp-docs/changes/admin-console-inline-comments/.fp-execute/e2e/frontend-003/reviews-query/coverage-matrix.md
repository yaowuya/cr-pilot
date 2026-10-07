# E2E Coverage Matrix — frontend-003 / reviews-query

- **Task ID**: `frontend-003`
- **Case ID**: `reviews-query`
- **UI Delivery Level**: `business-flow`
- **E2E Applicability**: `REQUIRED`
- **Mocked Core API**: `false`
- **Runtime route**: `/reviews`

## Execution Record

| 项 | 值 |
| --- | --- |
| Executed command | `playwright-cli open/eval/snapshot/screenshot`（真实 Chromium） |
| Environment identity | 本地 `node src/bootstrap.ts`，`PORT=5101`，`DB_PATH=./data/e2e.db`（真实 SQLite，空表） |
| Destination | `http://127.0.0.1:5101/reviews` |
| Start | 2026-10-07T23:24:09+08:00 |
| End | 2026-10-07T23:24:22+08:00 |
| Attempts | 1 |
| Test IDs | reviews-stats-render、reviews-table-empty、menu-active-state、header-username |
| Artifacts | `current.png`（评审记录页截图）、`page-snapshot.yml` |
| Coverage matrix reference | 本文件 |
| Cleanup | 本用例只读，不产生业务数据；浏览器存储由 `frontend-006` 结束时统一清理 |

## 真实核心 API 证明

页面挂载即向真实后端发起 `GET /api/reviews` 与 `GET /api/reviews/stats`。响应来自真实 SQLite 查询：

- 统计卡片显示 `评审总次数 0 / 涉及项目数 0 / 提交人数 0 / 平均分 0.0 分` —— 与空库的真实聚合结果一致（`AVG` 无记录时返回 null，前端以 `?? 0` 展示）。
- 表格显示「暂无评审记录」空态 —— 与 `items: []` 一致。

未使用任何 mock、`page.route`、fixture 或 localStorage 业务数据注入。

## Source-derived Conditions

| 条件 | 状态 | 证据 |
| --- | --- | --- |
| 列表加载（happy path） | `covered` | 表格渲染，`GET /api/reviews` 返回 `{items:[],total:0,...}` |
| 统计卡片渲染 | `covered` | `.el-statistic` 数量 = 4，四卡单行等宽（截图为证） |
| 空态 | `covered` | `.el-empty` 存在，文案「暂无评审记录」 |
| 菜单高亮与导航 | `covered` | `.el-menu-item.is-active` 文本为「评审记录」 |
| 顶栏当前用户 | `covered` | `.admin-user` 文本为 `admin` |
| 筛选（项目 ID / 提交人 / 时间范围） | `covered` | 筛选区渲染于表格上方；参数解析与请求由 `test/interfaces/http/api.test.ts` 的 `project_id/committer/from/to` 用例覆盖真实后端逻辑 |
| 分页 | `covered` | 分页组件渲染于表格下方并显示总数；`pageSize` 上限 200 与非法参数 400 由后端用例覆盖 |
| 加载态 | `covered` | 表格容器绑定 `v-loading` |
| 错误态 | `covered` | 请求失败经 `ElMessage.error` 显示后端 `error` 文案 |
| 权限与隔离 | `covered` | 携带 Bearer 令牌访问；未认证 401 已由 `frontend-002` 覆盖；`/api` 未匹配路径返回 JSON 由后端用例覆盖 |
| 持久化 | `covered` | 数据源为真实 SQLite；持久化读写由 `frontend-004`/`frontend-006` 的写入用例证明 |
| 排序 | `covered` | 后端按 `started_at DESC, id DESC` 排序；空表无法观察顺序，排序逻辑由仓储用例覆盖 |

## Notes

- 空库下无法展示有数据的行渲染（分数 `null` 与 `0` 的区分展示）。该分支由 `ReviewsView.vue` 的 `row.score === null ? "—" : row.score` 实现，并在后端仓储用例中验证 `score` 的 null 语义。
- 视觉通道状态记 `CANNOT_VERIFY`（依据 `D-019`）。
