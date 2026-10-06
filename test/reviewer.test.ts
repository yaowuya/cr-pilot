import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { buildLoaderOptions, createIsolatedWorkspace } from "../src/reviewer.ts";

test("createIsolatedWorkspace 返回已存在且为空的目录", () => {
  const dir = createIsolatedWorkspace();
  try {
    assert.equal(existsSync(dir), true);
    assert.deepEqual(readdirSync(dir), []);
    assert.notEqual(dir, createIsolatedWorkspace());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildLoaderOptions 关闭全部项目资源发现", () => {
  const options = buildLoaderOptions({ prompt: "PROMPT", cwd: "C:/tmp/x", agentDir: "C:/agent" });
  assert.equal(options.cwd, "C:/tmp/x");
  assert.equal(options.agentDir, "C:/agent");
  assert.equal(options.noContextFiles, true);
  assert.equal(options.noSkills, true);
  assert.equal(options.noPromptTemplates, true);
  assert.equal(options.systemPromptOverride?.("base"), "PROMPT");
  assert.deepEqual(options.appendSystemPromptOverride?.(["base"]), []);
});
