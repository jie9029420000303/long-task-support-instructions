const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {resolve}=require(path.join(process.env.CODEX_SUPERVISOR_SCRIPTS||path.resolve(__dirname,'../codex/.agents/skills/long-task-supervisor/scripts'),'model-route.cjs'));
const item=id=>({id,efforts:['low','medium','high','xhigh']}),opus='anthropic/claude-opus-5-5',sonnet='anthropic/claude-sonnet-5-5',sol='gpt-6.2-sol';
const base=()=>({supervisorModel:opus,roles:['executor','general','ui'],catalogs:{executor:[item(opus),item(sonnet),item(sol)],subagent:[item(sonnet)]}});
const fs=require('node:fs'),os=require('node:os');
function published(t,body){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'model-route-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'model-fallback.json');fs.writeFileSync(file,JSON.stringify(body));return file;
}
// Jay 2026-11-21: the executor side starts on subscription Sonnet; Opus stays with the supervisor.
test('a Claude supervisor starts the executor and its workers on subscription Sonnet at their baseline efforts',()=>{
 const r=resolve(base());assert.deepEqual(Object.fromEntries(Object.entries(r.roles).map(([k,v])=>[k,[v.model,v.effort]])),{executor:[sonnet,'high'],general:[sonnet,'medium'],ui:[sonnet,'low']});
});
test('a Sonnet supervisor selects its own model for the executor',()=>{
 const input=base();input.supervisorModel=sonnet;assert.equal(resolve(input).roles.executor.model,sonnet);
});
test('GPT supervision keeps the existing policy instead of being silently redirected to Claude',()=>{
 const r=resolve({...base(),supervisorModel:'gpt-6.1-sol'});assert.equal(r.family,'gpt');assert.equal(r.roles.general.status,'unavailable');
});
test('missing Sonnet never crosses provider or fabricates an available GPT or Haiku model',()=>{
 const input=base();input.catalogs.subagent=[item('anthropic-apikey/claude-sonnet-5-5'),item('gpt-5.6-terra'),item('anthropic/claude-haiku-5-5')];
 const r=resolve(input);assert.equal(r.roles.executor.status,'ready');assert.equal(r.roles.general.status,'unavailable');
});
test('unused roles do not block startup and explicit user choices supersede defaults',()=>{
 const input=base();input.roles=['executor'];input.catalogs.subagent=[];input.overrides={executor:{model:opus,effort:'medium'}};
 assert.deepEqual(resolve(input).roles.executor,{status:'ready',model:opus,effort:'medium',basis:'explicit-user-override'});
});
test('separate creation and subagent inventories cannot claim a model supported only by the other tool',()=>{
 const input=base();input.catalogs.executor=[item(opus)];input.catalogs.subagent=[item(sonnet)];
 assert.equal(resolve(input).roles.executor.status,'unavailable');
 input.catalogs.executor=[item(sonnet)];input.catalogs.subagent=[item(opus)];
 assert.equal(resolve(input).roles.general.status,'unavailable');
});
test('unsupported effort is not reported as applied or silently downgraded',()=>{
 const input=base();input.catalogs.subagent=[{id:sonnet,efforts:['high']}];assert.equal(resolve(input).roles.general.status,'unavailable');assert.equal(resolve(input).roles.ui.status,'unavailable');
});
test('the executor takes the newest subscription Sonnet and an API-key worker needs an explicit user choice',()=>{
 const input=base();input.catalogs.executor.push(item('anthropic/claude-sonnet-6-0'));assert.equal(resolve(input).roles.executor.model,'anthropic/claude-sonnet-6-0');
 const other='anthropic-apikey/claude-sonnet-5-5';input.catalogs.subagent.push(item(other));
 assert.equal(resolve(input).roles.general.model,sonnet);
 input.overrides={general:{model:other}};assert.equal(resolve(input).roles.general.model,other);
});

// The Claude API key is the supervisor's reserve: no executor-side role uses it, even under an API-key supervisor.
for(const provider of ['anthropic-apikey','anthropic']){
 test(`${provider} supervision puts every executor-side Claude role on the subscription path`,()=>{
  const input={supervisorModel:`${provider}/claude-opus-5-5`,roles:['executor','general','ui'],catalogs:{
   executor:[item('anthropic-apikey/claude-sonnet-5-5'),item(sonnet),item('anthropic-apikey/claude-opus-5-5')],
   subagent:[item('anthropic-apikey/claude-sonnet-5-5'),item(sonnet)]}};
  const r=resolve(input);assert.equal(r.provider,provider+'/');
  assert.deepEqual(Object.fromEntries(Object.entries(r.roles).map(([k,v])=>[k,[v.status,v.model,v.effort]])),{
   executor:['ready',sonnet,'high'],general:['ready',sonnet,'medium'],ui:['ready',sonnet,'low']});
 });
 test(`${provider} supervision never moves executor-side roles to the API key when the subscription models are missing`,()=>{
  const r=resolve({supervisorModel:`${provider}/claude-opus-5-5`,roles:['executor','general','ui'],catalogs:{
   executor:[item('anthropic-apikey/claude-sonnet-5-5')],subagent:[item('anthropic-apikey/claude-sonnet-5-5')]}});
  for(const role of ['executor','general','ui'])assert.equal(r.roles[role].status,'unavailable');
 });
}
// Q48 A: below the 35% reserve the executor starts on Sol and no new Claude worker is started (Q49 A).
test('the Claude reserve starts the executor on Sol and holds new Claude workers until the mainline moves',t=>{
 const fallback=published(t,{limits:{},claudeQuota:{executorMayUseClaude:false,weeklyRemaining:19.4,reserve:35}});
 const r=resolve({...base(),fallback});
 assert.deepEqual([r.roles.executor.model,r.roles.executor.basis],[sol,'claude-reserve']);
 assert.equal(r.roles.general.status,'unavailable');assert.match(r.roles.general.reason,/保留給監督/);
 const gpt=resolve({...base(),fallback,executorModel:sol,catalogs:{executor:[item(sol)],subagent:[item('gpt-6.1-terra')]}});
 assert.equal(gpt.roles.general.model,'gpt-6.1-terra');
 assert.equal(resolve({...base(),fallback:published(t,{limits:{},claudeQuota:{executorMayUseClaude:true}})}).roles.executor.model,sonnet);
});
test('an executor-side Sonnet limit starts the executor on Sol',t=>{
 const until=new Date(Date.now()+3600000).toISOString();
 const r=resolve({...base(),fallback:published(t,{limits:{'anthropic/':{until}}})});
 assert.deepEqual([r.roles.executor.model,r.roles.executor.basis,r.roles.executor.restoreAfter],[sol,'rate-limit-fallback',until]);
});

for(const [first,second,highest] of [
 ['gpt-6.1-terra','gpt-6.2-sol','gpt-6.2-astra'],
 ['anthropic/claude-sonnet-5-5','anthropic/claude-opus-5-5','anthropic/claude-fable-5-2']
]){
 test('third failure raises model and reasoning, fourth assigns mainline: '+first,()=>{
  const subagent=[first,second,highest].map(id=>({id,efforts:['low','medium','high','xhigh','max']}));
  const input={supervisorModel:second,roles:['general'],catalogs:{subagent},errors:3,previousEffort:'xhigh'};
  for(const [previousModel,target] of [[first,second],[second,highest],[highest,highest]]){
    const row=resolve({...input,previousModel}).roles.general;
    assert.equal(row.status,'ready');assert.equal(row.model,target);assert.equal(row.effort,'max');
  }
  const capped=resolve({...input,previousModel:highest,previousEffort:'max'}).roles.general;
  assert.equal(capped.effort,'max');assert.equal(capped.modelAtCeiling,true);assert.equal(capped.effortAtCeiling,true);
  const promoted=resolve({...input,previousModel:first}).roles.general;
  assert.equal(promoted.modelAtCeiling,false);assert.equal(promoted.effortAtCeiling,false);
  assert.equal(resolve({...input,previousModel:first,overrides:{general:{effort:'xhigh'}}}).roles.general.status,'unavailable');
  assert.equal(resolve({...input,errors:4}).roles.general.status,'takeover');
 });
}
test('worker catalog uses visible numerically latest release of actual executor family',()=>{
 const catalog=[item('gpt-6.9-terra'),item('gpt-6.10-terra'),{...item('gpt-7.0-terra'),visibility:'hide'},item(sonnet)];
 const input={supervisorModel:opus,executorModel:'gpt-6.2-sol',roles:['general'],catalogs:{subagent:catalog}};
 assert.equal(resolve(input).roles.general.model,'gpt-6.10-terra');
 assert.equal(resolve({...input,overrides:{general:{model:sonnet}}}).roles.general.status,'unavailable');
});
