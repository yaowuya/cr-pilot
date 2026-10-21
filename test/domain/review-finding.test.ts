import { test } from "node:test";
import assert from "node:assert/strict";
import { fingerprintLine, locateFingerprintLine } from "../../src/domain/review-finding.ts";

test("指纹忽略空白差异", () => {
  assert.equal(fingerprintLine("  const a = 1;  "), fingerprintLine("const   a = 1;"));
});

test("指纹对内容变化敏感", () => {
  assert.notEqual(fingerprintLine("const a = 1;"), fingerprintLine("const a = 2;"));
});

test("空行返回空串，不产生伪指纹", () => {
  assert.equal(fingerprintLine(""), "");
  assert.equal(fingerprintLine("   "), "");
});

test("指纹定长为 16 位十六进制", () => {
  assert.match(fingerprintLine("const a = 1;"), /^[0-9a-f]{16}$/);
});

test("按指纹在原行号附近定位目标行", () => {
  const content = ["line1", "line2", "const target = 1;", "line4"].join("\n");
  const fingerprint = fingerprintLine("const target = 1;");
  const hit = locateFingerprintLine(content, 3, fingerprint);
  assert.equal(hit?.line, 3);
  assert.equal(hit?.text, "const target = 1;");
});

test("行号漂移时仍能按指纹定位", () => {
  // 原第 3 行前插入了两行，现在位于第 5 行
  const content = ["new1", "new2", "line1", "line2", "const target = 1;", "line4"].join("\n");
  const hit = locateFingerprintLine(content, 3, fingerprintLine("const target = 1;"));
  assert.equal(hit?.line, 5);
});

test("超出窗口或指纹不存在时返回 null，不猜测", () => {
  const content = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].join("\n");
  assert.equal(locateFingerprintLine(content, 1, fingerprintLine("j"), 3), null);
  assert.equal(locateFingerprintLine(content, 1, fingerprintLine("并不存在的行"), 3), null);
});

test("空指纹直接返回 null，避免匹配到空行", () => {
  assert.equal(locateFingerprintLine("\n\n\n", 2, ""), null);
});

test("多个相同指纹时取最接近原行号的一个", () => {
  const content = ["same", "x", "same", "y", "same"].join("\n");
  const hit = locateFingerprintLine(content, 5, fingerprintLine("same"), 4);
  assert.equal(hit?.line, 5);
});
