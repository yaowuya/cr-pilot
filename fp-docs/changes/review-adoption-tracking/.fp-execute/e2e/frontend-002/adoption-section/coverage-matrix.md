# 采纳情况区块 — E2E 覆盖矩阵

- Task: `frontend-002`
- Case: `adoption-section`
- UI Delivery Level: `static-only`
- E2E Applicability: `N/A`

| 条件 | 状态 | 理由 |
| --- | --- | --- |
| 正常展示（有采纳数据） | `N/A` | 只读统计展示，无交互流程；按 static-only 契约不做前端 E2E |
| 加载态 | `N/A` | 由 `v-loading` 提供，行为来自现有页面模式 |
| 空态 | `N/A` | `el-empty` 静态展示，已在模板中实现 |
| 错误态 | `N/A` | 请求失败仅提示，不涉及用户可操作分支 |
| 权限隔离 | `N/A` | 复用 `/api` 登录鉴权，本次未新增权限分支 |
| 持久化与导航 | `N/A` | 无写操作、无路由变化 |

## 说明

本区块是纯只读展示：没有表单、没有写操作、不跨业务边界。按 `ui-e2e-contract.md`，`static-only` 可在有证据理由时记录 E2E `N/A`。

因此本 case 不需要真实浏览器 E2E，也就不存在 mock 违规问题。视觉验收的结论见同目录上级的 `visual/frontend-002/adoption-section/manifest.md`，当前为 `CANNOT_VERIFY`（缺少 approved 参考图）。
