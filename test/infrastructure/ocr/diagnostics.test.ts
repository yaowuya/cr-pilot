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
