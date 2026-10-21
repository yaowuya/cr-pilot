# 采纳情况区块 — 视觉证据记录

- Task: `frontend-002`
- Case: `adoption-section`
- Runtime route: `/stats`
- UI Delivery Level: `static-only`
- 结论: `CANNOT_VERIFY`

## 为什么不是 PASS

本次变更无 approved Figma 设计稿，也没有用户提供的截图基线。`fp-docs/settings/frontend.md` 记录当前项目的视觉来源是「生产源码为基线」，不包含权威设计稿。

按 UI/E2E 契约，`reference.png` 必须来自 approved design source。没有参考图时无法执行 `VISUAL_REVIEW_PASS`，只能记为 `CANNOT_VERIFY`。用当前运行截图冒充参考图会制造「已验证」的假象，因此不做。

## 已完成的静态核对

| 检查项 | 依据 | 结果 |
| --- | --- | --- |
| 指标卡复用现有 `.stat-grid` / `.stat-card` 类 | `web/src/views/StatsView.vue:278` | 结构一致 |
| 只使用 `--el-*` / `--app-*` 变量，无硬编码品牌色 | `fp-docs/settings/frontend.md:33` | 已核对新增样式 |
| 采纳率为 null 时显示「—」 | `design/frontend.md#Visual Checks` | 模板已实现 |
| 排行表空态使用 `el-empty` | 现有 `AdminsView.vue:51` 惯例 | 已实现 |
| 图表经 `ChartCard` 封装，主题由组件处理 | `web/src/components/ChartCard.vue` | 已复用 |
| ≤768px 换行 | 现有断点 `AdminLayout.vue` | 三列网格未加窄屏覆盖 |

## 待人工确认（浏览器内）

1. 打开 `/stats`，确认「采纳情况」卡片与上方指标卡视觉对齐。
2. 切换亮/暗主题，确认新增卡片背景、文字、图表颜色正确。
3. 缩窄到 768px 以下，确认三个指标卡换行不溢出。
4. 无数据时确认采纳率显示「—」而非 `0.0%`。

## 缺口

- 未启动服务，未做浏览器截图与主题切换实测。
- 若需要正式视觉验收，需补充 approved 设计稿或截图基线后重新执行。
