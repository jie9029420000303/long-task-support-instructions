// v1.12.0 (Jay 2026-11-21「開工」): the model order runs in the watcher, so it keeps working without a model deciding
// when to switch. What each test pins: the Claude subscription is kept for the Opus supervisor (weighted weekly
// remainder below 35%, or every usable account at 80% of its five hours, moves the executor to Sol), the executor never
// uses the Claude API, the API month cap learned by one run holds for every run, a run of non-quota failures moves a
// route, and an acceptance written by an interim open-source supervisor waits for a high-tier review.
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
const opus='anthropic/claude-opus-5-5',paid='anthropic-apikey/claude-opus-5-5',sonnet='anthropic/claude-sonnet-5-5',sol='gpt-6.10-sol';
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
function reading(now,{big=100,small=1,bigFive=0,smallFive=24,bigFiveReset=now+3*HOUR,smallFiveReset=now+2*HOUR}={}){
  return {accounts:[
    {provider:'anthropic',label:'jay@xplorx.co',plan:'max_20x',paused:false,quota:{weeklyPercent:big,weeklyResetAt:now+2*DAY,fiveHourPercent:bigFive,fiveHourResetAt:bigFiveReset}},
    {provider:'anthropic',label:'jay@jjdigi.com.tw',plan:'max_5x',paused:false,quota:{weeklyPercent:small,weeklyResetAt:now+5*DAY,fiveHourPercent:smallFive,fiveHourResetAt:smallFiveReset}},
    {provider:'anthropic',label:'paused-1',plan:'max_20x',paused:true,quota:{weeklyPercent:0,weeklyResetAt:now+DAY}},
    {provider:'anthropic',label:'paused-2',plan:'max_20x',paused:true,quota:{}},
    {provider:'openai',label:'not-claude',plan:'pro',paused:false,quota:{weeklyPercent:99,weeklyResetAt:now+DAY}}]};
}

test('the reserve weighs Max 20x four times Max 5x, counts a used-up account at 0% and leaves paused accounts out',()=>{
  const now=Date.now();
  const today=quota.evaluate(reading(now),now);
  assert.equal(today.weeklyRemaining,19.8,'(0×4 + 99×1) ÷ 5, Q52 A');
  assert.deepEqual([today.allowed,today.hold,today.excludedPaused],[false,'weekly',2]);
  assert.equal(quota.evaluate(reading(now,{big:99}),now).weeklyRemaining,20.6,'no jump when the account reaches 100%');
  const edge=quota.evaluate(reading(now,{big:81}),now);
  assert.deepEqual([edge.weeklyRemaining,edge.allowed],[35,true],'exactly 35% still lets the executor use Sonnet');
  const under=quota.evaluate(reading(now,{big:82}),now);
  assert.deepEqual([under.weeklyRemaining,under.hold],[34.2,'weekly']);
  const unreadable=reading(now,{big:0});delete unreadable.accounts[0].quota.weeklyPercent;
  assert.equal(quota.evaluate(unreadable,now).weeklyRemaining,19.8,'an unreadable account is never taken to have quota left');
  const stale=reading(now,{big:0});stale.accounts[0].quota.weeklyResetAt=now-MINUTE;
  assert.equal(quota.evaluate(stale,now).weeklyRemaining,19.8,'a reading whose week already ended is not current');
  const nothing=quota.evaluate({error:'ocx failed'},now);
  assert.deepEqual([nothing.weeklyRemaining,nothing.hold,nothing.allowed],[null,'unknown',false]);
  assert.match(quota.describe(today),/19\.8%.*保留 35% 給監督.*執行端改用 Sol/);
});

test('the five-hour guard moves the executor when every account that can serve is at 80%, except within 30 minutes of a reset',()=>{
  const now=Date.now(),full={big:0,small:0};
  const busy=quota.evaluate(reading(now,{...full,bigFive:80,smallFive:85}),now);
  assert.deepEqual([busy.weeklyRemaining,busy.hold,busy.allowed],[100,'five-hour',false]);
  assert.equal(busy.fiveHourResetAt,now+2*HOUR,'the first account to reset ends the hold');
  assert.equal(quota.evaluate(reading(now,{...full,bigFive:79,smallFive:99}),now).allowed,true,'one account under 80% can still serve');
  const near=reading(now,{...full,bigFive:90,smallFive:90,smallFiveReset:now+20*MINUTE});
  assert.equal(quota.evaluate(near,now).allowed,true,'20 minutes before a reset the executor stays where it is');
  assert.equal(quota.evaluate(near,now,{hold:'five-hour'}).hold,'five-hour','once moved it stays until that reset');
});

test('quota is read every 30 minutes and once just after an account reset; a test run without a named source never asks OpenCodex',async()=>{
  const now=Date.now(),root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'claude-quota-')));
  try{
    assert.equal(quota.nextReadAt({nextResetAt:now+10*MINUTE},now),now+11*MINUTE);
    assert.equal(quota.nextReadAt({nextResetAt:now+2*HOUR},now),now+30*MINUTE);
    const temp={};
    await withEnv({LONG_TASK_CLAUDE_QUOTA_FILE:undefined,LONG_TASK_TEMP_ROOT:undefined},()=>quota.refresh(temp,now,path.join(root,'run')));
    assert.deepEqual([temp.claudeQuota.unconfigured,temp.claudeQuota.allowed],[true,true]);
    assert.equal(quota.temporary(path.join(root,'run')),true);assert.equal(quota.temporary(path.join(os.homedir(),'run')),false);
    const file=path.join(root,'quota.json');save(file,reading(now));
    const state={};
    await withEnv({LONG_TASK_CLAUDE_QUOTA_FILE:file},async()=>{
      assert.equal(await quota.refresh(state,now),true);
      assert.equal(state.claudeQuota.weeklyRemaining,19.8);
      save(file,reading(now,{big:0}));
      assert.equal(await quota.refresh(state,now+MINUTE),false,'no second read before it is due');
      assert.equal(await quota.refresh(state,state.claudeQuota.nextReadAt),true);
      assert.equal(state.claudeQuota.allowed,true);
      fs.unlinkSync(file);
      await quota.refresh(state,state.claudeQuota.nextReadAt);
      assert.deepEqual([state.claudeQuota.hold,state.claudeQuota.allowed],['unknown',false],'a failed read does not keep the last good answer');
      assert.ok(state.claudeQuota.error);
    });
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('only the supervisor has the Claude API in its order, and a month cap learned by one run is skipped by every run',()=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'api-month-'));
  try{
    withEnv({OPENCODEX_MODEL_CATALOG:catalogFixture,LONG_TASK_HOME:home},()=>{
      assert.deepEqual(fallback.chainFor(opus,'supervisor'),[opus,paid,sol]);
      assert.deepEqual(fallback.chainFor(sonnet,'executor'),[sonnet,sol]);
      assert.deepEqual(fallback.chainFor(opus,'executor'),[opus,sol],'a manual Opus executor still skips the API');
      assert.deepEqual(fallback.chainFor(sonnet,'subagent',sonnet),[sonnet]);
      const first={},second={},until=Date.now()+9*DAY;
      fallback.recordApiMonth(first,path.join(home,'run-a'),until,'錯誤訊息寫明的恢復時間');
      assert.equal(read(path.join(home,'anthropic-api-month.json')).until,until);
      assert.equal(fallback.syncApiMonth(second,path.join(home,'run-b')),true);
      assert.equal(second.apiMonth.until,until);
      assert.equal(fallback.next(opus,opus,'supervisor',second),sol,'the other run goes from Opus straight to Sol');
      assert.equal(fallback.next(opus,opus,'supervisor',{}),paid,'without the cap the API comes next');
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

function fixture({executorModel=sonnet,supervisorModel=opus,quotaData=null,env:extra={}}={}){
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

test('below the reserve the executor first stops new Claude subagents, then moves to Sol with Terra workers; the supervisor keeps Opus',async()=>{
  const f=fixture({quotaData:reading(Date.now())});
  try{
    f.agent('worker-a',sonnet);
    f.start();
    await until(()=>f.calls().some(c=>c.threadId==='executor-qa'&&/LONG_TASK_QUOTA_RESERVE：/.test(c.prompt)));
    const notice=f.calls().find(c=>/LONG_TASK_QUOTA_RESERVE：/.test(c.prompt));
    assert.ok(!notice.model,'the notice leaves the mainline model alone while its Claude worker finishes');
    assert.match(notice.prompt,/19\.8%.*先停派新的 Claude 子代理/);
    const publishedFile=path.join(f.run,'model-fallback.json');
    await until(()=>peek(publishedFile)?.claudeQuota);
    const published=read(publishedFile);
    assert.deepEqual([published.claudeQuota.executorMayUseClaude,published.claudeQuota.weeklyRemaining],[false,19.8]);
    assert.ok(!published.chain.executor.some(model=>model.startsWith('anthropic-apikey/')));
    assert.ok(!f.calls().some(c=>c.threadId==='executor-qa'&&c.model));
    f.agent('worker-a',sonnet,{done:true});
    await until(()=>f.calls().some(c=>c.threadId==='executor-qa'&&c.model===sol));
    const moved=f.calls().find(c=>c.model===sol);
    assert.match(moved.prompt,/Claude 訂閱保留給監督/);assert.match(moved.prompt,/最新 Terra/);
    assert.equal(read(f.statePath).modelSwitch['executor-qa'].original,sonnet);
    assert.ok(!f.calls().some(c=>c.threadId==='supervisor-qa'&&c.model),'the reserve is for the supervisor: it is never moved by it');
    await until(()=>/Claude 訂閱額度：可用帳號週剩餘加權 19\.8%/.test(fs.readFileSync(path.join(f.run,'監督儀表板.md'),'utf8')));
  }finally{await f.stop();}
});

test('a Claude worker that keeps running holds the move at most for the drain time, and at the reserve the executor stays on Sonnet',async()=>{
  const slow=fixture({quotaData:reading(Date.now()),env:{LONG_TASK_QUOTA_DRAIN_MS:'1500'}});
  const kept=fixture({quotaData:reading(Date.now(),{big:81})});
  try{
    slow.agent('worker-b',sonnet);
    slow.start();kept.start();
    await until(()=>slow.calls().some(c=>c.threadId==='executor-qa'&&c.model===sol));
    await until(()=>read(kept.statePath).reads>=4);
    assert.ok(!kept.calls().some(c=>c.model),'35% left: no switch');
    assert.equal(read(path.join(kept.run,'model-fallback.json')).claudeQuota.executorMayUseClaude,true);
  }finally{await slow.stop();await kept.stop();}
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
test('a mainline a model left on an open-source route climbs back by the order: the executor to Sol below the reserve or Sonnet at it, the supervisor to Opus',async()=>{
  const muse='openrouter/meta-muse-ember';
  const low=fixture({executorModel:muse,quotaData:reading(Date.now())});
  const kept=fixture({executorModel:muse,supervisorModel:muse,quotaData:reading(Date.now(),{big:81})});
  try{
    low.start();kept.start();
    await until(()=>low.calls().some(c=>c.threadId==='executor-qa'&&c.model));
    const moved=low.calls().find(c=>c.threadId==='executor-qa'&&c.model);
    assert.deepEqual([moved.model,moved.thinking],[sol,'high'],'below the reserve: Sol at the executor High, not the open-source max');
    assert.match(moved.prompt,/開源模型只在前面順位都不能用時使用/);assert.match(moved.prompt,/最新 Terra/);
    const record=read(low.statePath).modelSwitch['executor-qa'];
    assert.deepEqual([record.original,record.current,record.restored],[sonnet,sol,null],'kept as a move away from Sonnet, so it returns when the reserve allows');
    assert.ok(!low.calls().some(c=>c.threadId==='supervisor-qa'&&c.model),'a supervisor already on Opus is left alone');
    await until(()=>['executor-qa','supervisor-qa'].every(id=>kept.calls().some(c=>c.threadId===id&&c.model)));
    const executor=kept.calls().find(c=>c.threadId==='executor-qa'&&c.model),supervisor=kept.calls().find(c=>c.threadId==='supervisor-qa'&&c.model);
    assert.deepEqual([executor.model,executor.thinking],[sonnet,'high'],'at the reserve the executor goes straight to Sonnet');
    assert.deepEqual([supervisor.model,supervisor.thinking],[opus,'xhigh'],'an open-source supervisor without its own refusal goes back to Opus');
    await until(()=>peek(kept.statePath)?.modelSwitch?.['supervisor-qa']?.restored).catch(()=>{});
    assert.ok(read(kept.statePath).modelSwitch['supervisor-qa'].restored,'back on the first stop: nothing is left to restore');
  }finally{await low.stop();await kept.stop();}
});
