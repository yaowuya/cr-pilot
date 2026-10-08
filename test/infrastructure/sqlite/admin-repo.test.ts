import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../../../src/infrastructure/sqlite/database.ts";
import { createAdminRepository } from "../../../src/infrastructure/sqlite/admin-repo.ts";

test("创建管理员后 list 不含密码哈希，重复用户名被拒", () => {
  const db = openDatabase(":memory:");
  const repo = createAdminRepository(db, "fixed-salt");
  repo.create("admin", "s3cret");
  const list = repo.list();
  assert.equal(list.length, 1);
  assert.equal("passwordHash" in list[0], false, "列表不得返回密码哈希");
  assert.throws(() => repo.create("admin", "other"), /已存在/);
  db.close();
});

test("ensureInitialAdmin 仅在无账号时创建", () => {
  const db = openDatabase(":memory:");
  const repo = createAdminRepository(db, "fixed-salt");
  repo.ensureInitialAdmin("root", "pw");
  repo.ensureInitialAdmin("other", "pw");
  assert.equal(repo.count(), 1);
  assert.ok(repo.findByUsername("root"), "首个账号必须创建");
  assert.equal(repo.findByUsername("other"), undefined, "已有账号时不得覆盖");
  db.close();
});

test("delete 移除账号后 findByUsername 返回 undefined", () => {
  const db = openDatabase(":memory:");
  const repo = createAdminRepository(db, "fixed-salt");
  const created = repo.create("admin", "s3cret");
  repo.delete(created.id);
  assert.equal(repo.findByUsername("admin"), undefined);
  assert.equal(repo.count(), 0);
  db.close();
});

test("authenticate 校验正确密码并拒绝错误密码", () => {
  const db = openDatabase(":memory:");
  const repo = createAdminRepository(db, "fixed-salt");
  const created = repo.create("admin", "s3cret");
  assert.equal(repo.authenticate("admin", "s3cret")?.id, created.id);
  assert.equal(repo.authenticate("admin", "wrong"), undefined);
  assert.equal(repo.authenticate("nobody", "s3cret"), undefined);
  db.close();
});

test("用户名去空白存储，且大小写敏感", () => {
  const db = openDatabase(":memory:");
  const repo = createAdminRepository(db, "fixed-salt");
  repo.create("  admin  ", "pw");
  assert.equal(repo.findByUsername("admin")?.username, "admin");
  repo.create("Admin", "pw");
  assert.equal(repo.count(), 2, "大小写不同视为不同账号");
  db.close();
});

test("换部署盐创建的账号哈希不同但都能各自校验", () => {
  const db = openDatabase(":memory:");
  const first = createAdminRepository(db, "salt-a");
  first.create("alpha", "pw");
  const second = createAdminRepository(db, "salt-b");
  second.create("beta", "pw");
  const hashes = db.prepare("SELECT password_hash FROM admins").all() as unknown as { password_hash: string }[];
  assert.notEqual(hashes[0].password_hash, hashes[1].password_hash, "盐含用户名，哈希必须不同");
  assert.ok(first.authenticate("alpha", "pw"));
  assert.ok(second.authenticate("beta", "pw"));
  db.close();
});

test("authenticate 对不存在的账号也执行等成本 scrypt（防时序枚举）", () => {
  const db = openDatabase(":memory:");
  const repo = createAdminRepository(db, "fixed-salt");
  repo.create("admin", "s3cret");
  // 不存在账号必须与错误密码耗时同量级：二者都跑一次 scrypt。
  // 单次 scrypt 约 60ms，若提前返回会快几个数量级，攻击者可据此枚举用户名。
  const started = process.hrtime.bigint();
  repo.authenticate("nobody", "whatever");
  const missingMs = Number(process.hrtime.bigint() - started) / 1e6;

  const started2 = process.hrtime.bigint();
  repo.authenticate("admin", "wrong-password");
  const wrongMs = Number(process.hrtime.bigint() - started2) / 1e6;

  // 两者都应落在 scrypt 成本量级（>10ms），且差异不超过一个数量级。
  assert.ok(missingMs > 10, `不存在账号耗时 ${missingMs.toFixed(1)}ms，说明没有执行 scrypt`);
  assert.ok(wrongMs > 10, `错误密码耗时 ${wrongMs.toFixed(1)}ms`);
  assert.ok(
    missingMs < wrongMs * 10 && wrongMs < missingMs * 10,
    `耗时差过大：不存在=${missingMs.toFixed(1)}ms 错误密码=${wrongMs.toFixed(1)}ms`,
  );
  db.close();
});
