// v1.15.0 (Jay 2026-11-25): Jay resumed the OpenAI subscription for his own voice use, and the long tasks moved onto
// it at once and used its last few percent. What each test pins: the subscription is skipped by every role once every
// account he has not paused is down to its last 2%, without pausing anything in OpenCodex; the OpenAI API key comes
// right after the subscription on both sides; every reading refreshes the subscription quota first; and another
// conversation's success never brings the subscription back. v1.18.0 (Jay 2026-11-26 decisions 19, 20 and 24): the
// supervisor and the executor share Opus → Opus API → Sol → Sol API → Terra → Terra API, workers keep their own order
// whatever the mainline runs, and this reading (8.2% available, step 6) also keeps the executor off its two Claude stops.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const scripts=process.env.CODEX_SUPERVISOR_SCRIPTS||path.resolve(__dirname,'../codex/.agents/skills/long-task-supervisor/scripts');
const quota=require(path.join(scripts,'claude-quota.cjs'));
const fallback=require(path.join(scripts,'model-fallback.cjs'));
const route=require(path.join(scripts,'model-route.cjs'));
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const save=(file,value)=>fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n');
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const peek=file=>{try{return read(file);}catch{return null;}};
const line=(file,value)=>fs.appendFileSync(file,JSON.stringify(value)+'\n');
const iso=ms=>new Date(ms).toISOString();
const MINUTE=60000,HOUR=60*MINUTE,DAY=24*HOUR;
const opus='anthropic/claude-opus-5-5',paid='anthropic-apikey/claude-opus-5-5',sonnet='anthropic/claude-sonnet-5-5';
const sol='gpt-6.10-sol',terra='gpt-6.1-terra',apiSol='openai-apikey/gpt-6.10-sol',apiTerra='openai-apikey/gpt-6.1-terra';
async function until(check,ms=15000){const end=Date.now()+ms;while(Date.now()<end){if(check())return;await new Promise(resolve=>setTimeout(resolve,50));}throw Error('Timed out');}
function withEnv(values,fn){
  const old=Object.fromEntries(Object.keys(values).map(key=>[key,process.env[key]]));
  for(const [key,value] of Object.entries(values))if(value===undefined)delete process.env[key];else process.env[key]=value;
  const restore=()=>{for(const [key,value] of Object.entries(old))if(value===undefined)delete process.env[key];else process.env[key]=value;};
  try{const result=fn();if(result?.then)return result.finally(restore);restore();return result;}catch(error){restore();throw error;}
}
// The local catalog with the openai-apikey provider Jay added on 2026-11-25.
function catalogFile(dir){
  const file=path.join(dir,'catalog.json');
  save(file,{models:[opus,paid,sonnet,'anthropic-apikey/claude-sonnet-5-5',sol,terra,apiSol,apiTerra].map(slug=>({slug,visibility:'list'}))});
  return file;
}
// The 2026-11-25 10:05 reading: prolite at 99% of its week (the main slot and a pool slot are one account, resets in
// seconds), the free account paused by Jay, and the Claude accounts below the reserve kept for the supervisor.
function reading(now,{prolite=99,free=3,freePaused=true}={}){
  const week=Math.floor((now+2*DAY)/1000);
  return {accounts:[
    {provider:'anthropic',label:'jay@xplorx.co',plan:'max_20x',paused:false,quota:{weeklyPercent:95,weeklyResetAt:now+4*DAY}},
    {provider:'openai',id:'__main__',label:'prolite',plan:'prolite',upstreamAccountKey:'uai1_pro',paused:false,quota:{weeklyPercent:prolite,weeklyResetAt:week}},
    {provider:'openai',id:'chatgpt-pool',label:'prolite',plan:'prolite',upstreamAccountKey:'uai1_pro',paused:false,quota:{weeklyPercent:prolite,weeklyResetAt:week}},
    {provider:'openai',id:'chatgpt-free',label:'free',plan:'free',upstreamAccountKey:'uai1_free',paused:freePaused,quota:{monthlyPercent:free,monthlyResetAt:Math.floor((now+20*DAY)/1000)}}]};
}

test('the OpenAI subscription is held once every account Jay has not paused has 2% or less left, and an unreadable account keeps it in use',()=>{
  const now=Date.now();
  const today=quota.evaluateOpenAI(reading(now),now);
  assert.deepEqual([today.held,today.accounts.length,today.accounts[0].remaining],[true,1,1],'the main and pool slot of one account count once');
  assert.equal(today.resetAt,Math.floor((now+2*DAY)/1000)*1000,'OpenAI resets come in seconds');
  assert.equal(quota.evaluateOpenAI(reading(now,{prolite:98}),now).held,true,'exactly 2% left is held');
  assert.equal(quota.evaluateOpenAI(reading(now,{prolite:97}),now).held,false,'3% left is still used');
  assert.equal(quota.evaluateOpenAI(reading(now,{freePaused:false}),now).held,false,'a resumed account with quota left serves the long tasks');
  const unknown=reading(now);for(const a of unknown.accounts)if(a.provider==='openai')a.quota={};
  assert.equal(quota.evaluateOpenAI(unknown,now).held,false);
  assert.equal(quota.evaluateOpenAI({error:'ocx failed'},now).held,false);
  const past=reading(now);for(const a of past.accounts)if(a.provider==='openai')a.quota.weeklyResetAt=Math.floor((now-MINUTE)/1000);
  assert.equal(quota.evaluateOpenAI(past,now).held,false,'a week that already ended is not current');
  assert.match(quota.describeOpenAI({openai:today}),/prolite 剩 1%.*留給你自己用/);
});

test('every reading refreshes the Claude and OpenAI subscription quota first, reads again a minute after the OpenAI reset and pauses nothing for the floor',async()=>{
  const now=Date.now(),root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'openai-floor-')));
  const calls=path.join(root,'calls.jsonl'),bin=path.join(root,'ocx'),data=path.join(root,'reading.json');
  save(data,reading(now));
  fs.writeFileSync(bin,'#!'+process.execPath+'\n'+
    "const fs=require('fs');fs.appendFileSync("+JSON.stringify(calls)+",JSON.stringify(process.argv.slice(2))+'\\n');"+
    "const all=JSON.parse(fs.readFileSync("+JSON.stringify(data)+",'utf8'));const provider=process.argv[4];"+
    "console.log(JSON.stringify({accounts:all.accounts.filter(a=>a.provider===provider),notes:[]}));\n");
  fs.chmodSync(bin,0o755);
  try{
    const state={};
    await withEnv({LONG_TASK_CLAUDE_QUOTA_FILE:undefined,OPENCODEX_OCX_BIN:bin,LONG_TASK_TEMP_ROOT:path.join(root,'elsewhere'),
      LONG_TASK_ACCOUNT_STOPS_FILE:path.join(root,'stops.json')},()=>quota.refresh(state,now,path.join(root,'run')));
    const argv=fs.readFileSync(calls,'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(argv.map(a=>a.join(' ')).sort(),['account list anthropic --quota --refresh --json','account list openai --quota --refresh --json']);
    assert.ok(!argv.some(a=>a[1]==='pause'),'nothing is paused in OpenCodex for the floor');
    assert.equal(state.claudeQuota.openai.held,true);
    assert.equal(quota.openaiHeld(state),true);
    const reset=Math.floor((now+2*DAY)/1000)*1000;
    assert.equal(quota.nextReadAt({nextResetAt:reset},reset-10*MINUTE),reset+MINUTE);
    assert.equal(state.claudeQuota.nextResetAt,reset,'the OpenAI reset is one of the resets read at once');
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('both mainline roles put the OpenAI API right after each OpenAI subscription stop, workers keep their own order, and the floor skips only the subscription',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'openai-chain-'));
  try{
    withEnv({OPENCODEX_MODEL_CATALOG:catalogFile(dir),LONG_TASK_HOME:dir,OPENCODEX_HOME:path.join(dir,'no-opencodex')},()=>{
      for(const role of ['supervisor','executor'])assert.deepEqual(fallback.chainFor(role),[opus,paid,sol,apiSol,terra,apiTerra],role);
      for(const mainline of [sol,apiSol,opus])assert.deepEqual(fallback.chainFor('subagent'),[sonnet,'anthropic-apikey/claude-sonnet-5-5',terra,apiTerra],'workers of '+mainline);
      const now=Date.now(),state={claudeQuota:{step:0,openai:quota.evaluateOpenAI(reading(now),now)}};
      for(const role of ['supervisor','executor','subagent'])assert.equal(fallback.limited(state,sol,now,role),true,role+' skips the subscription Sol');
      assert.equal(fallback.limited(state,terra,now,'subagent'),true);
      assert.equal(fallback.limited(state,apiSol,now,'executor'),false);
      assert.equal(fallback.limited(state,opus,now,'executor'),false,'the OpenAI floor does not touch the Claude stops');
      // With the Claude API out for the month the supervisor's next stop after Opus passes the held subscription Sol.
      state.apiMonth={until:now+DAY};
      assert.equal(fallback.next(opus,'supervisor',state),apiSol);
      // Jay's voice, or any other conversation, keeps using the subscription: its success never lifts the floor.
      state.rateLimits={};state.routeOk={[sol]:now};state.routeRefused={};
      fallback.recovered(state,now+HOUR);
      assert.equal(fallback.limited(state,sol,now+HOUR,'executor'),true);
      state.claudeQuota.openai=quota.evaluateOpenAI(reading(now,{prolite:10}),now);
      assert.equal(fallback.limited(state,sol,now,'executor'),false,'back once a reading shows the account can serve again');
    });
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('model-route gives the executor the API Sol at the floor and workers the API Terra once the Sonnet stops are gone, never a subscription Terra',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'openai-route-'));
  const file=path.join(dir,'model-fallback.json');
  const efforts=['low','medium','high','xhigh','max'],inventory=[sol,terra,apiSol,apiTerra].map(id=>({id,efforts}));
  // The executor is kept off its two Claude stops (ladder step 6) and the OpenAI subscription is out.
  save(file,{limits:{},ladder:{floors:{executor:2,subagent:2}},openaiQuota:{subscriptionHeld:true}});
  try{
    const executor=route.resolve({supervisorModel:opus,roles:['executor'],fallback:file,catalogs:{executor:inventory}});
    assert.equal(executor.roles.executor.model,apiSol);
    const workers=route.resolve({supervisorModel:opus,executorModel:apiSol,roles:['general'],fallback:file,catalogs:{subagent:inventory}});
    assert.deepEqual([workers.roles.general.model,workers.roles.general.effort],[apiTerra,'medium'],'workers of '+apiSol);
    // A mainline still on the subscription Sol can hand work only to the subscription Terra, which is out: it waits for
    // the watcher to move it (2026-11-27 decision 37).
    assert.equal(route.resolve({supervisorModel:opus,executorModel:sol,roles:['general'],fallback:file,catalogs:{subagent:inventory}}).roles.general.status,'unavailable');
    save(file,{limits:{},ladder:{floors:{executor:2,subagent:2}},openaiQuota:{subscriptionHeld:false}});
    assert.equal(route.resolve({supervisorModel:opus,roles:['executor'],fallback:file,catalogs:{executor:inventory}}).roles.executor.model,sol);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

function fixture({executorModel=sol,supervisorModel=opus,quotaData}){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'codex-v115-')));
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
  for(const [id,model] of [['executor-qa',executorModel],['supervisor-qa',supervisorModel]]){
    const log=path.join(dir,'rollout-t-'+id+'.jsonl');
    line(log,{timestamp:binding.createdAt,type:'session_meta',payload:{id}});
    line(log,{timestamp:binding.createdAt,type:'turn_context',payload:{turn_id:id+'-turn',model,effort:'high',approval_policy:'never'}});
  }
  const sent=path.join(root,'sent.json'),mockFile=path.join(root,'mock.json'),usage=path.join(root,'usage.jsonl'),quotaFile=path.join(root,'quota.json');
  fs.writeFileSync(usage,JSON.stringify({conversationId:'unrelated',status:200})+'\n');
  save(quotaFile,quotaData);
  save(mockFile,{supervisorId:binding.supervisorId,executorId:binding.executorId,noTurn:true});
  const env={...process.env,CODEX_HOME:home,CODEX_APP_TOOLS_SERVER_PATH:path.join(__dirname,'mock-codex-app-server.cjs'),MOCK_CODEX_FIXTURE:mockFile,MOCK_CODEX_SENT:sent,
    OPENCODEX_MODEL_CATALOG:catalogFile(root),OPENCODEX_USAGE_FILE:usage,OPENCODEX_QUOTA_FILE:path.join(root,'quota-cache.json'),OPENCODEX_HOME:path.join(root,'opencodex'),
    CHROME_RELAY_BIN:path.join(root,'no-relay'),CODEX_WATCH_IDLE_SLEEP_MS:'200',CODEX_SUPERVISOR_DECISION_POLL_MS:'100',LONG_TASK_HOME:path.join(root,'long-task-home'),
    LONG_TASK_CLAUDE_QUOTA_FILE:quotaFile};
  delete env.CODEX_THREAD_ID;delete env.CODEX_TURN_ID;
  let child;
  return {run,statePath:path.join(run,'daemon-state.json'),
    start(){child=spawn(process.execPath,[path.join(scripts,'native-watch.cjs'),run],{env,stdio:['ignore','pipe','pipe']});return child;},
    calls(){const file=sent+'.args.json';return fs.existsSync(file)?read(file):[];},
    async stop(){if(child?.exitCode===null){child.kill('SIGTERM');await new Promise(resolve=>child.once('exit',resolve));}fs.rmSync(root,{recursive:true,force:true});}};
}

test('at the OpenAI floor and ladder step 6 the executor on the subscription Sol moves to the API Sol and the supervisor on Opus to the API Terra',async()=>{
  const f=fixture({quotaData:reading(Date.now())});
  try{
    f.start();
    await until(()=>f.calls().some(c=>c.threadId==='executor-qa'&&c.model));
    const moved=f.calls().find(c=>c.threadId==='executor-qa'&&c.model);
    assert.deepEqual([moved.model,moved.thinking],[apiSol,'high']);
    assert.match(moved.prompt,/OpenAI 訂閱留給 Jay 自己用（prolite 剩 1%/);
    // Off the ChatGPT subscription the workers follow their own order again, so the move is told (2026-11-27 decision 37).
    assert.match(moved.prompt,/新派子代理照 model-fallback.json 的子代理順位/);
    const record=read(f.statePath).modelSwitch['executor-qa'];
    // Every mainline comes back to the first stop of its role (Jay 2026-11-27), so it climbs back up the order after the reset.
    assert.deepEqual([record.original,record.current],[opus,apiSol]);
    const published=read(path.join(f.run,'model-fallback.json'));
    assert.deepEqual(published.chain.executor.slice(2,4),[sol,apiSol]);
    assert.equal(published.openaiQuota.subscriptionHeld,true);
    // The supervisor steps down two steps before the executor: four stops off, and the subscription Terra is out too.
    await until(()=>f.calls().some(c=>c.threadId==='supervisor-qa'&&c.model));
    assert.equal(f.calls().find(c=>c.threadId==='supervisor-qa'&&c.model).model,apiTerra);
    await until(()=>{try{return /OpenAI 訂閱額度：prolite 剩 1%/.test(fs.readFileSync(path.join(f.run,'監督儀表板.md'),'utf8'));}catch{return false;}});
    await new Promise(resolve=>setTimeout(resolve,1200));
    assert.equal(f.calls().filter(c=>c.threadId==='executor-qa'&&c.model).length,1,'told once');
  }finally{await f.stop();}
});

