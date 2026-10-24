import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGitEnvironment, createGitRunner, GitProcessError } from "../../../src/infrastructure/git/git-runner.ts";

/** 测试执行可信 Node 子进程，覆盖真实 pipe/abort 生命周期，不触发网络。 */
async function withRoot(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "crp-runner-test-"));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test("Git 环境只保留运行必需变量，凭据只在 URL 限定的环境头中", async () => {
  await withRoot(async (root) => {
    const inherited = {PATH:process.env.PATH, SystemRoot:process.env.SystemRoot, LLM_API_KEY:"llm-secret", GIT_TRACE:"1", GIT_CONFIG_PARAMETERS:"injection", GIT_SSH_COMMAND:"evil", HTTPS_PROXY:"https://user:secret@proxy", HOME:"untrusted-home"};
    const env = buildGitEnvironment({root,repositoryUrl:"https://git.example/g/r.git",token:"fixture-token",inherited});
    assert.equal(env.GIT_TERMINAL_PROMPT, "0");
    assert.equal(env.GIT_CONFIG_NOSYSTEM, "1");
    assert.equal(env.HOME, root);
    for (const name of ["LLM_API_KEY","GIT_TRACE","GIT_CONFIG_PARAMETERS","GIT_SSH_COMMAND","HTTPS_PROXY"]) assert.equal(env[name], undefined);
    const config = Array.from({length:Number(env.GIT_CONFIG_COUNT)},(_,i)=>[env[`GIT_CONFIG_KEY_${i}`],env[`GIT_CONFIG_VALUE_${i}`]]);
    assert(config.some(([key,value])=>key==="http.https://git.example/g/r.git.extraHeader" && value===`Authorization: Basic ${Buffer.from('oauth2:fixture-token').toString('base64')}`));
    assert(config.some(([key,value])=>key==="http.followRedirects" && value==="false"));
    assert(config.some(([key,value])=>key==="credential.helper" && value===""));
    assert(config.some(([key,value])=>key==="protocol.allow" && value==="never"));
    assert(!Object.values(env).some(value=>value?.includes("llm-secret")));
    const local = buildGitEnvironment({root,inherited});
    assert(!Object.values(local).some(value=>value?.includes("Authorization")), "本地读取不携带网络凭据");
  });
});

test("Git runner 原样传递参数而不经过 shell，并返回 Buffer", async () => {
  await withRoot(async (root) => {
    const run = createGitRunner({executable:process.execPath});
    const arg = "x; echo injected & $(echo secret)";
    const output = await run(["-e","process.stdout.write(process.argv[1])",arg], {cwd:root,env:buildGitEnvironment({root}),maxOutputBytes:4096});
    assert(Buffer.isBuffer(output));
    assert.equal(output.toString(), arg);
  });
});

test("Git runner 拒绝超量 stdout 和 stderr，错误不含原始敏感输出", async () => {
  await withRoot(async (root) => {
    const run = createGitRunner({executable:process.execPath});
    for (const stream of ["stdout","stderr"]) {
      await assert.rejects(run(["-e",`process.${stream}.write('fixture-secret'.repeat(10000))`], {cwd:root,env:buildGitEnvironment({root}),maxOutputBytes:32}), (error: Error) => {
        assert(error instanceof GitProcessError);
        assert.match(error.message, /上限/);
        assert.doesNotMatch(error.message, /fixture-secret/);
        return true;
      });
    }
  });
});

test("Git runner 取消会终止真实进程并等 close，预先取消不会启动", async () => {
  await withRoot(async (root) => {
    const run = createGitRunner({executable:process.execPath});
    const controller = new AbortController();
    const pending = run(["-e","setInterval(()=>{},1000)"], {cwd:root,env:buildGitEnvironment({root}),signal:controller.signal,maxOutputBytes:64});
    const timer = setTimeout(()=>controller.abort(new Error("sensitive-abort-reason")),100);
    try {
      await assert.rejects(pending, (error: Error) => {
        assert(error instanceof GitProcessError);
        assert.equal(error.code, "aborted");
        assert.doesNotMatch(error.message, /sensitive-abort-reason/);
        return true;
      });
      await assert.rejects(run(["-e","throw Error('must not run')"], {cwd:root,env:{},signal:controller.signal,maxOutputBytes:64}), /中断/);
    } finally { clearTimeout(timer); }
  });
});

test("Git runner 的退出失败和找不到程序不暴露参数或 stderr", async () => {
  await withRoot(async (root) => {
    const run = createGitRunner({executable:process.execPath});
    await assert.rejects(run(["-e","process.stderr.write('private-token');process.exit(7)"], {cwd:root,env:buildGitEnvironment({root}),maxOutputBytes:1024}), (error: Error) => {
      assert(error instanceof GitProcessError);
      assert.equal(error.code, "failed");
      assert.doesNotMatch(error.message, /private-token|process.stderr/);
      return true;
    });
    await assert.rejects(createGitRunner({executable:join(root,"missing-git")})([],{cwd:root,env:{},maxOutputBytes:1024}), /不可用/);
  });
});
