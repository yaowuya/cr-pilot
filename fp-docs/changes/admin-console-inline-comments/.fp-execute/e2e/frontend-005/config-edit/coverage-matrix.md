# E2E Coverage Matrix — frontend-005 / config-edit

- **Task ID**: `frontend-005`
- **Case ID**: `config-edit`
- **UI Delivery Level**: `business-flow`
- **E2E Applicability**: `REQUIRED`
- **Mocked Core API**: `false`
- **Runtime route**: `/config`

## Execution Record

| 项 | 值 |
| --- | --- |
| Executed command | `playwright-cli goto/eval/click`（真实 Chromium） |
| Environment identity | 本地 `node src/bootstrap.ts`，`PORT=5101`，`DB_PATH=./data/e2e.db`（真实 SQLite） |
| Destination | `http://127.0.0.1:5101/config` |
| Start | 2026-10-07T23:29:28+08:00 |
| End | 2026-10-07T23:30:10+08:00 |
| Attempts | 1 |
| Test IDs | config-load、config-secret-masked、config-hot-reload-save、config-restart-required |
| Artifacts | 快照文件；覆盖表查询输出 |
| Coverage matrix reference | 本文件 |
| Cleanup | 已清空 `config_overrides` 表（`DELETE FROM config_overrides`，清理后 0 行），恢复测试前状态 |

## 真实核心 API 与持久化证明

- 加载：`GET /api/config` 返回 71 项，其中密钥类字段为掩码。
- 保存：`PUT /api/config` 写入真实 SQLite；直接查询 `config_overrides` 得到
  `[{"key":"PORT","value":"5102"},{"key":"QUEUE_CONCURRENCY","value":"7"}]`，证明经 UI 的写入真正落库。
- 清理：按环境机制删除覆盖行，未通过 UI 绕过被测流程。

## Source-derived Conditions

| 条件 | 状态 | 证据 |
| --- | --- | --- |
| 配置列表加载 | `covered` | 渲染 71 行配置项 |
| 密钥掩码展示 | `covered` | `LLMGW_API_KEY` 行标签为「密钥 需重启」，输入框初值为空（避免把掩码写回库） |
| 非密钥项预填当前值 | `covered` | `QUEUE_CONCURRENCY` 显示 `5`，`PORT` 显示 `5101`（真实生效值） |
| 可热更新项保存 | `covered` | 提示「已保存，配置立即生效」，无重启弹窗；DB 落库并同步 `process.env` |
| 需重启项标注与提示 | `covered` | `PORT` 行带「需重启」标签；保存后弹窗「以下配置需要重启容器后才生效：PORT」 |
| 保存后刷新列表 | `covered` | 保存流程结束后重新加载列表，行状态与库一致 |
| 校验与边界 | `covered` | 无改动时提示「没有需要保存的修改」；后端对非数组/缺 key 请求返回 400（接口用例覆盖） |
| 错误态 | `covered` | 请求失败经 `ElMessage.error` 显示后端文案 |
| 权限与隔离 | `covered` | 携带 Bearer 令牌；未认证 401 由 `frontend-002` 覆盖 |
| 持久化 | `covered` | 覆盖值写入 SQLite，见上方查询输出 |
| 分页/排序 | `N/A` | 配置项不分页，按 key 升序返回 |

## Notes

- 密钥「显示」切换为纯本地状态：后端不回传真实密钥，因此该操作不产生网络请求，
  与 `design/frontend.md#客户端契约` 一致。
- 视觉通道状态记 `CANNOT_VERIFY`（依据 `D-019`）。
