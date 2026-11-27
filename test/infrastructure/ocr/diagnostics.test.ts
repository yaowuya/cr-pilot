import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { readOcrDiagnostics } from "../../../src/infrastructure/ocr/diagnostics.ts";

const sessionId = "12345678-1234-4321-8234-123456789abc";
const repoDirName = "temp-pinned-repo";
const report = {
  status: "complete",
  session_id: sessionId,
  comments: null,
  tool_calls: { by_tool: { code_comment: 2 }, failure_by_tool: { code_comment: 1 } },
  warnings: [{ type: "review_round_failed", message: "private warning", file: "private path" }, { type: "private warning type" }],
  manifest: { coverage: { excluded: [
    { exclude_reason: "default_path", path: "private test filename" },
    { exclude_reason: "default_path", path: "private second test filename" },
    { exclude_reason: "private exclusion reason", path: "private filename" },
  ] } },
};

function event(type: string, data: Record<string, unknown> = {}) {
  return { type, sessionId, ...data };
}

async function workspaceFor(t: TestContext): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "cr-pilot-ocr-diagnostics-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  return workspace;
}

async function sessionFile(workspace: string, events: Record<string, unknown>[]): Promise<string> {
  const directory = join(workspace, ".opencodereview", "sessions", repoDirName);
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${sessionId}.jsonl`);
  await writeFile(path, events.map((record) => JSON.stringify(record)).join("\n") + "\n");
  return path;
}

test("OCR 只返回脱敏后的规则排除、警告、建议提交与结果数量", async (t) => {
  const workspace = await workspaceFor(t);
  const taskDone = { name: "task_done", arguments: '{"state":"DONE"}' };
  const codeComment = { name: "code_comment", arguments: '{"comments":[{"content":"private code"}]}' };
  await sessionFile(workspace, [
    event("session_start"),
    event("llm_response", { taskType: "main_task", filePath: "private path", content: "private prose", tool_calls: [taskDone] }),
    event("llm_response", { taskType: "main_task", content: "submitted elsewhere", tool_calls: [codeComment, taskDone] }),
    event("llm_response", { taskType: "main_task", content: "    ", tool_calls: [taskDone] }),
    event("llm_response", { taskType: "plan_task", content: "private plan", tool_calls: [taskDone] }),
    event("tool_call", { taskType: "main_task", tool_name: "code_comment", ok: true, result: "private result" }),
    event("tool_call", { taskType: "main_task", tool_name: "code_comment", ok: false, result: "private failure" }),
    event("session_end"),
  ]);

  assert.deepEqual(await readOcrDiagnostics(report, workspace), {
    status: "complete",
    returnedComments: 0,
    codeCommentCalls: 2,
    codeCommentFailures: 1,
    acceptedCodeCommentCalls: 1,
    unsubmittedTextCompletions: 1,
    session: "complete",
    warningCounts: { review_round_failed: 1, other: 1 },
    exclusionCounts: { default_path: 2, other: 1 },
  });
});

test("OCR 详细诊断只采集未提交建议的结束轮次可见正文", async (t) => {
  const workspace = await workspaceFor(t);
  const visibleText = "  审核正文\n  保留原始空格。  ";
  const taskDone = { name: "task_done", arguments: '{"state":"DONE"}' };
  await sessionFile(workspace, [
    event("session_start"),
    event("llm_request", { taskType: "main_task", content: "private prompt", tool_calls: [taskDone] }),
    event("llm_response", { taskType: "plan_task", content: "private plan", tool_calls: [taskDone] }),
    event("llm_response", { taskType: "main_task", content: "not the ending turn", tool_calls: [] }),
    event("llm_response", { taskType: "main_task", content: "already submitted", tool_calls: [taskDone, { name: "code_comment" }] }),
    event("llm_response", { taskType: "main_task", content: visibleText, tool_calls: [taskDone],
      reasoning_content: "private reasoning", native_payload: { text: "private native payload" }, filePath: "private path" }),
    event("tool_call", { taskType: "main_task", tool_name: "task_done", content: "private tool content", tool_calls: [taskDone] }),
    event("session_end"),
  ]);
  const captured: Array<[string, boolean]> = [];
  const result = await readOcrDiagnostics(report, workspace, (text, truncated) => captured.push([text, truncated]));
  assert.deepEqual(captured, [[visibleText, false]]);
  assert.equal(result.unsubmittedTextCompletions, 1);
  assert.equal(result.session, "complete");
});

test("OCR 详细诊断限制正文长度和条数，同时保留完整的匹配计数", async (t) => {
  const workspace = await workspaceFor(t);
  const longPrefix = "中".repeat(3999);
  await sessionFile(workspace, [
    event("session_start"),
    ...[`${longPrefix}🚀末尾`, "第二条", "第三条", "第四条"].map((content) =>
      event("llm_response", { taskType: "main_task", content, tool_calls: [{ name: "task_done" }] })),
    event("session_end"),
  ]);
  const captured: Array<[string, boolean]> = [];
  const result = await readOcrDiagnostics(report, workspace, (text, truncated) => {
    captured.push([text, truncated]);
    if (captured.length === 1) throw new Error("日志接收方故障");
  });
  assert.equal(captured.length, 3);
  assert.ok(captured[0][0] === longPrefix);
  assert.equal(captured[0][1], true);
  assert.deepEqual(captured.slice(1), [["第二条", false], ["第三条", false]]);
  assert.equal(result.unsubmittedTextCompletions, 4);
  assert.equal(result.session, "complete");
});

test("OCR 在截断前脱敏正文，单条脱敏失败时跳过该条", async (t) => {
  const workspace = await workspaceFor(t);
  const prefix = "中".repeat(3991);
  const credential = "demo-sensitive-credential";
  const replacement = "[已脱敏]";
  await sessionFile(workspace, [
    event("session_start"),
    ...[`${prefix}${credential}正文足够长，需要截断。`, "脱敏失败", "剩余正文"].map((content) =>
      event("llm_response", { taskType: "main_task", content, tool_calls: [{ name: "task_done" }] })),
    event("session_end"),
  ]);
  const captured: Array<[string, boolean]> = [];
  const result = await readOcrDiagnostics(report, workspace, (text, truncated) => captured.push([text, truncated]), (text) => {
    if (text === "脱敏失败") throw new Error("脱敏失败");
    return text.replaceAll(credential, replacement);
  });
  assert.equal(captured.length, 2);
  assert.equal(captured[0][0].slice(prefix.length), `${replacement}正文足够`);
  assert.equal(captured[0][0].length, 4000);
  assert.equal(captured[0][1], true);
  assert.deepEqual(captured[1], ["剩余正文", false]);
  assert.equal(result.unsubmittedTextCompletions, 3);
});

test("OCR 在会话损坏或结束记录重复时不采集任何正文", async (t) => {
  const workspace = await workspaceFor(t);
  const matchingTurn = event("llm_response", { taskType: "main_task", content: "private text", tool_calls: [{ name: "task_done" }] });
  for (const endRecords of [[], [event("session_end"), event("session_end")], [event("session_end", { sessionId: "different-session" })]]) {
    await sessionFile(workspace, [event("session_start"), matchingTurn, ...endRecords]);
    let delivered = 0;
    let redacted = 0;
    const result = await readOcrDiagnostics(report, workspace, () => { delivered++; }, (text) => { redacted++; return text; });
    assert.equal(delivered, 0);
    assert.equal(redacted, 0);
    assert.equal(result.session, "incomplete");
  }
});

test("OCR 找不到会话时只使用报告中的可验证计数", async (t) => {
  const workspace = await workspaceFor(t);
  const result = await readOcrDiagnostics({ status: "private model response", comments: [{}], tool_calls: { by_tool: {} } }, workspace);
  assert.equal(result.status, null);
  assert.equal(result.returnedComments, 1);
  assert.equal(result.codeCommentCalls, 0);
  assert.equal(result.codeCommentFailures, null);
  assert.equal(result.acceptedCodeCommentCalls, null);
  assert.equal(result.unsubmittedTextCompletions, null);
  assert.equal(result.session, "unavailable");
});

test("OCR 未结束或内容超限的会话不会被当作零次工具提交", async (t) => {
  const workspace = await workspaceFor(t);
  const path = await sessionFile(workspace, [event("session_start"), event("llm_response", { taskType: "main_task", content: "private" })]);
  for (const shouldTruncate of [false, true]) {
    if (shouldTruncate) await truncate(path, 9 * 1024 * 1024);
    const result = await readOcrDiagnostics(report, workspace);
    assert.equal(result.session, "incomplete");
    assert.equal(result.unsubmittedTextCompletions, null);
    assert.equal(result.acceptedCodeCommentCalls, null);
    assert.equal(result.codeCommentCalls, 2);
  }
});

test("OCR 诊断不能通过不安全的会话 ID 读取其他文件", async (t) => {
  const workspace = await workspaceFor(t);
  await sessionFile(workspace, [event("session_start"), event("session_end")]);
  const unsafeId = "../../private";
  await writeFile(join(workspace, ".opencodereview", "private.jsonl"), [
    event("session_start", { sessionId: unsafeId }), event("session_end", { sessionId: unsafeId }),
  ].map((record) => JSON.stringify(record)).join("\n") + "\n");
  assert.equal((await readOcrDiagnostics({ ...report, session_id: unsafeId }, workspace)).session, "unavailable");
});

test("OCR 诊断拒绝指向隔离目录外的链接", async (t) => {
  const workspace = await workspaceFor(t);
  const external = await workspaceFor(t);
  await sessionFile(external, [event("session_start"), event("session_end")]);
  try {
    await symlink(join(external, ".opencodereview"), join(workspace, ".opencodereview"), process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (!["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    t.skip("The test sandbox cannot create a directory link");
    return;
  }
  assert.equal((await readOcrDiagnostics(report, workspace)).session, "unavailable");
});
