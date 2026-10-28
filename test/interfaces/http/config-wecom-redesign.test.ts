import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const ROOT = process.cwd();

function readView(name: string): string {
  return readFileSync(join(ROOT, "web", "src", "views", name), "utf8");
}

test("环境变量页以 Framed Sheet 两列分组承载配置项，并在 768px 保持可用", () => {
  const source = readView("ConfigView.vue");

  assert.match(source, /class="config-grid"/, "配置分组应进入独立的两列工作区");
  assert.match(source, /v-for="\(column, columnIndex\) in configColumns"/, "两列应独立堆叠，避免短分组下方被高分组撑出空洞");
  assert.match(source, /v-for="group in column"/, "分组仍应由既有 groups 数据驱动");
  assert.match(source, /const configColumns = computed/, "列分配应保持响应式并复用既有分组结果");
  assert.match(source, /\.config-column\s*\{[^}]*display:\s*grid[^}]*align-content:\s*start/s);
  assert.match(
    source,
    /\.config-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s,
    "桌面与 768px 主工作区应使用两列，且列允许安全收缩",
  );
  assert.match(source, /\.config-panel\s*\{[^}]*border:\s*1px solid var\(--el-border-color-lighter\)/s);
  assert.doesNotMatch(source, /\.config-panel\s*\{[^}]*box-shadow:/s, "Framed Sheet 面板不得依赖静态阴影");
  assert.match(source, /@media\s*\(max-width:\s*680px\)[\s\S]*?\.config-grid\s*\{[^}]*grid-template-columns:\s*1fr/s);
  assert.doesNotMatch(source, /backgroundColor:\s*group\.bg/, "分组不再使用重复的彩色图标块");
});

test("环境变量页重排后仍保留密钥、只读、脏值提交、重启与厂商跳转语义", () => {
  const source = readView("ConfigView.vue");

  assert.match(source, /draft:\s*item\.masked\s*\?\s*""\s*:\s*item\.value/, "密钥初始草稿必须为空，不能回写掩码");
  assert.match(source, /row\.dirty\s*&&\s*!row\.readOnly\s*&&\s*row\.draft\.trim\(\)\s*!==\s*""/, "只能提交非空的可编辑脏值");
  assert.match(source, /:disabled="row\.readOnly \|\| configWritesBlocked"/, "只读配置与普通账号只读模式均须禁用输入");
  assert.match(source, /@input="row\.dirty = true"/, "用户输入仍须标记脏值");
  assert.match(source, /留空表示不修改/, "密钥空值保留原配置的提示不能丢失");
  assert.match(source, /router\.push\("\/providers"\)/, "AI 模型分组仍须跳转厂商页");
  assert.match(source, /result\.restartRequired\.length\s*>\s*0/);
  assert.match(source, /ElMessageBox\.alert/, "保存需重启项后仍须明确提示");
});

test("企微映射页用真实列表数据呈现映射概览与 Framed Sheet 账号表", () => {
  const source = readView("WecomContactsView.vue");

  assert.match(source, /class="mapping-overview"/, "列表前应先回答映射覆盖情况");
  assert.match(source, /const mappingOverview = computed(?:<[^>]+>)?\(/, "概览必须由当前接口列表计算，不能写演示数字");
  assert.match(source, /contacts\.value\.length/);
  assert.match(source, /filter\(\(row\) => row\.hasWecomUserId\)\.length/, "真实提醒数量应按已配置 userid 计算");
  assert.match(source, /class="mapping-panel"/, "账号表应放在独立工作面板中");
  assert.match(
    source,
    /\.mapping-overview\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/s,
    "768px 可用宽度内仍应保留三个等分概览指标",
  );
  assert.match(source, /\.mapping-table\s*\{[^}]*min-width:\s*0[^}]*overflow:\s*hidden/s, "宽表只能在自身区域滚动，不能撑宽页面");
});

test("企微映射页重排后仍保留校验、掩码、保留或清除 userid、账号锁定与具名删除确认", () => {
  const source = readView("WecomContactsView.vue");

  assert.match(source, /row\.hasWecomUserId/);
  assert.match(source, /row\.wecomUserIdMasked/, "列表只能展示接口下发的 userid 掩码");
  assert.match(source, /:disabled="editing"/, "编辑映射时 GitLab 账号不可修改");
  assert.match(source, /editing\.value\s*&&\s*editingHasUserId\.value\s*&&\s*!form\.clearWecomUserId/, "留空编辑必须视为保留旧 userid");
  assert.match(source, /\.\.\.\(userId\s*\?\s*\{\s*wecomUserId:\s*userId\s*\}\s*:\s*\{\}\)/s, "空 userid 不得进入保存 payload");
  assert.match(source, /\.\.\.\(form\.clearWecomUserId\s*\?\s*\{\s*clearWecomUserId:\s*true\s*\}\s*:\s*\{\}\)/s);
  assert.match(source, /:title="deleteConfirmTitle\(row\)"/, "删除确认应明确指出目标账号");
  assert.match(source, /deleteConfirmTitle[\s\S]*row\.gitlabUsername/, "确认文案必须包含 GitLab 账号");
});
