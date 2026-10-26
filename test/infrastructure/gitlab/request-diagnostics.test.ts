import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createGitlabClient, GitlabApiError } from "../../../src/infrastructure/gitlab/gitlab-client.ts";
import { createLogger, type LogFields, type Logger } from "../../../src/shared/logger.ts";

const token = "fixture-private-task-token";
const comment = "私有评审正文：fixture-private-source，含引号\"、换行\n和表情🙂";
const position = {
  position_type: "text" as const,
  base_sha: "b".repeat(40), start_sha: "s".repeat(40), head_sha: "h".repeat(40),
  old_path: "a.ts", new_path: "a.ts", new_line: 1,
};

/** 真 Response + 注入 fetch，诊断测试不访问网络、不使用真实凭据。 */
function harness(respond: () => Response | Promise<Response>) {
  const logs: { level: string; message: string; fields?: LogFields }[] = [];
  const lines: string[] = [];
  const sink = createLogger("debug", (line) => { lines.push(line); });
  const logger: Logger = {
    debug: (message, fields) => { logs.push({ level: "debug", message, fields }); sink.debug(message, fields); },
    info: (message, fields) => { logs.push({ level: "info", message, fields }); sink.info(message, fields); },
    warn: (message, fields) => { logs.push({ level: "warn", message, fields }); sink.warn(message, fields); },
    error: (message, fields) => { logs.push({ level: "error", message, fields }); sink.error(message, fields); },
  };
  const calls: { url: string; init: RequestInit }[] = [];
  const client = createGitlabClient({
    url: "https://gitlab.example.invalid", timeoutMs: 1000, insecureTls: false, logger,
    fetchFn: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return respond();
    },
  });
  return { client, calls, logs, lines };
}

const readOperations = [
  { name: "普通 JSON 请求", path: "/changes", run: (client: ReturnType<typeof createGitlabClient>) => client.getMergeRequestChanges(7, 8, "", token) },
  { name: "分页请求", path: "/discussions", run: (client: ReturnType<typeof createGitlabClient>) => client.getDiscussions(7, 8, "", token) },
  { name: "raw 文件请求", path: "/raw", run: (client: ReturnType<typeof createGitlabClient>) => client.getFileRaw(7, 8, "a.ts", "h", "", token) },
];

for (const operation of readOperations) {
  test(`${operation.name} 的 JSON 403 保留类别和安全追踪字段，不重试`, async () => {
    const { client, calls, logs } = harness(() => Response.json(
      { message: "403 Forbidden" },
      { status: 403, headers: { "x-request-id": "fixture-request-403", server: "nginx/1.26" } },
    ));
    await assert.rejects(operation.run(client), (error: unknown) => {
      assert.ok(error instanceof GitlabApiError);
      assert.equal(error.status, 403);
      assert.equal(error.responseKind, "json");
      assert.match(error.message, /403 Forbidden/);
      assert.match(error.message, /fixture-request-403/);
      assert.doesNotMatch(error.message, /WAF/);
      return true;
    });
    assert.equal(calls.length, 1);
    const fields = logs.find((entry) => entry.message === "GitLab API 请求失败")?.fields;
    assert.equal(fields?.方法, "GET");
    assert.ok(String(fields?.路径).includes(operation.path));
    assert.equal(fields?.状态码, 403);
    assert.equal(fields?.响应类别, "json");
    assert.equal(fields?.响应ContentType, "application/json");
    assert.equal(fields?.请求ID, "fixture-request-403");
    assert.equal(fields?.服务标识, "nginx/1.26");
  });
}

test("明确 WAF HTML 403 归类为 waf，不回显拦截页或敏感响应头", async () => {
  const html = `<!DOCTYPE html><html><head>${" ".repeat(700)}<title>WAF拦截页面</title></head><body>${token} ${comment}</body></html>`;
  const { client, calls, logs, lines } = harness(() => new Response(html, {
    status: 403,
    headers: {
      "content-type": "text/html; charset=utf-8", "x-request-id": "waf-event-123", server: "nginx",
      "set-cookie": "fixture-private-cookie", "private-token": token,
      location: "https://private.example/?token=fixture-location-secret", "x-waf-secret": "fixture-private-waf-secret",
    },
  }));
  await assert.rejects(client.postMergeRequestNote(7, 8, comment, "", token), (error: unknown) => {
    assert.ok(error instanceof GitlabApiError);
    assert.equal(error.status, 403);
    assert.equal(error.responseKind, "waf");
    assert.match(error.message, /WAF.*拦截/);
    assert.match(error.message, /waf-event-123/);
    assert.doesNotMatch(error.message, /<!DOCTYPE|<html|<body|fixture-private/);
    return true;
  });
  assert.equal(calls.length, 1, "诊断改动不得增加重试或备用写接口");
  assert.equal(new Headers(calls[0].init.headers).get("PRIVATE-TOKEN"), token);
  assert.equal(calls[0].init.body, JSON.stringify({ body: comment }));
  const fields = logs.find((entry) => entry.message === "GitLab API 请求失败")?.fields;
  assert.equal(fields?.响应类别, "waf");
  assert.equal(fields?.响应ContentType, "text/html");
  assert.equal(fields?.请求ID, "waf-event-123");
  const output = JSON.stringify({ logs, lines });
  for (const secret of [token, comment, "fixture-private-source", "fixture-private-cookie", "fixture-location-secret", "fixture-private-waf-secret"]) {
    assert.ok(!output.includes(secret), `诊断中不得回显 ${secret}`);
  }
});

test("普通 HTML 403 不是 WAF，JSON 正文含 WAF 字样也不能误分类", async () => {
  for (const fixture of [
    { body: "<html><head><title>Sign in</title></head><body>WAF example</body></html>", type: "text/html", expected: "html" },
    { body: JSON.stringify({ message: "403 Forbidden", example: "<title>WAF拦截页面</title>" }), type: "application/json", expected: "json" },
    { body: "fixture-private-unknown-response", type: "text/plain", expected: "unknown" },
  ]) {
    const { client, lines } = harness(() => new Response(fixture.body, {
      status: 403, headers: { "content-type": fixture.type },
    }));
    await assert.rejects(client.postMergeRequestNote(7, 8, comment, "", token), (error: unknown) => {
      assert.ok(error instanceof GitlabApiError);
      assert.equal(error.responseKind, fixture.expected);
      assert.doesNotMatch(error.message, /WAF.*拦截|<html>|fixture-private-unknown-response/);
      return true;
    });
    assert.ok(!lines.join("\n").includes("fixture-private-unknown-response"));
  }
});

test("反射到 JSON message 和追踪字段的任务凭据、正文被清除，任意响应字段不入日志", async () => {
  const { client, logs, lines } = harness(() => Response.json({
    message: `rejected ${token}: ${comment}`,
    body: comment, debug: "fixture-private-extra-json-field",
  }, {
    status: 403,
    headers: {
      "content-type": `application/json; private=${token}`,
      "x-request-id": `id-${token}`, server: token,
      "x-extra": "fixture-private-extra-header",
    },
  }));
  let message = "";
  await assert.rejects(client.postMergeRequestNote(7, 8, comment, "", token), (error: unknown) => {
    assert.ok(error instanceof GitlabApiError);
    assert.equal(error.responseKind, "json");
    message = error.message;
    return true;
  });
  const output = JSON.stringify({ message, logs, lines });
  for (const secret of [token, "fixture-private-source", "fixture-private-extra-json-field", "fixture-private-extra-header"]) {
    assert.ok(!output.includes(secret), `反射值 ${secret} 不得泄露`);
  }
});

test("JSON message 原样或编码反射包含 token 的评论时，不能泄露剩余源码", async () => {
  const privateComment = `fixture-private-overlapping-source ${token} \"quoted\"\nconfidential-review`;
  for (const reflected of [privateComment, JSON.stringify(privateComment)]) {
    const { client, logs, lines } = harness(() => Response.json({ message: `rejected body=${reflected}` }, { status: 403 }));
    let message = "";
    await assert.rejects(client.postMergeRequestNote(7, 8, privateComment, "", token), (error: unknown) => {
      assert.ok(error instanceof GitlabApiError);
      assert.equal(error.responseKind, "json");
      message = error.message;
      return true;
    });
    const output = JSON.stringify({ message, logs, lines });
    assert.ok(!output.includes(token));
    assert.ok(!output.includes("fixture-private-overlapping-source"));
    assert.ok(!output.includes("confidential-review"));
  }
});

test("HTML 注释或脚本中的 WAF 标题示例不能覆盖实际 Sign in 标题", async () => {
  for (const example of [
    "<!-- <title>WAF拦截页面</title> -->",
    "<script>const example = '<title>WAF拦截页面</title>';</script>",
    "<style>/* <title>WAF拦截页面</title> */</style>",
    "<template><title>WAF拦截页面</title></template>",
  ]) {
    const { client } = harness(() => new Response(`<html><head>${example}<title>Sign in</title></head><body>Login</body></html>`, {
      status: 403, headers: { "content-type": "text/html" },
    }));
    await assert.rejects(client.postMergeRequestNote(7, 8, comment, "", token), (error: unknown) => {
      assert.ok(error instanceof GitlabApiError);
      assert.equal(error.responseKind, "html");
      assert.doesNotMatch(error.message, /WAF.*拦截/);
      return true;
    });
  }
});

test("嵌套模板、属性及脚本中的注释标记不干扰真实标题", async () => {
  for (const fixture of [
    { example: "<template><template>example</template><title>WAF拦截页面</title></template>", title: "Sign in", kind: "html" },
    { example: '<meta name="example" content="<title>WAF拦截页面</title>">', title: "Sign in", kind: "html" },
    { example: '<script>const example = "<!--";</script>', title: "WAF拦截页面", kind: "waf" },
    { example: '<meta name="example" content="<title>Sign in</title>">', title: "WAF拦截页面", kind: "waf" },
  ]) {
    const { client } = harness(() => new Response(`<html><head>${fixture.example}<title>${fixture.title}</title></head></html>`, {
      status: 403, headers: { "content-type": "text/html" },
    }));
    await assert.rejects(client.postMergeRequestNote(7, 8, comment, "", token), (error: unknown) => {
      assert.ok(error instanceof GitlabApiError);
      assert.equal(error.responseKind, fixture.kind);
      return true;
    });
  }
});

test("追踪字段有长度和字符限制，不因可打印就接受整个响应头", async () => {
  const { client, logs, lines } = harness(() => Response.json({ message: "403 Forbidden" }, {
    status: 403,
    headers: { "x-request-id": "x".repeat(600), server: "s".repeat(600) },
  }));
  await assert.rejects(client.getMergeRequestChanges(7, 8, "", token));
  const fields = logs.find((entry) => entry.message === "GitLab API 请求失败")?.fields;
  assert.equal(fields?.请求ID, undefined);
  assert.equal(fields?.服务标识, undefined);
  assert.ok(!lines.join("\n").includes("x".repeat(600)));
});

test("notes/discussions 在真实发送边界只记录 JSON 字节数及 SHA256，不改变请求正文", async () => {
  const { client, calls, logs, lines } = harness(() => Response.json({ id: "d1", notes: [] }, { status: 201 }));
  await client.postMergeRequestNote(7, 8, comment, "", token);
  await client.postDiscussion(7, 8, comment, position, "", token);
  const requests = logs.filter((entry) => entry.message === "GitLab 写入请求");
  assert.equal(requests.length, 2);
  assert.equal(calls.length, 2);
  for (const [index, call] of calls.entries()) {
    const expected = index === 0 ? JSON.stringify({ body: comment }) : JSON.stringify({ body: comment, position });
    assert.equal(call.init.body, expected);
    assert.equal(requests[index].fields?.方法, "POST");
    assert.equal(requests[index].fields?.路径, new URL(call.url).pathname);
    assert.equal(requests[index].fields?.请求体字节数, Buffer.byteLength(expected, "utf8"));
    assert.equal(requests[index].fields?.请求体SHA256, createHash("sha256").update(expected, "utf8").digest("hex"));
  }
  const output = JSON.stringify({ logs, lines });
  assert.ok(!output.includes(token));
  assert.ok(!output.includes("fixture-private-source"));
});

test("错误响应体读取失败时仍保留 HTTP 状态与安全追踪 ID", async () => {
  const { client, calls } = harness(() => {
    const response = new Response("", { status: 403, headers: { "x-request-id": "read-error-123" } });
    Object.defineProperty(response, "text", { value: async () => { throw new Error(`read failed: ${token}`); } });
    return response;
  });
  await assert.rejects(client.postMergeRequestNote(7, 8, comment, "", token), (error: unknown) => {
    assert.ok(error instanceof GitlabApiError);
    assert.equal(error.status, 403);
    assert.match(error.message, /read-error-123/);
    assert.ok(!error.message.includes(token));
    return true;
  });
  assert.equal(calls.length, 1);
});
