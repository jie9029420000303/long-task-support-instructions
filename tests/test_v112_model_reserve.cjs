// v1.12.0 (Jay 2026-11-21「開工」): the model order runs in the watcher, so it keeps working without a model deciding
// when to switch. v1.18.0 (Jay 2026-11-26 decisions 19, 20, 24, 25 and 29) replaced the 35% reserve for the supervisor
// with one step-down ladder: the Agent's available share of the subscriptions (stop lines kept for Jay) sets a step
// every 7 points under 50%, the subagents step down first, the supervisor two steps later and the executor two after
// that, so the roles that matter most keep the front of their order longest. What each test pins: the share and its
// steps, the five-hour step, the reading schedule, the shared mainline order with the Claude API on it, the API month
// cap held for every run, a run of non-quota failures moving a route, and an acceptance written by an interim
// open-source supervisor waiting for a high-tier review.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawn,execFileSync}=require('node:child_process');
const scripts=process.env.CODEX_SUPERVISOR_SCRIPTS||path.resolve(__dirname,'../codex/.agents/skills/long-task-supervisor/scripts');
const quota=require(path.join(scripts,'claude-quota.cjs'));
const fallback=require(path.join(scripts,'model-fallback.cjs'));
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const save=(file,value)=>fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n');
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const line=(file,value)=>fs.appendFileSync(file,JSON.stringify(value)+'\n');
const iso=ms=>new Date(ms).toISOString();
const opus='anthropic/claude-opus-5-5',paid='anthropic-apikey/claude-opus-5-5',sonnet='anthropic/claude-sonnet-5-5',sol='gpt-6.10-sol',terra='gpt-6.1-terra';
const catalogFixture=path.join(__dirname,'fixtures/model-routing-catalog.json');
const MINUTE=60000,HOUR=60*MINUTE,DAY=24*HOUR;
async function until(check,ms=15000){const end=Date.now()+ms;while(Date.now()<end){if(check())return;await new Promise(resolve=>setTimeout(resolve,50));}throw Error('Timed out');}
// The watcher records a sent message before it writes what follows from it, so a file read at once may be missing or half written.
const peek=file=>{try{return read(file);}catch{return null;}};
function withEnv(values,fn){
  const old=Object.fromEntries(Object.keys(values).map(key=>[key,process.env[key]]));
  for(const [key,value] of Object.entries(values))if(value===undefined)delete process.env[key];else process.env[key]=value;
  const restore=()=>{for(const [key,value] of Object.entries(old))if(value===undefined)delete process.env[key];else process.env[key]=value;};
  try{const result=fn();if(result?.then)return result.finally(restore);restore();return result;}catch(error){restore();throw error;}
}
// The 2026-11-21 12:48 reading: jay@xplorx.co (Max 20x) used up until 11/23, jjdigi (Max 5x) at 1%, two Max 20x paused.
// That is 19.8% available, ladder step 5; big:61 gives 51%, step 0.
function reading(now,{big=100,small=1,bigFive=0,smallFive=24,bigFiveReset=now+3*HOUR,smallFiveReset=now+2*HOUR}={}){
  return {accounts:[
    {provider:'anthropic',label:'jay@xplorx.co',plan:'max_20x',paused:false,quota:{weeklyPercent:big,weeklyResetAt:now+2*DAY,fiveHourPercent:bigFive,fiveHourResetAt:bigFiveReset}},
    {provider:'anthropic',label:'jay@jjdigi.com.tw',plan:'max_5x',paused:false,quota:{weeklyPercent:small,weeklyResetAt:now+5*DAY,fiveHourPercent:smallFive,fiveHourResetAt:smallFiveReset}},
    {provider:'anthropic',label:'paused-1',plan:'max_20x',paused:true,quota:{weeklyPercent:0,weeklyResetAt:now+DAY}},
    {provider:'anthropic',label:'paused-2',plan:'max_20x',paused:true,quota:{}},
    // Not a Claude account; well above the OpenAI floor (v1.15.0), so the subscription Sol stays usable here.
    {provider:'openai',label:'not-claude',plan:'pro',paused:false,quota:{weeklyPercent:10,weeklyResetAt:now+DAY}}]};
}

test('the available share weighs Max 20x four times Max 5x, keeps what lies above a stop line for Jay and sets one step per 7 points under 50%',()=>{
  const now=Date.now();
  const today=quota.evaluate(reading(now),now);
  assert.deepEqual([today.available,today.step,today.excludedPaused],[19.8,5,2],'(0×4 + 99×1) ÷ 5 is below 50, 43, 36, 29 and 22');
  assert.equal(quota.evaluate(reading(now,{big:99}),now).available,20.6,'no jump when the account reaches 100%');
  // A stop line of 60 on the Max 20x: only the 60 below it is the Agent's, so 30 used leaves half of its share.
  const lined=reading(now,{big:30});lined.accounts[0].autoSwitchThresholdOverride=60;
  assert.equal(quota.evaluate(lined,now).available,64.4,'(4×30 + 1×99) ÷ (4×60 + 1×100)');
  assert.deepEqual([50,49.9,43,42.9,1,0.9,null].map(quota.stepOf),[0,1,1,2,7,8,8],'thresholds 50 43 36 29 22 15 8 1; nothing readable is the bottom step');
  const unreadable=reading(now,{big:0});delete unreadable.accounts[0].quota.weeklyPercent;
  assert.equal(quota.evaluate(unreadable,now).available,19.8,'an unreadable account is never taken to have quota left');
  const stale=reading(now,{big:0});stale.accounts[0].quota.weeklyResetAt=now-MINUTE;
  assert.equal(quota.evaluate(stale,now).available,19.8,'a reading whose week already ended is not current');
  assert.equal(quota.evaluate({error:'ocx failed'},now).available,null);
  // Each role keeps away from as many stops as its step: the subagents k, the supervisor k−2, the executor k−4.
  assert.deepEqual(['subagent','supervisor','executor'].map(role=>quota.floorOf(today,role)),[5,3,1]);
  assert.deepEqual(['subagent','supervisor','executor'].map(role=>quota.floorOf({step:3},role)),[3,1,0]);
  assert.match(quota.describe(today),/19\.8%.*降級第 5 階.*子代理退 5 站、監督退 3 站、執行主線退 1 站/);
});

test('the five-hour step lowers the ladder one step when every account that can serve is at 80%, except within 30 minutes of a reset',()=>{
  const now=Date.now(),full={big:0,small:0};
  const busy=quota.evaluate(reading(now,{...full,bigFive:80,smallFive:85}),now);
  assert.deepEqual([busy.available,busy.step,busy.fiveHourStep],[100,1,true],'subagents give way first, as on the ladder');
  assert.equal(busy.fiveHourResetAt,now+2*HOUR,'the first account to reset ends the extra step');
  assert.equal(quota.evaluate(reading(now,{...full,bigFive:79,smallFive:99}),now).step,0,'one account under 80% can still serve');
  const near=reading(now,{...full,bigFive:90,smallFive:90,smallFiveReset:now+20*MINUTE});
  assert.equal(quota.evaluate(near,now).step,0,'20 minutes before a reset nothing moves');
  assert.equal(quota.evaluate(near,now,{fiveHourStep:true}).step,1,'once moved it stays until that reset');
});

test('quota is read every 30 minutes and once just after an account reset; a test run without a named source never asks OpenCodex',async()=>{
  const now=Date.now(),root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'claude-quota-')));
  try{
    assert.equal(quota.nextReadAt({nextResetAt:now+10*MINUTE},now),now+11*MINUTE);
    assert.equal(quota.nextReadAt({nextResetAt:now+2*HOUR},now),now+30*MINUTE);
    const temp={};
    await withEnv({LONG_TASK_CLAUDE_QUOTA_FILE:undefined,LONG_TASK_TEMP_ROOT:undefined},()=>quota.refresh(temp,now,path.join(root,'run')));
    assert.deepEqual([temp.claudeQuota.unconfigured,quota.step(temp)],[true,0]);
    assert.equal(quota.temporary(path.join(root,'run')),true);assert.equal(quota.temporary(path.join(os.homedir(),'run')),false);
    const file=path.join(root,'quota.json');save(file,reading(now));
    const state={};
    await withEnv({LONG_TASK_CLAUDE_QUOTA_FILE:file},async()=>{
      assert.equal(await quota.refresh(state,now),true);
      assert.deepEqual([state.claudeQuota.available,state.claudeQuota.step],[19.8,5]);
      save(file,reading(now,{big:0}));
      assert.equal(await quota.refresh(state,now+MINUTE),false,'no second read before it is due');
      assert.equal(await quota.refresh(state,state.claudeQuota.nextReadAt),true);
      assert.equal(state.claudeQuota.step,0);
      fs.unlinkSync(file);
      await quota.refresh(state,state.claudeQuota.nextReadAt);
      assert.deepEqual([state.claudeQuota.available,state.claudeQuota.step],[null,8],'a failed read does not keep the last good answer');
      assert.ok(state.claudeQuota.error);
    });
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('the supervisor and the executor share one order with the Claude API on it, and a month cap learned by one run is skipped by every run',()=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'api-month-'));
  try{
    withEnv({OPENCODEX_MODEL_CATALOG:catalogFixture,LONG_TASK_HOME:home},()=>{
      for(const role of ['supervisor','executor'])assert.deepEqual(fallback.chainFor(role),[opus,paid,sol,terra],role);
      assert.deepEqual(fallback.chainFor('subagent'),[sonnet,'anthropic-apikey/claude-sonnet-5-5',terra],'workers have the Claude API too');
      const first={},second={},until=Date.now()+9*DAY;
      fallback.recordApiMonth(first,path.join(home,'run-a'),until,'錯誤訊息寫明的恢復時間');
      assert.equal(read(path.join(home,'anthropic-api-month.json')).until,until);
      assert.equal(fallback.syncApiMonth(second,path.join(home,'run-b')),true);
      assert.equal(second.apiMonth.until,until);
      for(const role of ['supervisor','executor'])assert.equal(fallback.next(opus,role,second),sol,'the other run goes from Opus straight to Sol');
      assert.equal(fallback.next(opus,'executor',{}),paid,'without the cap the API comes next');
      assert.equal(fallback.syncApiMonth(second,path.join(home,'run-b'),until+1),true);assert.equal(second.apiMonth,undefined,'it ends at the named reset');
    });
  }finally{fs.rmSync(home,{recursive:true,force:true});}
});

test('a run of three non-quota failures over at least a minute moves a route; cancellations and a success in between do not',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'route-failures-')),usage=path.join(root,'usage.jsonl'),id=fallback.hashId('executor-qa');
  const threads=[{role:'executor',threadId:'executor-qa'}],t0=Date.now()-2*MINUTE,row=(at,status)=>line(usage,{conversationId:id,timestamp:at,requestedModel:sol,status});
  try{
    fs.writeFileSync(usage,'');
    withEnv({OPENCODEX_USAGE_FILE:usage},()=>{
      const state={};fallback.scan(state,threads);
      row(t0,500);row(t0+20000,502);row(t0+30000,500);
      assert.deepEqual(fallback.scan(state,threads),[],'three failures within 30 seconds can be one outage blip');
      row(t0+70000,500);
      const hits=fallback.scan(state,threads);
      assert.equal(hits.length,1);assert.deepEqual([hits[0].failure,hits[0].model,hits[0].role],[true,sol,'executor']);
      const other={};fallback.scan(other,threads);
      row(t0+80000,499);row(t0+90000,499);row(t0+100000,499);row(t0+110000,499);
      assert.deepEqual(fallback.scan(other,threads),[],'a cancelled request is not a failure');
      row(t0+111000,500);row(t0+112000,200);row(t0+113000,500);row(t0+180000,500);
      assert.deepEqual(fallback.scan(other,threads),[],'a success clears the count');
    });
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

// 2026-11-23 15:30:43～15:34: Anthropic and OpenRouter failed together. 工區 E's supervisor got one 429 that OpenCodex
// wrote itself for a dropped connection and was taken off Opus on the 5-hour quota default; WebRPA's supervisor had six
// 502s, was paused for 30 minutes and ran a turn on Muse at 15:54 although Opus answered again from 15:34:04. At noon
// both supervisors had worked on DeepSeek for 28 and 37 minutes the same way. Jay's Q67 ruling (B): keep the move on
// consecutive failures, end the pause early by the existing route-recovery rule, and do not read that 429 as a refusal.
test('for the supervisor a 429 that OpenCodex writes for a dropped connection counts as a failure, not a refusal; the executor still moves on it',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'connection-reset-')),usage=path.join(root,'usage.jsonl'),reset='upstream_reset_replay_refused';
  const threads=[{role:'supervisor',threadId:'supervisor-qa'},{role:'executor',threadId:'executor-qa'}],t0=Date.now()-2*MINUTE;
  const row=(thread,at,status,errorCode,model=opus)=>line(usage,{conversationId:fallback.hashId(thread),timestamp:at,requestedModel:model,status,
    ...(errorCode?{errorCode}:{}),...(errorCode===reset?{terminalSource:'synthetic'}:{})});
  const seen=hits=>hits.map(hit=>[hit.role,hit.failure,hit.status]);
  try{
    fs.writeFileSync(usage,'');
    withEnv({OPENCODEX_USAGE_FILE:usage},()=>{
      const state={};fallback.scan(state,threads);
      row('supervisor-qa',t0,429,reset);
      assert.deepEqual(fallback.scan(state,threads),[],'one dropped connection does not move the supervisor');
      assert.equal(state.routeFailed['anthropic/'],t0,'it is kept as the time the route last failed');
      row('supervisor-qa',t0+20000,502);row('supervisor-qa',t0+70000,502);
      assert.deepEqual(seen(fallback.scan(state,threads)),[['supervisor',true,502]],'with two more failures over a minute it is a run of failures');
      row('executor-qa',t0+80000,429,reset,sol);
      assert.deepEqual(seen(fallback.scan(state,threads)),[['executor',undefined,429]],'the executor still takes it as a refusal and moves on');
      row('supervisor-qa',t0+90000,429,'usage_limit_reached');
      assert.deepEqual(seen(fallback.scan(state,threads)),[['supervisor',undefined,429]],'a real quota refusal still moves the supervisor at once');
    });
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('a supervisor failure pause ends once its route has been quiet for 10 minutes and has answered since; the executor pause keeps its 30 minutes',()=>{
  const t0=Date.now()-20*MINUTE,pause=basis=>({since:t0,until:t0+30*MINUTE,basis});
  const own='supervisor|anthropic/',executorKey=fallback.limitKey('executor',sol);
  const state={rateLimits:{[own]:pause(fallback.FAILURE_BASIS),[executorKey]:pause(fallback.FAILURE_BASIS)},
    routeFailed:{'anthropic/':t0+2*MINUTE,[sol]:t0,'anthropic-apikey/':t0},routeOk:{'anthropic/':t0+MINUTE,[sol]:t0+3*MINUTE,'anthropic-apikey/':t0+3*MINUTE}};
  assert.equal(fallback.recovered(state,t0+15*MINUTE),false,'its last success came before the route last failed');
  state.routeOk['anthropic/']=t0+3*MINUTE;
  assert.equal(fallback.recovered(state,t0+11*MINUTE),false,'answering again, but the route has not been quiet for 10 minutes');
  assert.equal(fallback.recovered(state,t0+12*MINUTE),true);
  assert.deepEqual(state.rateLimits[own],{since:t0,until:t0+12*MINUTE,basis:'同一路線之後已有成功請求'});
  assert.deepEqual(state.rateLimits[executorKey],pause(fallback.FAILURE_BASIS));
});

function fixture({executorModel=opus,supervisorModel=opus,quotaData=null,env:extra={}}={}){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'codex-v112-')));
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
  const log=id=>path.join(dir,'rollout-t-'+id+'.jsonl');
  for(const [id,model] of [['executor-qa',executorModel],['supervisor-qa',supervisorModel]]){
    line(log(id),{timestamp:binding.createdAt,type:'session_meta',payload:{id}});
    line(log(id),{timestamp:binding.createdAt,type:'turn_context',payload:{turn_id:id+'-turn',model,effort:'high',approval_policy:'never'}});
  }
  const sent=path.join(root,'sent.json'),mockFile=path.join(root,'mock.json'),usage=path.join(root,'usage.jsonl'),quotaFile=path.join(root,'claude-quota.json');
  fs.writeFileSync(usage,JSON.stringify({conversationId:'unrelated',status:200})+'\n');
  if(quotaData)save(quotaFile,quotaData);
  save(mockFile,{supervisorId:binding.supervisorId,executorId:binding.executorId,noTurn:true});
  const env={...process.env,CODEX_HOME:home,CODEX_APP_TOOLS_SERVER_PATH:path.join(__dirname,'mock-codex-app-server.cjs'),MOCK_CODEX_FIXTURE:mockFile,MOCK_CODEX_SENT:sent,
    OPENCODEX_MODEL_CATALOG:catalogFixture,OPENCODEX_USAGE_FILE:usage,OPENCODEX_QUOTA_FILE:path.join(root,'quota-cache.json'),OPENCODEX_HOME:path.join(root,'opencodex'),
    CHROME_RELAY_BIN:path.join(root,'no-relay'),CODEX_WATCH_IDLE_SLEEP_MS:'200',CODEX_SUPERVISOR_DECISION_POLL_MS:'100',LONG_TASK_HOME:path.join(root,'long-task-home'),
    ...(quotaData?{LONG_TASK_CLAUDE_QUOTA_FILE:quotaFile}:{}),...extra};
  delete env.CODEX_THREAD_ID;delete env.CODEX_TURN_ID;
  let child;
  return {root,run,log,env,mockFile,statePath:path.join(run,'daemon-state.json'),
    start(){child=spawn(process.execPath,[path.join(scripts,'native-watch.cjs'),run],{env,stdio:['ignore','pipe','pipe']});return child;},
    calls(){const file=sent+'.args.json';return fs.existsSync(file)?read(file):[];},
    agent(id,model,{done=false}={}){
      const file=path.join(dir,'rollout-t-'+id+'.jsonl'),at=iso(Date.now());
      if(!fs.existsSync(file)){
        line(file,{timestamp:at,type:'session_meta',payload:{id,thread_source:'subagent',parent_thread_id:'executor-qa',agent_path:'/root/'+id}});
        line(file,{timestamp:at,type:'turn_context',payload:{model,effort:'medium'}});
        line(file,{timestamp:at,type:'event_msg',payload:{type:'task_started',turn_id:id+'-turn'}});
      }
      if(done)line(file,{timestamp:at,type:'event_msg',payload:{type:'task_complete',turn_id:id+'-turn'}});
    },
    async stop(){if(child?.exitCode===null){child.kill('SIGTERM');await new Promise(resolve=>child.once('exit',resolve));}fs.rmSync(root,{recursive:true,force:true});}};
}

test('at ladder step 5 the supervisor moves three stops down to Terra and the executor one stop to the Opus API; at 51% nothing moves',async()=>{
  const low=fixture({quotaData:reading(Date.now())}),kept=fixture({quotaData:reading(Date.now(),{big:61})});
  try{
    low.start();kept.start();
    await until(()=>['executor-qa','supervisor-qa'].every(id=>low.calls().some(c=>c.threadId===id&&c.model)));
    const executor=low.calls().find(c=>c.threadId==='executor-qa'&&c.model),supervisor=low.calls().find(c=>c.threadId==='supervisor-qa'&&c.model);
    assert.equal(executor.model,paid,'the executor gives way last: only its first stop is off');
    assert.equal(supervisor.model,terra,'two steps ahead of the executor: Opus, the Opus API and Sol are off');
    for(const call of [executor,supervisor])assert.match(call.prompt,/降級階梯（Agent 可用量 19\.8%/);
    assert.equal(read(low.statePath).modelSwitch['executor-qa'].original,opus,'kept as a move away from Opus, so it returns when the share rises');
    const published=peek(path.join(low.run,'model-fallback.json'));
    assert.deepEqual([published.ladder.step,published.ladder.available],[5,19.8]);
    await until(()=>{try{return /訂閱額度降級階梯：Agent 可用量 19\.8%/.test(fs.readFileSync(path.join(low.run,'監督儀表板.md'),'utf8'));}catch{return false;}});
    await until(()=>read(kept.statePath).reads>=4);
    assert.ok(!kept.calls().some(c=>c.model),'51% left: no switch');
    assert.equal(read(path.join(kept.run,'model-fallback.json')).ladder.step,0);
  }finally{await low.stop();await kept.stop();}
});

test('an acceptance from an interim open-source supervisor is kept and sent again for a high-tier review before the run closes',async()=>{
  const muse='openrouter/meta-muse-ember',f=fixture({supervisorModel:muse,executorModel:sol});
  const keep=path.join(f.root,'candidate.txt'),manifest=path.join(f.root,'manifest.json');
  fs.writeFileSync(keep,'alpha\nbeta\n');save(manifest,{files:[{path:keep,sha256:sha(keep)}]});
  save(f.mockFile,{supervisorId:'supervisor-qa',executorId:'executor-qa',
    final:'QA result submitted.\nLONG_TASK_EVENT '+JSON.stringify({kind:'submission',revision:'sha256:'+sha(manifest),manifest})});
  const submit=()=>{
    const event=read(f.statePath).pending,file=path.join(f.run,'draft-decision-'+event.id+'.json');
    save(file,{eventId:event.id,disposition:'accept',revision:event.revision,
      results:[{id:'A1',status:'PASS',method:'Read exact bytes',expected:'alpha LF beta LF',actual:'alpha LF beta LF',evidence:[{path:keep,sha256:sha(keep)}]}]});
    return JSON.parse(execFileSync(process.execPath,[path.join(scripts,'supervise.cjs'),'decision',f.run,file],{env:f.env,encoding:'utf8'}));
  };
  try{
    f.start();
    await until(()=>read(f.statePath).pending?.kind==='submission'&&f.calls().some(c=>c.threadId==='supervisor-qa'));
    const id=read(f.statePath).pending.id;
    const interim=submit();
    assert.deepEqual([interim.held,interim.submitted],[true,false]);
    await until(()=>read(f.statePath).heldFinalReviews?.length===1&&!read(f.statePath).pending);
    assert.notEqual(read(f.statePath).phase,'accepted','an open-source acceptance never closes the run');
    assert.equal(fs.readFileSync(path.join(f.run,'held-acceptances.jsonl'),'utf8').trim().split('\n').length,1);
    await until(()=>/暫代監督保留的結案：1 件/.test(fs.readFileSync(path.join(f.run,'監督儀表板.md'),'utf8')));
    line(f.log('supervisor-qa'),{timestamp:iso(Date.now()),type:'turn_context',payload:{turn_id:'opus-turn',model:opus,effort:'xhigh'}});
    await until(()=>f.calls().some(c=>c.threadId==='supervisor-qa'&&/高階監督複驗/.test(c.prompt)));
    const review=f.calls().find(c=>/高階監督複驗/.test(c.prompt));
    assert.ok(review.prompt.includes(muse));assert.ok(review.prompt.includes('review-'+id+'-high-1'));
    await until(()=>read(f.statePath).pending?.id===id);
    const high=submit();
    assert.notEqual(high.held,true);
    await until(()=>read(f.statePath).phase==='accepted');
    const snapshot=read(path.join(f.run,read(path.join(f.run,'committed-decision-'+id+'.json')).snapshotName));
    assert.deepEqual([snapshot.reviewer.model,snapshot.reviewer.turnId],[opus,'opus-turn']);
  }finally{await f.stop();}
});

// WebRPA 2026-11-21: its executor sat on Muse, chosen by a model under the retired "Sol below 50%" rule, and the
// watcher had no switch of its own to undo, so the order was never applied. Open source is the last stop of both roles.
test('a mainline a model left on an open-source route climbs back by the order: the executor to the Opus API at step 5 or Opus at step 0, the supervisor to Opus',async()=>{
  const muse='openrouter/meta-muse-ember';
  const low=fixture({executorModel:muse,quotaData:reading(Date.now())});
  const kept=fixture({executorModel:muse,supervisorModel:muse,quotaData:reading(Date.now(),{big:61})});
  try{
    low.start();kept.start();
    await until(()=>low.calls().some(c=>c.threadId==='executor-qa'&&c.model));
    const moved=low.calls().find(c=>c.threadId==='executor-qa'&&c.model);
    assert.equal(moved.model,paid,'at step 5 the highest stop the executor may use');
    assert.match(moved.prompt,/開源模型只在前面順位都不能用時使用/);
    const record=read(low.statePath).modelSwitch['executor-qa'];
    assert.deepEqual([record.original,record.current,record.restored],[opus,paid,null],'kept as a move away from Opus, so it returns when the ladder allows');
    await until(()=>['executor-qa','supervisor-qa'].every(id=>kept.calls().some(c=>c.threadId===id&&c.model)));
    const executor=kept.calls().find(c=>c.threadId==='executor-qa'&&c.model),supervisor=kept.calls().find(c=>c.threadId==='supervisor-qa'&&c.model);
    assert.equal(executor.model,opus,'at step 0 the executor goes straight to Opus');
    assert.deepEqual([supervisor.model,supervisor.thinking],[opus,'xhigh'],'an open-source supervisor without its own refusal goes back to Opus');
    await until(()=>peek(kept.statePath)?.modelSwitch?.['supervisor-qa']?.restored).catch(()=>{});
    assert.ok(read(kept.statePath).modelSwitch['supervisor-qa'].restored,'back on the first stop: nothing is left to restore');
  }finally{await low.stop();await kept.stop();}
});

// 2026-11-23 工區 E: the supervisor was set back to Opus at 13:17 while a turn begun at 12:56 kept running on DeepSeek.
// The watcher read the running turn's model, took the chat for still left on open source, and sent the same notice 72
// times in 19 minutes until that turn ended. Jay: 「印出來的訊息要讓我知道重送原因，不然我會以為是死迴圈不斷傳訊息」.
test('a supervisor on an open-source route is told to move only when idle and once per turn, never when it is already set to move; a notice sent again says why',async()=>{
  const deepseek='openrouter/deepseek-deepseek-v4.1-flash-1017';
  const f=fixture({executorModel:sol,supervisorModel:deepseek,quotaData:reading(Date.now(),{big:61})});
  const turnEnded=path.join(f.root,'supervisor-turn-ended');
  save(f.mockFile,{...read(f.mockFile),supervisorCompletedGate:turnEnded});
  const notices=()=>f.calls().filter(c=>c.threadId==='supervisor-qa'&&c.model);
  const quiet=(ms=1500)=>new Promise(resolve=>setTimeout(resolve,ms));
  // A new turn writes its context and, right after it, what the chat is set to; both land in one write as in a real rollout.
  const turn=(n,model,set=model)=>fs.appendFileSync(f.log('supervisor-qa'),[{timestamp:iso(Date.now()),type:'turn_context',payload:{turn_id:'supervisor-turn-'+n,model,effort:'max'}},
    {timestamp:iso(Date.now()),type:'event_msg',payload:{type:'thread_settings_applied',thread_id:'supervisor-qa',thread_settings:{model:set}}}].map(row=>JSON.stringify(row)+'\n').join(''));
  try{
    f.start();
    await until(()=>peek(path.join(f.run,'model-fallback.json')));
    await quiet();
    assert.equal(notices().length,0,'the turn in progress keeps its model: nothing is sent into it');
    turn(1,deepseek,opus);
    await quiet();
    fs.writeFileSync(turnEnded,'');
    await quiet();
    assert.equal(notices().length,0,'already set to Opus from the next turn on: there is nothing to tell, during the turn or after it');
    turn(2,deepseek);
    await until(()=>notices().length===1);
    const first=notices()[0];
    assert.deepEqual([first.model,first.thinking],[opus,'xhigh']);
    assert.match(first.prompt,/開源模型只在前面順位都不能用時使用/);assert.doesNotMatch(first.prompt,/重送原因/);
    await quiet();
    assert.equal(notices().length,1,'told once: the same turn is not told again');
    turn(3,deepseek);
    await until(()=>notices().length===2);
    assert.match(notices()[1].prompt,/（第 2 次通知。重送原因：上一則在 \d\d\/\d\d \d\d:\d\d 送出，之後開始的新回合仍設定為 openrouter\/deepseek-deepseek-v4\.1-flash-1017。）$/);
    await quiet();
    assert.equal(notices().length,2,'a new turn still on open source is told once more, with the reason');
    turn(4,opus);
    await until(()=>!peek(f.statePath)?.strandedNotice?.['supervisor-qa']);
    await quiet(800);
    assert.equal(notices().length,2,'on Opus: nothing more to send');
  }finally{await f.stop();}
});

test('the watcher puts a supervisor moved for consecutive failures back on Opus once the connection answers again, without waiting out the 30 minutes',async()=>{
  const f=fixture({executorModel:sol,quotaData:reading(Date.now(),{big:61})});
  const usage=f.env.OPENCODEX_USAGE_FILE,own=fallback.hashId('supervisor-qa'),t0=Date.now()-14*MINUTE;
  const row=(at,status,conversationId=own)=>line(usage,{conversationId,timestamp:at,requestedModel:opus,status,...(status===200?{usage:{outputTokens:5}}:{})});
  const moves=()=>f.calls().filter(c=>c.threadId==='supervisor-qa'&&c.model);
  row(t0,502);row(t0+30000,502);row(t0+90000,502);
  try{
    f.start();
    await until(()=>moves().length===1);
    assert.equal(moves()[0].model,paid,'three failures over a minute: the supervisor moves to its next stop');
    const paused=read(f.statePath).rateLimits['supervisor|anthropic/'];
    assert.deepEqual([paused.basis,paused.until],[fallback.FAILURE_BASIS,t0+90000+30*MINUTE]);
    await new Promise(resolve=>setTimeout(resolve,1500));
    assert.equal(moves().length,1,'while Opus has not answered again the supervisor stays where it was moved');
    row(Date.now(),200,'another-chat');
    await until(()=>moves().length===2);
    assert.equal(moves()[1].model,opus,'the route last failed 12 minutes ago and has answered since: back to Opus 17 minutes before the pause would have ended');
    assert.equal(read(f.statePath).rateLimits['supervisor|anthropic/'].basis,'同一路線之後已有成功請求');
  }finally{await f.stop();}
});

