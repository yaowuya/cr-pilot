import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { createLogger } from "../../../src/shared/logger.ts";
import { createAgentSession } from "@earendil-works/pi-coding-agent";
import type { RepositoryReadAccess, RepositoryToolCallEvent } from "../../../src/domain/repository-context.ts";

const repositoryAccess: RepositoryReadAccess = {
  headSha: "a".repeat(40),
  list: async () => ({text:"a.ts",truncated:false}),
  read: async () => ({text:"1: fixture",truncated:false}),
  search: async () => ({text:"",truncated:false}),
};
import {
  buildLoaderOptions,
  buildRepositorySessionOptions,
  buildUserMessage,
  createIsolatedWorkspace,
  createPiReviewer,
  EmptyReviewError,
  type PiSessionLike,
} from "../../../src/infrastructure/pi/reviewer.ts";

function fakeSession(text: string | undefined) {
  let disposeCount = 0;
  const session: PiSessionLike = {
    prompt: async () => {},
    getLastAssistantText: () => text,
    model: {
      provider: "test-provider",
      id: "test-model",
      baseUrl: "https://test-provider.example/v1",
      api: "openai-responses",
    },
    dispose: () => {
      disposeCount += 1;
    },
  };
  return { session, disposeCount: () => disposeCount };
}

test("createIsolatedWorkspace 返回已存在且为空的目录", () => {
  const dir = createIsolatedWorkspace();
  try {
    assert.equal(existsSync(dir), true);
    assert.deepEqual(readdirSync(dir), []);
    assert.notEqual(dir, createIsolatedWorkspace());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildLoaderOptions 保留旧模式的 context/skills/templates 关闭约定", () => {
  const options = buildLoaderOptions({ prompt: "PROMPT", cwd: "C:/tmp/x", agentDir: "C:/agent" });
  assert.equal(options.cwd, "C:/tmp/x");
  assert.equal(options.agentDir, "C:/agent");
  assert.equal(options.noContextFiles, true);
  assert.equal(options.noSkills, true);
  assert.equal(options.noPromptTemplates, true);
  assert.equal(options.systemPromptOverride?.("base"), "PROMPT");
  assert.deepEqual(options.appendSystemPromptOverride?.(["base"]), []);
});

test("buildUserMessage 有上下文时前置背景段", () => {
  assert.match(buildUserMessage("CODE", "CTX"), /CTX[\s\S]*CODE/);
  assert.equal(buildUserMessage("CODE"), "待评审的代码变更：\nCODE");
});

test("上下文会话初始化期间取消，不执行 prompt 且等待 abort 后释放", async () => {
  const controller = new AbortController();
  let resolveFactory!: (session: PiSessionLike) => void;
  let prompted = false;
  let aborted = false;
  let disposed = false;
  const reviewer = createPiReviewer({sessionFactory:async (options) => {
    assert.equal(options.repositoryContext, repositoryAccess);
    return new Promise<PiSessionLike>(resolve => {resolveFactory = resolve;});
  }});
  const pending = reviewer.review({systemPrompt:"s",code:"diff",signal:controller.signal,repositoryContext:repositoryAccess});
  controller.abort();
  resolveFactory({prompt:async()=>{prompted=true;},getLastAssistantText:()=>"text",model:undefined,
    abort:async()=>{await new Promise(resolve=>setTimeout(resolve,10));aborted=true;},
    dispose:()=>{assert.equal(aborted,true);disposed=true;}});
  await assert.rejects(pending);
  assert.equal(prompted,false);
  assert.equal(disposed,true);
});

test("上下文 SDK options 无发现资源，实际激活工具只有三种仓库读取", async () => {
  const cwd = createIsolatedWorkspace();
  const agentDir = createIsolatedWorkspace();
  const options = buildRepositorySessionOptions({systemPrompt:"trusted-prompt",cwd,agentDir,repositoryContext:repositoryAccess,signal:new AbortController().signal,
    settings:{defaultProvider:"safe-provider",defaultModel:"safe-model",packages:["must-not-install"],extensions:["must-not-run"],defaultTools:["bash"],defaultThinkingLevel:"low"}});
  try {
    assert.equal(options.cwd,cwd);
    assert.equal(options.settingsManager?.getDefaultProvider(),"safe-provider");
    assert.equal(options.settingsManager?.getDefaultModel(),"safe-model");
    assert.equal(options.settingsManager?.getDefaultThinkingLevel(),"low");
    assert.deepEqual(options.settingsManager?.getSettings().packages,undefined);
    assert.deepEqual(options.tools,["repo_list","repo_read","repo_search"]);
    await options.resourceLoader!.reload();
    assert.deepEqual(options.resourceLoader!.getAgentsFiles(),{agentsFiles:[]});
    assert.deepEqual(options.resourceLoader!.getAppendSystemPrompt(),[]);
    assert.deepEqual(options.resourceLoader!.getExtensions().extensions,[]);
    assert.equal(options.resourceLoader!.getSystemPrompt(),"trusted-prompt");
    const {session} = await createAgentSession(options);
    try {
      assert.deepEqual(session.getActiveToolNames().sort(),["repo_list","repo_read","repo_search"]);
    } finally {await session.abort();session.dispose();}
    assert.deepEqual(readdirSync(cwd),[],"SDK cwd 不写入仓库或会话文件");
  } finally {rmSync(cwd,{recursive:true,force:true});rmSync(agentDir,{recursive:true,force:true});}
});

test("createPiReviewer 正常路径返回文本与模型并释放一次", async () => {
  const { session, disposeCount } = fakeSession("  评审结论  ");
  const reviewer = createPiReviewer({ sessionFactory: async () => session });
  const result = await reviewer.review({ systemPrompt: "P", code: "CODE", signal: AbortSignal.timeout(5000) });
  assert.equal(result.text, "评审结论");
  assert.equal(result.provider, "test-provider");
  assert.equal(result.model, "test-model");
  assert.equal(result.baseUrl, "https://test-provider.example/v1");
  assert.equal(result.api, "openai-responses");
  assert.equal(disposeCount(), 1);
});

test("createPiReviewer 对空文本抛 EmptyReviewError 且仍释放", async () => {
  const { session, disposeCount } = fakeSession("   ");
  const reviewer = createPiReviewer({ sessionFactory: async () => session });
  await assert.rejects(
    () => reviewer.review({ systemPrompt: "P", code: "CODE", signal: AbortSignal.timeout(5000) }),
    EmptyReviewError,
  );
  assert.equal(disposeCount(), 1);
});

test("createPiReviewer 在信号已中断时不创建会话直接失败", async () => {
  const { session, disposeCount } = fakeSession("x");
  let prompted = false;
  session.prompt = async () => {
    prompted = true;
  };
  const reviewer = createPiReviewer({ sessionFactory: async () => session });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => reviewer.review({ systemPrompt: "P", code: "CODE", signal: controller.signal }));
  assert.equal(disposeCount(), 0);
  assert.equal(prompted, false);
});

test("createPiReviewer 在 debug 级别记录会话生命周期", async () => {
  const lines: string[] = [];
  const logger = createLogger("debug", (line) => lines.push(line));
  const { session } = fakeSession("  评审结论  ");
  const reviewer = createPiReviewer({ sessionFactory: async () => session, logger });
  await reviewer.review({ systemPrompt: "P", code: "CODE", context: "CTX", signal: AbortSignal.timeout(5000) });
  const text = lines.join("\n");
  assert.match(text, /创建 pi 会话/);
  assert.match(text, /会话已释放/);
  assert.match(text, /系统提示字数=1/);
  assert.match(text, /用户消息字数=\d+/);
  assert.doesNotMatch(text, /CODE/, "用户消息正文不应写入日志");
});

test("仓库工具事件 buildRepositorySessionOptions 把 observer 交给真实 customTools 而不扩散到 SDK 参数", async () => {
  const cwd = createIsolatedWorkspace();
  const agentDir = createIsolatedWorkspace();
  const events: RepositoryToolCallEvent[] = [];
  const onRepositoryToolCall = (event: RepositoryToolCallEvent): void => { events.push(event); };
  try {
    const options = buildRepositorySessionOptions({
      systemPrompt: "trusted-system-prompt", cwd, agentDir,
      repositoryContext: repositoryAccess, signal: new AbortController().signal,
      onRepositoryToolCall, settings: {},
    });
    assert.equal("onRepositoryToolCall" in options, false, "observer 不是 SDK 的额外选项");
    assert.equal(Object.values(options).includes(onRepositoryToolCall), false);
    assert.deepEqual(options.tools, ["repo_list", "repo_read", "repo_search"]);
    assert.deepEqual(options.excludeTools, ["mcp__*"]);
    assert.equal(options.resourceLoader!.getSystemPrompt(), "trusted-system-prompt");
    assert.deepEqual(options.resourceLoader!.getAppendSystemPrompt(), []);
    assert.equal(events.length, 0, "组装会话本身不是工具调用");
    const tool = options.customTools!.find(item => item.name === "repo_search")!;
    const context = {} as Parameters<typeof tool.execute>[4];
    const result = await tool.execute("offline-search", { query: "private-query" }, undefined, undefined, context);
    const content = result.content[0];
    if (content.type !== "text") assert.fail("仓库工具必须返回模型文本");
    assert.equal(events.length, 1);
    assert.deepEqual(Object.keys(events[0]).sort(), ["durationMs", "outcome", "outputCharacters", "tool", "truncated"]);
    assert.deepEqual({ ...events[0], durationMs: 0 }, {
      tool: "repo_search", outcome: "success", durationMs: 0,
      outputCharacters: content.text.length, truncated: false,
    });
    assert.ok(Number.isFinite(events[0].durationMs) && events[0].durationMs >= 0);
    assert.doesNotMatch(JSON.stringify(events), /private-query|onRepositoryToolCall/);
    assert.equal(options.resourceLoader!.getSystemPrompt(), "trusted-system-prompt");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("仓库工具事件 createPiReviewer 经离线 sessionFactory 和真实 customTools 透传三工具事件", async () => {
  const agentDir = createIsolatedWorkspace();
  let cwd: string | undefined;
  const events: RepositoryToolCallEvent[] = [];
  const outputCharacters: number[] = [];
  const onRepositoryToolCall = (event: RepositoryToolCallEvent): void => { events.push(event); };
  const controller = new AbortController();
  const { session, disposeCount } = fakeSession("离线评审结论");
  let promptText: string | undefined;
  let sdkOptions: ReturnType<typeof buildRepositorySessionOptions> | undefined;
  try {
    const reviewer = createPiReviewer({ sessionFactory: async options => {
      cwd = options.cwd;
      assert.equal(options.repositoryContext, repositoryAccess);
      assert.equal(options.signal, controller.signal);
      assert.equal(options.onRepositoryToolCall, onRepositoryToolCall, "reviewer 必须传递同一个 observer");
      // 只替换模型/SDK 会话；仓库工具仍使用生产构造器，避免工厂替身直接调用回调造成伪通过。
      const built = buildRepositorySessionOptions({ ...options, agentDir, repositoryContext: repositoryAccess, settings: {} });
      sdkOptions = built;
      assert.equal("onRepositoryToolCall" in built, false);
      assert.equal(Object.values(built).includes(onRepositoryToolCall), false);
      assert.deepEqual(built.tools, ["repo_list", "repo_read", "repo_search"]);
      assert.deepEqual(built.excludeTools, ["mcp__*"]);
      session.prompt = async text => {
        promptText = text;
        for (const entry of [
          { name: "repo_list", args: { prefix: "private-prefix" } },
          { name: "repo_read", args: { path: "private-path.ts" } },
          { name: "repo_search", args: { query: "private-query" } },
        ]) {
          const tool = built.customTools!.find(item => item.name === entry.name)!;
          const context = {} as Parameters<typeof tool.execute>[4];
          const result = await tool.execute("offline-tool-call", entry.args, undefined, undefined, context);
          const content = result.content[0];
          if (content.type !== "text") assert.fail("仓库工具必须返回模型文本");
          outputCharacters.push(content.text.length);
        }
      };
      return session;
    } });
    const result = await reviewer.review({
      systemPrompt: "trusted-system-prompt", code: "private-diff", context: "trusted-context",
      signal: controller.signal, repositoryContext: repositoryAccess, onRepositoryToolCall,
    });
    assert.deepEqual(result, {
      text: "离线评审结论",
      provider: "test-provider",
      model: "test-model",
      baseUrl: "https://test-provider.example/v1",
      api: "openai-responses",
    });
    assert.equal(disposeCount(), 1);
    assert.equal(promptText, buildUserMessage("private-diff", "trusted-context"));
    assert.equal(sdkOptions!.resourceLoader!.getSystemPrompt(), "trusted-system-prompt");
    assert.deepEqual(events.map(event => ({ ...event, durationMs: 0 })), [
      { tool: "repo_list", outcome: "success", durationMs: 0, outputCharacters: outputCharacters[0], truncated: false },
      { tool: "repo_read", outcome: "success", durationMs: 0, outputCharacters: outputCharacters[1], truncated: false },
      { tool: "repo_search", outcome: "success", durationMs: 0, outputCharacters: outputCharacters[2], truncated: false },
    ]);
    assert.doesNotMatch(JSON.stringify(events), /private-|fixture|a\.ts/);
    assert.doesNotMatch(promptText!, /onRepositoryToolCall|durationMs|outputCharacters/);
  } finally {
    if (cwd) rmSync(cwd, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  }
});

// ============ usage 透传 ============

test("createPiReviewer 透传会话实际 usage，并在缺失时不伪造零值", async () => {
  const usage = { input: 1200, output: 300, cacheRead: 500, cacheWrite: 0, totalTokens: 2000 };
  const withUsage = fakeSession("评审正文");
  withUsage.session.getUsage = () => usage;
  const reviewerWith = createPiReviewer({ sessionFactory: async () => withUsage.session });
  const resultWith = await reviewerWith.review({ systemPrompt: "P", code: "CODE", signal: AbortSignal.timeout(5000) });
  assert.deepEqual(resultWith.usage, usage, "有 usage 时必须原样带回");

  const withoutUsage = fakeSession("评审正文");
  const reviewerWithout = createPiReviewer({ sessionFactory: async () => withoutUsage.session });
  const resultWithout = await reviewerWithout.review({ systemPrompt: "P", code: "CODE", signal: AbortSignal.timeout(5000) });
  assert.equal(resultWithout.usage, undefined, "未提供 usage 时应保持 undefined，不能补 0");
});
