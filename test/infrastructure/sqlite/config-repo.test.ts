import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../../../src/infrastructure/sqlite/database.ts";
import { createConfigRepository, isSecretKey, READ_ONLY_KEYS, RESTART_REQUIRED_KEYS } from "../../../src/infrastructure/sqlite/config-repo.ts";

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

test("RESTART_REQUIRED_KEYS 覆盖所有「消费方持有快照」的键", () => {
  assert.ok(RESTART_REQUIRED_KEYS.has("PORT"));
  assert.ok(RESTART_REQUIRED_KEYS.has("LLMGW_API_KEY"));
  assert.ok(RESTART_REQUIRED_KEYS.has("LOG_FILE"));
  // 这些键虽然会被写进 process.env，但消费方（队列槽位、管线解构、日志器阈值、
  // 规则渲染）都在构造时固定了值，因此必须标注需重启——否则页面会错误地
  // 提示「已立即生效」。
  for (const snapshotKey of ["QUEUE_CONCURRENCY", "REVIEW_TIMEOUT_MS", "REVIEW_BATCH_MAX_TOKENS", "LOG_LEVEL", "REVIEW_STYLE", "GITLAB_API_TIMEOUT", "GITLAB_INSECURE_TLS", "GITLAB_URL", "AUTH_SALT"]) {
    assert.ok(RESTART_REQUIRED_KEYS.has(snapshotKey), `${snapshotKey} 消费方持有快照，必须标注需重启`);
  }
  assert.ok(RESTART_REQUIRED_KEYS.has("DB_PATH"), "DB_PATH 影响开库路径，必须标注需重启");
});

test("READ_ONLY_KEYS 覆盖启动引导类键", () => {
  for (const key of ["DB_PATH", "ADMIN_USERNAME", "ADMIN_PASSWORD"]) {
    assert.ok(READ_ONLY_KEYS.has(key), `${key} 不应允许页面修改`);
  }
  assert.equal(READ_ONLY_KEYS.has("QUEUE_CONCURRENCY"), false, "普通配置项应可修改");
});

test("isSecretKey 命中常见密钥命名", () => {
  for (const key of ["LLMGW_API_KEY", "GITLAB_TOKEN", "AUTH_SECRET", "ADMIN_PASSWORD"]) {
    assert.equal(isSecretKey(key), true, `${key} 应判定为密钥`);
  }
  for (const key of ["PORT", "QUEUE_CONCURRENCY", "LOG_LEVEL", "REVIEW_TIMEOUT_MS"]) {
    assert.equal(isSecretKey(key), false, `${key} 不是密钥`);
  }
});
