import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMergeRequestTask } from "../../../src/interfaces/http/webhook-parser.ts";

/** 构造一个最小可用的 merge_request payload。 */
function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    object_kind: "merge_request",
    project: { id: 3483, path_with_namespace: "group/proj" },
    object_attributes: {
      iid: 5396,
      author_id: 1751,
      source_branch: "dev/x",
      target_branch: "develop/y",
    },
    user: { id: 9001, name: "触发者乙", username: "trigger-b" },
    repository: { homepage: "https://code.cwoa.net/group/proj" },
    ...overrides,
  };
}

test("authorId 取自 object_attributes.author_id，与触发者区分开", () => {
  // 关键回归：MR 作者（author_id）与事件触发者（payload.user）是两个人。
  // 早先实现直接把 payload.user.name 当提交人，导致「别人评论/推代码触发的
  // 事件」把评审记录记到了触发者名下。
  const task = parseMergeRequestTask(payload());
  assert.ok(task);
  assert.equal(task.authorId, 1751, "作者 ID 应取自 object_attributes.author_id");
  assert.equal(task.triggerUserName, "触发者乙", "触发者单独保留，仅作兜底");
});

test("作者与触发者相同时两个字段都正确", () => {
  const task = parseMergeRequestTask(
    payload({
      object_attributes: { iid: 1, author_id: 1751, source_branch: "a", target_branch: "b" },
      user: { id: 1751, name: "郭豪[guohao]", username: "guohao" },
    }),
  );
  assert.ok(task);
  assert.equal(task.authorId, 1751);
  assert.equal(task.triggerUserName, "郭豪[guohao]");
});

test("payload 缺 author_id 时 authorId 为 undefined，解析不失败", () => {
  const task = parseMergeRequestTask(payload({ object_attributes: { iid: 5, source_branch: "a", target_branch: "b" } }));
  assert.ok(task, "缺 author_id 不应导致整个任务被丢弃");
  assert.equal(task.authorId, undefined);
});

test("author_id 非数字时按缺失处理", () => {
  const task = parseMergeRequestTask(
    payload({ object_attributes: { iid: 6, author_id: "not-a-number", source_branch: "a", target_branch: "b" } }),
  );
  assert.ok(task);
  assert.equal(task.authorId, undefined);
});

test("缺 user 时不报错，triggerUserName 为空串", () => {
  const task = parseMergeRequestTask(payload({ user: undefined }));
  assert.ok(task);
  assert.equal(task.triggerUserName, "");
  assert.equal(task.authorId, 1751, "作者信息不依赖 payload.user");
});

test("关键字段缺失时仍返回 null（作者字段不影响必填校验）", () => {
  assert.equal(parseMergeRequestTask(payload({ project: {} })), null);
  assert.equal(
    parseMergeRequestTask(payload({ object_attributes: { author_id: 1 } })),
    null,
    "缺 iid 应返回 null",
  );
});
