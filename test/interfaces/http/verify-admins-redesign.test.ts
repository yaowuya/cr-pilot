import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const verifySource = readFileSync(new URL("../../../web/src/views/VerifyView.vue", import.meta.url), "utf8");
const adminsSource = readFileSync(new URL("../../../web/src/views/AdminsView.vue", import.meta.url), "utf8");

/** 压平模板与样式空白，让断言锁定页面契约而非格式化细节。 */
function compact(source: string): string {
  return source.replace(/\s+/g, " ").trim();
}

test("功能自检采用 Framed Sheet 双通道工作台，并呈现本会话最近结果与安全边界", () => {
  const source = compact(verifySource);

  assert.match(source, /class="verify-workbench"/);
  assert.match(source, /aria-labelledby="ai-channel-title"/);
  assert.match(source, /aria-labelledby="wecom-channel-title"/);
  assert.match(source, /最近自检/);
  assert.match(source, /recentTasks/);
  assert.match(source, /本次页面会话/);
  assert.match(source, /不会写入真实 MR/);
  assert.match(source, /不接触完整(?:机器人地址|密钥)/);
  assert.match(source, /\.verify-workbench\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(source, /@media \(max-width:\s*960px\)[^{]*\{[\s\S]*?\.verify-workbench\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
});

test("功能自检保留独立加载重试、双任务互斥、预览实发分流与轮询清理", () => {
  const source = compact(verifySource);

  assert.match(source, /v-if="botsError"[\s\S]{0,280}@click="loadBots">重试/);
  assert.match(source, /v-if="contactsError"[\s\S]{0,280}@click="loadContacts">重试/);
  assert.match(source, /开始验证 AI 评审[\s\S]{0,160}:disabled="wecomRunning"|:disabled="wecomRunning"[\s\S]{0,160}开始验证 AI 评审/);
  assert.match(source, /仅预览[\s\S]{0,220}:disabled="aiRunning \|\| !canVerifyWecom"|:disabled="aiRunning \|\| !canVerifyWecom"[\s\S]{0,220}仅预览/);
  assert.match(source, /function previewWecom\(\)[\s\S]{0,80}submitWecom\(false\)/);
  assert.match(source, /function sendWecom\(\)[\s\S]{0,80}submitWecom\(true\)/);
  assert.match(source, /<el-popconfirm[\s\S]{0,280}@confirm="sendWecom"/);
  assert.match(source, /setInterval\([\s\S]*?查询结果失败或任务已过期/);
  assert.match(source, /onBeforeUnmount\([\s\S]{0,140}disposed = true;[\s\S]{0,80}stopPolling\(\)/);
});

test("管理员页以账号台账配套权限边界和账号安全说明，并在页面内承接后端错误", () => {
  const source = compact(adminsSource);

  assert.match(source, /class="[^"]*\baccount-ledger\b/);
  assert.match(source, /控制台账号/);
  assert.match(source, /\{\{\s*admins\.length\s*\}\}\s*个账号/);
  assert.match(source, /class="admin-support-grid"/);
  assert.match(source, /权限边界/);
  assert.match(source, /账号安全/);
  assert.match(source, /ADMIN_USERNAME/);
  assert.match(source, /非管理员请求返回 403/);
  assert.match(source, /当前账号[\s\S]{0,120}禁止删除/);
  assert.match(source, /系统至少保留一个可用账号/);
  assert.match(source, /loadError/);
  assert.match(source, /createError/);
  assert.match(source, /deleteError/);
  assert.match(source, /\.admin-support-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(source, /@media \(max-width:\s*960px\)[^{]*\{[\s\S]*?\.admin-support-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
});

test("管理员新增、删除与权限展示保留校验和服务端兜底语义", () => {
  const source = compact(adminsSource);

  assert.match(source, /username:\s*\[[\s\S]{0,260}required:\s*true[\s\S]{0,180}pattern:\s*\/\\S\//);
  assert.match(source, /password:\s*\[[\s\S]{0,300}min:\s*MIN_PASSWORD_LENGTH/);
  assert.match(source, /formRef\.value\?\.validate\(\)[\s\S]{0,140}if \(!valid\) return/);
  assert.match(source, /v-if="row\.username === selfName" class="delete-disabled">不可删除/);
  assert.match(source, /if \(deletingId\.value !== null \|\| row\.username === selfName\.value\) return/);
  assert.match(source, /确认删除账号「\$\{row\.username\}」/);
  assert.match(source, /loadError\.value = isApiError\(error\) \? error\.message/);
  assert.match(source, /createError\.value = isApiError\(error\) \? error\.message/);
  assert.match(source, /deleteError\.value = isApiError\(error\) \? error\.message/);
  assert.match(source, /let loadRequestGeneration = 0/);
  assert.match(source, /const request = \+\+loadRequestGeneration[\s\S]{0,220}if \(request !== loadRequestGeneration\) return[\s\S]{0,80}admins\.value = result/);
  assert.doesNotMatch(source, /async function load\(\)[\s\S]{0,80}if \(loading\.value\) return/);
  assert.match(source, /row\.isAdmin[\s\S]{0,140}>管理员<\/el-tag>/);
});
