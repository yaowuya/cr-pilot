import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPromptPayload, canEnableRepositoryContext, createPromptDraft, createRequestGeneration, synchronizeProjectSettings, validatePromptDraft } from "../../web/src/views/prompt-form.ts";
import type { StoredPrompt } from "../../web/src/types.ts";

const detail:StoredPrompt={id:1,repository:'rules',projects:['g/a','g/b'],systemPrompt:'s',userPrompt:'u',updatedAt:1};

test('已有短项目名的仓库拉取开关可用，兼容页面存量关联',()=>{
  for (const project of ['auto-ops','auto-ops-platform','auto-screenshot','cw-auto-ops','ops-node-server']) {
    assert.equal(canEnableRepositoryContext(project),true,`${project} 的开关不能因旧短名而禁用`);
    const draft=createPromptDraft({...detail,projects:[project]});
    draft.projectStates[project]=true;
    assert.deepEqual(validatePromptDraft(draft),[]);
    assert.deepEqual(buildPromptPayload(draft).project_settings,[{project,repository_context_enabled:true}]);
  }
});

test('旧响应缺新增字段时映射为空规范/全关，未操作的开关不写入 payload',()=>{
  const draft=createPromptDraft(detail);
  assert.equal(draft.repositoryStandards,'');
  assert.equal(draft.projectStates['g/a'],false);
  assert.deepEqual(buildPromptPayload(draft).project_settings,[]);
  draft.projectStates['g/a']=true;
  assert.deepEqual(buildPromptPayload(draft).project_settings,[{project:'g/a',repository_context_enabled:true}]);
  draft.projectStates['g/a']=false;
  assert.deepEqual(buildPromptPayload(draft).project_settings,[]);
});

test('项目状态按全名归一化且独立，共享规范不覆盖 system/user',()=>{
  const draft=createPromptDraft({...detail,repositoryStandards:'规范',projectSettings:[{project:'G/A',repositoryContextEnabled:true},{project:'g/b',repositoryContextEnabled:false}]});
  assert.equal(draft.projectStates['g/a'],true);
  draft.repositoryStandards='新规范';
  draft.projectStates['g/b']=true;
  const payload=buildPromptPayload(draft);
  assert.equal(payload.system_prompt,'s');assert.equal(payload.user_prompt,'u');assert.equal(payload.repository_standards,'新规范');
  assert.deepEqual(payload.project_settings,[{project:'g/b',repository_context_enabled:true}]);
});

test('新增关联读取 meta 共享状态，缺 meta 时待加载，不擅自写 false',()=>{
  const draft=createPromptDraft(detail);
  draft.projects.push('g/existing','g/new');
  synchronizeProjectSettings(draft);
  assert.equal(draft.projectStates['g/existing'],undefined);
  assert.deepEqual(buildPromptPayload(draft).project_settings,[]);
  synchronizeProjectSettings(draft,[{project:'G/Existing',repositoryContextEnabled:true}]);
  assert.equal(draft.projectStates['g/existing'],true);
  assert.equal(draft.projectStates['g/new'],false);
  assert.deepEqual(buildPromptPayload(draft).project_settings,[]);
  draft.projectStates['g/new']=true;
  draft.projects=draft.projects.filter(p=>p!=='g/new');
  synchronizeProjectSettings(draft,[]);
  assert(!('g/new' in draft.projectStates));
  assert.deepEqual(buildPromptPayload(draft).project_settings,[]);
});

test('meta 刷新不覆盖用户已修改开关，新增项目去重去空白',()=>{
  const draft=createPromptDraft(detail);
  draft.projectStates['g/a']=true;
  draft.projects.push(' G/A ','','g/c');
  synchronizeProjectSettings(draft,[]);
  assert.deepEqual(draft.projects,['g/a','g/b','g/c']);
  assert.equal(draft.projectStates['g/a'],true);
  assert.equal(draft.projectStates['g/c'],false);
  assert.deepEqual(buildPromptPayload(draft).project_settings,[{project:'g/a',repository_context_enabled:true}]);
});

test('必填/规范长度/非法短名开关校验返回分组，不把可空规范当必填',()=>{
  const draft=createPromptDraft(detail);
  assert.deepEqual(validatePromptDraft(draft),[]);
  draft.repositoryStandards='x'.repeat(32001);
  assert(validatePromptDraft(draft).some(e=>e.field==='repositoryStandards'&&e.group==='standards'));
  draft.repositoryStandards='';draft.systemPrompt=' ';
  assert(validatePromptDraft(draft).some(e=>e.field==='systemPrompt'&&e.group==='prompt'));
  draft.systemPrompt='s';draft.projects=['g/../escape'];synchronizeProjectSettings(draft,[]);
  draft.projectStates['g/../escape']=true;
  assert(validatePromptDraft(draft).some(e=>e.group==='projects'));
});

test('短项目名合法可开启，只有含非法字符的项目名被校验拒绝',()=>{
  const valid=createPromptDraft({...detail,projects:['auto-ops']});
  valid.projectStates['auto-ops']=true;
  assert.deepEqual(validatePromptDraft(valid),[]);
  for (const bad of ['g/../escape','g//bad','g\\bad','-leading','https://git.example/g/a']) {
    assert.equal(canEnableRepositoryContext(bad),false,`${bad} 不应可开启`);
    const draft=createPromptDraft({...detail,projects:[bad]});
    draft.projectStates[bad.trim().toLowerCase()]=true;
    assert(validatePromptDraft(draft).some(e=>e.group==='projects'),`${bad} 应被拒绝`);
  }
});

test('非 default 名称允许修改，空名与超长名称被拒绝',()=>{
  const draft=createPromptDraft(detail);
  draft.repository='改名后的规则';
  assert.deepEqual(validatePromptDraft(draft),[]);
  draft.repository='  ';
  assert(validatePromptDraft(draft).some(e=>e.field==='repository'));
  draft.repository='x'.repeat(201);
  assert(validatePromptDraft(draft).some(e=>e.field==='repository'));
  draft.repository='x'.repeat(200);
  assert.deepEqual(validatePromptDraft(draft),[]);
});

test('前端校验文案与后端一致，不再出现“完整项目路径”旧提示',()=>{
  const draft=createPromptDraft({...detail,projects:['g/../escape']});
  draft.projectStates['g/../escape']=true;
  const messages=validatePromptDraft(draft).map(e=>e.message).join('\n');
  assert.doesNotMatch(messages,/完整项目路径|namespace\/project/);
  assert.match(messages,/不允许的字符/);
});

test('请求归属守卫让最后一次编辑意图生效，关闭后未决响应失效',()=>{
  const guard=createRequestGeneration();
  const old=guard.start();const latest=guard.start();
  assert.equal(guard.isCurrent(old),false);assert.equal(guard.isCurrent(latest),true);
  guard.invalidate();assert.equal(guard.isCurrent(latest),false);
});
