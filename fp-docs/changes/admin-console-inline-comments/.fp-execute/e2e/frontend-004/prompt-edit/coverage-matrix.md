# E2E Coverage Matrix — frontend-004 / prompt-edit

- **Task ID**: `frontend-004`
- **Case ID**: `prompt-edit`
- **UI Delivery Level**: `business-flow`
- **E2E Applicability**: `REQUIRED`
- **Mocked Core API**: `false`
- **Runtime route**: `/prompts`

## Execution Record

| 项 | 值 |
| --- | --- |
| Executed command | `playwright-cli goto/click/fill/eval/reload/screenshot`（真实 Chromium） |
| Environment identity | 本地 `node src/bootstrap.ts`，`PORT=5101`，`DB_PATH=./data/e2e.db`（真实 SQLite） |
| Destination | `http://127.0.0.1:5101/prompts` |
| Start | 2026-10-07T23:25:03+08:00 |
| End | 2026-10-07T23:29:00+08:00 |
| Attempts | 2（第 1 次发现实现缺陷并修复，见下；第 2 次通过） |
| Test IDs | prompt-create、prompt-persist-reload、prompt-edit-backfill、prompt-duplicate-409、prompt-delete-fallback |
| Artifacts | `current.png`、快照文件 |
| Coverage matrix reference | 本文件 |
| Cleanup | 已通过 UI 删除测试数据 `e2e-group/e2e-repo`（删除后表格为空），并清理直连 API 创建的 `api-direct/test` |

## 真实核心 API 与持久化证明

- 创建：UI 提交 → `POST /api/prompts` → 真实 SQLite 写入 → 表格出现新行。
- 持久化：`playwright-cli reload` 后该行仍在，证明写入落库而非前端内存。
- 删除：UI 二次确认 → `DELETE /api/prompts/:id` → 表格回到空态。

未使用 `page.route`、MSW、fixture、localStorage 业务数据注入或数据库 seed。

## 本轮发现的实现缺陷（已修复并回归）

**现象**：点击「保存」后弹窗不关闭、无任何提示、列表无新行。

**根因**：`PromptEditor.vue` 原先绑定整个表单对象（`v-model="form"`），父组件用
`reactive()` 声明的 `form` 是 `const`，`v-model` 生成的整体赋值 `form = $event` 无法
生效，文本域输入静默丢失，随后表单校验判定 prompt 为空并提前返回。

**修复**：改为按字段绑定（`v-model:system-prompt` / `v-model:user-prompt`），只写属性
不整体赋值。修复后一次通过，并用「重新构建 + 刷新页面 + 重跑全流程」验证。

该缺陷只有真实浏览器 E2E 能发现：单元测试与接口测试都不经过组件双向绑定。

## Source-derived Conditions

| 条件 | 状态 | 证据 |
| --- | --- | --- |
| 新建 prompt（happy path） | `covered` | 提示「已创建，下一次评审即使用新 prompt」，表格出现新行 |
| 刷新后持久 | `covered` | `reload` 后行仍在，`updatedAt` 时间戳保持 |
| 编辑回填 | `covered` | system/user 两个文本域回填原值；项目名输入框在编辑态禁用 |
| 占位符提示 | `covered` | 提示文案渲染「可用占位符：{diffs_text}（代码变更，必填）与 {commits_text}（提交历史）」 |
| 校验与边界 | `covered` | 空项目名 / 空 prompt 均提前拦截并给出中文提示；后端同样校验（接口用例覆盖） |
| 冲突（validation boundary） | `covered` | 重复 repository 提交后显示后端文案「prompt e2e-group/e2e-repo 已存在」（HTTP 409） |
| 删除与回落 | `covered` | 二次确认后删除成功，提示「已删除，该项目回落到 default prompt」，列表回到空态 |
| 加载、空态、错误态 | `covered` | 空库显示「暂无 prompt，可先点『从 yaml 导入』」；错误经 `ElMessage.error` 显示后端文案 |
| 权限与隔离 | `covered` | 所有请求携带 Bearer 令牌；未认证 401 由 `frontend-002` 覆盖 |
| 列表不含正文 | `covered` | 打开编辑时才按 id 拉完整正文（列表接口摘要字段由接口用例断言不含 `systemPrompt`） |
| 分页/排序 | `N/A` | prompt 数量为个位数，接口按 `repository` 升序返回，页面不分页 |

## Notes

- 视觉通道状态记 `CANNOT_VERIFY`（依据 `D-019`）。
- 「保存后下一次评审即用新 prompt」的后端语义由 `test/infrastructure/sqlite/prompt-repo.test.ts`
  与 `test/application/review-pipeline.test.ts` 的「数据库命中 prompt 时不使用 yaml」用例覆盖。
