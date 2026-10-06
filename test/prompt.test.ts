import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadReviewPrompt, PromptFileError } from "../src/prompt.ts";

test("loadReviewPrompt 返回去空白后的全文", async () => {
  const dir = await mkdtemp(join(tmpdir(), "crp-prompt-"));
  try {
    const file = join(dir, "review.md");
    await writeFile(file, "\n  请审查以下代码  \n", "utf8");
    assert.equal(await loadReviewPrompt(file), "请审查以下代码");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadReviewPrompt 对缺失文件抛 PromptFileError", async () => {
  await assert.rejects(() => loadReviewPrompt(join(tmpdir(), "crp-missing-prompt.md")), PromptFileError);
});

test("loadReviewPrompt 对空白文件抛 PromptFileError", async () => {
  const dir = await mkdtemp(join(tmpdir(), "crp-prompt-"));
  try {
    const file = join(dir, "empty.md");
    await writeFile(file, "   \n\n", "utf8");
    await assert.rejects(() => loadReviewPrompt(file), PromptFileError);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
