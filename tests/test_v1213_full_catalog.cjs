// v1.21.3 (Jay 2026-11-27「A」). spawn_agent listed only the first 16 routed models, so workspace E's Opus mainline
// never saw Terra: with Sonnet's subscription left at ladder step 1 and the Claude API out for the month, model-route
// sent every worker to DeepSeek (18 of 24 that evening, C72 at 22:46 after v1.21.2), while the watcher published Terra
// as their first stop. The CLI now adds the OpenCodex catalog the watcher reads.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const ROUTE=path.resolve(__dirname,'../codex/.agents/skills/long-task-supervisor/scripts/model-route.cjs');
const save=(file,value)=>fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n');
const efforts=['low','medium','high','xhigh','max','ultra'];
const opus='anthropic/claude-opus-5-5',sonnet='anthropic/claude-sonnet-5-5',apiSonnet='anthropic-apikey/claude-sonnet-5-5';
const terra='gpt-6.1-terra',apiTerra='openai-apikey/gpt-6.1-terra';

function route(t,input,catalogIds){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'v1213-catalog-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const catalog=path.join(root,'catalog.json');
  save(catalog,{models:catalogIds.map(slug=>({slug,visibility:'list',supported_reasoning_levels:efforts.map(effort=>({effort}))}))});
  const fallback=path.join(root,'model-fallback.json');
  // Workspace E at 22:46: ladder step 1 leaves the Sonnet subscription and the Claude API is out until the 1st.
  save(fallback,{limits:{},apiMonth:{until:new Date(Date.now()+86400000).toISOString()},ladder:{floors:{subagent:1,supervisor:0,executor:0}},openaiQuota:{subscriptionHeld:false}});
  const file=path.join(root,'input.json');
  save(file,{supervisorModel:opus,executorModel:opus,executorEffort:'xhigh',roles:['general'],fallback,...input});
  const env={...process.env,OPENCODEX_MODEL_CATALOG:catalog,OPENCODEX_HOME:root};delete env.CODEX_THREAD_ID;
  return JSON.parse(execFileSync(process.execPath,[ROUTE,file],{encoding:'utf8',env})).roles.general;
}

test('a worker reaches Terra on the subscription when the mainline tool list stops before it',t=>{
  // The mainline's own list, cut off before Terra as spawn_agent showed it.
  const listed=[opus,sonnet,apiSonnet].map(id=>({id,efforts}));
  const general=route(t,{catalogs:{subagent:listed}},[opus,sonnet,apiSonnet,terra,apiTerra]);
  assert.deepEqual([general.status,general.model,general.effort,general.basis],['ready',terra,'high','quota-ladder']);
});

test('the mainline no longer has to copy a model list into the route input',t=>{
  const general=route(t,{},[opus,sonnet,apiSonnet,terra,apiTerra]);
  assert.deepEqual([general.model,general.effort],[terra,'high']);
});



// Jay 2026-11-27「這個技能對opencodex裡面的各類相關設定應該要有即時掌握的機制，不是寫入一次然後改技能或是我改opencodex設定都會漏，
// 而且要固化成程式程序」: what the skill uses from OpenCodex is read from its settings when it is used.
const quota=require(path.resolve(__dirname,'../codex/.agents/skills/long-task-supervisor/scripts/claude-quota.cjs'));
const catalogModule=path.resolve(__dirname,'../codex/.agents/skills/long-task-supervisor/scripts/model-catalog.cjs');
function withEnv(values,fn){
  const old=Object.fromEntries(Object.keys(values).map(key=>[key,process.env[key]]));
  for(const [key,value] of Object.entries(values))if(value===undefined)delete process.env[key];else process.env[key]=value;
  const restore=()=>{for(const [key,value] of Object.entries(old))if(value===undefined)delete process.env[key];else process.env[key]=value;};
  return Promise.resolve().then(fn).finally(restore);
}

test('a model or provider switched off in OpenCodex is not chosen before OpenCodex rewrites its catalog',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'v1213-settings-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const catalog=path.join(root,'catalog.json');
  save(catalog,{models:[sonnet,apiSonnet,terra,apiTerra].map(slug=>({slug,visibility:'list',supported_reasoning_levels:efforts.map(effort=>({effort}))}))});
  await withEnv({OPENCODEX_HOME:root,OPENCODEX_MODEL_CATALOG:catalog},()=>{
    const {installed}=require(catalogModule),ids=()=>installed().map(item=>item.slug);
    save(path.join(root,'config.json'),{disabledModels:[terra],providers:{'anthropic-apikey':{disabled:true}}});
    assert.deepEqual(ids(),[sonnet,apiTerra]);
    save(path.join(root,'config.json'),{disabledModels:[],providers:{}});
    assert.deepEqual(ids(),[sonnet,apiSonnet,terra,apiTerra],'switched back on, they are offered again at once');
  });
});

test('a changed stop line or label reads the quota at once, and a token refresh does not',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'v1213-settings-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const now=Date.now(),file=path.join(root,'quota.json'),auth=path.join(root,'auth.json');
  save(file,{accounts:[{provider:'anthropic',id:'jay',label:'jay@xplorx.co',plan:'max_20x',paused:false,autoSwitchThresholdOverride:null,quota:{weeklyPercent:10,weeklyResetAt:now+86400000}}]});
  const account=over=>({anthropic:{accounts:[{id:'jay',alias:'jay@xplorx.co',credential:'one',autoSwitchThresholdOverride:null,...over}]}});
  await withEnv({LONG_TASK_CLAUDE_QUOTA_FILE:file,OPENCODEX_HOME:root,OPENCODEX_MODEL_CATALOG:path.join(root,'none.json'),LONG_TASK_ACCOUNT_STOPS_FILE:path.join(root,'stops.json')},async()=>{
    save(auth,account({}));
    const state={};await quota.refresh(state,now);
    const first=state.claudeQuota.at;
    save(auth,account({credential:'two'}));
    await quota.refresh(state,now+60000);
    assert.equal(state.claudeQuota.at,first,'a new token is not a settings change: the 30-minute reading holds');
    save(auth,account({credential:'two',autoSwitchThresholdOverride:60}));
    await quota.refresh(state,now+120000);
    assert.equal(state.claudeQuota.at,now+120000,'a new stop line is read at once');
    save(auth,account({credential:'two',autoSwitchThresholdOverride:60,alias:'jay@xplorx.co（共用帳號）'}));
    await quota.refresh(state,now+180000);
    assert.equal(state.claudeQuota.at,now+180000,'a new label is read at once');
  });
});

