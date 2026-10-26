import { test } from "node:test";
import assert from "node:assert/strict";
import type { RepositoryReadAccess, RepositoryToolCallEvent } from "../../../src/domain/repository-context.ts";
import { createRepositoryTools } from "../../../src/infrastructure/pi/repository-tools.ts";

test("只注册三种仓库工具，schema 不接受任意命令、路径根或凭据", async () => {
  const calls:unknown[]=[];
  const access:RepositoryReadAccess={headSha:'a'.repeat(40),list:async input=>{calls.push(input);return{text:'src/a.ts',truncated:true,nextCursor:2};},read:async()=>({text:'1: fixture',truncated:false}),search:async()=>({text:'src/a.ts:1: fixture',truncated:false})};
  const tools=createRepositoryTools(access,new AbortController().signal);
  assert.deepEqual(tools.map(t=>t.name).sort(),['repo_list','repo_read','repo_search']);
  const ctx={} as Parameters<typeof tools[0]['execute']>[4];
  const result=await tools[0].execute('1',{prefix:'src'},undefined,undefined,ctx);
  assert.match(JSON.stringify(result),/src\/a.ts/);
  assert.match(JSON.stringify(result),/truncated/);
  assert.deepEqual(calls,[{prefix:'src'}]);
  for(const [name,args] of [['repo_list',{command:'whoami'}],['repo_read',{path:'a',startLine:0}],['repo_search',{query:''}],['repo_search',{query:'x'.repeat(201)}]] as const){
    const tool=tools.find(t=>t.name===name)!;
    await assert.rejects(tool.execute('x',args,undefined,undefined,ctx),/参数/);
  }
  const schema=JSON.stringify(tools.map(t=>t.parameters));
  assert.doesNotMatch(schema,/token|cwd|repositoryUrl|command/);
});

test("仓库工具每会话共享次数和输出预算，独立新会话不受影响", async () => {
  let calls=0;
  const access:RepositoryReadAccess={headSha:'a'.repeat(40),list:async()=>{calls++;return{text:'a',truncated:false};},read:async()=>({text:'x'.repeat(16000),truncated:false}),search:async()=>({text:'',truncated:false})};
  const tools=createRepositoryTools(access,new AbortController().signal);
  const ctx={} as Parameters<typeof tools[0]['execute']>[4];
  for(let i=0;i<40;i++)await tools[0].execute(String(i),{},undefined,undefined,ctx);
  await assert.rejects(tools[0].execute('41',{},undefined,undefined,ctx),/预算|次数/);
  assert.equal(calls,40);
  const second=createRepositoryTools(access,new AbortController().signal);
  await second[0].execute('new',{},undefined,undefined,ctx);
  assert.equal(calls,41);
  let emitted=0;
  for(let i=0;i<10;i++){
    try {const result=await second[1].execute('read',{path:'a'},undefined,undefined,ctx);emitted+=JSON.stringify(result.content).length;}
    catch(error){assert.match((error as Error).message,/预算/);break;}
  }
  assert(emitted<129000,'输出预算必须限制累计正文');
});

test("取消信号同时覆盖会话与单次调用，取消后不调用只读端口", async () => {
  let calls=0;
  const access:RepositoryReadAccess={headSha:'a'.repeat(40),list:async()=>{calls++;return{text:'x',truncated:false};},read:async()=>({text:'',truncated:false}),search:async()=>({text:'',truncated:false})};
  const controller=new AbortController();
  const tool=createRepositoryTools(access,controller.signal)[0];
  const ctx={} as Parameters<typeof tool.execute>[4];
  const once=new AbortController();once.abort();
  await assert.rejects(tool.execute('x',{},once.signal,undefined,ctx),/中断/);
  controller.abort();
  await assert.rejects(tool.execute('y',{},undefined,undefined,ctx),/中断/);
  assert.equal(calls,0);
});

const eventAccess: RepositoryReadAccess = {
  headSha: "a".repeat(40),
  list: async () => ({ text: "src/private-list.ts", truncated: false }),
  read: async () => ({ text: "1: private-source-body 密钥🔒", truncated: false }),
  search: async () => ({ text: "src/private-search.ts:1: private-search-body", truncated: false }),
};
const eventContext = {} as Parameters<ReturnType<typeof createRepositoryTools>[number]["execute"]>[4];

/** 事件只允许固定元数据字段，正文、参数和原始异常都不能成为附加属性。 */
function assertToolCallEvent(
  events: RepositoryToolCallEvent[],
  expected: Omit<RepositoryToolCallEvent, "durationMs">,
): void {
  assert.equal(events.length, 1, "每次 execute 必须且只能通知一次");
  const event = events[0];
  assert.deepEqual(Object.keys(event).sort(), [
    "durationMs", "outcome", "outputCharacters", "tool", "truncated",
  ]);
  assert.deepEqual({ ...event, durationMs: 0 }, { ...expected, durationMs: 0 });
  assert.equal(typeof event.durationMs, "number");
  assert.ok(Number.isFinite(event.durationMs) && event.durationMs >= 0, "耗时必须是非负有限毫秒数");
}

for (const entry of [
  { name: "repo_list", args: { prefix: "private-prefix", query: "private-list-query", cursor: 3 }, body: "src/private-list.ts" },
  { name: "repo_read", args: { path: "private-path.ts", startLine: 2, limit: 3 }, body: "1: private-source-body 密钥🔒" },
  { name: "repo_search", args: { query: "private-search-query", prefix: "private-prefix", cursor: 4 }, body: "src/private-search.ts:1: private-search-body" },
] as const) {
  test(`仓库工具事件 ${entry.name} 成功只报告元数据，字符数包含模型实际收到的元信息`, async () => {
    const events: RepositoryToolCallEvent[] = [];
    const tools = createRepositoryTools(eventAccess, new AbortController().signal, event => events.push(event));
    const tool = tools.find(item => item.name === entry.name)!;
    const result = await tool.execute("private-call-id", entry.args, undefined, undefined, eventContext);
    const content = result.content[0];
    assert.equal(content.type, "text");
    if (content.type !== "text") assert.fail("仓库工具必须返回模型文本");
    assert.ok(content.text.startsWith(entry.body));
    assert.match(content.text, /truncated=false/);
    assert.ok(content.text.length > entry.body.length, "统计不能仅包含只读端口正文");
    assertToolCallEvent(events, {
      tool: entry.name, outcome: "success", outputCharacters: content.text.length, truncated: false,
    });
    assert.doesNotMatch(JSON.stringify(events), /private-|密钥|🔒/);
  });
}

for (const entry of [
  { label: "只读端口分页", name: "repo_list", args: {}, result: { text: "private-page", truncated: true, nextCursor: 8 } },
  { label: "单次输出超限", name: "repo_read", args: { path: "private-path.ts" }, result: { text: "private-source-body".repeat(1500), truncated: false } },
] as const) {
  test(`仓库工具事件 ${entry.label} 的 truncated 与模型实际结果一致`, async () => {
    const events: RepositoryToolCallEvent[] = [];
    const access: RepositoryReadAccess = {
      ...eventAccess,
      list: async () => entry.result,
      read: async () => entry.result,
    };
    const tool = createRepositoryTools(access, new AbortController().signal, event => events.push(event))
      .find(item => item.name === entry.name)!;
    const result = await tool.execute("truncated", entry.args, undefined, undefined, eventContext);
    const content = result.content[0];
    if (content.type !== "text") assert.fail("仓库工具必须返回模型文本");
    assert.ok(typeof result.details === "object" && result.details !== null && "truncated" in result.details);
    assert.equal(result.details.truncated, true);
    assert.match(content.text, /truncated=true/);
    assert.ok(content.text.length <= 16_000, "新增观察不能放宽既有单次输出预算");
    assertToolCallEvent(events, {
      tool: entry.name, outcome: "success", outputCharacters: content.text.length, truncated: true,
    });
  });
}

for (const entry of [
  { name: "repo_list", args: { query: "private-query", token: "private-token" } },
  { name: "repo_read", args: { path: "private-path.ts", startLine: 0 } },
  { name: "repo_search", args: { query: "private-query".repeat(20) } },
] as const) {
  test(`仓库工具事件 ${entry.name} 参数拒绝仍只通知一次且不暴露参数`, async () => {
    const events: RepositoryToolCallEvent[] = [];
    let accessCalls = 0;
    const action = async () => {
      accessCalls += 1;
      return { text: "private-source-body", truncated: false };
    };
    const access: RepositoryReadAccess = { headSha: eventAccess.headSha, list: action, read: action, search: action };
    const tool = createRepositoryTools(access, new AbortController().signal, event => events.push(event))
      .find(item => item.name === entry.name)!;
    await assert.rejects(tool.execute("private-call-id", entry.args, undefined, undefined, eventContext), /参数/);
    assert.equal(accessCalls, 0, "参数拒绝不能触达只读端口");
    assertToolCallEvent(events, {
      tool: entry.name, outcome: "failed", outputCharacters: 0, truncated: false,
    });
    assert.doesNotMatch(JSON.stringify(events), /private-|token|path|query|error|stack/);
  });
}

for (const name of ["repo_list", "repo_read", "repo_search"] as const) {
  test(`仓库工具事件 ${name} 读取失败保留原异常，事件不含错误、query、token 或正文`, async () => {
    const events: RepositoryToolCallEvent[] = [];
    const failure = new Error("private-raw-error private-token", {
      cause: { query: "private-query", token: "private-token", body: "private-source-body" },
    });
    const fail = async () => { throw failure; };
    const access: RepositoryReadAccess = { headSha: eventAccess.headSha, list: fail, read: fail, search: fail };
    const tool = createRepositoryTools(access, new AbortController().signal, event => events.push(event))
      .find(item => item.name === name)!;
    const args = name === "repo_read" ? { path: "private-path.ts" } : { query: "private-query" };
    await assert.rejects(tool.execute("private-call-id", args, undefined, undefined, eventContext), error => error === failure);
    assertToolCallEvent(events, { tool: name, outcome: "failed", outputCharacters: 0, truncated: false });
    assert.doesNotMatch(JSON.stringify(events), /private-|token|path|query|body|error|stack|cause/);
  });
}

for (const source of ["会话", "单次调用"] as const) {
  test(`仓库工具事件 ${source}提前取消也通知一次且不触达只读端口`, async () => {
    const events: RepositoryToolCallEvent[] = [];
    const session = new AbortController();
    const once = new AbortController();
    (source === "会话" ? session : once).abort(new Error("private-cancel-reason private-token"));
    let accessCalls = 0;
    const access: RepositoryReadAccess = {
      ...eventAccess,
      read: async () => { accessCalls += 1; return { text: "private-source-body", truncated: false }; },
    };
    const tool = createRepositoryTools(access, session.signal, event => events.push(event))[1];
    await assert.rejects(tool.execute("cancelled", { path: "private-path.ts" }, once.signal, undefined, eventContext), /中断/);
    assert.equal(accessCalls, 0);
    assertToolCallEvent(events, { tool: "repo_read", outcome: "failed", outputCharacters: 0, truncated: false });
    assert.doesNotMatch(JSON.stringify(events), /private-|token|error|reason/);
  });
}

for (const source of ["会话", "单次调用"] as const) {
  test(`仓库工具事件 读取中${source}取消不会将未交付正文统计为成功`, async () => {
    const events: RepositoryToolCallEvent[] = [];
    const session = new AbortController();
    const once = new AbortController();
    const access: RepositoryReadAccess = {
      ...eventAccess,
      read: async (_input, signal) => {
        assert.equal(signal?.aborted, false);
        (source === "会话" ? session : once).abort();
        assert.equal(signal?.aborted, true, "既有取消信号必须继续传给只读端口");
        return { text: "private-undelivered-source", truncated: true };
      },
    };
    const tool = createRepositoryTools(access, session.signal, event => events.push(event))[1];
    await assert.rejects(tool.execute("cancelled-during-read", { path: "private-path.ts" }, once.signal, undefined, eventContext), /中断/);
    assertToolCallEvent(events, { tool: "repo_read", outcome: "failed", outputCharacters: 0, truncated: false });
  });
}

test("仓库工具事件 次数预算耗尽的被拒 execute 也只通知一次", async () => {
  const events: RepositoryToolCallEvent[] = [];
  let accessCalls = 0;
  const access: RepositoryReadAccess = {
    ...eventAccess,
    list: async () => { accessCalls += 1; return { text: "a", truncated: false }; },
  };
  const tool = createRepositoryTools(access, new AbortController().signal, event => events.push(event))[0];
  for (let index = 0; index < 40; index += 1) {
    await tool.execute(String(index), {}, undefined, undefined, eventContext);
  }
  await assert.rejects(tool.execute("over-budget", {}, undefined, undefined, eventContext), /预算|次数/);
  assert.equal(accessCalls, 40, "新增观察不能放宽既有 40 次预算");
  assert.equal(events.length, 41);
  assert.ok(events.slice(0, 40).every(event => event.outcome === "success"));
  assertToolCallEvent(events.slice(40), { tool: "repo_list", outcome: "failed", outputCharacters: 0, truncated: false });
});

test("仓库工具事件 累计字符预算耗尽后拒绝也通知，截断输出只统计实际交付字符", async () => {
  const events: RepositoryToolCallEvent[] = [];
  let accessCalls = 0;
  const access: RepositoryReadAccess = {
    ...eventAccess,
    read: async () => { accessCalls += 1; return { text: "private-source-body".repeat(1500), truncated: false }; },
  };
  const tool = createRepositoryTools(access, new AbortController().signal, event => events.push(event))[1];
  let remaining = 128_000;
  let deliveredCharacters = 0;
  let successfulCalls = 0;
  while (remaining > 0 && successfulCalls < 40) {
    const result = await tool.execute(String(successfulCalls), { path: "private-path.ts" }, undefined, undefined, eventContext);
    const content = result.content[0];
    if (content.type !== "text") assert.fail("仓库工具必须返回模型文本");
    successfulCalls += 1;
    deliveredCharacters += content.text.length;
    assert.ok(typeof result.details === "object" && result.details !== null && "remainingCharacters" in result.details);
    assert.ok(typeof result.details.remainingCharacters === "number");
    remaining = result.details.remainingCharacters;
    assert.equal(events.length, successfulCalls);
    assertToolCallEvent(events.slice(-1), {
      tool: "repo_read", outcome: "success", outputCharacters: content.text.length, truncated: true,
    });
  }
  assert.equal(deliveredCharacters, 128_000, "新增观察不能放宽既有累计字符预算");
  await assert.rejects(tool.execute("over-character-budget", { path: "private-path.ts" }, undefined, undefined, eventContext), /预算/);
  assert.equal(accessCalls, successfulCalls, "预算拒绝不能再次读取正文");
  assert.equal(events.length, successfulCalls + 1);
  assertToolCallEvent(events.slice(-1), { tool: "repo_read", outcome: "failed", outputCharacters: 0, truncated: false });
});

test("仓库工具事件 observer 抛错不改变成功返回文本、元信息或预算", async () => {
  const events: RepositoryToolCallEvent[] = [];
  const signal = new AbortController().signal;
  const reference = createRepositoryTools(eventAccess, signal)[1];
  const observed = createRepositoryTools(eventAccess, signal, event => {
    events.push(event);
    throw new Error("private-observer-error");
  })[1];
  const args = { path: "private-path.ts" };
  const expected = await reference.execute("baseline", args, undefined, undefined, eventContext);
  const actual = await observed.execute("observed", args, undefined, undefined, eventContext);
  assert.deepEqual(actual, expected);
  const content = actual.content[0];
  if (content.type !== "text") assert.fail("仓库工具必须返回模型文本");
  assertToolCallEvent(events, { tool: "repo_read", outcome: "success", outputCharacters: content.text.length, truncated: false });
});

test("仓库工具事件 observer 抛错不能替换原始读取异常或重复通知", async () => {
  const events: RepositoryToolCallEvent[] = [];
  const failure = new Error("private-original-read-error private-token");
  const access: RepositoryReadAccess = { ...eventAccess, read: async () => { throw failure; } };
  const tool = createRepositoryTools(access, new AbortController().signal, event => {
    events.push(event);
    throw new Error("private-observer-error");
  })[1];
  await assert.rejects(tool.execute("failed", { path: "private-path.ts" }, undefined, undefined, eventContext), error => error === failure);
  assertToolCallEvent(events, { tool: "repo_read", outcome: "failed", outputCharacters: 0, truncated: false });
  assert.doesNotMatch(JSON.stringify(events), /private-|token|error|stack/);
});
