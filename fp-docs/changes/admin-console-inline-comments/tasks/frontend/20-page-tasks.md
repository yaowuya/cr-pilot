# Frontend Page Tasks

> **For agentic workers:** REQUIRED FLOW: Use `fp-execute` to implement this plan task-by-task. Only task markers use checkbox (`- [ ] **Task frontend-NNN: ...**`) syntax for tracking; substeps are plain ordered instructions.

- [x] **Task frontend-003: 后台骨架与评审记录页**

**Files:**
- Create: `web/src/layouts/AdminLayout.vue`、`web/src/views/ReviewsView.vue`
- Test: 浏览器 E2E，证据目录 `.fp-execute/e2e/frontend-003/reviews-query/`

**Reasoning:**
- `design/frontend.md#组件映射` 要求侧边菜单 + 顶栏的后台骨架承载全部页面；评审记录页是用户最常访问的入口（`/` 重定向到此），先实现骨架与该页可验证导航与真实数据读取。

**Depends on**: frontend-002, backend-019（后端评审记录接口）

**Interfaces:**
- Consumes: `GET /api/reviews`、`GET /api/reviews/stats`；`AdminLayout` 组件树契约；四菜单项路由契约
- Produces: `AdminLayout.vue`、`ReviewsView.vue`；侧边菜单四项、顶栏下拉退出
- Contract checks: 当前路由高亮；统计四卡单行等宽；筛选与分页触发真实请求；空态与错误提示可观察

**UI Delivery Level**: `business-flow`；**E2E Applicability**: `REQUIRED`；`Mocked Core API: false`

**Step 1: Write the failing test**

```typescript
// 登录后进入 /reviews，展示统计卡片与表格
await loginAsAdmin(page);
await expect(page.locator(".el-menu-item.is-active")).toContainText("评审记录");
const cards = page.locator(".el-statistic");
await expect(cards).toHaveCount(4);

// 按提交人筛选触发真实请求并更新表格
await page.fill('input[placeholder="提交人"]', "e2e-user");
await page.click('button:has-text("查询")');
await page.waitForResponse((r) => r.url().includes("/api/reviews?") && r.url().includes("committer=e2e-user"));
await expect(page.locator(".el-table__empty-text")).toBeVisible();

// 顶栏下拉退出登录
await page.click(".el-dropdown");
await page.click('text=退出登录');
await expect(page).toHaveURL(/\/login/);
```

**Step 2: Run test to verify it fails**

Run: `playwright-cli run web/e2e/reviews-query.spec.ts`
Expected: FAIL，因骨架与页面尚未实现

**Step 3: Write minimal implementation**

`AdminLayout.vue` 用 `el-container` / `el-aside`（200px）/ `el-header`（60px）/ `el-main`；侧边 `el-menu` 的四项 `router-link` 分别指向 `/reviews`、`/prompts`、`/config`、`/admins`；顶栏 `el-dropdown` 显示 `auth` 中的用户名，下拉仅「退出登录」，点击后 `auth.logout()` 并跳 `/login`。

`ReviewsView.vue` 分两块：顶部 `el-row` 四个 `el-col` 各含一个 `el-statistic`（总次数、项目数、提交人数、平均分），下方 `el-card` 内含筛选 `el-form`（项目 ID、提交人、日期范围）与 `el-table`，底部 `el-pagination`。

数据获取在 `onMounted` 并发请求列表与统计；筛选或分页变更时只重新请求列表（统计不受分页影响）。表格容器加 `v-loading`，`items` 为空时展示 `el-empty`，请求失败用 `ElMessage.error` 显示后端文案。

日期范围用 `el-date-picker` 的 `daterange`，提交时转为毫秒时间戳传入 `from`/`to`。

**Step 4: Run test to verify it passes**

Run: `playwright-cli run web/e2e/reviews-query.spec.ts`
Expected: PASS

**Step 5: Record E2E evidence**

在 `.fp-execute/e2e/frontend-003/reviews-query/` 写 `coverage-matrix.md`，覆盖：列表加载、筛选、分页、空态、错误态、退出登录。记录测试账号与清理动作（本任务只读，无需清理业务数据，但需清除浏览器存储）。

**Step 6: Commit**

```bash
git add web/src/layouts web/src/views/ReviewsView.vue web/e2e .fp-execute/e2e/frontend-003
git commit -m "feat: 后台骨架与评审记录页，含统计、筛选与分页"
```

- [x] **Task frontend-004: prompt 管理页**

**Files:**
- Create: `web/src/components/PromptEditor.vue`、`web/src/views/PromptsView.vue`
- Test: 浏览器 E2E，证据目录 `.fp-execute/e2e/frontend-004/prompt-edit/`

**Reasoning:**
- proposal 变更点 13、14 要求 prompt 增删改查与保存即生效。这是唯一会改变真实评审行为的管理页面，需证明端到端生效。

**Depends on**: frontend-003, backend-021（后端 prompt 接口）

**Interfaces:**
- Consumes: `/api/prompts` 全部端点；`PromptEditor` 双栏契约与占位符提示
- Produces: `PromptEditor.vue`、`PromptsView.vue`；表格摘要列与编辑弹窗
- Contract checks: 列表不含正文（需点开才加载）；保存后刷新内容仍在；`repository` 重复显示 409 错误；删除二次确认

**UI Delivery Level**: `business-flow`；**E2E Applicability**: `REQUIRED`；`Mocked Core API: false`

**Step 1: Write the failing test**

```typescript
await loginAsAdmin(page);
await page.goto("/prompts");
// 新建项目 prompt
await page.click('button:has-text("新建")');
await page.fill('input[placeholder="项目全名"]', "e2e-group/e2e-repo");
const areas = page.locator(".el-dialog textarea");
await areas.nth(0).fill("你是资深工程师，评审以下变更。");
await areas.nth(1).fill("请评审：{diffs_text}\n提交：{commits_text}");
await page.click('.el-dialog button:has-text("保存")');
await expect(page.locator(".el-message--success")).toBeVisible();

// 刷新后仍在
await page.reload();
await expect(page.locator('.el-table__row:has-text("e2e-group/e2e-repo")')).toBeVisible();

// 占位符提示可见
await page.click('.el-table__row:has-text("e2e-group/e2e-repo") .el-button:has-text("编辑")');
await expect(page.locator("text={diffs_text}")).toBeVisible();
await expect(page.locator("text={commits_text}")).toBeVisible();
```

**Step 2: Run test to verify it fails**

Run: `playwright-cli run web/e2e/prompt-edit.spec.ts`
Expected: FAIL，因页面尚未实现

**Step 3: Write minimal implementation**

`PromptEditor.vue` 接收 `modelValue`（`{systemPrompt, userPrompt}`）并 `emit('update:modelValue', ...)`；两个 `el-input type="textarea"` 上下排列，`user` 文本域下方用 `el-text type="info"` 展示 `{diffs_text}` 与 `{commits_text}` 两个占位符。

`PromptsView.vue` 用 `el-table` 展示摘要列（`repository`、`updatedAt`、是否配置企微 webhook、操作），点击「编辑」时按需 `GET /api/prompts/:id` 拉完整正文再打开弹窗——列表接口刻意不返回正文，避免一次拉取全部 prompt（见 `#API 契约`）。

删除用 `el-popconfirm` 二次确认；409 重复时 `ElMessage.error` 显示后端文案。

**Step 4: Run test to verify it passes**

Run: `playwright-cli run web/e2e/prompt-edit.spec.ts`
Expected: PASS

**Step 5: Record E2E evidence**

在 `.fp-execute/e2e/frontend-004/prompt-edit/` 写 `coverage-matrix.md`，覆盖：新建、编辑保存、刷新持久、重复 repository 409、删除、占位符提示。**必须清理**：通过 UI 删除本任务创建的 `e2e-group/e2e-repo`，并在矩阵中记录清理结果。

**Step 6: Commit**

```bash
git add web/src/components web/src/views/PromptsView.vue web/e2e .fp-execute/e2e/frontend-004
git commit -m "feat: prompt 管理页，含双栏编辑器与按需加载正文"
```

- [x] **Task frontend-005: 环境变量管理页**

**Files:**
- Create: `web/src/views/ConfigView.vue`
- Test: 浏览器 E2E，证据目录 `.fp-execute/e2e/frontend-005/config-edit/`

**Reasoning:**
- proposal 变更点 10 要求环境变量查询与更新；`D-012` 密钥掩码、`D-014` 立即生效并标注需重启项，三者都在这一页可观察。

**Depends on**: frontend-003, backend-020（后端配置接口）

**Interfaces:**
- Consumes: `GET /api/config`、`PUT /api/config`；密钥掩码契约与需重启标注契约
- Produces: `ConfigView.vue`；逐行编辑表格与保存反馈
- Contract checks: `masked` 项默认显示掩码且点击可切换；保存后响应含 `restartRequired` 并以提示告知用户重启

**UI Delivery Level**: `business-flow`；**E2E Applicability**: `REQUIRED`；`Mocked Core API: false`

**Step 1: Write the failing test**

```typescript
await loginAsAdmin(page);
await page.goto("/config");
// 密钥项显示掩码
const keyRow = page.locator('.el-table__row:has-text("LLMGW_API_KEY")');
await expect(keyRow.locator("input")).toHaveValue(/sk-\*{4}/);
// 修改可热更新的项并保存
await page.locator('.el-table__row:has-text("QUEUE_CONCURRENCY") input').fill("7");
await page.click('button:has-text("保存")');
await expect(page.locator(".el-message--success")).toBeVisible();
// 修改需重启的项后响应标注
await page.locator('.el-table__row:has-text("PORT") input').fill("6001");
await page.click('button:has-text("保存")');
await expect(page.locator(".el-message--warning")).toContainText("重启");
```

**Step 2: Run test to verify it fails**

Run: `playwright-cli run web/e2e/config-edit.spec.ts`
Expected: FAIL，因页面尚未实现

**Step 3: Write minimal implementation**

`ConfigView.vue` 用 `el-table` 每行一个配置项：`key` 列为只读文本，`value` 列为 `el-input`，末列为「需重启」标记（由 `restartRequired` 字段决定显示 `el-tag`）。

`masked` 行的输入框 `show-password` 关闭并显示后端返回的掩码值，点击切换按钮只改变本地展示状态，**不请求后端**（后端不回传真实密钥，见 `#客户端契约`）。

保存时收集所有被修改的项，一次 `PUT /api/config` 提交；响应 `restartRequired` 非空时用 `ElMessage.warning` 告知「以下配置需重启容器后生效：<键列表>」。

**Step 4: Run test to verify it passes**

Run: `playwright-cli run web/e2e/config-edit.spec.ts`
Expected: PASS

**Step 5: Record E2E evidence**

在 `.fp-execute/e2e/frontend-005/config-edit/` 写 `coverage-matrix.md`，覆盖：密钥掩码展示、掩码切换、可热更新项保存、需重启项标注。**必须清理**：把 `QUEUE_CONCURRENCY` 与 `PORT` 恢复为测试前的值（`PORT` 的覆盖值会写入数据库，需通过 UI 改回或删除覆盖），并在矩阵中记录清理结果。

**Step 6: Commit**

```bash
git add web/src/views/ConfigView.vue web/e2e .fp-execute/e2e/frontend-005
git commit -m "feat: 环境变量管理页，含密钥掩码与需重启标注"
```

- [x] **Task frontend-006: 管理员账号管理页**

**Files:**
- Create: `web/src/views/AdminsView.vue`
- Test: 浏览器 E2E，证据目录 `.fp-execute/e2e/frontend-006/admin-crud/`

**Reasoning:**
- proposal 变更点 9 要求账号增删与两项删除约束。删除约束是真实的权限行为，必须在浏览器中证明后端确实拒绝。

**Depends on**: frontend-003, backend-018（后端管理员接口）

**Interfaces:**
- Consumes: `/api/admins` 全部端点；`el-popconfirm` 二次确认契约
- Produces: `AdminsView.vue`；账号表格与新增弹窗
- Contract checks: 列表不含密码字段；密码过短显示 400 错误；删除自己与删除最后一个显示 400 错误文案

**UI Delivery Level**: `business-flow`；**E2E Applicability**: `REQUIRED`；`Mocked Core API: false`

**Step 1: Write the failing test**

```typescript
await loginAsAdmin(page);
await page.goto("/admins");
// 新增账号
await page.click('button:has-text("新增")');
await page.fill('input[placeholder="用户名"]', "e2e-admin");
await page.fill('input[type="password"]', "e2e-password-long");
await page.click('.el-dialog button:has-text("保存")');
await expect(page.locator('.el-table__row:has-text("e2e-admin")')).toBeVisible();
// 删除自己被拒绝
await page.locator('.el-table__row:has-text("admin")').locator('button:has-text("删除")').click();
await page.locator(".el-popconfirm button:has-text("确定")").click();
await expect(page.locator(".el-message--error")).toContainText("不能删除当前登录");
// 删除测试账号
await page.locator('.el-table__row:has-text("e2e-admin")').locator('button:has-text("删除")').click();
await page.locator(".el-popconfirm button:has-text("确定")").click();
await expect(page.locator('.el-table__row:has-text("e2e-admin")')).toHaveCount(0);
```

**Step 2: Run test to verify it fails**

Run: `playwright-cli run web/e2e/admin-crud.spec.ts`
Expected: FAIL，因页面尚未实现

**Step 3: Write minimal implementation**

`AdminsView.vue` 用 `el-table` 展示 `username` 与 `createdAt`，操作列为「删除」按钮（`el-popconfirm` 二次确认）。新增用 `el-dialog` + `el-form`，提交时校验密码长度不小于 8（与后端一致，避免无谓的 400 往返）。

删除失败时用 `ElMessage.error` 显示后端文案——后端对「删自己」与「删最后一个管理员」返回不同的中文错误，前端原样透传即可，无需自行判断。

**Step 4: Run test to verify it passes**

Run: `playwright-cli run web/e2e/admin-crud.spec.ts`
Expected: PASS

**Step 5: Record E2E evidence**

在 `.fp-execute/e2e/frontend-006/admin-crud/` 写 `coverage-matrix.md`，覆盖：新增成功、密码过短 400、删除自己被拒、删除他人成功。**必须清理**：删除本任务创建的 `e2e-admin`（测试脚本已包含该步骤），并在矩阵中记录清理结果；若清理失败需在矩阵中标注并人工处理。

**Step 6: Commit**

```bash
git add web/src/views/AdminsView.vue web/e2e .fp-execute/e2e/frontend-006
git commit -m "feat: 管理员账号管理页，含删除约束的错误透传"
```
