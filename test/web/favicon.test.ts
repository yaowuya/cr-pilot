import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** 仓库根（测试从项目根运行）。 */
const ROOT = process.cwd();

test("index.html 声明了站点图标", () => {
  // 浏览器标签页没有图标会显示空白方块，观感很差。
  // 这条用例防止后续改 index.html 时把 icon 链接丢掉。
  const html = readFileSync(join(ROOT, "web", "index.html"), "utf8");
  assert.match(html, /<link[^>]+rel="icon"/, "index.html 必须有 rel=icon 的 link");
  assert.match(html, /favicon\.svg/, "图标应指向 favicon.svg");
});

test("favicon.svg 存在于 public 目录且是合法 SVG", () => {
  const path = join(ROOT, "web", "public", "favicon.svg");
  assert.equal(existsSync(path), true, "缺少 web/public/favicon.svg");

  const svg = readFileSync(path, "utf8");
  assert.match(svg, /^<svg[\s>]/, "文件必须以 <svg 开头");
  assert.match(svg, /<\/svg>\s*$/, "文件必须以 </svg> 结尾");
  // 显式尺寸：SVG 缺少 width/height 时浏览器按默认尺寸渲染，favicon 会模糊
  assert.match(svg, /width="64"/, "应声明 width");
  assert.match(svg, /height="64"/, "应声明 height");
  assert.match(svg, /viewBox="0 0 64 64"/, "应声明 viewBox");
});

test("favicon 用品牌主色，与侧边栏标识一致", () => {
  // 图标与 UI 品牌色必须同源，否则标签页和页面看起来像两个产品
  const svg = readFileSync(join(ROOT, "web", "public", "favicon.svg"), "utf8");
  assert.match(svg, /#5b5bd6/i, "应使用主色 #5b5bd6");
  assert.match(svg, /#7c7cdf/i, "应使用主色浅色 #7c7cdf");
  assert.match(svg, />CR</, "应包含 CR 字标");
});

test("index.html 同时声明 apple-touch-icon，移动端主屏不留白块", () => {
  const html = readFileSync(join(ROOT, "web", "index.html"), "utf8");
  assert.match(html, /apple-touch-icon/, "应声明 apple-touch-icon");
});
