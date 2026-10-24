import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { createLogger } from "../../../src/shared/logger.ts";
import { createAgentSession } from "@earendil-works/pi-coding-agent";
import type { RepositoryReadAccess } from "../../../src/domain/repository-context.ts";

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
    model: { id: "test-model" },
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
  assert.equal(result.model, "test-model");
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
