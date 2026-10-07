import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveToken, generateToken, hashPassword, verifyPassword } from "../../src/shared/crypto.ts";

test("hashPassword 产出 scrypt$盐$哈希 且同输入稳定", () => {
  const stored = hashPassword("s3cret", "admin", "deploy-salt");
  assert.match(stored, /^scrypt\$[0-9a-f]+\$[0-9a-f]+$/);
  assert.equal(stored, hashPassword("s3cret", "admin", "deploy-salt"));
  assert.notEqual(stored, hashPassword("s3cret", "admin", "other-deploy-salt"), "换部署盐必须换哈希");
});

test("hashPassword 相同密码不同用户名得到不同哈希", () => {
  const alice = hashPassword("same-password", "alice", "deploy-salt");
  const bob = hashPassword("same-password", "bob", "deploy-salt");
  assert.notEqual(alice, bob, "盐含用户名，避免相同密码产生相同哈希");
});

test("verifyPassword 正确密码通过、错误密码拒绝", () => {
  const stored = hashPassword("s3cret", "admin", "deploy-salt");
  assert.equal(verifyPassword("s3cret", stored), true);
  assert.equal(verifyPassword("wrong", stored), false);
});

test("verifyPassword 对格式非法的哈希返回 false 而不抛错", () => {
  assert.equal(verifyPassword("s3cret", "not-a-hash"), false);
  assert.equal(verifyPassword("s3cret", "scrypt$onlytwo"), false);
  assert.equal(verifyPassword("s3cret", "bcrypt$aa$bb"), false);
  assert.equal(verifyPassword("s3cret", "scrypt$aa$"), false);
});

test("部署盐轮换不影响已存储密码的校验", () => {
  const stored = hashPassword("s3cret", "admin", "old-deploy-salt");
  // 盐内嵌于哈希串，轮换部署盐不应把既有管理员锁在门外。
  assert.equal(verifyPassword("s3cret", stored), true);
  assert.notEqual(hashPassword("s3cret", "admin", "new-deploy-salt"), stored);
});

test("generateToken 每次不同，deriveToken 确定性", () => {
  assert.notEqual(generateToken(), generateToken());
  assert.match(generateToken(), /^[0-9a-f]{64}$/);
  assert.equal(deriveToken("admin", "salt"), deriveToken("admin", "salt"));
  assert.notEqual(deriveToken("admin", "salt"), deriveToken("other", "salt"));
  assert.notEqual(deriveToken("admin", "salt"), deriveToken("admin", "other-salt"));
});
