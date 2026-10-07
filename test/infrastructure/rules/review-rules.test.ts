import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadReviewRules, renderUserPrompt, renderStyleTemplate } from "../../../src/infrastructure/rules/review-rules.ts";

const DEFAULT_YAML = `
code_review_prompt:
  system_prompt: "默认系统提示 {{ style }}"
  user_prompt: "请评审：{diffs_text}"
`;

/** 在临时目录写规则文件并执行断言，结束自动清理。 */
async function withRulesDir(files: Record<string, string>, run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "crp-rules-"));
  try {
    for (const [name, content] of Object.entries(files)) {
      const path = join(dir, name);
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, content, "utf8");
    }
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const REPO_RULE = "repository: team/app\ncode_review_prompt:\n  system_prompt: \"仓库系统提示\"\n  user_prompt: \"仓库用户提示 {diffs_text}\"\n";

test("仓库规则命中时优先于 default", async () => {
  await withRulesDir({ "default.yaml": DEFAULT_YAML, "team__app.yaml": REPO_RULE }, async (dir) => {
    const rules = await loadReviewRules(dir, "fallback-md");
    assert.equal(rules.resolve("team/app").systemPrompt, "仓库系统提示");
  });
});

test("无仓库规则时使用 default", async () => {
  await withRulesDir({ "default.yaml": DEFAULT_YAML }, async (dir) => {
    const rules = await loadReviewRules(dir, "fallback-md");
    assert.equal(rules.resolve("other/app").systemPrompt, "默认系统提示 professional");
  });
});

test("无 YAML 规则时用 Markdown 兜底", async () => {
  await withRulesDir({}, async (dir) => {
    const rules = await loadReviewRules(dir, "## md 兜底内容");
    const set = rules.resolve("other/app");
    assert.equal(set.systemPrompt, "## md 兜底内容");
    assert.match(set.userPrompt, /\{diffs_text\}/);
  });
});

test("缺少 repository 字段的规则文件被跳过并回落到 default", async () => {
  await withRulesDir({ "default.yaml": DEFAULT_YAML, "broken.yaml": "code_review_prompt:\n  system_prompt: \"孤儿规则\"\n" }, async (dir) => {
    const rules = await loadReviewRules(dir, "fallback-md");
    assert.equal(rules.resolve("team/app").systemPrompt, "默认系统提示 professional");
  });
});

test("repository 支持逗号分隔多仓库，短项目名可匹配，大小写不敏感", async () => {
  const multi = "repository: cw-publish, app-mgmt\ncode_review_prompt:\n  system_prompt: \"发布中心规则\"\n  user_prompt: \"{diffs_text}\"\n";
  await withRulesDir({ "default.yaml": DEFAULT_YAML, "ada.yaml": multi }, async (dir) => {
    const rules = await loadReviewRules(dir, "fallback-md");
    // 全名匹配（大小写不敏感）
    assert.equal(rules.resolve("rd-fy21-canway/cw-publish")?.systemPrompt, "发布中心规则");
    // 短项目名匹配：namespace/project 命中列表里的 project 短名
    assert.equal(rules.resolve("rd-fy21-canway/app-mgmt")?.systemPrompt, "发布中心规则");
  });
});

test("loadReviewRules 注入 REVIEW_STYLE 渲染模板分支", async () => {
  const template = "repository: team/app\ncode_review_prompt:\n  system_prompt: |\n    风格：{{ style }}\n    {% if style == 'professional' %}\n    专业严谨。\n    {% elif style == 'gentle' %}\n    温和措辞。\n    {% else %}\n    默认风格。\n    {% endif %}\n  user_prompt: \"{diffs_text}\"\n";
  await withRulesDir({ "team__app.yaml": template }, async (dir) => {
    const professional = await loadReviewRules(dir, "fallback-md", { style: "professional" });
    assert.match(professional.resolve("team/app").systemPrompt, /专业严谨/);
    assert.doesNotMatch(professional.resolve("team/app").systemPrompt, /温和措辞|默认风格|\{\{|endif/);
    const gentle = await loadReviewRules(dir, "fallback-md", { style: "gentle" });
    assert.match(gentle.resolve("team/app").systemPrompt, /温和措辞/);
  });
});

test("renderStyleTemplate 替换 style 变量并保留未知占位符", () => {
  assert.equal(renderStyleTemplate("保持{{ style }}风格", "professional"), "保持professional风格");
  assert.equal(renderStyleTemplate("无模板的文本", "x"), "无模板的文本");
  // 未闭合的分支保持原样，避免静默吞掉内容
  assert.match(renderStyleTemplate("{% if style == 'x' %}a", "x"), /\{%\s*if/);
});

test("renderUserPrompt 替换占位符", () => {
  assert.equal(
    renderUserPrompt("评：{diffs_text}；提交：{commits_text}", { diffsText: "D", commitsText: "C" }),
    "评：D；提交：C",
  );
});
