// v1.21.4 (Jay 2026-11-28「A，放寬子代理跟主線同家的限制，做成 v1.21.4 發版，背景程式加檢查 plaintext 設定還開著」).
// With OpenCodex's experimental plaintextV2AgentMessages on, a mainline on the ChatGPT subscription and a worker of any
// other provider read each other's task and messages (2026-11-28 00:16: Opus to the subscription Terra and the
// subscription Sol to DeepSeek both passed). What each test pins:
// - while the running OpenCodex says the setting is on, a mainline on the ChatGPT subscription dispatches on the
//   subagent order like any other mainline, and never strands for want of the subscription Terra;
// - while it is off or cannot be read, decision 37 comes back: only the subscription Terra, and the mainline moves on
//   once that Terra cannot serve (a task the worker cannot read stops the mainline's turn);
// - the setting is read with every quota reading from the running proxy, and a restart of OpenCodex is read at once;
// - the supervisor hears once when it goes off and once when it is back.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const scripts=process.env.CODEX_SUPERVISOR_SCRIPTS||path.resolve(__dirname,'../codex/.agents/skills/long-task-supervisor/scripts');
const fallback=require(path.join(scripts,'model-fallback.cjs'));
const route=require(path.join(scripts,'model-route.cjs'));
const quota=require(path.join(scripts,'claude-quota.cjs'));
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const save=(file,value)=>fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n');
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const peek=file=>{try{return read(file);}catch{return null;}};
const line=(file,value)=>fs.appendFileSync(file,JSON.stringify(value)+'\n');
const iso=ms=>new Date(ms).toISOString();
const opus='anthropic/claude-opus-5-5',sonnet='anthropic/claude-sonnet-5-5',sol='gpt-6.2-sol',terra='gpt-6.1-terra';
const catalogFixture=path.join(__dirname,'fixtures/model-routing-catalog.json');
const DAY=86400000;
async function until(check,ms=20000){const end=Date.now()+ms;while(Date.now()<end){if(check())return;await new Promise(resolve=>setTimeout(resolve,50));}throw Error('Timed out');}
async function withEnv(values,fn){
  const old=Object.fromEntries(Object.keys(values).map(key=>[key,process.env[key]]));
  for(const [key,value] of Object.entries(values))if(value===undefined)delete process.env[key];else process.env[key]=value;
  try{return await fn();}finally{for(const [key,value] of Object.entries(old))if(value===undefined)delete process.env[key];else process.env[key]=value;}
}
// One Max 20x account barely used: ladder step 0, nothing moves for the quota.
const reading=(plaintext)=>({accounts:[{provider:'anthropic',label:'jay@xplorx.co',plan:'max_20x',paused:false,
  quota:{weeklyPercent:5,weeklyResetAt:Date.now()+2*DAY,fiveHourPercent:0,fiveHourResetAt:Date.now()+3600000}}],
  ...(plaintext===undefined?{}:{plaintextAgentMessages:plaintext})});
const subagentCatalog=[sonnet,terra].map(id=>({id,efforts:['low','medium','high','xhigh']}));
const ask=(executorModel,fallbackFile)=>route.resolve({supervisorModel:opus,executorModel,roles:['general'],catalogs:{subagent:subagentCatalog},fallback:fallbackFile}).roles.general;

test('with the setting on, a mainline on the ChatGPT subscription dispatches on the subagent order; off or unknown, only the subscription Terra',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'v1214-route-')),file=path.join(root,'model-fallback.json');
  try{await withEnv({OPENCODEX_MODEL_CATALOG:catalogFixture,OPENCODEX_HOME:path.join(root,'opencodex')},()=>{
    save(file,{limits:{},ladder:{floors:{subagent:0}},plaintextAgentMessages:{enabled:true}});
    assert.deepEqual([ask(sol,file).model,ask(sol,file).basis],[sonnet,'role-policy'],'a Sol mainline sends Sonnet, the first stop of the subagent order');
    assert.equal(ask(terra,file).model,sonnet);
    for(const plain of [{enabled:false},{enabled:null},undefined]){
      save(file,{limits:{},ladder:{floors:{subagent:0}},...(plain?{plaintextAgentMessages:plain}:{})});
      assert.deepEqual([ask(sol,file).model,ask(sol,file).basis],[terra,'subscription-mainline'],JSON.stringify(plain));
    }
    assert.equal(ask(opus,file).model,sonnet,'an Opus mainline keeps the subagent order either way');
    // The watcher's side: no stranded mainline while the setting is on.
    const now=Date.now(),limits={[fallback.limitKey('subagent',terra)]:{since:now-60000,until:now+3600000,model:terra}};
    assert.equal(fallback.cannotDispatch({rateLimits:limits,claudeQuota:{plaintext:{enabled:true}}},sol,'executor',now),false);
    assert.equal(fallback.cannotDispatch({rateLimits:limits,claudeQuota:{plaintext:{enabled:false}}},sol,'executor',now),true);
    assert.equal(fallback.cannotDispatch({rateLimits:limits},sol,'executor',now),true,'before the first reading the rule of decision 37 holds');
  });}finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('the running OpenCodex is asked with every reading, a restart is read at once, and model-fallback.json shows the answer',async()=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'v1214-read-'))),home=path.join(root,'opencodex'),data=path.join(root,'status.json'),calls=path.join(root,'calls.jsonl');
  fs.mkdirSync(home);fs.writeFileSync(path.join(home,'ocx.pid'),'100\n');save(data,{plaintext:true});
  const accounts=reading().accounts,bin=path.join(root,'ocx');
  // A stand-in ocx: account list answers the quota, agent status the running proxy's settings.
  fs.writeFileSync(bin,'#!'+process.execPath+'\n'+
    "const fs=require('fs');fs.appendFileSync("+JSON.stringify(calls)+",JSON.stringify(process.argv.slice(2))+'\\n');"+
    "if(process.argv[2]==='agent'){console.log(JSON.stringify({v2:{plaintextAgentMessagesEnabled:JSON.parse(fs.readFileSync("+JSON.stringify(data)+",'utf8')).plaintext}}));process.exit(0);}"+
    "const provider=process.argv[4];console.log(JSON.stringify({accounts:"+JSON.stringify(accounts)+".filter(a=>a.provider===provider),notes:[]}));\n");
  fs.chmodSync(bin,0o755);
  try{await withEnv({LONG_TASK_CLAUDE_QUOTA_FILE:undefined,OPENCODEX_OCX_BIN:bin,OPENCODEX_HOME:home,OPENCODEX_MODEL_CATALOG:catalogFixture,
    LONG_TASK_TEMP_ROOT:path.join(root,'elsewhere'),LONG_TASK_ACCOUNT_STOPS_FILE:path.join(root,'stops.json'),LONG_TASK_HOME:path.join(root,'lt-home')},async()=>{
    const state={},run=path.join(root,'run');fs.mkdirSync(run);
    await quota.refresh(state,Date.now(),run);
    assert.ok(fs.readFileSync(calls,'utf8').includes('["agent","status","--json"]'));
    assert.equal(quota.crossFamily(state),true);
    fallback.publish(run,state,Date.now());
    let published=read(path.join(run,'model-fallback.json'));
    assert.equal(published.plaintextAgentMessages.enabled,true);
    assert.equal(published.subscriptionMainlineWorker,undefined,'no Terra-only worker while the setting is on');
    assert.match(published.rule,/不論主線用哪一家/);
    // The setting turned off and OpenCodex restarted: the next pass reads it without waiting 30 minutes.
    save(data,{plaintext:false});
    assert.equal(await quota.refresh(state,Date.now()+1000,run),false,'the proxy unchanged, the reading is not due');
    assert.equal(quota.crossFamily(state),true);
    fs.writeFileSync(path.join(home,'ocx.pid'),'200\n');
    assert.equal(await quota.refresh(state,Date.now()+2000,run),true,'a restart is a change of the decision');
    assert.equal(quota.crossFamily(state),false);
    fallback.publish(run,state,Date.now());
    published=read(path.join(run,'model-fallback.json'));
    assert.equal(published.subscriptionMainlineWorker,terra);
    assert.match(published.plaintextAgentMessages.summary,/ocx config set plaintextV2AgentMessages true/);
    // An ocx that cannot answer counts as off.
    fs.writeFileSync(bin,'#!'+process.execPath+'\nprocess.exit(1);\n');
    await quota.refresh(state,Date.now()+3000,run,{force:true});
    assert.equal(state.claudeQuota.plaintext.enabled,null);
    assert.equal(quota.crossFamily(state),false);
  });}finally{fs.rmSync(root,{recursive:true,force:true});}
});

function fixture(quotaFile){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'v1214-watch-')));
  const home=path.join(root,'codex-home'),source=path.join(root,'source.txt');fs.writeFileSync(source,'Keep the work moving\n');
  const contract={goal:'Finish',authorization:'Isolated QA',criteria:[{id:'A1',requirement:'Keep work moving',source:'source.txt:1',verify:'Replay'}],sources:[{path:source,sha256:sha(source)}]};
  const run=path.join(root,'run');fs.mkdirSync(run);save(path.join(run,'contract.json'),contract);
  const binding={platform:'codex',projectRoot:root,allowedRoots:[root,run],supervisorId:'supervisor-qa',executorId:'executor-qa',callerTurnId:'supervisor-turn',
    contractSha256:sha(path.join(run,'contract.json')),createdAt:iso(Date.now()-60000),modelPolicy:'automatic'};
  save(path.join(run,'binding.json'),binding);
  save(path.join(run,'daemon-state.json'),{phase:'starting',cursor:null,seen:[],messages:[],pending:null,inflight:null,reads:0,starts:0,
    lastExecutorActivityAt:Date.now(),lastProgressReviewAt:Date.now()});
  const now=new Date(),dir=path.join(home,'sessions',String(now.getFullYear()),String(now.getMonth()+1).padStart(2,'0'),String(now.getDate()).padStart(2,'0'));
  fs.mkdirSync(dir,{recursive:true});
  for(const id of ['executor-qa','supervisor-qa']){
    const log=path.join(dir,'rollout-t-'+id+'.jsonl');
    line(log,{timestamp:binding.createdAt,type:'session_meta',payload:{id}});
    line(log,{timestamp:binding.createdAt,type:'turn_context',payload:{turn_id:id+'-turn',model:opus,effort:'xhigh',approval_policy:'never'}});
  }
  const sent=path.join(root,'sent.json'),mockFile=path.join(root,'mock.json'),usage=path.join(root,'usage.jsonl'),opencodex=path.join(root,'opencodex');
  fs.mkdirSync(opencodex);save(path.join(opencodex,'config.json'),{revision:1});
  fs.writeFileSync(usage,JSON.stringify({conversationId:'unrelated',status:200})+'\n');
  save(mockFile,{supervisorId:binding.supervisorId,executorId:binding.executorId,noTurn:true});
  const env={...process.env,CODEX_HOME:home,CODEX_APP_TOOLS_SERVER_PATH:path.join(__dirname,'mock-codex-app-server.cjs'),MOCK_CODEX_FIXTURE:mockFile,MOCK_CODEX_SENT:sent,
    OPENCODEX_MODEL_CATALOG:catalogFixture,OPENCODEX_USAGE_FILE:usage,OPENCODEX_QUOTA_FILE:path.join(root,'quota-cache.json'),OPENCODEX_HOME:opencodex,
    CHROME_RELAY_BIN:path.join(root,'no-relay'),CODEX_WATCH_IDLE_SLEEP_MS:'200',CODEX_SUPERVISOR_DECISION_POLL_MS:'100',LONG_TASK_HOME:path.join(root,'long-task-home'),
    LONG_TASK_CLAUDE_QUOTA_FILE:quotaFile};
  delete env.CODEX_THREAD_ID;delete env.CODEX_TURN_ID;
  let child;
  return {root,run,opencodex,statePath:path.join(run,'daemon-state.json'),
    start(){child=spawn(process.execPath,[path.join(scripts,'native-watch.cjs'),run],{env,stdio:['ignore','pipe','pipe']});},
    calls(){const file=sent+'.args.json';return fs.existsSync(file)?read(file):[];},
    async stop(){if(child?.exitCode===null){child.kill('SIGTERM');await new Promise(resolve=>child.once('exit',resolve));}fs.rmSync(root,{recursive:true,force:true});}};
}

test('the supervisor hears once when the setting goes off and once when it is back, and nothing while it stays on',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'v1214-quota-')),quotaFile=path.join(dir,'quota.json');
  save(quotaFile,reading(true));
  const f=fixture(quotaFile);
  const told=pattern=>f.calls().filter(call=>call.threadId==='supervisor-qa'&&pattern.test(call.prompt||''));
  // The quota file counts as the reading; a change of OpenCodex's config.json makes the watcher read it again.
  const flip=(value,revision)=>{save(quotaFile,reading(value));save(path.join(f.opencodex,'config.json'),{revision});};
  try{
    f.start();
    await until(()=>peek(f.statePath)?.plaintextSeen===true);
    await new Promise(resolve=>setTimeout(resolve,800));
    assert.equal(told(/LONG_TASK_PLAINTEXT/).length,0,'on from the start: nothing to say');
    flip(false,2);
    await until(()=>told(/LONG_TASK_PLAINTEXT_OFF/).length===1);
    assert.match(told(/LONG_TASK_PLAINTEXT_OFF/)[0].prompt,/只能用 Terra 訂閱/);
    assert.equal(peek(path.join(f.run,'model-fallback.json'))?.subscriptionMainlineWorker,terra);
    flip(false,3);
    await new Promise(resolve=>setTimeout(resolve,1000));
    assert.equal(told(/LONG_TASK_PLAINTEXT_OFF/).length,1,'still off: told once');
    flip(true,4);
    await until(()=>told(/LONG_TASK_PLAINTEXT_ON/).length===1);
  }finally{await f.stop();fs.rmSync(dir,{recursive:true,force:true});}
});

