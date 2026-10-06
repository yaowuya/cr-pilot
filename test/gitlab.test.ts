import { test } from "node:test";
import assert from "node:assert/strict";
import { extractGitlabContext, isGitlabPayload } from "../src/gitlab.ts";

const mergeRequestPayload = {
  object_kind: "merge_request",
  project: { path_with_namespace: "team/app" },
  object_attributes: {
    iid: 12,
    title: "修复登录超时",
    description: "把超时时间调大",
    source_branch: "fix/login",
    target_branch: "main",
    action: "open",
  },
};

const pushPayload = {
  object_kind: "push",
  ref: "refs/heads/main",
  project: { path_with_namespace: "team/app" },
  commits: [
    { message: "修复登录超时\n\n补充说明", added: ["a.ts"], modified: ["b.ts"], removed: ["c.ts"] },
  ],
};

test("isGitlabPayload 只认带 object_kind 的对象", () => {
  assert.equal(isGitlabPayload(mergeRequestPayload), true);
  assert.equal(isGitlabPayload({ code: "x" }), false);
  assert.equal(isGitlabPayload(null), false);
});

test("extractGitlabContext 提取 merge_request 元数据", () => {
  const context = extractGitlabContext(mergeRequestPayload);
  assert.match(context ?? "", /!12/);
  assert.match(context ?? "", /修复登录超时/);
  assert.match(context ?? "", /fix\/login/);
  assert.match(context ?? "", /team\/app/);
});

test("extractGitlabContext 提取 push 提交与变更文件", () => {
  const context = extractGitlabContext(pushPayload);
  assert.match(context ?? "", /main/);
  assert.match(context ?? "", /修复登录超时/);
  assert.match(context ?? "", /a\.ts/);
  assert.match(context ?? "", /c\.ts/);
});

test("extractGitlabContext 对未知类型与非对象返回 null", () => {
  assert.equal(extractGitlabContext({ object_kind: "issue" }), null);
  assert.equal(extractGitlabContext("raw code"), null);
});
