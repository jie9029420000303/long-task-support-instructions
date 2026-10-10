const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {resolve}=require(path.join(process.env.CODEX_SUPERVISOR_SCRIPTS||path.resolve(__dirname,'../codex/.agents/skills/long-task-supervisor/scripts'),'model-route.cjs'));
const item=id=>({id,efforts:['low','medium','high','xhigh']}),opus='anthropic/claude-opus-5-5',sonnet='anthropic/claude-sonnet-5-5';
const base=()=>({supervisorModel:opus,roles:['executor','general','ui'],catalogs:{executor:[item(opus)],subagent:[item(sonnet)]}});
test('Claude supervisor explicitly routes an Opus executor and Sonnet workers at their baseline efforts',()=>{
 const r=resolve(base());assert.deepEqual(Object.fromEntries(Object.entries(r.roles).map(([k,v])=>[k,[v.model,v.effort]])),{executor:[opus,'high'],general:[sonnet,'medium'],ui:[sonnet,'low']});
});
test('a Sonnet supervisor still uses the Claude-side Opus executor policy',()=>{
 const input=base();input.supervisorModel=sonnet;assert.equal(resolve(input).roles.executor.model,opus);
});
test('GPT supervision keeps the existing policy instead of being silently redirected to Claude',()=>{
 assert.equal(resolve({...base(),supervisorModel:'gpt-6.1-sol'}).family,'unchanged');
});
test('missing Sonnet never crosses provider or fabricates an available GPT or Haiku model',()=>{
 const input=base();input.catalogs.subagent=[item('anthropic-apikey/claude-sonnet-5-5'),item('gpt-5.6-terra'),item('anthropic/claude-haiku-5-5')];
 const r=resolve(input);assert.equal(r.roles.executor.status,'ready');assert.equal(r.roles.general.status,'unavailable');
});
test('unused roles do not block startup and explicit user choices supersede defaults',()=>{
 const input=base();input.roles=['executor'];input.catalogs.subagent=[];input.catalogs.executor.push(item(sonnet));input.overrides={executor:{model:sonnet,effort:'medium'}};
 assert.deepEqual(resolve(input).roles.executor,{status:'ready',model:sonnet,effort:'medium',basis:'explicit-user-override'});
});
test('separate creation and subagent inventories cannot claim a model supported only by the other tool',()=>{
 const input=base();input.catalogs.executor=[item(sonnet)];input.catalogs.subagent=[item(opus)];const r=resolve(input);
 assert.equal(r.roles.executor.status,'unavailable');assert.equal(r.roles.general.status,'unavailable');
});
test('unsupported effort is not reported as applied or silently downgraded',()=>{
 const input=base();input.catalogs.subagent=[{id:sonnet,efforts:['high']}];assert.equal(resolve(input).roles.general.status,'unavailable');assert.equal(resolve(input).roles.ui.status,'unavailable');
});
test('an already selected Opus version is preserved and another provider requires an explicit user choice',()=>{
 const input=base();input.catalogs.executor.push(item('anthropic/claude-opus-6-0'));assert.equal(resolve(input).roles.executor.model,opus);
 const other='anthropic-apikey/claude-sonnet-5-5';input.catalogs.subagent.push(item(other));input.overrides={general:{model:other}};assert.equal(resolve(input).roles.general.model,other);
});

for(const provider of ['anthropic-apikey','anthropic']){
 const other=provider==='anthropic'?'anthropic-apikey':'anthropic';
 test(`${provider} supervision keeps every role in its active series even when the other series offers newer models`,()=>{
  const ownOpus=`${provider}/claude-opus-5-5`,ownSonnet=`${provider}/claude-sonnet-5-5`;
  const input={supervisorModel:ownSonnet,roles:['executor','general','ui'],catalogs:{
   executor:[item(`${other}/claude-opus-99-0`),item(ownOpus)],
   subagent:[item(`${other}/claude-sonnet-99-0`),item(ownSonnet)]}};
  const r=resolve(input);assert.equal(r.provider,provider+'/');
  assert.deepEqual(Object.fromEntries(Object.entries(r.roles).map(([k,v])=>[k,[v.status,v.model,v.effort]])),{
   executor:['ready',ownOpus,'high'],general:['ready',ownSonnet,'medium'],ui:['ready',ownSonnet,'low']});
 });
 test(`${provider} supervision never borrows the other series when its own role models are missing`,()=>{
  const r=resolve({supervisorModel:`${provider}/claude-opus-5-5`,roles:['executor','general','ui'],catalogs:{
   executor:[item(`${other}/claude-opus-5-5`)],subagent:[item(`${other}/claude-sonnet-5-5`)]}});
  for(const role of ['executor','general','ui'])assert.equal(r.roles[role].status,'unavailable');
 });
}
