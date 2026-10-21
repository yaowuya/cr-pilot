import { test } from "node:test";
import assert from "node:assert/strict";
import { openSecret, sealSecret } from "../../src/shared/secret-box.ts";

const SECRET = "deployment-salt-abc";

test("加密后可解密还原原文", () => {
  const plain = "glpat-xxxxxxxxxxxxxxxxxxxx";
  const sealed = sealSecret(plain, SECRET);
  assert.notEqual(sealed, plain, "密文不能等于明文");
  assert.equal(openSecret(sealed, SECRET), plain);
});

test("空串原样返回，不产生密文", () => {
  assert.equal(sealSecret("", SECRET), "");
  assert.equal(openSecret("", SECRET), "");
});

test("同一明文两次加密结果不同（随机 IV）", () => {
  assert.notEqual(sealSecret("same", SECRET), sealSecret("same", SECRET));
});

test("错误密钥解不开，返回空串而不是抛错", () => {
  const sealed = sealSecret("glpat-secret", SECRET);
  assert.equal(openSecret(sealed, "another-salt"), "");
});

test("密文被篡改时解密失败返回空串", () => {
  const sealed = sealSecret("glpat-secret", SECRET);
  const parts = sealed.split(":");
  // 篡改载荷最后一段的一个字符
  const payload = parts[3];
  parts[3] = (payload[0] === "A" ? "B" : "A") + payload.slice(1);
  assert.equal(openSecret(parts.join(":"), SECRET), "");
});

test("格式非法时返回空串，不抛错", () => {
  assert.equal(openSecret("not-a-sealed-value", SECRET), "");
  assert.equal(openSecret("v1:only:three", SECRET), "");
  assert.equal(openSecret("v0:a:b:c", SECRET), "");
});
