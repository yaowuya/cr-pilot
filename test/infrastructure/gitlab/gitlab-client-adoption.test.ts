import { test } from "node:test";
import assert from "node:assert/strict";
import { createGitlabClient } from "../../../src/infrastructure/gitlab/gitlab-client.ts";
import { createSilentLogger } from "../../../src/shared/logger.ts";

/** 最小客户端：固定 base 与可注入 fetch。 */
function makeClient(fetchFn: typeof fetch) {
  return createGitlabClient({
    url: "https://gitlab.example.com",
    timeoutMs: 1000,
    insecureTls: false,
    logger: createSilentLogger(),
    fetchFn,
  });
}

test("getFileRaw 按 ref 请求 raw 文件并返回文本", async () => {
  const calls: string[] = [];
  const client = makeClient((async (input: string | URL | Request) => {
    calls.push(String(input));
    return new Response("const a = 1;\n", { status: 200 });
  }) as typeof fetch);

  const text = await client.getFileRaw(1, 7, "src/a.ts", "abc123");
  assert.equal(text, "const a = 1;\n");
  assert.equal(calls.length, 1);
  // 路径必须整体编码：斜杠不能变成真实路径分隔
  assert.match(calls[0], /\/projects\/1\/repository\/files\/src%2Fa\.ts\/raw\?ref=abc123$/);
});

test("getFileRaw 文件不存在时抛错而不是返回空串", async () => {
  const client = makeClient((async () => new Response("404 File Not Found", { status: 404 })) as typeof fetch);
  await assert.rejects(() => client.getFileRaw(1, 7, "src/a.ts", "abc"), /404/);
});

test("讨论映射保留解决状态，缺失按 false", async () => {
  const client = makeClient((async () =>
    new Response(
      JSON.stringify([
        {
          id: "d1",
          notes: [
            { id: 1, body: "x", resolvable: true, resolved: true },
            { id: 2, body: "y" },
            { id: 3, body: "z", resolvable: true, resolved: false },
          ],
        },
      ]),
      { status: 200 },
    )) as typeof fetch);

  const discussions = await client.getDiscussions(1, 7);
  assert.equal(discussions[0].notes[0].resolved, true);
  assert.equal(discussions[0].notes[0].resolvable, true);
  assert.equal(discussions[0].notes[1].resolved, false, "缺失字段不能当成已解决");
  assert.equal(discussions[0].notes[2].resolved, false);
});

test("getLatestHeadSha 复用 versions 接口的 head 值", async () => {
  const client = makeClient((async () =>
    new Response(JSON.stringify({ base_commit_sha: "b", start_commit_sha: "s", head_commit_sha: "h" }), { status: 200 })) as typeof fetch);
  assert.equal(await client.getLatestHeadSha(1, 7), "h");
});
