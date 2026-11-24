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
// Jay 2026-11-23「子代理sonnet 改為high」: a Sonnet general worker starts at High; interface work keeps Low.
test('a Claude supervisor starts the executor and its workers on subscription Sonnet at their baseline efforts',()=>{
 const r=resolve(base());assert.deepEqual(Object.fromEntries(Object.entries(r.roles).map(([k,v])=>[k,[v.model,v.effort]])),{executor:[sonnet,'high'],general:[sonnet,'high'],ui:[sonnet,'low']});
});
// Jay 2026-11-23 21:50: the first unsuccessful delivery raises the same model two steps (at most max) in a new
// subagent, because followup_task cannot change the effort. Sonnet High goes max, Terra Medium xhigh, interface Low high.
test('a first failure raises the same model two reasoning steps, capped at max, in a new subagent',()=>{
 const wide=id=>({id,efforts:['low','medium','high','xhigh','max','ultra']}),terra='gpt-6.1-terra';
 const claude=errors=>resolve({supervisorModel:opus,roles:['general','ui'],catalogs:{subagent:[wide(sonnet)]},errors}).roles;
 assert.deepEqual([0,1].map(n=>claude(n).general.effort),['high','max']);
 assert.deepEqual([0,1].map(n=>claude(n).ui.effort),['low','high'],'interface work keeps its own baseline');
 assert.equal(claude(1).general.newAgent,true,'the raise needs a new subagent');assert.equal(claude(0).general.newAgent,undefined);
 assert.equal(claude(1).general.model,sonnet,'no model change');
 const gpt=errors=>resolve({supervisorModel:opus,executorModel:sol,roles:['general'],catalogs:{subagent:[wide(terra)]},errors}).roles.general;
 assert.deepEqual([0,1].map(n=>[gpt(n).model,gpt(n).effort]),[[terra,'medium'],[terra,'xhigh']]);
 // A catalog that stops at xhigh raises as far as it goes; ultra is never chosen.
 assert.equal(resolve({...base(),roles:['general'],errors:1}).roles.general.effort,'xhigh');
 const top=resolve({supervisorModel:opus,roles:['general'],catalogs:{subagent:[wide(sonnet)]},errors:1,previousEffort:'max'}).roles.general;
 assert.deepEqual([top.effort,top.effortAtCeiling],['max',true]);
 // An explicit user effort still wins, and an explicit Opus worker without an effort keeps the general Medium.
 assert.equal(resolve({...base(),roles:['general'],overrides:{general:{effort:'medium'}}}).roles.general.effort,'medium');
 const explicit=resolve({supervisorModel:opus,roles:['general'],catalogs:{subagent:[wide(sonnet),wide(opus)]},overrides:{general:{model:opus}}}).roles.general;
 assert.deepEqual([explicit.model,explicit.effort],[opus,'medium']);
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
 const input=base();input.catalogs.subagent=[{id:sonnet,efforts:['medium']}];assert.equal(resolve(input).roles.general.status,'unavailable');assert.equal(resolve(input).roles.ui.status,'unavailable');
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
   executor:['ready',sonnet,'high'],general:['ready',sonnet,'high'],ui:['ready',sonnet,'low']});
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

// The second failure goes to research at xhigh; the research returns to the second attempt's subagent and the count
// resets without lowering its effort. There is no third-failure model change and no fourth-failure takeover.
test('research runs at xhigh, a reset keeps the raised effort, and no count reaches a model change or takeover',()=>{
 const wide=id=>({id,efforts:['low','medium','high','xhigh','max','ultra']}),terra='gpt-6.1-terra';
 const research=resolve({supervisorModel:opus,roles:['general'],catalogs:{subagent:[wide(sonnet)]},research:true}).roles.general;
 assert.deepEqual([research.model,research.effort,research.research],[sonnet,'xhigh',true]);
 assert.throws(()=>resolve({supervisorModel:opus,roles:['general'],catalogs:{subagent:[wide(sonnet)]},research:true,errors:1}),/own count/);
 for(const errors of [2,3,4])assert.throws(()=>resolve({...base(),roles:['general'],errors}),/0 or 1/);
 // After the reset Terra's subagent ran at xhigh: it continues there, and its next failure raises to max.
 const gpt=input=>resolve({supervisorModel:opus,executorModel:sol,roles:['general'],catalogs:{subagent:[wide(terra)]},previousEffort:'xhigh',...input}).roles.general;
 assert.equal(gpt({}).effort,'xhigh');assert.equal(gpt({errors:1}).effort,'max');
 assert.throws(()=>gpt({previousEffort:'turbo'}),/previousEffort/);
});
test('worker catalog uses visible numerically latest release of actual executor family',()=>{
 const catalog=[item('gpt-6.9-terra'),item('gpt-6.10-terra'),{...item('gpt-7.0-terra'),visibility:'hide'},item(sonnet)];
 const input={supervisorModel:opus,executorModel:'gpt-6.2-sol',roles:['general'],catalogs:{subagent:catalog}};
 assert.equal(resolve(input).roles.general.model,'gpt-6.10-terra');
 assert.equal(resolve({...input,overrides:{general:{model:sonnet}}}).roles.general.status,'unavailable');
});
