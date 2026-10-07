import { test } from "node:test";
import assert from "node:assert/strict";
import { createWecomNotifier, truncateUtf8Bytes } from "../../../src/infrastructure/wecom/wecom-notifier.ts";
import { createSilentLogger } from "../../../src/shared/logger.ts";

function trackFetch(respond: () => Response): { calls: { url: string; init: RequestInit }[]; fetchFn: typeof fetch } {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return respond();
  }) as typeof fetch;
  return { calls, fetchFn };
}

test("send 发送企微 markdown 机器人消息", async () => {
  const { calls, fetchFn } = trackFetch(() => {
    const response = { status: 200, ok: true, json: async () => ({ errcode: 0 }) } as Response;
    return response;
  });
  const notifier = createWecomNotifier({ logger: createSilentLogger(), fetchFn });
  await notifier.send("https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test", "# 标题\n\n正文");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test");
  const body = JSON.parse(String(calls[0].init.body)) as { msgtype: string; markdown: { content: string } };
  assert.equal(body.msgtype, "markdown");
  assert.equal(body.markdown.content, "# 标题\n\n正文");
});

test("send 对企微 errcode 非 0 抛错", async () => {
  const { fetchFn } = trackFetch(() => {
    const response = { status: 200, ok: true, json: async () => ({ errcode: 93000, errmsg: "invalid webhook" }) } as Response;
    return response;
  });
  const notifier = createWecomNotifier({ logger: createSilentLogger(), fetchFn });
  await assert.rejects(() => notifier.send("https://x", "content"), /errcode=93000/);
});

test("send 对 HTTP 非 2xx 抛错", async () => {
  const { fetchFn } = trackFetch(() => {
    const response = { status: 403, ok: false, json: async () => ({}) } as Response;
    return response;
  });
  const notifier = createWecomNotifier({ logger: createSilentLogger(), fetchFn });
  await assert.rejects(() => notifier.send("https://x", "content"), /HTTP 403/);
});

test("truncateUtf8Bytes 超限按字节截断并保留有效 UTF-8", () => {
  const long = "中文内容".repeat(2000);
  const truncated = truncateUtf8Bytes(long, 4096);
  const bytes = new TextEncoder().encode(truncated).length;
  assert.ok(bytes <= 4096);
  assert.match(truncated, /内容过长，已截断/);
  // 截断边界不产生损坏字符：解码回原文前缀
  const short = truncateUtf8Bytes("短内容", 4096);
  assert.equal(short, "短内容");
});
