// v1.19.0 (Jay 2026-11-27「甲選項可以，七項都修，做成同一版」, decisions 36-42). What each test pins:
// - a mainline on the ChatGPT subscription (Sol or Terra) hands work only to the subscription Terra, whatever the
//   subagent ladder says, because any other provider refuses the encrypted task (13:58～14:02 工區 E and 清票 were
//   refused on DeepSeek, Muse and the OpenAI API; the 14:42 test reproduced unreadable_encrypted_agent_task), and once
//   that Terra cannot serve, the mainline itself leaves the subscription;
// - a switch that did not take is sent again and the new stop is not paused for it (14:0x: Terra was paused 30 minutes
//   as "silent" and two supervisors fell to DeepSeek); from v1.20.0 that is read from the chat's next turn;
// - an API key out of balance (billing_exhausted) is skipped by every role of every run and tried again after 5 hours;
// - a supervisor shared by two runs is moved by one watcher only;
// - prolite's main slot without its upstream key is still one account with its pool slot (14:25 清票 read 24.9% while
//   E and D read 15.4%);
// - a collect result JSON the mainline writes is not a code edit (14:28 /tmp/c16-result.json).
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const scripts=process.env.CODEX_SUPERVISOR_SCRIPTS||path.resolve(__dirname,'../codex/.agents/skills/long-task-supervisor/scripts');
const claudeScripts=path.resolve(__dirname,'../claude-code/.claude/skills/long-task-supervisor/scripts');
const fallback=require(path.join(scripts,'model-fallback.cjs'));
const route=require(path.join(scripts,'model-route.cjs'));
const quota=require(path.join(scripts,'claude-quota.cjs'));
const clock=require(path.join(scripts,'supervisor-clock.cjs'));
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const save=(file,value)=>fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n');
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const line=(file,value)=>fs.appendFileSync(file,JSON.stringify(value)+'\n');
const iso=ms=>new Date(ms).toISOString();
const opus='anthropic/claude-opus-5-5',sonnet='anthropic/claude-sonnet-5-5',sol='gpt-6.2-sol',terra='gpt-6.1-terra';
const apiSol='openai-apikey/gpt-6.2-sol',apiTerra='openai-apikey/gpt-6.1-terra';
async function until(check,ms=20000){const end=Date.now()+ms;while(Date.now()<end){if(check())return;await new Promise(resolve=>setTimeout(resolve,50));}throw Error('Timed out');}
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function withEnv(values,fn){
  const old=Object.fromEntries(Object.keys(values).map(key=>[key,process.env[key]]));
  for(const [key,value] of Object.entries(values))if(value===undefined)delete process.env[key];else process.env[key]=value;
  try{return fn();}finally{for(const [key,value] of Object.entries(old))if(value===undefined)delete process.env[key];else process.env[key]=value;}
}
// The routing fixture with the OpenAI API stops added.
function catalogHome(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'v1190-catalog-')),file=path.join(root,'models.json');
  const catalog=read(path.join(__dirname,'fixtures/model-routing-catalog.json'));
  for(const slug of [apiSol,apiTerra])catalog.models.push({slug,visibility:'list',supported_reasoning_levels:['low','medium','high','xhigh'].map(effort=>({effort}))});
  save(file,catalog);
  return {root,env:{OPENCODEX_HOME:root,OPENCODEX_MODEL_CATALOG:file}};
}
const efforts=['low','medium','high','xhigh','max'];
const subagentCatalog=[sonnet,terra,apiTerra].map(id=>({id,efforts}));

test('a mainline on the ChatGPT subscription dispatches the subscription Terra whatever the subagent ladder says',()=>{
  const home=catalogHome();
  try{withEnv(home.env,()=>{
    const fallbackFile=path.join(home.root,'model-fallback.json');
    // The subagent ladder already passed Terra (step 4 or lower), as it had at 13:58.
    save(fallbackFile,{limits:{},ladder:{floors:{subagent:4,supervisor:2,executor:0}}});
    const ask=executorModel=>route.resolve({supervisorModel:opus,executorModel,roles:['general'],catalogs:{subagent:subagentCatalog},fallback:fallbackFile}).roles.general;
    for(const mainline of [sol,terra])
      assert.deepEqual([ask(mainline).model,ask(mainline).effort,ask(mainline).basis],[terra,'medium','subscription-mainline'],mainline+' mainline');
    assert.notEqual(ask(opus).model,terra,'an Opus mainline keeps the subagent ladder');
    // Terra refused: no worker for this mainline, which the watcher moves on.
    save(fallbackFile,{limits:{[terra]:{until:iso(Date.now()+3600000)}},ladder:{floors:{subagent:0}}});
    assert.equal(ask(sol).status,'unavailable');
    assert.match(ask(sol).reason,/Terra 訂閱/);
    assert.equal(ask(apiSol).model,sonnet,'off the subscription the workers follow their order again');
  });}finally{fs.rmSync(home.root,{recursive:true,force:true});}
});

test('once the subscription Terra cannot serve, a mainline on the ChatGPT subscription leaves it; the supervisor does not',()=>{
  const home=catalogHome();
  try{withEnv(home.env,()=>{
    const now=Date.now(),state={rateLimits:{[fallback.limitKey('subagent',terra)]:{since:now-60000,until:now+3600000,model:terra}}};
    assert.equal(fallback.cannotDispatch(state,sol,'executor',now),true);
    assert.equal(fallback.cannotDispatch(state,sol,'supervisor',now),false,'the supervisor sends no workers');
    assert.equal(fallback.cannotDispatch(state,opus,'executor',now),false);
    assert.equal(fallback.next(sol,'executor',state,now),opus);
    const claudeOut={rateLimits:{...state.rateLimits,[fallback.limitKey('executor',opus)]:{until:now+3600000},[fallback.limitKey('executor','anthropic-apikey/claude-opus-5-5')]:{until:now+3600000}}};
    assert.equal(fallback.next(opus,'executor',claudeOut,now),apiSol,'the mainline goes to the OpenAI API Sol, not the subscription Sol');
    assert.equal(fallback.cannotDispatch({},sol,'executor',now),false,'with Terra serving the mainline stays');
  });}finally{fs.rmSync(home.root,{recursive:true,force:true});}
});

test('an API key out of balance is skipped by every role of every run, and only after five hours is it tried again',()=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'v1190-billing-')),usage=path.join(home,'usage.jsonl');
  try{withEnv({LONG_TASK_HOME:home,OPENCODEX_USAGE_FILE:usage},()=>{
    fs.writeFileSync(usage,JSON.stringify({conversationId:'unrelated',status:200})+'\n');
    const threads=[{role:'executor',threadId:'executor-qa'}],state={},now=Date.now();
    fallback.scan(state,threads);
    // The 2026-11-27 usage row, trimmed to what the watcher reads.
    line(usage,{conversationId:fallback.hashId('executor-qa'),timestamp:now,provider:'openai-apikey',model:'gpt-6.2-sol',requestedModel:apiSol,
      status:429,errorCode:'rate_limit_exceeded',upstreamCondition:'billing_exhausted',failureCause:'rate-limit'});
    const [hit]=fallback.scan(state,threads);
    assert.equal(hit.billing,true);
    assert.equal(fallback.billingAccount(hit.model),'openai-apikey/');
    fallback.recordUnsupported('/runs/工區E','openai-apikey/',now,now+fallback.FALLBACK_MS,fallback.BILLING_BASIS);
    const other={routeOk:{[apiTerra]:now+1000}};
    assert.equal(fallback.syncUnsupported(other,'/runs/清票',now),true);
    for(const role of ['supervisor','executor','subagent'])for(const model of [apiSol,apiTerra])
      assert.equal(fallback.limited(other,model,now,role),true,role+' skips '+model);
    assert.equal(fallback.limited(other,sol,now,'executor'),false,'the subscription is another account');
    assert.equal(fallback.recovered({...other,routeRefused:{}},now+20*60000),false,'a later success does not end it early');
    assert.equal(fallback.limited(other,apiSol,now+fallback.FALLBACK_MS+1000,'executor'),false,'five hours on it is tried again');
    assert.match(fallback.switchReason(hit,opus,900000),/儲值用完/);
  });}finally{fs.rmSync(home,{recursive:true,force:true});}
});

test('a supervisor shared by two runs is moved by one watcher, and the other takes over once the first stops',()=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'v1190-owner-'));
  try{withEnv({LONG_TASK_HOME:home},()=>{
    const now=Date.now();
    assert.equal(fallback.supervisorOwner('/runs/工區D','supervisor-shared',now),true);
    assert.equal(fallback.supervisorOwner('/runs/清票','supervisor-shared',now+60000),false);
    assert.equal(fallback.supervisorOwner('/runs/工區D','supervisor-shared',now+120000),true,'the owner keeps it on every pass');
    assert.equal(fallback.supervisorOwner('/runs/清票','supervisor-other',now+120000),true,'another supervisor is another entry');
    assert.equal(fallback.supervisorOwner('/runs/清票','supervisor-shared',now+120000+10*60000),true,'ten quiet minutes and the other run takes it');
  });}finally{fs.rmSync(home,{recursive:true,force:true});}
});

test('prolite\'s main slot read without its upstream key is still one account with its pool slot',()=>{
  const now=Date.now(),week=Math.floor((now+2*86400000)/1000);
  const slot=extra=>({provider:'openai',label:'prolite',plan:'prolite',email:'j***y@xplorx.co',paused:false,quota:{weeklyPercent:4,weeklyResetAt:week},...extra});
  const reading={accounts:[slot({id:'__main__',autoSwitchThresholdOverride:95}),slot({id:'chatgpt-pool',upstreamAccountKey:'uai1_pro'}),
    {provider:'openai',id:'chatgpt-free',label:'free',plan:'free',email:'j***y@jjdigi.com.tw',upstreamAccountKey:'uai1_free',paused:false,quota:{}}]};
  const at=quota.evaluateOpenAI(reading,now);
  assert.deepEqual(at.accounts.map(account=>[account.label,account.line]),[['prolite',95],['free',null]]);
  const twoAccounts={accounts:[slot({id:'a',upstreamAccountKey:'uai1_a'}),slot({id:'b',upstreamAccountKey:'uai1_b'})]};
  assert.equal(quota.evaluateOpenAI(twoAccounts,now).accounts.length,2,'two upstream keys stay two accounts');
});

test('a collect result JSON the mainline writes is the dispatch tool\'s data, and other JSON is still configuration',()=>{
  const result='{\n  "status": {\n    "list": "completed",\n    "handle": "/root/v14",\n    "evidence": ["/tmp/v14.log"]\n  }\n}';
  const added=(file,body)=>'*** Add File: '+file+'\n'+body.split('\n').map(text=>'+'+text).join('\n')+'\n';
  // 14:28 工區 E: the patch was a template string in an exec cell.
  const cell={type:'custom_tool_call',name:'exec',input:'const patch = \x60*** Begin Patch\n'+added('/tmp/c16-result.json',result)+added('/repo/config/app.json','{"port":1}')+
    '*** Update File: /repo/src/x.ts\n@@\n-a\n+b\n*** End Patch\x60;\nawait tools.apply_patch(patch);'};
  assert.deepEqual(clock.selfWorkOf(cell).map(hit=>hit.item),['/repo/config/app.json','/repo/src/x.ts']);
  const direct={type:'function_call',name:'apply_patch',arguments:JSON.stringify({input:'*** Begin Patch\n'+added('/tmp/c20-result.json','{"verdict":{"kind":"adopt"}}')+'*** End Patch'})};
  assert.deepEqual(clock.selfWorkOf(direct),[]);
  const claude=require(path.join(claudeScripts,'activity-correlation.cjs'));
  const write=(file,content)=>({type:'tool_use',id:'t1',name:'Write',input:{file_path:file,content}});
  assert.equal(claude.selfWorkOf(write('/tmp/c16-result.json',result)),null);
  assert.deepEqual(claude.selfWorkOf(write('/repo/package.json','{"name":"x"}')),{kind:'edit',item:'/repo/package.json'});
});

// A watcher replayed on a chat it has just switched: the record, the rollout and the usage are the test's own.
function watched({record,setTo,turnModel,laterTurn=null,aboveCurrent=false,extraEnv={}}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'v1190-watch-')),now=Date.now();
  const home=path.join(root,'codex-home'),source=path.join(root,'source.txt');fs.writeFileSync(source,'Keep the work moving\n');
  const contract={goal:'Finish',authorization:'Isolated QA',criteria:[{id:'A1',requirement:'Keep work moving',source:'source.txt:1',verify:'Replay'}],sources:[{path:source,sha256:sha(source)}]};
  const run=path.join(root,'run');fs.mkdirSync(run);save(path.join(run,'contract.json'),contract);
  const binding={platform:'codex',projectRoot:root,allowedRoots:[root,run],supervisorId:'supervisor-qa',executorId:'executor-qa',callerTurnId:'supervisor-turn',
    contractSha256:sha(path.join(run,'contract.json')),createdAt:iso(now-60000)};
  save(path.join(run,'binding.json'),binding);
  const catalog=catalogHome();
  // Every stop of the executor's order above the chat's current model is out, as at 14:0x.
  const stops=withEnv(catalog.env,()=>fallback.chainFor('executor')),limited=aboveCurrent?stops.slice(0,stops.indexOf(record.current)):[];
  save(path.join(run,'daemon-state.json'),{phase:'starting',cursor:null,seen:[],messages:[],pending:null,inflight:null,reads:0,starts:0,
    lastExecutorActivityAt:now,lastProgressReviewAt:now,
    rateLimits:Object.fromEntries(limited.map(model=>[fallback.limitKey('executor',model),{since:now-60000,until:now+3600000,model,basis:'replay',files:[]}])),modelSwitch:record?{'executor-qa':{...record,since:now-30000,until:now+3600000}}:{}});
  const dir=path.join(home,'sessions',...new Date().toLocaleDateString('en-CA').split('-'));fs.mkdirSync(dir,{recursive:true});
  const executorLog=path.join(dir,'rollout-t-executor-qa.jsonl');
  line(executorLog,{timestamp:iso(now-60000),type:'session_meta',payload:{id:'executor-qa'}});
  line(executorLog,{timestamp:iso(now-50000),type:'turn_context',payload:{turn_id:'old-turn',model:turnModel,effort:'xhigh',approval_policy:'never',approvals_reviewer:'user'}});
  line(executorLog,{timestamp:iso(now-30000),type:'event_msg',payload:{type:'thread_settings_applied',thread_settings:{model:setTo,approval_policy:'never'}}});
  line(executorLog,{timestamp:iso(now-29000),type:'event_msg',payload:{type:'task_complete',turn_id:'old-turn'}});
  // A turn the chat started after the switch, on the model laterTurn names.
  if(laterTurn){
    line(executorLog,{timestamp:iso(now-20000),type:'turn_context',payload:{turn_id:'new-turn',model:laterTurn,effort:'xhigh',approval_policy:'never',approvals_reviewer:'user'}});
    line(executorLog,{timestamp:iso(now-15000),type:'event_msg',payload:{type:'task_complete',turn_id:'new-turn'}});
  }
  const sent=path.join(root,'sent.json'),mockFile=path.join(root,'mock.json'),usage=path.join(root,'usage.jsonl');
  fs.writeFileSync(usage,JSON.stringify({conversationId:'unrelated',status:200})+'\n');
  save(mockFile,{supervisorId:binding.supervisorId,executorId:binding.executorId,noTurn:true});
  const env={...process.env,...catalog.env,CODEX_HOME:home,CODEX_APP_TOOLS_SERVER_PATH:path.join(__dirname,'mock-codex-app-server.cjs'),MOCK_CODEX_FIXTURE:mockFile,MOCK_CODEX_SENT:sent,
    OPENCODEX_USAGE_FILE:usage,OPENCODEX_QUOTA_FILE:path.join(root,'quota.json'),CHROME_RELAY_BIN:path.join(root,'no-relay'),CODEX_WATCH_IDLE_SLEEP_MS:'200',...extraEnv};
  delete env.CODEX_THREAD_ID;delete env.LONG_TASK_HOME;
  let child;
  return {run,usage,statePath:path.join(run,'daemon-state.json'),
    start(){child=spawn(process.execPath,[path.join(scripts,'native-watch.cjs'),run],{env,stdio:['ignore','pipe','pipe']});},
    calls(){const file=sent+'.args.json';return fs.existsSync(file)?read(file):[];},
    async stop(){if(child?.exitCode===null){child.kill('SIGTERM');await new Promise(resolve=>child.once('exit',resolve));}fs.rmSync(root,{recursive:true,force:true});fs.rmSync(catalog.root,{recursive:true,force:true});}};
}
const request=(model,status,extra={})=>({conversationId:fallback.hashId('executor-qa'),timestamp:Date.now(),requestedModel:model,model,status,...extra});

// v1.20.0 (Jay 2026-11-27 decision 44): whether a switch took is read from the chat's own turn, not from failed requests
// or from the time that passes.
test('a turn started after the switch on the old model means the switch did not take: it is sent again once for that turn',async()=>{
  const f=watched({record:{role:'executor',original:opus,from:sol,current:terra,effort:'xhigh',restored:null},setTo:terra,turnModel:sol,laterTurn:sol,aboveCurrent:true});
  try{
    f.start();
    await until(()=>f.calls().some(call=>/重送換模型通知（第 1 次）/.test(call.prompt||'')));
    const resent=f.calls().find(call=>/重送換模型通知/.test(call.prompt||''));
    assert.equal(resent.model,terra);
    assert.match(resent.prompt,new RegExp('新回合仍用 '+sol));
    await delay(1000);
    assert.equal(f.calls().filter(call=>/重送換模型通知/.test(call.prompt||'')).length,1,'one turn on the old model, one resend');
    assert.equal(read(f.statePath).rateLimits[fallback.limitKey('executor',terra)],undefined,'Terra is not paused for it');
  }finally{await f.stop();}
});

test('a turn started after the switch on the new model marks it taken, and nothing is judged by the time that passes',async()=>{
  const f=watched({record:{role:'executor',original:opus,from:sol,current:terra,effort:'xhigh',restored:null},setTo:terra,turnModel:sol,laterTurn:terra,aboveCurrent:true});
  try{
    f.start();
    await until(()=>read(f.statePath).modelSwitch['executor-qa'].takenAt);
    await delay(1000);
    assert.ok(!f.calls().some(call=>call.model),'no notice for a switch that took');
    assert.equal(read(f.statePath).rateLimits[fallback.limitKey('executor',terra)],undefined);
  }finally{await f.stop();}
});

test('a billing_exhausted refusal moves the mainline off the API at once and is kept for every run',async()=>{
  const f=watched({record:null,setTo:apiSol,turnModel:apiSol});
  try{
    f.start();
    await until(()=>read(f.statePath).usageOffset!==undefined);
    line(f.usage,request(apiSol,429,{errorCode:'rate_limit_exceeded',upstreamCondition:'billing_exhausted',failureCause:'rate-limit'}));
    await until(()=>f.calls().some(call=>call.model));
    const notice=f.calls().find(call=>call.model);
    assert.match(notice.prompt,/儲值用完/);
    assert.ok(!notice.model.startsWith('openai-apikey/'),'not to another model on the same key');
    const state=read(f.statePath);
    for(const side of ['supervisor','executor'])assert.equal(state.rateLimits[side+'|openai-apikey/']?.basis,fallback.BILLING_BASIS,side);
    assert.equal(read(path.join(f.run,'model-unavailable.json'))['openai-apikey/'].basis,fallback.BILLING_BASIS,'shared with the other runs');
  }finally{await f.stop();}
});


// v1.20.0 (decision 44): the target answers one request through OpenCodex before a chat is switched to it. A local
// server stands in for OpenCodex, answering as the 2026-11-27 15:46 test did: a completed stream for a model that
// serves, a failed stream naming credit_balance_exhausted for the OpenAI API Sol, and a 429 for a model out of quota.
function probeServer(answer){
  const http=require('node:http'),asked=[];
  const server=http.createServer((req,res)=>{
    let body='';req.on('data',chunk=>body+=chunk);
    req.on('end',()=>{
      const model=JSON.parse(body).model;asked.push(model);
      const [status,rows]=answer(model);
      res.writeHead(status,{'content-type':status===200?'text/event-stream':'application/json'});
      res.end(status===200?rows.map(row=>'event: '+row.type+'\ndata: '+JSON.stringify(row)+'\n\n').join(''):JSON.stringify(rows));
    });
  });
  return new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve({asked,url:'http://127.0.0.1:'+server.address().port+'/v1/responses',close:()=>new Promise(done=>server.close(done))})));
}
const completed=[{type:'response.created'},{type:'response.completed',response:{status:'completed'}}];
const outOfBalance=[{type:'response.created'},{type:'response.failed',response:{error:{code:'credit_balance_exhausted',message:'Your credit balance is too low'}}}];

test('a probe passes only on a completed stream, keeps the provider code of a failure, and is asked once a minute',async()=>{
  const probes=require(path.join(scripts,'route-probe.cjs'));
  const server=await probeServer(model=>model===apiSol?[200,outOfBalance]:[200,completed]);
  const run=fs.mkdtempSync(path.join(os.tmpdir(),'v1200-probe-')),old=process.env.LONG_TASK_PROBE_URL;
  process.env.LONG_TASK_PROBE_URL=server.url;
  try{
    const now=Date.now();
    assert.equal((await probes.probe(opus,run,now)).ok,true);
    assert.equal((await probes.probe(opus,run,now+30000)).ok,true);
    assert.deepEqual(server.asked,[opus],'a second probe within the minute reads the first answer');
    const refused=await probes.probe(apiSol,run,now);
    assert.deepEqual([refused.ok,refused.status,refused.code],[false,200,'credit_balance_exhausted'],'HTTP 200 alone is not a pass');
    assert.equal(probes.failedRecently(apiSol,run,now+30000),true);
    assert.equal(probes.failedRecently(apiSol,run,now+probes.PROBE_TTL_MS),false,'after a minute it is asked again');
    assert.equal(probes.failedRecently(opus,run,now),false);
    await probes.probe(opus,run,now+probes.PROBE_TTL_MS);
    assert.deepEqual(server.asked,[opus,apiSol,opus]);
  }finally{
    if(old===undefined)delete process.env.LONG_TASK_PROBE_URL;else process.env.LONG_TASK_PROBE_URL=old;
    await server.close();fs.rmSync(run,{recursive:true,force:true});
  }
});

test('a mainline left on Sonnet comes back to Opus, the first stop of its role',async()=>{
  const f=watched({record:null,setTo:sonnet,turnModel:sonnet});
  try{
    f.start();
    await until(()=>f.calls().some(call=>call.model));
    const notice=f.calls().find(call=>call.model);
    assert.equal(notice.model,opus);
    assert.match(notice.prompt,new RegExp(sonnet+' 不在本角色的順位上'));
    assert.equal(read(f.statePath).modelSwitch['executor-qa'].original,opus);
  }finally{await f.stop();}
});

test('a target that fails its probe is never switched to: it is recorded as refused and the next stop is taken',async()=>{
  const server=await probeServer(model=>model===opus?[429,{error:{type:'rate_limit_error',message:'usage limit reached'}}]:[200,completed]);
  const f=watched({record:null,setTo:sonnet,turnModel:sonnet,extraEnv:{LONG_TASK_PROBE_URL:server.url}});
  try{
    const stops=withEnv(catalogHome().env,()=>fallback.chainFor('executor'));
    f.start();
    await until(()=>f.calls().some(call=>call.model));
    const notices=f.calls().filter(call=>call.model);
    assert.ok(notices.every(call=>call.model!==opus),'no switch is sent to the model that failed');
    assert.equal(notices[0].model,stops.find(model=>model!==opus));
    assert.ok(server.asked.indexOf(opus)<server.asked.indexOf(notices[0].model),'Opus was asked first');
    assert.ok(read(f.statePath).rateLimits[fallback.limitKey('executor',opus)]?.until>Date.now(),'the refusal pauses Opus for this role');
  }finally{await f.stop();await server.close();}
});
