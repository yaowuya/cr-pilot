import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { buildGitEnvironment, createGitRunner, type GitRunner } from "../../../src/infrastructure/git/git-runner.ts";
import { createRepositoryProvider } from "../../../src/infrastructure/git/repository-context.ts";

const url = "https://git.example/g/repo.git";

/** 用真实 Git 建造无敏感数据的 fixture；仅测试 transport 可映射为本地 file。 */
async function fixture(run: (data: {root:string;source:string;head:string;git:(args:string[],input?:string)=>string;runner:GitRunner;calls:string[][]}) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "crp-repository-test-"));
  const source = join(root,"source");
  await mkdir(source);
  await mkdir(join(root,"empty-template"));
  await mkdir(join(root,"empty-hooks"));
  const env = buildGitEnvironment({root});
  const git = (args:string[], input?:string):string => execFileSync("git",["-c","user.name=Fixture","-c","user.email=fixture@example.invalid","-c","commit.gpgsign=false",...args],{cwd:source,env,input,encoding:"utf8",stdio:["pipe","pipe","pipe"]}).trim();
  try {
    git(["init","-b","feature"]);
    await mkdir(join(source,"src"));
    await mkdir(join(source,".pi"));
    await writeFile(join(source,"src","a.ts"),"const value = 1;\nexport { value };\n");
    await writeFile(join(source,"README.md"),"fixture repository\n");
    await writeFile(join(source,".env"),"SECRET=fixture-only\n");
    await writeFile(join(source,".pi","APPEND_SYSTEM.md"),"not an instruction\n");
    await writeFile(join(source,"src","private.pem"),"fixture-only\n");
    await writeFile(join(source,"binary.bin"),Buffer.from([0,1,2,255]));
    await writeFile(join(source,"large.txt"),"z".repeat(300_000));
    await writeFile(join(source,"lfs.txt"),"version https://git-lfs.github.com/spec/v1\noid sha256:fixture\nsize 100\n");
    git(["add","."]);
    git(["commit","-m","fixture"]);
    const first = git(["rev-parse","HEAD"]);
    const link = git(["hash-object","-w","--stdin"],"../outside-secret");
    git(["update-index","--add","--cacheinfo",`120000,${link},escape`]);
    git(["update-index","--add","--cacheinfo",`160000,${first},submodule`]);
    git(["commit","-m","fixture links"]);
    const head = git(["rev-parse","HEAD"]);
    const calls:string[][]=[];
    const real = createGitRunner();
    const runner:GitRunner = (args,options) => {
      calls.push([...args]);
      const mapped = args.map(arg=>arg===url?pathToFileURL(source).href:arg);
      return real(["-c","protocol.file.allow=always",...mapped],options);
    };
    await run({root,source,head,git,runner,calls});
  } finally { await rm(root,{recursive:true,force:true}); }
}

function input(head:string) {
  return {repositoryUrl:url,gitlabUrl:"https://git.example",sourceBranch:"feature",headSha:head,token:"fixture-token",signal:AbortSignal.timeout(20_000)};
}

async function roots(root:string):Promise<string[]> {
  return (await readdir(root)).filter(name=>name.startsWith("cr-pilot-repo-"));
}

test("浅克隆不检出工作树，实际从固定 blob 读取且所有出口释放目录", async () => {
  await fixture(async ({root,head,runner,calls}) => {
    const provider = createRepositoryProvider({runner,tempRoot:root});
    const handle = await provider.prepare(input(head));
    const taskRoot = join(root,(await roots(root))[0]);
    try {
      const clone = calls.find(args=>args[0]==="clone")!;
      for(const flag of ["--progress","--single-branch","--depth=1","--no-checkout"]) assert(clone.includes(flag));
      assert(clone.includes("--branch=feature"));
      assert(!existsSync(join(taskRoot,"repository","src")),"不得检出目标工作树");
      assert.match((await handle.access.read({path:"src/a.ts"})).text,/1: const value = 1;/);
      assert.equal(handle.access.headSha,head);
      const config = await readFile(join(taskRoot,"repository",".git","config"),"utf8");
      assert.doesNotMatch(config,/fixture-token|Authorization|b2F1dGgy/);
      const list = await handle.access.list({});
      assert.match(list.text,/src\/a.ts/);
      assert.doesNotMatch(list.text,/\.env|private\.pem|APPEND_SYSTEM|escape|submodule/);
      assert.match((await handle.access.search({query:"export"})).text,/src\/a.ts:2/);
    } finally { await handle.dispose(); await handle.dispose(); }
    assert.deepEqual(await roots(root),[]);
    await assert.rejects(handle.access.list({}),/释放|关闭/);
  });
});

test("真实本地 Git HTTP 拉取收到限定授权头并保持浅克隆，不持久化凭据", async () => {
  await fixture(async ({root,head}) => {
    const requests: {path:string;authorization:string|undefined}[] = [];
    const backendErrors: string[] = [];
    const env = buildGitEnvironment({root});
    const authorization = `Basic ${Buffer.from('oauth2:fixture-token').toString('base64')}`;
    // 仅监听本机，用实际 git-http-backend 提供 smart HTTP；不替换客户端 runner 或 transport。
    const server = createServer(async (request,response) => {
      const requestUrl = new URL(request.url!, 'http://fixture.invalid');
      requests.push({path:requestUrl.pathname,authorization:request.headers.authorization});
      if (request.headers.authorization !== authorization) {
        response.writeHead(401, {'WWW-Authenticate':'Basic realm="fixture"'}); response.end(); return;
      }
      try {
        const chunks:Buffer[]=[];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const output = execFileSync('git', ['http-backend'], {
          cwd:root, maxBuffer:4*1024*1024, input:Buffer.concat(chunks), stdio:['pipe','pipe','pipe'],
          env:{...env,GIT_PROJECT_ROOT:root,GIT_HTTP_EXPORT_ALL:'1',PATH_INFO:requestUrl.pathname.replace(/^\/repo\.git(?=\/|$)/,'/source'),
            REQUEST_METHOD:request.method!,QUERY_STRING:requestUrl.search.slice(1),CONTENT_TYPE:request.headers['content-type'] ?? '',
            CONTENT_LENGTH:String(Buffer.concat(chunks).length),REMOTE_USER:'fixture',REMOTE_ADDR:'127.0.0.1',
            HTTP_GIT_PROTOCOL:String(request.headers['git-protocol'] ?? '')},
        });
        const separator=output.indexOf('\r\n\r\n');
        if(separator<0)throw new Error('Missing CGI header separator');
        let status=200;
        for(const header of output.subarray(0,separator).toString('utf8').split('\r\n')) {
          const colon=header.indexOf(':');
          if(colon<0)continue;
          const name=header.slice(0,colon),value=header.slice(colon+1).trim();
          if(name.toLowerCase()==='status')status=Number.parseInt(value,10);else response.setHeader(name,value);
        }
        response.writeHead(status);response.end(output.subarray(separator+4));
      } catch(error) {backendErrors.push(error instanceof Error ? error.message : 'backend error');response.writeHead(500);response.end();}
    });
    server.listen(0,'127.0.0.1');
    await new Promise<void>((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});
    const address=server.address();
    assert(address && typeof address!=='string');
    const origin=`http://127.0.0.1:${address.port}`;
    try {
      const handle=await createRepositoryProvider({tempRoot:root}).prepare({...input(head),repositoryUrl:`${origin}/repo.git`,gitlabUrl:origin});
      try {
        assert.match((await handle.access.read({path:'src/a.ts'})).text,/const value = 1/);
        const taskRoot=join(root,(await roots(root))[0]);
        const config=await readFile(join(taskRoot,'repository','.git','config'),'utf8');
        assert.doesNotMatch(config,/fixture-token|Authorization|b2F1dGgy/);
        assert(existsSync(join(taskRoot,'repository','.git','shallow')),'真实 HTTP 拉取应保持 depth=1');
        assert(requests.some(item=>item.path.endsWith('/info/refs')));
        assert(requests.some(item=>item.path.endsWith('/git-upload-pack')));
        assert(requests.every(item=>item.authorization===authorization),'所有 Git HTTP 请求必须携带限定授权头');
        assert.deepEqual(backendErrors,[]);
      } finally {await handle.dispose();}
      assert.deepEqual(await roots(root),[]);
    } finally {server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
  });
});

test("分支已推进时只补取指定 SHA，读取旧版本而非新的 branch HEAD", async () => {
  await fixture(async ({root,source,head,git,runner,calls}) => {
    await writeFile(join(source,"src","a.ts"),"const value = 2;\n");
    git(["add","src/a.ts"]);git(["commit","-m","advance"]);
    const handle = await createRepositoryProvider({runner,tempRoot:root}).prepare(input(head));
    try {
      assert.match((await handle.access.read({path:"src/a.ts"})).text,/value = 1/);
      assert.equal(calls.filter(args=>args[0]==="fetch").length,1);
      assert(calls.find(args=>args[0]==="fetch")!.includes(head));
    } finally { await handle.dispose(); }
  });
});

test("读取拒绝越界/敏感/链接/二进制/大文件/LFS，搜索不泄漏拒绝内容", async () => {
  await fixture(async ({root,head,runner}) => {
    const handle = await createRepositoryProvider({runner,tempRoot:root}).prepare(input(head));
    try {
      for(const path of ["../source/.env","/etc/passwd","C:/secret","src\\a.ts","src/a.ts:stream",".git/config",".env","src/private.pem",".pi/APPEND_SYSTEM.md","escape","submodule","binary.bin","large.txt","lfs.txt"]) {
        await assert.rejects(handle.access.read({path}),/路径|许可|文本|上限|LFS|文件/);
      }
      assert.doesNotMatch((await handle.access.search({query:"fixture-only"})).text,/SECRET|fixture-only|\.env|private/);
      await assert.rejects(handle.access.search({query:""}),/搜索|query/);
      await assert.rejects(handle.access.search({query:"x".repeat(201)}),/搜索|query/);
      await assert.rejects(handle.access.read({path:"src/a.ts",startLine:0}),/行/);
      await assert.rejects(handle.access.list({prefix:"../"}),/路径/);
    } finally { await handle.dispose(); }
  });
});

test("查询截断和游标可见，工具取消不会继续读文件", async () => {
  await fixture(async ({root,head,runner}) => {
    const handle = await createRepositoryProvider({runner,tempRoot:root,limits:{listEntries:1,searchFiles:1,outputChars:80}}).prepare(input(head));
    try {
      const first=await handle.access.list({});assert.equal(first.truncated,true);assert.equal(typeof first.nextCursor,"number");
      const second=await handle.access.list({cursor:first.nextCursor});assert.notEqual(first.text,second.text);
      const search=await handle.access.search({query:"value"});assert.equal(search.truncated,true);assert.equal(typeof search.nextCursor,"number");
      const controller=new AbortController();controller.abort();
      await assert.rejects(handle.access.read({path:"src/a.ts"},controller.signal),/中断/);
    } finally { await handle.dispose(); }
  });
});

test("准备总超时等待 runner 真正结束后清理，dispose 取消并等活动读取", async () => {
  await fixture(async ({root,head,runner}) => {
    let stopped = false;
    const blocked: GitRunner = async (_args, options) => {
      await new Promise<void>((resolve) => {
        const finish = () => setTimeout(() => { stopped = true; resolve(); }, 20);
        if (options.signal?.aborted) finish();
        else options.signal?.addEventListener("abort", finish, {once:true});
      });
      throw new Error("fixture cancelled");
    };
    await assert.rejects(createRepositoryProvider({runner:blocked,tempRoot:root,timeoutMs:30}).prepare(input(head)));
    assert.equal(stopped,true);
    assert.deepEqual(await roots(root),[]);
    let blockReads = false;
    let readStopped = false;
    const gated: GitRunner = async (args, options) => {
      if (blockReads && args[0] === "cat-file") {
        await new Promise<void>(resolve => {
          options.signal!.addEventListener("abort", () => setTimeout(() => {readStopped = true;resolve();},20), {once:true});
        });
        throw new Error("fixture read cancelled");
      }
      return runner(args, options);
    };
    const handle = await createRepositoryProvider({runner:gated,tempRoot:root}).prepare(input(head));
    blockReads = true;
    const read = handle.access.read({path:"src/a.ts"});
    const rejected = assert.rejects(read);
    await handle.dispose();
    await rejected;
    assert.equal(readStopped,true);
    assert.deepEqual(await roots(root),[]);
  });
});

test("准备失败/超量/SHA 不可达都不留下仓库目录", async () => {
  await fixture(async ({root,head,runner}) => {
    await assert.rejects(createRepositoryProvider({runner,tempRoot:root,limits:{maxFiles:1}}).prepare(input(head)),/文件|上限/);
    assert.deepEqual(await roots(root),[]);
    await assert.rejects(createRepositoryProvider({runner,tempRoot:root,limits:{maxRepositoryBytes:1}}).prepare(input(head)),/体积|上限/);
    assert.deepEqual(await roots(root),[]);
    await assert.rejects(createRepositoryProvider({runner,tempRoot:root}).prepare(input("f".repeat(40))),/Git|版本|提交/);
    assert.deepEqual(await roots(root),[]);
    for(const changed of [{repositoryUrl:"https://evil.example/g/r.git"},{sourceBranch:"--upload-pack=evil"},{sourceBranch:"feature\nother"},{headSha:"HEAD:secret"}]) {
      await assert.rejects(createRepositoryProvider({runner,tempRoot:root}).prepare({...input(head),...changed}),/仓库|分支|版本|提交|同源/);
      assert.deepEqual(await roots(root),[]);
    }
  });
});
