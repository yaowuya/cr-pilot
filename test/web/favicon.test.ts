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

test("favicon 使用 Framed Sheet 的 CR 线框标识并适配浏览器暗色主题", () => {
  const svg = readFileSync(join(ROOT, "web", "public", "favicon.svg"), "utf8");
  assert.doesNotMatch(svg, /linearGradient|url\(#brand\)/, "新图标不再使用旧版渐变方块");
  assert.match(svg, /#eef2f7/i, "亮色底应复用页面框架色");
  assert.match(svg, /#20293a/i, "亮色线框应复用主文本墨色");
  assert.match(svg, /prefers-color-scheme:\s*dark/i, "SVG 应跟随浏览器标签的暗色偏好");
  assert.match(svg, /#151e30/i, "暗色底应复用工作表色");
  assert.match(svg, /#f1f5f9/i, "暗色线框与字标应使用亮色文本色");
  assert.match(svg, />CR</, "应包含 CR 字标");
});

test("index.html 用版本参数刷新 favicon 缓存，并同时声明 apple-touch-icon", () => {
  const html = readFileSync(join(ROOT, "web", "index.html"), "utf8");
  assert.match(html, /rel="icon"[^>]+href="\/favicon\.svg\?v=2"/, "浏览器标签图标应使用版本化地址");
  assert.match(html, /rel="apple-touch-icon"[^>]+href="\/favicon\.svg\?v=2"/, "主屏图标应与标签图标同版本");
});
