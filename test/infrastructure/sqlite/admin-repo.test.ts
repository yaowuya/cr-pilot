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
