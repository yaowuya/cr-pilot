import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateTokens, splitChangesIntoBatches } from "../src/pipeline.ts";
import type { Change } from "../src/gitlab-client.ts";

function change(diff: string, newPath = "a.ts"): Change {
  return { newPath, oldPath: newPath, diff };
}

test("estimateTokens 按字符数/4 向上取整", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("abc"), 1);
  assert.equal(estimateTokens("abcdefgh"), 2);
});

test("小变更保持单批", () => {
  const batches = splitChangesIntoBatches([change("diff".repeat(10))], 6000, 100);
  assert.equal(batches.length, 1);
});

test("超过预算的多个变更拆成多批，且每批不超阈值", () => {
  const big = "x".repeat(4000); // ≈1000 tokens；单行超阈值时会按字符再拆
  const changes = [change(big, "a.ts"), change(big, "b.ts"), change(big, "c.ts")];
  const batches = splitChangesIntoBatches(changes, 1200, 100); // 阈值 = 1200*0.85-100 = 920 tokens
  assert.ok(batches.length > 3);
  for (const batch of batches) {
    const totalTokens = batch.reduce((sum, c) => sum + estimateTokens(c.diff), 0);
    assert.ok(totalTokens <= 920, `批过大：${totalTokens} tokens`);
  }
});

test("单文件超预算时按 diff 行拆分，且每批不超阈值", () => {
  const lines = Array.from({ length: 8 }, (_, i) => `+line-${i}-${"y".repeat(200)}`);
  const diff = lines.join("\n");
  const batches = splitChangesIntoBatches([change(diff, "big.ts")], 600, 100); // 阈值 = 410 tokens
  assert.ok(batches.length > 1);
  for (const batch of batches) {
    const totalTokens = batch.reduce((sum, c) => sum + estimateTokens(c.diff), 0);
    assert.ok(totalTokens <= 410, `批过大：${totalTokens} tokens`);
  }
});

test("拆分后每批保留文件路径", () => {
  const lines = Array.from({ length: 6 }, (_, i) => `+line-${i}-${"y".repeat(200)}`);
  const batches = splitChangesIntoBatches([change(lines.join("\n"), "keep/me.ts")], 600, 100);
  for (const batch of batches) {
    for (const item of batch) {
      assert.equal(item.newPath, "keep/me.ts");
    }
  }
});
