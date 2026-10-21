import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../../../src/infrastructure/sqlite/database.ts";
import { createWecomContactRepository } from "../../../src/infrastructure/sqlite/wecom-contact-repo.ts";

test("空表时列表为空且查不到映射", () => {
  const repo = createWecomContactRepository(openDatabase(":memory:"));
  assert.deepEqual(repo.list(), []);
  assert.equal(repo.findByGitlabUsername("nobody"), undefined);
});

test("写入后可读回，字段与更新时间齐全", () => {
  const repo = createWecomContactRepository(openDatabase(":memory:"));
  const saved = repo.upsert({ gitlabUsername: "samxiao", wecomName: "王秦", wecomUserId: "wangqin" });
  assert.equal(saved.gitlabUsername, "samxiao");
  assert.equal(saved.wecomName, "王秦");
  assert.equal(saved.wecomUserId, "wangqin");
  assert.ok(saved.updatedAt > 0);
  assert.deepEqual(repo.list().map((item) => item.gitlabUsername), ["samxiao"]);
});

test("按账号查询大小写不敏感", () => {
  const repo = createWecomContactRepository(openDatabase(":memory:"));
  repo.upsert({ gitlabUsername: "SamXiao", wecomName: "王秦", wecomUserId: "" });
  assert.equal(repo.findByGitlabUsername("samxiao")?.wecomName, "王秦");
  assert.equal(repo.findByGitlabUsername("SAMXIAO")?.wecomName, "王秦");
});

test("重复写入同一账号是更新而不是插入，且保留原账号写法", () => {
  const repo = createWecomContactRepository(openDatabase(":memory:"));
  repo.upsert({ gitlabUsername: "SamXiao", wecomName: "王秦", wecomUserId: "" });
  const updated = repo.upsert({ gitlabUsername: "samxiao", wecomName: "王秦（改）", wecomUserId: "wangqin" });
  assert.equal(repo.list().length, 1, "大小写不同的同一账号不能产生两行");
  assert.equal(updated.gitlabUsername, "SamXiao", "以库里原有写法为准");
  assert.equal(updated.wecomName, "王秦（改）");
  assert.equal(updated.wecomUserId, "wangqin");
});

test("删除存在的映射返回 true，重复删除返回 false", () => {
  const repo = createWecomContactRepository(openDatabase(":memory:"));
  repo.upsert({ gitlabUsername: "samxiao", wecomName: "王秦", wecomUserId: "" });
  assert.equal(repo.remove("SAMXIAO"), true);
  assert.equal(repo.list().length, 0);
  assert.equal(repo.remove("samxiao"), false);
});
