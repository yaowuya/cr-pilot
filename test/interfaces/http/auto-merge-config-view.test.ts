import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("../../../web/src/views/ConfigView.vue", import.meta.url), "utf8");
const compact = source.replace(/\s+/g, " ").trim();

test("ConfigView 复用当前角色，普通账号始终只读且管理员不受影响", () => {
  assert.match(source, /import \{ currentIsAdmin \} from "\.\.\/stores\/auth\.ts";/);
  assert.match(source, /const isAdmin = currentIsAdmin\(\);/);
  assert.match(compact, /const configWritesBlocked = computed\(\(\) => !isAdmin\.value\);/);
  assert.match(compact, /<el-alert v-if="configWritesBlocked"[^>]*class="write-protection-alert">/);
  assert.match(source, /运行配置当前为只读/);
  assert.match(source, /运行配置属于自动合并评估与执行链的信任根，只有管理员可以修改/);
});

test("ConfigView 不再按当前自动合并状态条件放行写操作", () => {
  assert.doesNotMatch(source, /\/api\/prompts\/meta/);
  assert.doesNotMatch(source, /PromptMeta/);
  assert.doesNotMatch(source, /autoMergeEnabled|writeAccessKnown|writeAccessLoading|writeAccessError/);
});

test("只读状态禁用保存与所有配置输入，并在保存处理器再次守卫", () => {
  assert.match(compact, /<el-button type="primary" :loading="saving" :disabled="configWritesBlocked" @click="onSave">/);
  assert.match(source, /:disabled="row\.readOnly \|\| configWritesBlocked"/);
  assert.match(compact, /async function onSave\(\): Promise<void> \{ if \(!ensureConfigWritesAllowed\(\) \|\| saving\.value\) return;/);
  assert.match(compact, /function ensureConfigWritesAllowed\(\): boolean \{ if \(!configWritesBlocked\.value\) return true; ElMessage\.warning\("运行配置仅允许管理员修改"\); return false; \}/);
});

test("管理员写入仍保留 dirty、密钥、只读与重启提示语义", () => {
  assert.match(source, /draft: item\.masked \? "" : item\.value/, "密钥仍必须以空草稿表示保留原值");
  assert.match(source, /row\.dirty && !row\.readOnly && row\.draft\.trim\(\) !== ""/, "dirty、只读与空值过滤不能退化");
  assert.match(source, /result\.restartRequired\.length > 0/, "需重启提示不能退化");
});
