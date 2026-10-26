import { test } from "node:test";
import assert from "node:assert/strict";
import { createReviewPipeline } from "../../src/application/review-pipeline.ts";
import { createSilentLogger } from "../../src/shared/logger.ts";
import { openDatabase } from "../../src/infrastructure/sqlite/database.ts";
import { createPromptRepository } from "../../src/infrastructure/sqlite/prompt-repo.ts";
import type { GitlabClient, MergeRequestTask, ReviewInput } from "../../src/domain/review-task.ts";
import type { ReviewRecord } from "../../src/domain/review-record.ts";
import type { RepositoryPrepareInput, RepositoryProvider, RepositoryReadAccess } from "../../src/domain/repository-context.ts";

const task:MergeRequestTask={projectId:7,iid:2,fullName:'g/a',sourceBranch:'feature',targetBranch:'main',gitlabUrl:'https://git.example',gitlabToken:'fixture-token'};
const refs={baseSha:'b'.repeat(40),startSha:'c'.repeat(40),headSha:'a'.repeat(40)};

/** 单元管线使用真实配置仓储；外部 GitLab、模型和通知全部隔离。 */
function harness(options:{enabled?:boolean;fail?:'snapshot'|'prepare'|'batch'|'summary'|'note'|'record';noProvider?:boolean;cleanupFailure?:boolean;changeConfig?:boolean;retryBatch?:boolean;legacyProjects?:boolean}={}){
  const db=openDatabase(':memory:');const prompts=createPromptRepository(db);
  const settingProject=options.legacyProjects?'a':'g/a';
  const prompt=prompts.create({repository:'rules',projects:options.legacyProjects?['a','b']:['g/a','g/b'],systemPrompt:'SYS',userPrompt:'{diffs_text}',repositoryStandards:'本仓库使用分层架构',projectSettings:[{project:settingProject,repositoryContextEnabled:options.enabled!==false}]});
  const calls:ReviewInput[]=[];const prepared:RepositoryPrepareInput[]=[];const records:ReviewRecord[]=[];const notes:string[]=[];
  let disposed=0;let snapshots=0;let oldChanges=0;let versions=0;let batchAttempts=0;
  const access:RepositoryReadAccess={headSha:refs.headSha,list:async()=>({text:'a.ts',truncated:false}),read:async()=>({text:'1: fixture',truncated:false}),search:async()=>({text:'',truncated:false})};
  const change={oldPath:'a.ts',newPath:'a.ts',diff:'@@ -1 +1 @@\n-old\n+new'};
  const client:GitlabClient={
    getRepositoryReviewSnapshot:async()=>{
      snapshots++;
      if(options.changeConfig)prompts.update(prompt.id,{systemPrompt:'CHANGED',userPrompt:'u',repositoryStandards:'CHANGED',projectSettings:[{project:'g/a',repositoryContextEnabled:false}]});
      if(options.fail==='snapshot')throw new Error('snapshot failed');
      return{changes:[change],commits:[{id:refs.headSha,message:'fixture'}],refs,sourceProjectId:9,sourceBranch:'api-branch',repositoryUrl:'https://git.example/fork/a.git',gitlabUrl:'https://git.example'};
    },
    getMergeRequestChanges:async()=>{oldChanges++;return[change];},getMergeRequestCommits:async()=>[{id:'old',message:'old'}],
    getMergeRequestVersions:async()=>{versions++;return refs;},
    postMergeRequestNote:async(_p,_i,body)=>{if(options.fail==='note')throw new Error('note failed');notes.push(body);},
    getLatestHeadSha:async()=>refs.headSha,getFileRaw:async()=>'',postDiscussion:async()=>({id:'d',notes:[]}),getDiscussions:async()=>[],getUser:async()=>({id:1,name:'fixture',username:'fixture'}),
  };
  const repositoryProvider:RepositoryProvider={prepare:async input=>{
    prepared.push(input);if(options.fail==='prepare')throw new Error('prepare failed');
    return{access,dispose:async()=>{disposed++;if(options.cleanupFailure)throw new Error('cleanup failed');}};
  }};
  const pipeline=createReviewPipeline({client,promptSource:prompts,isProjectAllowed:project=>prompts.isProjectConfigured(project),rules:{resolve:()=>({systemPrompt:'fallback',userPrompt:'{diffs_text}'})},
    reviewer:{review:async input=>{
      calls.push(input);const summary=input.systemPrompt.includes('你之前分批评审了同一变更的各部分');
      if(!summary){batchAttempts++;if(options.fail==='batch'||(options.retryBatch&&batchAttempts===1))throw new Error('transient batch');}
      if(summary&&options.fail==='summary')throw new Error('summary failed');
      return{text:'评分：90\n评审结果',model:'fixture'};
    }},repositoryProvider:options.noProvider?undefined:repositoryProvider,logger:createSilentLogger(),batchMaxTokens:6000,retryDelayMs:1,
    recordWriter:{insert:record=>{if(options.fail==='record')throw new Error('record failed');records.push(record);}},
  });
  return{pipeline,db,calls,prepared,records,notes,access,counts:()=>({disposed,snapshots,oldChanges,versions,batchAttempts})};
}

test('开启项目准备一次固定仓库，批次可读上下文，汇总只使用规范且不带工具',async()=>{
  const h=harness();try{
    await h.pipeline.run(task);
    assert.equal(h.prepared.length,1);assert.equal(h.prepared[0].sourceBranch,'api-branch');assert.equal(h.prepared[0].headSha,refs.headSha);assert.equal(h.prepared[0].token,'fixture-token');
    assert.equal(h.calls[0].repositoryContext,h.access);assert.match(h.calls[0].systemPrompt,/仓库规范[\s\S]*分层架构/);assert.match(h.calls[0].code,new RegExp(refs.headSha));
    assert.equal(h.calls.at(-1)?.repositoryContext,undefined);assert.match(h.calls.at(-1)!.systemPrompt,/分层架构/);
    assert.equal(h.counts().disposed,1);assert.equal(h.counts().versions,0);assert.equal(h.counts().oldChanges,0);
    assert.equal(h.notes.length,1);assert.equal(h.records[0].result,'success');
  }finally{h.db.close();}
});

test('短名配置在真实 MR 全名下启用，克隆地址仍取权威快照而非拼接别名',async()=>{
  const h=harness({legacyProjects:true});try{
    await h.pipeline.run(task);
    assert.equal(h.prepared.length,1);
    assert.equal(h.prepared[0].repositoryUrl,'https://git.example/fork/a.git');
    assert.equal(h.prepared[0].sourceBranch,'api-branch');
    assert.equal(h.calls[0].repositoryContext,h.access);
    assert.equal(h.counts().disposed,1);
    await h.pipeline.run({...task,fullName:'g/b'});
    assert.equal(h.prepared.length,1,'另一个关闭的短名项目不得拉取');
  }finally{h.db.close();}
});

test('关闭项目保留旧 diff 流程，不准备仓库、不追加规范或读取工具',async()=>{
  const h=harness({enabled:false});try{
    await h.pipeline.run(task);assert.equal(h.prepared.length,0);assert.equal(h.counts().snapshots,0);assert.equal(h.counts().oldChanges,1);assert.equal(h.counts().versions,1);
    assert(h.calls.every(c=>c.repositoryContext===undefined&&!c.systemPrompt.includes('分层架构')));assert.equal(h.notes.length,1);
  }finally{h.db.close();}
});

test('同 Prompt 另一关闭项目不受已开启项目影响',async()=>{
  const h=harness();try{await h.pipeline.run({...task,fullName:'g/b'});assert.equal(h.prepared.length,0);assert.equal(h.counts().snapshots,0);assert.equal(h.notes.length,1);}finally{h.db.close();}
});

test('配置在任务开始快照，网络阶段修改配置不影响本次，批次重试不重复拉仓库',async()=>{
  const h=harness({changeConfig:true,retryBatch:true});try{
    await h.pipeline.run(task);assert.equal(h.prepared.length,1);assert.equal(h.counts().batchAttempts,2);assert.match(h.calls[0].systemPrompt,/SYS[\s\S]*分层架构/);assert.doesNotMatch(h.calls[0].systemPrompt,/CHANGED/);assert.equal(h.counts().disposed,1);
  }finally{h.db.close();}
});

for(const fail of ['snapshot','prepare','batch','summary','note','record'] as const){
  test(`上下文流程 ${fail} 失败不静默降级且清理已准备的仓库`,async()=>{
    const h=harness({fail});try{
      if(fail==='record')await assert.rejects(h.pipeline.run(task),/record failed/);else await h.pipeline.run(task);
      assert.equal(h.counts().oldChanges,0);
      assert.equal(h.counts().disposed,['snapshot','prepare'].includes(fail)?0:1);
      if(fail!=='record'){assert.equal(h.notes.length,0);assert.equal(h.records[0].result,'failed');}
      if(fail==='snapshot'||fail==='prepare')assert.equal(h.calls.length,0);
    }finally{h.db.close();}
  });
}

test('开启但准备端口缺失明确失败，清理异常不撤销已完成回写',async()=>{
  const missing=harness({noProvider:true});try{await missing.pipeline.run(task);assert.equal(missing.records[0].result,'failed');assert.equal(missing.calls.length,0);}finally{missing.db.close();}
  const cleanup=harness({cleanupFailure:true});try{await cleanup.pipeline.run(task);assert.equal(cleanup.notes.length,1);assert.equal(cleanup.records[0].result,'success');assert.equal(cleanup.counts().disposed,1);}finally{cleanup.db.close();}
});
