import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();

test("docker-entrypoint.sh 存在且声明了 POSIX shebang", () => {
  // 镜像 ENTRYPOINT 指这个脚本；缺失会让容器起不来。
  const path = join(ROOT, "docker-entrypoint.sh");
  assert.equal(existsSync(path), true, "缺少 docker-entrypoint.sh");

  const script = readFileSync(path, "utf8");
  assert.match(script, /^#!\/bin\/sh/, "必须用 /bin/sh（Alpine 无 bash）");
});

test("docker-entrypoint.sh 使用 LF 换行", () => {
  // 回归：Windows 上 core.autocrlf=true 会把脚本 checkout 成 CRLF，
  // 容器内 sh 无法解析 CRLF 的 shebang，报 "bad interpreter" 且难以定位。
  // .gitattributes 已强制 eol=lf，这条用例兜住工作区被误改的情况。
  const script = readFileSync(join(ROOT, "docker-entrypoint.sh"), "utf8");
  assert.equal(script.includes("\r\n"), false, "不得包含 CRLF");
});

test("entrypoint 在降权前修正数据与日志目录属主", () => {
  // 具名卷根目录属主是 root，不 chown 会让 node(uid 1000) 无法建库/写日志，
  // 表现为 "unable to open database file"。
  const script = readFileSync(join(ROOT, "docker-entrypoint.sh"), "utf8");
  assert.match(script, /chown -R node:node/, "必须递归修正属主");
  assert.match(script, /\/app\/data/, "必须处理数据目录");
  assert.match(script, /\/app\/logs/, "必须处理日志目录");
  assert.match(script, /su-exec node/, "修正后要降权到 node");
});

test("Dockerfile 安装 su-exec 并声明 entrypoint", () => {
  const dockerfile = readFileSync(join(ROOT, "Dockerfile"), "utf8");
  assert.match(dockerfile, /apk add[^\n]*su-exec/, "需安装 su-exec 用于降权");
  assert.match(dockerfile, /ENTRYPOINT \["\/usr\/local\/bin\/docker-entrypoint\.sh"\]/, "需声明 entrypoint");
  assert.match(dockerfile, /COPY docker-entrypoint\.sh/, "需把脚本拷进镜像");
  assert.match(dockerfile, /chmod \+x/, "脚本必须有执行权限");
});

test("Dockerfile 在装 su-exec 前可切换 apk 镜像源", () => {
  // 回归：官方源 dl-cdn.alpinelinux.org 在部分网络下 TLS 握手失败，apk 拿不到
  // 索引后会把缺包误报成 "su-exec (no such package)"；必须能整体换成可用镜像源。
  const dockerfile = readFileSync(join(ROOT, "Dockerfile"), "utf8");

  const argMatch = dockerfile.match(/^ARG APK_MIRROR=(\S+)$/m);
  assert.ok(argMatch, "需声明 APK_MIRROR 构建参数并给出默认镜像源");

  const rewrite = dockerfile.match(/sed -i "([^"]+)" \/etc\/apk\/repositories/);
  assert.ok(rewrite, "安装前需重写 /etc/apk/repositories");
  // 只替换 "://主机" 段，保留 /alpine/vX.Y/main|community 路径：
  // 这样基础镜像升级 Alpine 主版本时不用改这里。
  assert.ok(rewrite[1].includes("://[^/]*/alpine/"), "只应替换仓库地址的主机段");
  assert.equal(rewrite[1].includes(argMatch[1]), false, "sed 表达式不应硬编码默认镜像源");

  // 顺序保证：先换源再装包。
  const rewriteAt = dockerfile.indexOf(rewrite[0]);
  const apkAddAt = dockerfile.search(/apk add[^\n]*su-exec/);
  assert.ok(rewriteAt > 0 && apkAddAt > rewriteAt, "必须先重写源再 apk add");
});

test(".gitattributes 强制 shell 脚本与 Dockerfile 用 LF", () => {
  const path = join(ROOT, ".gitattributes");
  assert.equal(existsSync(path), true, "缺少 .gitattributes");

  const attrs = readFileSync(path, "utf8");
  assert.match(attrs, /\*\.sh text eol=lf/, "所有 .sh 必须 LF");
  assert.match(attrs, /docker-entrypoint\.sh text eol=lf/, "entrypoint 必须 LF");
  assert.match(attrs, /Dockerfile text eol=lf/, "Dockerfile 必须 LF");
});

test("compose 把日志挂到宿主机固定路径 /data/logs/cr-pilot", () => {
  // 运维需要按路径直接 tail / 归档日志，因此日志用 bind mount 而不是具名卷。
  const compose = readFileSync(join(ROOT, "docker-compose.yml"), "utf8");
  assert.match(compose, /\/data\/logs\/cr-pilot:\/app\/logs/, "日志应挂到 /data/logs/cr-pilot");
  assert.match(compose, /LOG_FILE=\/app\/logs\/cr-pilot\.log/, "LOG_FILE 应与日志文件名一致");
  // 日志改成 bind mount 后不该再声明具名卷
  assert.equal(/cr-pilot-logs/.test(compose), false, "不应再残留 cr-pilot-logs 卷");
});

test("compose 的宿主机端口可用 .env 覆盖", () => {
  // 线上常遇到端口被其他服务占用（port is already allocated），
  // 支持用 HOST_PORT / HOST_UI_PORT 覆盖可避免改 compose 文件。
  const compose = readFileSync(join(ROOT, "docker-compose.yml"), "utf8");
  assert.match(compose, /\$\{HOST_PORT:-5001\}:5001/, "主端口应支持覆盖且默认 5001");
  assert.match(compose, /\$\{HOST_UI_PORT:-5002\}:5002/, "管理界面端口应支持覆盖且默认 5002");
});
