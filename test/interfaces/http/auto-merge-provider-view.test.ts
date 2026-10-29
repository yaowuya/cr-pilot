import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("../../../web/src/views/ProvidersView.vue", import.meta.url),
  "utf8",
);
const compact = source.replace(/\s+/g, " ").trim();

test("ProvidersView 复用当前角色，普通账号始终只读且无需查询 Prompt meta", () => {
  assert.match(source, /import \{ currentIsAdmin \} from "\.\.\/stores\/auth\.ts";/);
  assert.match(source, /const isAdmin = currentIsAdmin\(\);/);
  assert.match(source, /const providerWritesBlocked = computed\(\(\) => !isAdmin\.value\);/);
  assert.doesNotMatch(source, /api\.get<PromptMeta>\("\/api\/prompts\/meta"\)/);
  assert.doesNotMatch(source, /writeAccessLoading|writeAccessKnown|autoMergeEnabled/);
  assert.match(compact, /<el-alert v-if="providerWritesBlocked"[^>]*class="write-protection-alert">/);
  assert.match(source, /AI 厂商与项目绑定当前为只读/);
  assert.match(source, /这些配置属于自动合并的 evaluator 信任根，只有管理员可以修改/);
});

test("只读状态禁用所有厂商和项目绑定写入口，并在事件处理器再次守卫", () => {
  assert.match(compact, /type="primary" :disabled="providerWritesBlocked" @click="openCreate"/);
  assert.match(compact, /<el-dropdown :disabled="providerWritesBlocked"/);
  assert.match(compact, /<el-button size="small" :disabled="providerWritesBlocked" @click="openBinding">新增绑定<\/el-button>/);
  assert.match(compact, /<el-button link type="danger" :disabled="providerWritesBlocked">解除<\/el-button>/);
  assert.match(compact, /<el-form label-position="top" :disabled="saving \|\| providerWritesBlocked" class="provider-editor-form"/);
  assert.match(compact, /<el-button type="primary" :loading="saving" :disabled="providerWritesBlocked" @click="onSave">保存<\/el-button>/);
  assert.match(compact, /<el-form label-position="top" :disabled="saving \|\| providerWritesBlocked" class="binding-form">/);
  assert.match(compact, /<el-button type="primary" :loading="saving" :disabled="providerWritesBlocked" @click="onBind">保存<\/el-button>/);

  for (const handler of ["openCreate", "openEdit", "onSave", "onCommand", "openBinding", "onBind", "onUnbind"]) {
    assert.match(
      compact,
      new RegExp(`(?:async )?function ${handler}\\([^)]*\\)(?:: [^{]+)? \\{ if \\(!ensureProviderWritesAllowed\\(\\)\\) return;`),
      `${handler} 必须在脚本层再次守卫只读状态`,
    );
  }
});

test("管理员不受前端只读裁剪影响，读取与密钥留空语义保持原样", () => {
  assert.match(compact, /function ensureProviderWritesAllowed\(\): boolean \{ if \(!providerWritesBlocked\.value\) return true;/);
  assert.match(source, /api_key:\s*form\.apiKey \|\| undefined/);
  assert.match(source, /editingId\.value \? "留空表示不修改现有密钥"/);
  assert.match(source, /void Promise\.all\(\[load\(\), loadTemplates\(\)\]\)/);
});
