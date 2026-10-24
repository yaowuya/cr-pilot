import { test } from "node:test";
import assert from "node:assert/strict";
import type { RepositoryReadAccess } from "../../../src/domain/repository-context.ts";
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
