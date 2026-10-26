import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PROJECT_REVIEW_DENIED_MESSAGE, PROJECT_REVIEW_POLICY_UNAVAILABLE_MESSAGE } from "../../../src/domain/review-prompt.ts";

test("Webhook 契约记录项目白名单的 403/503，不能把所有带 token 的 MR 描述为必入队", () => {
  const spec = JSON.parse(readFileSync(new URL("../../../docs/openapi.json", import.meta.url), "utf8"));
  const webhook = spec.paths["/review/webhook"].post;
  assert.match(webhook.description, /项目白名单/);
  assert.match(webhook.description, /default/);
  assert.match(webhook.description, /采纳追踪/);
  assert.equal(webhook.responses["403"].content["application/json"].example.error, PROJECT_REVIEW_DENIED_MESSAGE);
  assert.equal(webhook.responses["503"].content["application/json"].example.error, PROJECT_REVIEW_POLICY_UNAVAILABLE_MESSAGE);
});
