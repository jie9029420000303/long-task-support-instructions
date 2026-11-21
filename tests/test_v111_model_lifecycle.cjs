const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawn,execFileSync} = require('node:child_process');
const {setTimeout: delay} = require('node:timers/promises');
const scripts = process.env.CODEX_SUPERVISOR_SCRIPTS || path.resolve(__dirname,'../codex/.agents/skills/long-task-supervisor/scripts');
const watcher = path.join(scripts,'native-watch.cjs');
const subscription = 'anthropic/claude-opus-5-5';
const paid = 'anthropic-apikey/claude-opus-5-5';
const sol = 'gpt-6.2-sol';
const cheap = new Map([
  ['deepseek/deepseek-v4.1-flash-1017','ambient/fp4'],
  ['meta/muse-ember','google-vertex/global']
]);
const slug = raw => 'openrouter/'+raw.replace('/','-');
const fourths = [...cheap.keys()].map(slug);
const executor = 'executor-qa', supervisor = 'supervisor-qa';
const sha = text => crypto.createHash('sha256').update(text).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file,'utf8'));
const write = (file,obj) => fs.writeFileSync(file,JSON.stringify(obj)+'\n');
const line = (file,obj) => fs.appendFileSync(file,JSON.stringify(obj)+'\n');
const now = () => new Date().toISOString();

async function waitFor(predicate,description) {
  const deadline = Date.now()+12000;
  while (Date.now()<deadline) {
    if(predicate()) return;
    await delay(50);
  }
  assert.fail(description);
}
function sandbox(t,{state={},preferred}={}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'model-lifecycle-')));
  const proxyHome = path.join(root,'opencodex'), home = path.join(root,'codex'), run = path.join(root,'run');
  const today = new Date();
  const logs = path.join(home,'sessions',String(today.getFullYear()),String(today.getMonth()+1).padStart(2,'0'),String(today.getDate()).padStart(2,'0'));
  for(const dir of [proxyHome,logs,run]) fs.mkdirSync(dir,{recursive:true});
  const source = path.join(root,'source.txt'), contract = path.join(run,'contract.json');
  fs.writeFileSync(source,'Run the synthetic route test.\n');
  write(contract,{goal:'Resume isolated work',authorization:'Synthetic fixture only',criteria:[{id:'A1',requirement:'Route work',source:'source.txt:1',verify:'Mock receipt'}],
    sources:[{path:source,sha256:sha(fs.readFileSync(source))}]});
  write(path.join(run,'binding.json'),{platform:'codex',projectRoot:root,allowedRoots:[root,run],supervisorId:supervisor,executorId:executor,callerTurnId:'isolated',
    createdAt:now(),contractSha256:sha(fs.readFileSync(contract)),...(preferred?{fourthExecutorModel:{model:preferred,effort:'max'}}:{})});
  const stateFile = path.join(run,'daemon-state.json');
  write(stateFile,{phase:'starting',cursor:null,seen:[],messages:[],pending:null,inflight:null,reads:0,starts:0,
    lastExecutorActivityAt:Date.now(),lastProgressReviewAt:Date.now(),...state});
  const catalog = path.join(home,'opencodex-catalog.json'), usage = path.join(proxyHome,'usage.jsonl');
  write(catalog,{models:[subscription,paid,sol,...fourths].map(id=>({slug:id,visibility:'list',supported_reasoning_levels:[{effort:'high'},{effort:'max'}]}))});
  write(path.join(proxyHome,'config.json'),{providers:{openrouter:{disabled:false,enforceSelectedModels:true,selectedModels:[...cheap.keys()],
    modelOpenRouterRouting:Object.fromEntries([...cheap].map(([id,provider])=>[id,{only:[provider],allowFallbacks:false}])),
    modelPinnedReasoningEfforts:Object.fromEntries([...cheap.keys()].map(id=>[id,'max']))}}});
  fs.writeFileSync(usage,'');
  const rollout = id => path.join(logs,'rollout-test-'+id+'.jsonl');
  const context = (id,model) => line(rollout(id),{timestamp:now(),type:'turn_context',payload:{model,effort:'high',approval_policy:'never'}});
  for(const id of [executor,supervisor]){
    line(rollout(id),{timestamp:now(),type:'session_meta',payload:{id}});
    context(id,sol);
  }
  const sent = path.join(root,'sent'), mock = path.join(root,'mock.json');
  write(mock,{executorId:executor,supervisorId:supervisor,noTurn:true,supervisorIdle:true});
  const env = {...process.env,HOME:root,CODEX_HOME:home,OPENCODEX_HOME:proxyHome,OPENCODEX_USAGE_FILE:usage,OPENCODEX_MODEL_CATALOG:catalog,
    OPENCODEX_QUOTA_FILE:path.join(proxyHome,'provider-account-quota-cache.json'),CODEX_APP_TOOLS_SERVER_PATH:path.join(__dirname,'mock-codex-app-server.cjs'),
    MOCK_CODEX_FIXTURE:mock,MOCK_CODEX_SENT:sent,CODEX_WATCH_IDLE_SLEEP_MS:'150',CODEX_SUPERVISOR_DECISION_POLL_MS:'150',CHROME_RELAY_BIN:path.join(root,'absent'),LONG_TASK_REGISTER:'0'};
  delete env.CODEX_THREAD_ID;
  let processHandle,stderr='';
  t.after(async()=>{
    if(processHandle && processHandle.exitCode===null && processHandle.signalCode===null){
      const stopped=new Promise(resolve=>processHandle.once('exit',resolve));
      processHandle.kill('SIGTERM');await stopped;
    }
    fs.rmSync(root,{recursive:true,force:true});
  });
  const quota = (id,used,{window=10080,reset=Math.floor(Date.now()/1000)+86400,slot='primary',limit='codex'}={}) => line(rollout(id),{
    timestamp:now(),type:'event_msg',payload:{type:'token_count',rate_limits:{limit_id:limit,[slot]:{used_percent:used,window_minutes:window,resets_at:reset}}}
  });
  return {quota,context,catalog,config:path.join(proxyHome,'config.json'),state:()=>read(stateFile),
    resolveWorker(input,threadId){
      const file=path.join(root,'worker-input.json');
      write(file,input);
      return JSON.parse(execFileSync(process.execPath,[path.join(scripts,'model-route.cjs'),file],{env:threadId?{...env,CODEX_THREAD_ID:threadId}:env,encoding:'utf8',timeout:3000})).roles.general;
    },
    async start(){
      processHandle=spawn(process.execPath,[watcher,run],{env,stdio:['ignore','ignore','pipe']});
      processHandle.stderr.on('data',data=>{stderr=(stderr+data).slice(-1500);});
      await waitFor(()=>{assert.equal(processHandle.exitCode,null,stderr);return read(stateFile).reads>0;},'watcher did not start');
    },
    calls:()=>fs.existsSync(sent+'.args.json')?read(sent+'.args.json'):[],
    refuse(id,model){line(usage,{conversationId:sha(id).slice(0,32),requestedModel:model,status:429,timestamp:Date.now()});}
  };
}
function initialState() {
  const until = Date.now()+3600000, since=Date.now()-60000;
  return {rateLimits:{'anthropic/':{until,since},'anthropic-apikey/':{until,since}},
    modelSwitch:Object.fromEntries([executor,supervisor].map(id=>[id,{
      role:id===executor?'executor':'supervisor',original:subscription,current:sol,effort:'high',since,until
    }]))};
}

test('the current Sol conversation can protect subscription capacity without switching its supervisor at 49% remaining',async t=>{
  const f=sandbox(t,{state:initialState()});
  f.quota(supervisor,91);
  f.context(executor,paid);f.quota(executor,90);f.context(executor,sol);
  f.quota(executor,95,{window:300});f.quota(executor,99,{reset:Math.floor(Date.now()/1000)-10});
  f.quota(executor,93,{limit:'different-plan'});
  await f.start();
  assert.deepEqual(f.calls().filter(call=>call.model),[],'unrelated, stale, short and missing weekly data do not justify a switch');
  const oldReads=f.state().reads;
  f.quota(executor,50);
  await waitFor(()=>f.state().reads>oldReads+1,'no poll at the 50% boundary');
  assert.deepEqual(f.calls().filter(call=>call.model),[],'exactly 50% stays on Sol');
  f.quota(executor,51,{slot:'secondary'});
  await waitFor(()=>f.calls().some(call=>call.threadId===executor&&fourths.includes(call.model)),'no automatic fourth route at 49%');
  assert.equal(f.calls().find(call=>fourths.includes(call.model)).thinking,'max');
  assert.ok(!f.calls().some(call=>call.threadId===supervisor&&fourths.includes(call.model)));
});

test('an existing run with no available model resumes on the first higher route to recover without another failed request',async t=>{
  const state=initialState(),since=Date.now()-1000,until=Date.now()+60000;
  state.rateLimits['anthropic-apikey/'].until=Date.now()+3000;
  for(const model of fourths)state.rateLimits[model]={since,until};
  const f=sandbox(t,{state});
  f.refuse(executor,sol);
  f.refuse(supervisor,sol);
  await f.start();
  for(const id of [executor,supervisor]){
    await waitFor(()=>f.calls().some(call=>call.threadId===id&&call.model===paid),'the recovered API route did not resume '+id);
    assert.equal(f.calls().filter(call=>call.threadId===id&&call.model===paid).length,1,'one resume per conversation');
  }
});

test('the approved explicit choice is used at max when the third model refuses a bound executor',async t=>{
  const preferred=fourths[1],f=sandbox(t,{preferred,state:initialState()});
  f.refuse(executor,sol);
  await f.start();
  await waitFor(()=>f.calls().some(call=>call.threadId===executor&&call.model===preferred),'the bound candidate was not used');
  assert.equal(f.calls().find(call=>call.model===preferred).thinking,'max');
});

test('an unpinned OpenRouter provider or changed effort cannot silently consume a fourth route',async t=>{
  const f=sandbox(t,{state:initialState()});
  const config=read(f.config),provider=config.providers.openrouter;
  provider.modelOpenRouterRouting['deepseek/deepseek-v4.1-flash-1017'].allowFallbacks=true;
  provider.modelPinnedReasoningEfforts['meta/muse-ember']='low';
  write(f.config,config);
  f.refuse(executor,sol);
  await f.start();
  await waitFor(()=>f.state().rateLimits?.[sol]?.since,'the watcher missed the refusal');
  assert.ok(!f.calls().some(call=>fourths.includes(call.model)),'unapproved cost and quality must never be selected');
});

test('a stale visible catalog cannot reactivate a disabled provider or a model removed from its selection', async t=>{
  for(const mode of ['provider disabled','removed selection','disabled models']){
    await t.test(mode,async t=>{
      const f=sandbox(t,{state:initialState()});
      const config=read(f.config),provider=config.providers.openrouter;
      if(mode==='provider disabled')provider.disabled=true;
      if(mode==='removed selection')provider.selectedModels=[];
      if(mode==='disabled models')config.disabledModels=[...fourths];
      write(f.config,config);
      f.refuse(executor,sol);
      await f.start();
      await waitFor(()=>f.state().rateLimits?.[sol]?.since,'watcher missed the refusal');
      assert.ok(!f.calls().some(call=>fourths.includes(call.model)),mode+' must win over cached catalog data');
    });
  }
});

test('a fourth-route 429 continues the same executor on the other pinned model at max and keeps the supervisor on subscription',async t=>{
  const f=sandbox(t,{state:initialState()});
  f.refuse(executor,sol);
  await f.start();
  await waitFor(()=>f.calls().some(call=>call.threadId===executor&&fourths.includes(call.model)),'no default fourth model');
  const first=f.calls().find(call=>fourths.includes(call.model)).model;
  const other=fourths.find(model=>model!==first);
  f.context(executor,first);
  f.refuse(executor,first);
  await waitFor(()=>f.calls().some(call=>call.threadId===executor&&call.model===other),'the first fourth model refused and no alternate continued');
  assert.equal(f.calls().find(call=>call.model===other).thinking,'max');
  assert.ok(!f.calls().some(call=>call.threadId===supervisor&&fourths.includes(call.model)));
});

test('the dispatch resolver can assign a compatible child at max and rejects an unavailable or different fourth model',t=>{
  const f=sandbox(t);
  const inventory=fourths.map(id=>({id,efforts:['max']}));
  for(const model of fourths){
    const input={supervisorModel:sol,executorModel:model,roles:['general'],catalogs:{subagent:inventory}};
    const worker=f.resolveWorker(input);
    assert.equal(worker.status,'ready');
    assert.equal(worker.model,model);
    assert.equal(worker.effort,'max');
    const other=fourths.find(id=>id!==model);
    assert.equal(f.resolveWorker({...input,overrides:{general:{model:other}}}).status,'unavailable');
    assert.equal(f.resolveWorker({...input,catalogs:{subagent:[{id:other,efforts:['max']}]}}).status,'unavailable');
  }
});

test('an executor that moved off Sol selects its actual fourth-route model for the next worker',t=>{
  const f=sandbox(t),catalog=fourths.map(id=>({id,efforts:['max']}));
  for(const model of fourths){
    f.context(executor,model);
    const row=f.resolveWorker({supervisorModel:sol,executorModel:sol,roles:['general'],catalogs:{subagent:catalog}},executor);
    assert.equal(row.model,model);assert.equal(row.effort,'max');
  }
});
