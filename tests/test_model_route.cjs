const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {resolve}=require(path.join(process.env.CODEX_SUPERVISOR_SCRIPTS||path.resolve(__dirname,'../codex/.agents/skills/long-task-supervisor/scripts'),'model-route.cjs'));
const item=id=>({id,efforts:['low','medium','high','xhigh']}),wide=id=>({id,efforts:['low','medium','high','xhigh','max','ultra']});
const opus='anthropic/claude-opus-5-5',sonnet='anthropic/claude-sonnet-5-5',sol='gpt-6.2-sol',terra='gpt-6.1-terra';
const apiOpus='anthropic-apikey/claude-opus-5-5',apiSonnet='anthropic-apikey/claude-sonnet-5-5',apiSol='openai-apikey/gpt-6.2-sol',apiTerra='openai-apikey/gpt-6.1-terra';
const base=()=>({supervisorModel:opus,roles:['executor','general','ui'],catalogs:{executor:[item(opus),item(sonnet),item(sol)],subagent:[item(sonnet)]}});
const fs=require('node:fs'),os=require('node:os');
const pick=r=>Object.fromEntries(Object.entries(r.roles).map(([k,v])=>[k,[v.model,v.effort]]));
function published(t,body){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'model-route-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'model-fallback.json');fs.writeFileSync(file,JSON.stringify(body));return file;
}
// Jay 2026-11-26 decisions 1 and 9: the mainline plans, dispatches and judges, so it runs Opus at xhigh; with a stronger
// mainline the general worker goes back to Medium, and interface work keeps Low.
test('the executor starts on subscription Opus at xhigh and workers on subscription Sonnet at Medium',()=>{
 assert.deepEqual(pick(resolve(base())),{executor:[opus,'xhigh'],general:[sonnet,'medium'],ui:[sonnet,'low']});
 // Whoever supervises, the executor and its workers keep their own orders (decisions 19-20).
 for(const supervisorModel of [sonnet,'gpt-6.1-sol'])assert.deepEqual(pick(resolve({...base(),supervisorModel})),{executor:[opus,'xhigh'],general:[sonnet,'medium'],ui:[sonnet,'low']});
});
// Decision 33: the count of one criterion never restarts. The 1st, 3rd and 5th go back to the subagent that delivered
// (followup keeps its context but cannot change its effort); the 2nd and 4th go to research and then to a new subagent,
// two steps higher after the 2nd and on the mainline's own model and effort after the 4th; the 6th waits for Jay.
test('the six-step rework loop: same subagent, research, two steps up, mainline-equivalent, then Jay',()=>{
 const claude=input=>resolve({supervisorModel:opus,roles:['general','ui'],catalogs:{subagent:[wide(sonnet),wide(opus)]},executorModel:opus,executorEffort:'xhigh',...input}).roles;
 for(const failures of [1,3,5]){
  const again=claude({failures,previousModel:sonnet,previousEffort:'high'}).general;
  assert.deepEqual([again.model,again.effort,again.reuse,again.basis],[sonnet,'high',true,'same-subagent'],'failure '+failures);
 }
 assert.equal(claude({failures:1}).general.status,'unavailable','a redo by the same subagent names what it ran');
 const raised=claude({failures:2,previousModel:sonnet,previousEffort:'medium'});
 assert.deepEqual([raised.general.model,raised.general.effort,raised.general.newAgent],[sonnet,'xhigh',true]);
 assert.equal(claude({failures:2,previousModel:sonnet,previousEffort:'low'}).ui.effort,'high','interface work raises two steps from its Low baseline');
 assert.equal(claude({failures:2,previousModel:sonnet,previousEffort:'xhigh'}).general.effort,'max');
 const top=claude({failures:2,previousModel:sonnet,previousEffort:'max'}).general;
 assert.deepEqual([top.effort,top.effortAtCeiling],['max',true]);
 const fourth=claude({failures:4,previousModel:sonnet,previousEffort:'max'}).general;
 assert.deepEqual([fourth.model,fourth.effort,fourth.basis,fourth.newAgent],[opus,'xhigh','executor-equivalent',true]);
 assert.match(claude({failures:6}).general.reason,/Jay/);
 const research=claude({failures:2,research:true}).general;
 assert.deepEqual([research.model,research.effort,research.research],[sonnet,'xhigh',true]);
 assert.equal(claude({failures:3,research:true}).general.status,'unavailable','research only at the 2nd, 4th and 6th');
 assert.throws(()=>claude({errors:1}),/failures/,'the old reset-based field is refused rather than misread');
 assert.throws(()=>claude({failures:-1}),/failures/);
 assert.throws(()=>claude({failures:2,previousEffort:'turbo'}),/previousEffort/);
});
// Decisions 16 and 20: the Claude API key is the second stop of every order, no longer the supervisor's reserve.
test('every role takes the Claude API key as its second stop',()=>{
 const r=resolve({supervisorModel:opus,roles:['executor','general'],catalogs:{executor:[item(apiOpus),item(sol)],subagent:[item(apiSonnet),item(terra)]}});
 assert.deepEqual(pick(r),{executor:[apiOpus,'xhigh'],general:[apiSonnet,'medium']});
});
// Decision 20: workers follow their own order whatever the mainline runs, except under a mainline on the ChatGPT
// subscription, which can only hand work to the subscription Terra (2026-11-27 decision 37).
test('workers follow the subagent order, a mainline on the ChatGPT subscription gets the subscription Terra, and none falls to Haiku',()=>{
 assert.equal(resolve({...base(),executorModel:sol,catalogs:{executor:[item(sol)],subagent:[item(sonnet),item(terra)]}}).roles.general.model,terra);
 assert.equal(resolve({...base(),executorModel:opus,catalogs:{executor:[item(opus)],subagent:[item(sonnet),item(terra)]}}).roles.general.model,sonnet);
 const catalog=[item('gpt-6.9-terra'),item('gpt-6.10-terra'),{...item('gpt-7.0-terra'),visibility:'hide'},item('anthropic/claude-haiku-5-5')];
 assert.equal(resolve({supervisorModel:opus,executorModel:sol,roles:['general'],catalogs:{subagent:catalog}}).roles.general.model,'gpt-6.10-terra','the visible numerically latest Terra');
 assert.equal(resolve({supervisorModel:opus,roles:['general'],catalogs:{subagent:[item('anthropic/claude-haiku-5-5')]}}).roles.general.status,'unavailable');
});
test('unused roles do not block startup and explicit user choices supersede defaults',()=>{
 const input=base();input.roles=['executor'];input.catalogs.subagent=[];input.overrides={executor:{model:opus,effort:'medium'}};
 assert.deepEqual(resolve(input).roles.executor,{status:'ready',model:opus,effort:'medium',basis:'explicit-user-override'});
});
test('separate creation and subagent inventories cannot claim a model supported only by the other tool',()=>{
 const input=base();input.catalogs.executor=[item(sonnet)];input.catalogs.subagent=[item(opus)];
 assert.equal(resolve(input).roles.executor.status,'unavailable');
 assert.equal(resolve(input).roles.general.status,'unavailable');
});
test('unsupported effort is not reported as applied or silently downgraded',()=>{
 const input=base();input.catalogs.subagent=[{id:sonnet,efforts:['high']}];input.catalogs.executor=[{id:opus,efforts:['high']}];
 for(const role of ['executor','general','ui'])assert.equal(resolve(input).roles[role].status,'unavailable',role);
});
test('a refused stop moves the role down and says when the front stop returns',t=>{
 const until=new Date(Date.now()+3600000).toISOString();
 const r=resolve({...base(),fallback:published(t,{limits:{'anthropic/':{until}}})});
 assert.deepEqual([r.roles.executor.model,r.roles.executor.basis,r.roles.executor.restoreAfter],[sol,'rate-limit-fallback',until]);
});
// Decision 24: one ladder step k for everyone; the watcher publishes how far each role stands back. A role never goes
// past the last stop that can still serve it.
test('the quota ladder skips the front stops of each role, never past its last serving stop',t=>{
 const catalogs={executor:[item(opus),item(apiOpus),item(sol),item(apiSol)],subagent:[item(sonnet),item(apiSonnet),item(terra),item(apiTerra)]};
 const r=resolve({supervisorModel:opus,roles:['executor','general'],catalogs,fallback:published(t,{limits:{},ladder:{floors:{executor:2,subagent:3}}})});
 assert.deepEqual(pick(r),{executor:[sol,'xhigh'],general:[apiTerra,'medium']});
 assert.equal(r.roles.general.basis,'quota-ladder');
 const deep=resolve({supervisorModel:opus,roles:['general'],catalogs:{subagent:[item(sonnet)]},fallback:published(t,{limits:{},ladder:{floors:{subagent:9}}})});
 assert.equal(deep.roles.general.model,sonnet,'the bottom of the order stays usable');
 // Decision 26: an OpenAI subscription at its line is skipped for the API key, without a pause.
 const held=resolve({supervisorModel:opus,roles:['general'],catalogs:{subagent:[item(terra),item(apiTerra)]},fallback:published(t,{limits:{},openaiQuota:{subscriptionHeld:true}})});
 assert.equal(held.roles.general.model,apiTerra);
});
