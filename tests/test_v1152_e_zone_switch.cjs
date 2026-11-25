// v1.15.2 (Jay 2026-11-25「1A 2A 3 4A 5A」). 工區 E, 12:02～12:04: the executor's chat was set to Muse, but every new turn first
// asked for gpt-6.2-sol (the free account answers model_unavailable) and failed before writing its turn context. The
// watcher read the chat's model from that stale turn context, took each Sol refusal as new, and sent the same switch to
// Muse 21 times. At 10:23 a worker's Terra refusal under the mainline's conversation hid the mainline's own Sol refusal,
// and at 12:02 E moved to Sol although 工區 D and 清票 had both been refused there. What each test pins: a refusal of a
// model the chat no longer runs is left to the supervisor, which the failed turn wakes; each route of a conversation
// keeps its own latest refusal; and a model an account cannot run is skipped by every run until that route works again.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const scripts=process.env.CODEX_SUPERVISOR_SCRIPTS||path.resolve(__dirname,'../codex/.agents/skills/long-task-supervisor/scripts');
const fallback=require(path.join(scripts,'model-fallback.cjs'));
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const save=(file,value)=>fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n');
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const line=(file,value)=>fs.appendFileSync(file,JSON.stringify(value)+'\n');
const iso=ms=>new Date(ms).toISOString();
const sol='gpt-6.2-sol',terra='gpt-6.1-terra',muse='openrouter/meta-muse-ember',museRaw='meta/muse-ember';
async function until(check,ms=20000){const end=Date.now()+ms;while(Date.now()<end){if(check())return;await new Promise(resolve=>setTimeout(resolve,50));}throw Error('Timed out');}
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function withEnv(values,fn){
  const old=Object.fromEntries(Object.keys(values).map(key=>[key,process.env[key]]));
  for(const [key,value] of Object.entries(values))if(value===undefined)delete process.env[key];else process.env[key]=value;
  try{return fn();}finally{for(const [key,value] of Object.entries(old))if(value===undefined)delete process.env[key];else process.env[key]=value;}
}
// The 2026-11-25 12:03 usage row of 工區 E's executor, trimmed to the fields the watcher reads.
const refusal=(threadId,at,model=sol)=>({conversationId:fallback.hashId(threadId),timestamp:at,provider:'openai-p23897d',model,requestedModel:model,
  status:400,errorCode:'invalid_request_error',upstreamCondition:'model_unavailable'});

test('each route of one conversation keeps its own latest refusal, so a worker\'s refusal does not hide the mainline\'s',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'v1152-scan-')),usage=path.join(root,'usage.jsonl');
  try{
    fs.writeFileSync(usage,JSON.stringify({conversationId:'unrelated',status:200})+'\n');
    withEnv({OPENCODEX_USAGE_FILE:usage},()=>{
      const threads=[{role:'executor',threadId:'executor-qa'}],state={},now=Date.now();
      fallback.scan(state,threads);
      // 10:23: the mainline is refused on Sol, a worker under the same conversation is refused on Terra ten seconds later.
      line(usage,{...refusal('executor-qa',now-10000),upstreamCondition:undefined,status:429,errorCode:'usage_limit_reached'});
      line(usage,{...refusal('executor-qa',now,terra),upstreamCondition:undefined,status:429,errorCode:'usage_limit_reached'});
      assert.deepEqual(fallback.scan(state,threads).map(hit=>hit.model).sort(),[sol,terra].sort());
      // A success on Terra ends only Terra's refusal.
      line(usage,{...refusal('executor-qa',now-10000),upstreamCondition:undefined,status:429,errorCode:'usage_limit_reached',timestamp:now+1000});
      line(usage,{conversationId:fallback.hashId('executor-qa'),timestamp:now+2000,requestedModel:terra,status:200});
      assert.deepEqual(fallback.scan(state,threads).map(hit=>hit.model),[sol]);
    });
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('a model the account cannot run is skipped by every run on both sides until the route serves a request again',()=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'v1152-shared-'));
  try{
    withEnv({LONG_TASK_HOME:home},()=>{
      const now=Date.now();
      fallback.recordUnsupported('/runs/工區D',sol,now-60000,now+fallback.FALLBACK_MS);
      const other={};
      assert.equal(fallback.syncUnsupported(other,'/runs/工區E',now),true,'12:02: 工區 E learns what 工區 D was told');
      for(const role of ['supervisor','executor'])assert.equal(fallback.limited(other,sol,now,role),true,role+' skips Sol');
      assert.equal(other.rateLimits[fallback.limitKey('executor',sol)].cooldown,'unsupported');
      const served={routeOk:{[sol]:now-1000}};
      assert.equal(fallback.syncUnsupported(served,'/runs/清票',now),false,'a request served on Sol since then means the account runs it again');
      assert.equal(fallback.limited(served,sol,now,'executor'),false);
      fallback.recordUnsupported('/runs/清票',sol,now-120000,now+1000);
      assert.equal(read(path.join(home,'model-unavailable.json'))[sol].since,now-60000,'an older refusal does not replace a newer one');
    });
  }finally{fs.rmSync(home,{recursive:true,force:true});}
});

// The watcher replayed on the 12:03 state: every route above Muse is out, the chat is set to Muse, its last turn context
// still says Sol, and the failed turn left an error in the executor's rollout.
function eZone(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'v1152-watch-')),now=Date.now();
  const home=path.join(root,'codex-home'),source=path.join(root,'source.txt');fs.writeFileSync(source,'Keep the work moving\n');
  const contract={goal:'Finish',authorization:'Isolated QA',criteria:[{id:'A1',requirement:'Keep work moving',source:'source.txt:1',verify:'Replay'}],sources:[{path:source,sha256:sha(source)}]};
  const run=path.join(root,'run');fs.mkdirSync(run);save(path.join(run,'contract.json'),contract);
  const binding={platform:'codex',projectRoot:root,allowedRoots:[root,run],supervisorId:'supervisor-qa',executorId:'executor-qa',callerTurnId:'supervisor-turn',
    contractSha256:sha(path.join(run,'contract.json')),createdAt:iso(now-60000)};
  save(path.join(run,'binding.json'),binding);
  const catalogFile=path.join(root,'models.json'),catalog=read(path.join(__dirname,'fixtures/model-routing-catalog.json'));
  catalog.models.push({slug:muse,visibility:'list',supported_reasoning_levels:[{effort:'max'}]});save(catalogFile,catalog);
  save(path.join(root,'config.json'),{providers:{openrouter:{modelPinnedReasoningEfforts:{[museRaw]:'max'},modelOpenRouterRouting:{[museRaw]:{only:['google-vertex/global'],allowFallbacks:false}}}}});
  const envBase={OPENCODEX_HOME:root,OPENCODEX_MODEL_CATALOG:catalogFile};
  const rateLimits={};
  withEnv(envBase,()=>{for(const model of fallback.chainFor(sol,'executor'))rateLimits[fallback.limitKey('executor',model)]={since:now-60000,until:now+3600000,model,basis:'replay'};});
  const record={role:'executor',original:sol,current:muse,effort:'high',since:now-30000,until:now+3600000,restored:null,respondedAt:now-29000};
  save(path.join(run,'daemon-state.json'),{phase:'starting',cursor:null,seen:[],messages:[],pending:null,inflight:null,reads:0,starts:0,
    lastExecutorActivityAt:now,lastProgressReviewAt:now,rateLimits,modelSwitch:{'executor-qa':record}});
  const dir=path.join(home,'sessions',...new Date().toLocaleDateString('en-CA').split('-'));fs.mkdirSync(dir,{recursive:true});
  const executorLog=path.join(dir,'rollout-t-executor-qa.jsonl');
  line(executorLog,{timestamp:iso(now-60000),type:'session_meta',payload:{id:'executor-qa'}});
  line(executorLog,{timestamp:iso(now-50000),type:'turn_context',payload:{turn_id:'sol-turn',model:sol,effort:'high',approval_policy:'never',approvals_reviewer:'user'}});
  line(executorLog,{timestamp:iso(now-30000),type:'event_msg',payload:{type:'thread_settings_applied',thread_settings:{model:muse,approval_policy:'never'}}});
  line(executorLog,{timestamp:iso(now-28000),type:'event_msg',payload:{type:'task_complete',turn_id:'muse-turn',
    error:{message:"The 'gpt-6.2-sol' model is not supported when using Codex with a ChatGPT account.",codex_error_info:'model_not_found'}}});
  const sent=path.join(root,'sent.json'),mockFile=path.join(root,'mock.json'),usage=path.join(root,'usage.jsonl');
  fs.writeFileSync(usage,JSON.stringify({conversationId:'unrelated',status:200})+'\n');
  save(mockFile,{supervisorId:binding.supervisorId,executorId:binding.executorId,noTurn:true});
  const env={...process.env,...envBase,CODEX_HOME:home,CODEX_APP_TOOLS_SERVER_PATH:path.join(__dirname,'mock-codex-app-server.cjs'),MOCK_CODEX_FIXTURE:mockFile,MOCK_CODEX_SENT:sent,
    OPENCODEX_USAGE_FILE:usage,OPENCODEX_QUOTA_FILE:path.join(root,'quota.json'),CHROME_RELAY_BIN:path.join(root,'no-relay'),CODEX_WATCH_IDLE_SLEEP_MS:'200'};
  delete env.CODEX_THREAD_ID;delete env.LONG_TASK_HOME;
  let child;
  return {run,usage,statePath:path.join(run,'daemon-state.json'),
    start(){child=spawn(process.execPath,[path.join(scripts,'native-watch.cjs'),run],{env,stdio:['ignore','pipe','pipe']});},
    calls(){const file=sent+'.args.json';return fs.existsSync(file)?read(file):[];},
    async stop(){if(child?.exitCode===null){child.kill('SIGTERM');await new Promise(resolve=>child.once('exit',resolve));}fs.rmSync(root,{recursive:true,force:true});}};
}

test('a refusal of the model a chat has already left is not answered with the same switch again; the failed turn wakes the supervisor',async()=>{
  const f=eZone();
  try{
    f.start();
    await until(()=>read(f.statePath).usageOffset!==undefined);
    line(f.usage,refusal('executor-qa',Date.now()));
    await until(()=>{const state=read(f.statePath);return state.rateLimits[fallback.limitKey('executor',sol)]?.cooldown==='unsupported'&&!(state.switchQueue||[]).length&&!Object.keys(state.routeWaiting||{}).length;});
    await delay(1500);
    assert.deepEqual(f.calls().filter(call=>call.model).map(call=>call.model),[],'12:03: no switch to the Muse it is already set to');
    const state=read(f.statePath);
    assert.equal(state.modelSwitch['executor-qa'].current,muse);
    assert.equal(state.platformError?.kind,'model_not_found');
    assert.ok(state.pending?.reasons?.includes('platform_error'),'the supervisor is woken with the error to handle it');
    assert.ok(read(path.join(f.run,'model-unavailable.json'))[sol],'the refusal is shared with the other runs');
  }finally{await f.stop();}
});

