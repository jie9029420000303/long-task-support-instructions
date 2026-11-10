// v1.3.0 (Jay 2026-11-10). Each test pins the incident behind a rule: WEB idled 12 minutes beside 14 "blocked"
// packages, most only later in the plan; the OPS supervisor and executor wrote each other's guessed times, up to 97
// minutes ahead; a perl locale warning was stored as the time of Jay's words; and one OPS executor turn was too large
// for the App to return, so the watcher restarted 11 times.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawn,execFileSync}=require('node:child_process');
const X=path.resolve(__dirname,'../codex/.agents/skills/long-task-supervisor/scripts');
const C=path.resolve(__dirname,'../claude-code/.claude/skills/long-task-supervisor/scripts');
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const save=(file,value)=>fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n');
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const line=(file,value)=>fs.appendFileSync(file,JSON.stringify(value)+'\n');
const minutesAgo=minutes=>new Date(Date.now()-minutes*60000).toISOString();
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,ms=15000){const end=Date.now()+ms;while(Date.now()<end){if(check())return;await sleep(50);}throw Error('Timed out');}
const TAIPEI=/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const fromTaipei=text=>Date.parse(text.replace(' ','T')+'+08:00');
function withEnv(values,fn){
  const old=Object.fromEntries(Object.keys(values).map(key=>[key,process.env[key]]));Object.assign(process.env,values);
  try{return fn();}finally{for(const [key,value] of Object.entries(old))if(value===undefined)delete process.env[key];else process.env[key]=value;}
}
// The clock checks at most once a minute per process; each unit check loads it fresh.
function freshClock(){for(const key of Object.keys(require.cache))if(key.endsWith('supervisor-clock.cjs'))delete require.cache[key];return require(path.join(X,'supervisor-clock.cjs'));}

test('a model-written time must name date, time and zone and not be ahead of the clock; the locale warning, 11/10 08:48 and 05:5x are refused',()=>{
  for(const dir of [X,C]){
    const {exactTime,notLater}=require(path.join(dir,'contract-state.cjs'));
    assert.ok(Number.isFinite(Date.parse('LC_ALL = "C.UTF-8",')),'the lenient parser this replaces takes the warning for a date');
    for(const bad of ['LC_ALL = "C.UTF-8",','11/10 08:48','05:5x','2026-11-10 08:48:00+08:00','2026-11-10T08:48','2026-11-10','1999-12-31T23:59:00Z',null,42])
      assert.equal(exactTime(bad),null,String(bad));
    assert.equal(exactTime('2026-11-10T08:48:00+08:00'),Date.parse('2026-11-10T00:48:00Z'));
    assert.equal(exactTime('2026-11-10T00:48Z'),Date.parse('2026-11-10T00:48:00Z'));
    assert.ok(notLater(exactTime(new Date(Date.now()+30000).toISOString())),'a minute of rounding still counts as now');
    assert.equal(notLater(exactTime(new Date(Date.now()+5*60000).toISOString())),false,'a guess ahead of the clock is refused');
    assert.equal(notLater(null),false);
  }
});

test('a new amendment needs the exact time of Jay\'s words; a row recorded before the check still replays',()=>{
  for(const dir of [X,C]){
    const {append,effective}=require(path.join(dir,'contract-state.cjs'));
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'v130-amend-')),run=path.join(root,'run');fs.mkdirSync(run);
    try{
      const source=path.join(root,'source.md');fs.writeFileSync(source,'User: 取消會計時段\nUser: 改用縮短時間驗\n');
      save(path.join(run,'contract.json'),{goal:'Finish',authorization:'Supervise',criteria:[{id:'A1',requirement:'Works',source:'spec',verify:'Replay'}],sources:[{path:source,sha256:sha(source)}]});
      const binding={platform:'codex',supervisorId:process.env.CODEX_THREAD_ID||'supervisor',executorId:'executor',allowedRoots:[root],contractSha256:sha(path.join(run,'contract.json'))};
      save(path.join(run,'binding.json'),binding);save(path.join(run,'daemon-state.json'),{phase:'idle',pending:null,inflight:null});
      const row=(id,at,quote)=>({id,contractSha256:binding.contractSha256,authority:{role:'user',quote,at,locator:'user message',source:{path:source,sha256:sha(source)}},
        changes:[{action:'authorization',id,scope:'acceptance method',instruction:quote}]});
      // OPS 2026-11-10 08:48: the warning text went into authority.at. That row is history and must still replay.
      const old={...row('old-window','LC_ALL = "C.UTF-8",','取消會計時段'),previousSha256:binding.contractSha256};
      fs.writeFileSync(path.join(run,'contract-amendments.jsonl'),JSON.stringify(old)+'\n');
      assert.ok(effective(run,binding).authorizationUpdates.some(item=>item.id==='old-window'),'the recorded row replays as before');
      for(const bad of ['LC_ALL = "C.UTF-8",','11/10 08:48',new Date(Date.now()+10*60000).toISOString()])
        assert.throws(()=>append(run,binding,row('new-'+crypto.randomUUID().slice(0,6),bad,'改用縮短時間驗')),/authority\.at must be the time of Jay's words with date, time and zone/);
      append(run,binding,row('new-ok','2026-11-10T08:48:00+08:00','改用縮短時間驗'));
      assert.ok(effective(run,binding).authorizationUpdates.some(item=>item.id==='new-ok'));
    }finally{fs.rmSync(root,{recursive:true,force:true});}
  }
});

test('dispatch snapshots and acceptance attempts refuse inexact or future times on both platforms',()=>{
  for(const dir of [X,C]){
    const dispatch=require(path.join(dir,'dispatch-audit.cjs')),audit=require(path.join(dir,'acceptance-audit.cjs'));
    const binding={executorId:'executor-qa',dispatchAudit:{enabled:true,snapshot:'dispatch.json'}};
    const snap=(startedAt,at)=>({schemaVersion:1,executorId:'executor-qa',planningRevision:'p1',activity:'working',capacity:{verified:4,evidence:['spawn_agent tool']},
      ...(at?{planningReview:{basis:'a'.repeat(64),reason:'checked',at}}:{}),
      packages:{ready:[],inFlight:[{id:'W1',handle:'/root/w1',exclusiveResources:[],evidence:['wp/W1.md'],baseline:{minutes:20,startedAt,basis:'pace'}}],returned:[],blocked:[],completed:[],recurringRework:[]}});
    dispatch.parse(snap('2026-11-10T00:10:00Z','2026-11-10T08:48:00+08:00'),binding);
    assert.throws(()=>dispatch.parse(snap('11/10 08:48'),binding),/baseline\.startedAt must be a time with date, time and zone/);
    assert.throws(()=>dispatch.parse(snap(new Date(Date.now()+10*60000).toISOString()),binding),/not later than now/);
    assert.throws(()=>dispatch.parse(snap('2026-11-10T00:10:00Z','LC_ALL = "C.UTF-8",'),binding),/planningReview needs basis, reason and at/);
    const item=(startedAt,finishedAt)=>({revision:'r1',items:[{id:'A1',status:'INCONCLUSIVE',evidence:['wp/A1.md'],
      lastAttempt:{id:'t1',caseId:'Q1',revision:'r1',outcome:'INCONCLUSIVE',reason:'measured',evidence:['result:t1'],startedAt,finishedAt}}]});
    const contract={criteria:[{id:'A1'}]};
    audit.validate(item('2026-11-10T00:10:00Z','2026-11-10T08:12:00+08:00'),contract);
    for(const [s,e] of [['11/10 08:48','2026-11-10T00:12:00Z'],['2026-11-10T00:10:00Z','2099-01-01T00:00:00Z'],['2026-11-10T00:12:00Z','2026-11-10T00:10:00Z']])
      assert.throws(()=>audit.validate(item(s,e),contract),/attempt needs actual start\/end timestamps with date, time and zone/);
  }
});

test('allBlocked lists the set only when nothing is ready or in flight and something is blocked',()=>{
  for(const dir of [X,C]){
    const {allBlocked}=require(path.join(dir,'dispatch-audit.cjs'));
    const blocked=[{id:'D6',kind:'after_D5',dependencies:['D5'],acceptanceIds:['A6'],evidence:['wp/D6.md','plan.md:12','extra']},{id:'C3',kind:'user',evidence:['pending:c3-login']}];
    assert.deepEqual(allBlocked({packages:{ready:[],inFlight:[],blocked}}),{packages:[{id:'D6',kind:'after_D5',dependencies:['D5'],acceptanceIds:['A6'],evidence:['wp/D6.md','plan.md:12']},{id:'C3',kind:'user',evidence:['pending:c3-login']}]});
    assert.equal(allBlocked({packages:{ready:[{id:'R1'}],inFlight:[],blocked}}),null,'a ready package is work');
    assert.equal(allBlocked({packages:{ready:[],inFlight:[{id:'W1'}],blocked}}),null,'a package in flight is work');
    assert.equal(allBlocked({packages:{ready:[],inFlight:[],blocked:[]}}),null,'nothing left is not a wait');
    assert.equal(allBlocked(null),null);
  }
});

function codexRun(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'v130-codex-')),home=path.join(root,'codex-home'),source=path.join(root,'source.txt');fs.writeFileSync(source,'Keep the work moving\n');
  const run=path.join(root,'run');fs.mkdirSync(run);
  save(path.join(run,'contract.json'),{goal:'Finish',authorization:'Isolated QA',criteria:[{id:'A1',requirement:'Keep work moving',source:'source.txt:1',verify:'Replay'}],sources:[{path:source,sha256:sha(source)}]});
  const binding={platform:'codex',projectRoot:root,allowedRoots:[root,run],supervisorId:'supervisor-qa',executorId:'executor-qa',callerTurnId:'supervisor-turn',
    contractSha256:sha(path.join(run,'contract.json')),createdAt:minutesAgo(30)};
  save(path.join(run,'binding.json'),binding);
  save(path.join(run,'daemon-state.json'),{phase:'starting',cursor:null,seen:[],messages:[],pending:null,inflight:null,reads:0,starts:0,lastExecutorActivityAt:Date.now(),lastProgressReviewAt:Date.now()});
  const now=new Date(),dir=path.join(home,'sessions',String(now.getFullYear()),String(now.getMonth()+1).padStart(2,'0'),String(now.getDate()).padStart(2,'0'));fs.mkdirSync(dir,{recursive:true});
  const executorLog=path.join(dir,'rollout-t-executor-qa.jsonl');
  line(executorLog,{timestamp:binding.createdAt,type:'session_meta',payload:{id:'executor-qa',session_id:'executor-qa'}});
  return {root,home,run,binding,executorLog,statePath:path.join(run,'daemon-state.json')};
}

test('Codex: every package blocked with none ready or in flight wakes the supervisor once per set after 5 idle minutes, even while Jay is asked',()=>{
  const f=codexRun();
  try{
    f.binding.dispatchAudit={enabled:true,snapshot:'dispatch.json'};
    const snapshot=blocked=>({schemaVersion:1,executorId:'executor-qa',planningRevision:'p1',activity:'waiting',capacity:{verified:4,evidence:['spawn_agent tool']},
      packages:{ready:[],inFlight:[],returned:[],blocked,completed:[],recurringRework:[]},acceptance:{revision:'r1',items:[{id:'A1',status:'PENDING',evidence:['wp/A1.md']}]}});
    const pkg=(id,kind)=>({id,kind,exclusiveResources:[],evidence:['wp/'+id+'.md'],acceptanceIds:['A1']});
    // WEB 2026-11-09 22:52: the executor idle beside packages blocked only by their place in the plan while Jay's answer was pending.
    const state={lastRealEventAt:Date.now(),lastExecutorActivityAt:Date.now()-6*60000,checkedWait:{kind:'user_approval',conditions:[]}};
    const check=()=>withEnv({CODEX_HOME:f.home},()=>freshClock().check(f.run,f.binding,state));
    const reasons=()=>check()?.reasons||[];
    save(path.join(f.run,'dispatch.json'),snapshot([pkg('D6','after_D5'),pkg('C6','user')]));
    assert.ok(!reasons().includes('all_blocked'),'a set just seen is not news yet');
    assert.ok(state.allBlocked?.since,'the clock starts timing the set');
    state.allBlocked.since-=6*60000;
    const found=check();
    assert.ok(found.reasons.includes('all_blocked'),'waiting on Jay does not silence it');
    assert.ok(!found.reasons.includes('idle_with_work'),'the older idle reminder stays quiet while Jay is asked; this one is for that wait');
    assert.deepEqual(found.allBlocked.packages.map(item=>item.id),['D6','C6']);assert.ok(found.allBlocked.minutes>=6);
    assert.ok(!reasons().includes('all_blocked'),'the same set wakes once');
    save(path.join(f.run,'dispatch.json'),snapshot([pkg('D6','after_D5'),pkg('C6','user'),pkg('D9','after_D6')]));
    check();state.allBlocked.since-=6*60000;state.openTools={call:{commands:['npm test'],at:new Date().toISOString()}};
    assert.ok(!reasons().includes('all_blocked'),'a running command means the executor is working');
    delete state.openTools;
    assert.ok(reasons().includes('all_blocked'),'a new set wakes once the executor is idle');
    // A ruling on an executor event while the set stood: the supervisor saw it in brief.allBlocked.
    save(path.join(f.run,'dispatch.json'),snapshot([pkg('F1','time')]));
    check();state.allBlocked.since-=6*60000;state.lastDecisionAt=Date.now();
    assert.ok(!reasons().includes('all_blocked'),'a set the supervisor already ruled beside is not sent again');
    state.lastDecisionAt=Date.now()-60*60000;
    assert.ok(!reasons().includes('all_blocked'),'and stays quiet afterwards');
    const ready=snapshot([pkg('F1','time')]);ready.packages.ready=[{id:'P1',independent:true,safe:true,dependencies:[],exclusiveResources:[],evidence:['wp/P1.md']}];
    save(path.join(f.run,'dispatch.json'),ready);check();
    assert.equal(state.allBlocked,undefined,'work ready again clears the set');
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

function claudeRun(){
  const scripts=C,root=fs.mkdtempSync(path.join(os.tmpdir(),'v130-claude-'));
  const bin=path.join(root,'bin');fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin,'sysctl'),'#!/bin/sh\necho "{ sec = 1000000, usec = 0 } x"\necho "{ sec = 1000000, usec = 0 } x"\n',{mode:0o755});
  const project=path.join(root,'config','projects','qa');fs.mkdirSync(project,{recursive:true});
  const source=path.join(root,'source.md');fs.writeFileSync(source,'Parity criterion\n');
  const supervisorId=crypto.randomUUID(),executorId=crypto.randomUUID(),marker='LONG_TASK_BIND:'+crypto.randomUUID();
  line(path.join(project,supervisorId+'.jsonl'),{type:'user',sessionId:supervisorId,cwd:root,entrypoint:'claude-desktop'});
  line(path.join(project,executorId+'.jsonl'),{type:'user',sessionId:executorId,cwd:root,entrypoint:'claude-desktop',message:{content:[{type:'text',text:marker}]}});
  const run=path.join(root,'run'),input=path.join(root,'input.json');
  save(input,{dispatchAudit:false,loginSites:[],projectRoot:root,allowedRoots:[root],supervisorId,
    supervisorDesktopId:'local_'+crypto.randomUUID(),executorId,executorDesktopId:'local_'+crypto.randomUUID(),
    executorMarker:marker,executorPrompt:marker+' test',contract:{goal:'Finish on AI time',authorization:'Isolated QA',
      criteria:[{id:'A1',requirement:'Keep work moving',source:'source.md:1',verify:'Replay activity'},{id:'A2',requirement:'Second',source:'source.md:1',verify:'Replay'}],
      sources:[{path:source,sha256:sha(source)}]}});
  const env={...process.env,PATH:bin+path.delimiter+process.env.PATH,CLAUDE_CONFIG_DIR:path.join(root,'config'),CLAUDE_SESSION_ID:supervisorId,CLAUDE_WATCH_SETTLE_MS:'100'};
  execFileSync(process.execPath,[path.join(scripts,'supervise.cjs'),'init',run,input],{env});
  const statePath=path.join(run,'daemon-state.json');
  const state=read(statePath);state.lastExecutorActivityAt=Date.now();state.lastProgressReviewAt=Date.now()-60000;save(statePath,state);
  return {root,run,env,statePath,patch(change){const value=read(statePath);change(value);save(statePath,value);},done(){fs.rmSync(root,{recursive:true,force:true});}};
}

test('Claude: the receiver names every blocked package to the supervisor once the executor has been idle 5 minutes',async()=>{
  const f=claudeRun();
  const blocked=[{id:'D6',kind:'after_D5',evidence:['wp/D6.md'],acceptanceIds:['A1']},{id:'C6',kind:'user',evidence:['wp/C6.md'],acceptanceIds:['A2']}];
  const key='all_blocked:'+crypto.createHash('sha256').update(blocked.map(item=>item.id+'='+item.kind).sort().join('\n')).digest('hex').slice(0,16);
  f.patch(state=>{state.allBlocked={key,since:Date.now()-6*60000};state.lastExecutorWorkAt=Date.now()-6*60000;});
  save(path.join(f.run,'dispatch.json'),{capacity:{verified:4},acceptance:{items:[{id:'A1',status:'PENDING'},{id:'A2',status:'FAIL'}]},packages:{ready:[],inFlight:[],blocked}});
  const child=spawn(process.execPath,[path.join(C,'claude-watch.cjs'),f.run],{env:f.env,stdio:['ignore','pipe','pipe']});
  try{
    await until(()=>read(f.statePath).pending?.kind==='progress_review',8000);
    const event=read(f.statePath).pending;
    assert.ok(event.reasons.includes('all_blocked'));
    assert.deepEqual(event.allBlocked.packages.map(item=>item.id),['D6','C6']);
    const status=JSON.parse(execFileSync(process.execPath,[path.join(C,'supervise.cjs'),'status',f.run],{env:f.env,encoding:'utf8'}));
    assert.match(status.nowTaipei,TAIPEI);assert.ok(Math.abs(fromTaipei(status.nowTaipei)-Date.now())<120000,'status shows the clock now, in Taipei');
  }finally{
    if(child.exitCode===null&&child.signalCode===null){const exited=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGTERM');await exited;}
    f.done();
  }
});

test('rollout-turns reads the newest turns from the executor\'s own rollout in the shape read_thread returns',()=>{
  const {recent}=require(path.join(X,'rollout-turns.cjs'));
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'v130-rollout-')),file=path.join(root,'rollout.jsonl');
  try{
    const msg=(role,text,turn,phase)=>({type:'response_item',payload:{type:'message',role,id:role+'-'+turn+(phase||''),...(phase?{phase}:{}),
      content:[{type:role==='user'?'input_text':'output_text',text}],internal_chat_message_metadata_passthrough:{turn_id:turn}}});
    const ev=(type,turn,extra={})=>({type:'event_msg',payload:{type,turn_id:turn,...extra}});
    line(file,{type:'session_meta',payload:{id:'executor-qa'}});
    line(file,{type:'turn_context',payload:{turn_id:'t1'}});line(file,ev('task_started','t1',{started_at:1}));
    line(file,msg('user','start B6','t1'));line(file,msg('assistant','x'.repeat(900),'t1','final_answer'));line(file,ev('task_complete','t1',{completed_at:2,last_agent_message:'done'}));
    line(file,{type:'turn_context',payload:{turn_id:'t2'}});line(file,ev('task_started','t2'));
    line(file,msg('user','continue','t2'));line(file,ev('task_complete','t2',{error:{message:'stream disconnected'},last_agent_message:'partial'}));
    line(file,{type:'turn_context',payload:{turn_id:'t3'}});line(file,ev('task_started','t3'));line(file,msg('user','next','t3'));line(file,ev('turn_aborted','t3'));
    line(file,{type:'turn_context',payload:{turn_id:'t4'}});line(file,ev('task_started','t4'));line(file,msg('assistant','working','t4','commentary'));
    const turns=recent(file,{turnLimit:4,maxOutputCharsPerItem:500});
    assert.deepEqual(turns.map(item=>[item.id,item.status]),[['t4','inProgress'],['t3','interrupted'],['t2','failed'],['t1','completed']]);
    assert.equal(turns[3].items.find(item=>item.phase==='final_answer').text.length,500,'items keep the size asked for');
    assert.deepEqual(turns[3].items.map(item=>item.type),['userMessage','agentMessage']);
    assert.deepEqual(recent(file,{turnLimit:1}).map(item=>item.id),['t4']);
    // A completed turn whose final answer lies outside the part read still gives its text from task_complete.
    const late=path.join(root,'late.jsonl');
    line(late,{type:'turn_context',payload:{turn_id:'t9'}});line(late,ev('task_started','t9'));
    line(late,ev('task_complete','t9',{last_agent_message:'LONG_TASK_EVENT {"kind":"progress","nextAction":"B7"}'}));
    const last=recent(late)[0];
    assert.equal(last.status,'completed');assert.equal(last.items.at(-1).phase,'final_answer');assert.match(last.items.at(-1).text,/LONG_TASK_EVENT/);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

function executorTurn(file,id,finalText){
  line(file,{type:'turn_context',payload:{turn_id:id}});
  line(file,{type:'event_msg',payload:{type:'task_started',turn_id:id}});
  line(file,{type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'work on '+id}],internal_chat_message_metadata_passthrough:{turn_id:id}}});
  line(file,{type:'response_item',payload:{type:'message',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:finalText}],internal_chat_message_metadata_passthrough:{turn_id:id}}});
  line(file,{type:'event_msg',payload:{type:'task_complete',turn_id:id,last_agent_message:finalText}});
}

test('Codex: when the App cannot return one oversized executor turn, the watcher reads it from the local rollout and keeps going',async()=>{
  const f=codexRun();
  const sent=path.join(f.root,'sent.json'),mockFile=path.join(f.root,'mock.json'),usage=path.join(f.root,'usage.jsonl'),quota=path.join(f.root,'quota.json');
  fs.writeFileSync(usage,JSON.stringify({conversationId:'unrelated',status:200})+'\n');
  save(mockFile,{supervisorId:'supervisor-qa',executorId:'executor-qa',noTurn:true,oversizedExecutor:true});
  const env={...process.env,CODEX_HOME:f.home,CODEX_APP_TOOLS_SERVER_PATH:path.join(__dirname,'mock-codex-app-server.cjs'),MOCK_CODEX_FIXTURE:mockFile,MOCK_CODEX_SENT:sent,
    OPENCODEX_USAGE_FILE:usage,OPENCODEX_QUOTA_FILE:quota,CHROME_RELAY_BIN:path.join(f.root,'no-relay'),CODEX_WATCH_IDLE_SLEEP_MS:'200'};
  delete env.CODEX_THREAD_ID;
  // OPS 2026-11-10 04:01-04:04: every read of the executor failed even at 1 turn and 500 characters per item, so the
  // watcher restarted at its startup read proof. Here the executor's latest turn asks a question.
  executorTurn(f.executorLog,'t0','Which login should the B6 check use?\nLONG_TASK_EVENT {"kind":"question"}');
  const child=spawn(process.execPath,[path.join(X,'native-watch.cjs'),f.run],{env,stdio:['ignore','pipe','pipe']});
  let err='';child.stderr.on('data',chunk=>{err+=chunk;});
  const status=()=>JSON.parse(execFileSync(process.execPath,[path.join(X,'supervise.cjs'),'status',f.run],{env,encoding:'utf8'}));
  try{
    await until(()=>status().readVerified===true,20000);
    assert.ok((read(f.statePath).rolloutReads||[]).some(item=>item.threadId==='executor-qa'),'the startup proof came from the rollout');
    const now=status();
    assert.match(now.nowTaipei,TAIPEI);assert.ok(Math.abs(fromTaipei(now.nowTaipei)-Date.now())<120000,'status shows the clock now, in Taipei');
    // The question read from the rollout still reaches the supervisor.
    await until(()=>read(f.statePath).pending?.kind==='question',20000);
    assert.ok(JSON.parse(fs.existsSync(sent+'.args.json')?fs.readFileSync(sent+'.args.json','utf8'):'[]').some(call=>call.threadId==='supervisor-qa'&&call.prompt.includes('t0')),'the event was delivered to the supervisor');
    assert.equal(child.exitCode,null,'the watcher kept running instead of restarting: '+err.slice(-300));
  }finally{
    if(child.exitCode===null){child.kill('SIGTERM');await new Promise(resolve=>child.once('exit',resolve));}
    fs.rmSync(f.root,{recursive:true,force:true});
  }
});

test('the send time the background program adds is the Taipei clock time it left, across midnight too',()=>{
  for(const dir of [X,C]){
    const wake=require(path.join(dir,'execution-wake.cjs'));
    assert.equal(wake.taipei(Date.parse('2026-11-09T14:21:00Z')),'2026-11-09 22:21:00');
    assert.equal(wake.taipei(Date.parse('2026-11-09T16:15:30Z')),'2026-11-10 00:15:30','00:15 in Taipei is already the next day');
    assert.equal(wake.sentLine(Date.parse('2026-11-10T00:48:00Z')),'背景程式送出時間（台北）：2026-11-10 08:48:00');
    const shown=fromTaipei(wake.sentLine().split('：')[1]);
    assert.ok(Math.abs(shown-Date.now())<5000,'read from the system clock, not written by a model');
  }
});

