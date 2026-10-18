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

test(".gitattributes 强制 shell 脚本与 Dockerfile 用 LF", () => {
  const path = join(ROOT, ".gitattributes");
  assert.equal(existsSync(path), true, "缺少 .gitattributes");

  const attrs = readFileSync(path, "utf8");
  assert.match(attrs, /\*\.sh text eol=lf/, "所有 .sh 必须 LF");
  assert.match(attrs, /docker-entrypoint\.sh text eol=lf/, "entrypoint 必须 LF");
  assert.match(attrs, /Dockerfile text eol=lf/, "Dockerfile 必须 LF");
});
