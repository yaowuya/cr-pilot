import { test } from "node:test";
import assert from "node:assert/strict";
import { parseReviewScore, shouldNotifyByScore } from "../../src/domain/review-rules.ts";

test("parseReviewScore 解析总分并取最小值", () => {
  assert.equal(parseReviewScore("总分: 92分"), 92);
  assert.equal(parseReviewScore("总分： 61 分"), 61);
  // 多批结果拼接出现多个总分时取最低（最保守）
  assert.equal(parseReviewScore("总分: 92分\n总分: 61分\n总分: 84分"), 61);
});

test("parseReviewScore 无总分时返回 0", () => {
  assert.equal(parseReviewScore(""), 0);
  assert.equal(parseReviewScore("没有分数的评审文本"), 0);
  assert.equal(parseReviewScore("总分：不完整"), 0);
});

test("shouldNotifyByScore 低于阈值推送、达到阈值不推送", () => {
  assert.equal(shouldNotifyByScore(69, 70), true);
  assert.equal(shouldNotifyByScore(70, 70), false);
  assert.equal(shouldNotifyByScore(85, 70), false);
});

test("shouldNotifyByScore 无阈值时不按分数过滤", () => {
  assert.equal(shouldNotifyByScore(0, undefined), true);
  assert.equal(shouldNotifyByScore(95, undefined), true);
});
