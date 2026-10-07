import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../../../src/infrastructure/sqlite/database.ts";
import { createConfigRepository, isSecretKey, RESTART_REQUIRED_KEYS } from "../../../src/infrastructure/sqlite/config-repo.ts";

test("setAll 同键覆盖而非追加，clear 删除键", () => {
  const db = openDatabase(":memory:");
  const repo = createConfigRepository(db);
  repo.setAll([{ key: "QUEUE_CONCURRENCY", value: "9" }]);
  assert.equal(repo.list()[0].value, "9");
  repo.setAll([{ key: "QUEUE_CONCURRENCY", value: "3" }]);
  assert.equal(repo.list().length, 1);
  repo.clear(["QUEUE_CONCURRENCY"]);
  assert.equal(repo.list().length, 0);
  db.close();
});

test("list 按键名排序并保留空串覆盖语义", () => {
  const db = openDatabase(":memory:");
  const repo = createConfigRepository(db);
  repo.setAll([
    { key: "PORT", value: "6001" },
    { key: "ADMIN_USERNAME", value: "" },
  ]);
  const list = repo.list();
  assert.deepEqual(list.map((item) => item.key), ["ADMIN_USERNAME", "PORT"]);
  assert.equal(list[0].value, "", "空串表示清空覆盖，不得写回退值");
  db.close();
});

test("RESTART_REQUIRED_KEYS 含启动期与 pi 读取的键，不含可热更新项", () => {
  assert.ok(RESTART_REQUIRED_KEYS.has("PORT"));
  assert.ok(RESTART_REQUIRED_KEYS.has("LLMGW_API_KEY"));
  assert.ok(RESTART_REQUIRED_KEYS.has("LOG_FILE"));
  for (const hot of ["QUEUE_CONCURRENCY", "REVIEW_TIMEOUT_MS", "LOG_LEVEL", "REVIEW_STYLE"]) {
    assert.equal(RESTART_REQUIRED_KEYS.has(hot), false, `${hot} 每次读取，应可热更新`);
  }
});

test("isSecretKey 命中常见密钥命名", () => {
  for (const key of ["LLMGW_API_KEY", "GITLAB_TOKEN", "AUTH_SECRET", "ADMIN_PASSWORD"]) {
    assert.equal(isSecretKey(key), true, `${key} 应判定为密钥`);
  }
  for (const key of ["PORT", "QUEUE_CONCURRENCY", "LOG_LEVEL", "REVIEW_TIMEOUT_MS"]) {
    assert.equal(isSecretKey(key), false, `${key} 不是密钥`);
  }
});
