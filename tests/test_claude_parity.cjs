// Claude Desktop parity with the Codex supervisor fixes of v0.22.0-v0.24.4 (Jay 2026-10-13: "Q1 A、Q2 A、Q3 A、Q4 A").
// Each test holds a behaviour Jay decided on 2026-10-11 for Codex and asked to be matched with Claude's own signals:
// fewer wakes for a slow but working package, one question when an hour passes without an executor event, idle and
// unplanned criteria named for dispatch, instructions with deadlines, pauses only from words received this turn,
// compaction summaries never taken as receipts or new input, and the auto-mode, rate-limit, schedule and model
// signals real Claude transcripts carry.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawn,execFileSync,spawnSync}=require('node:child_process');
const scripts=process.env.CLAUDE_SUPERVISOR_SCRIPTS||path.resolve(__dirname,'../claude-code/.claude/skills/long-task-supervisor/scripts');
const signals=require(path.join(scripts,'signals.cjs'));
const checkedWait=require(path.join(scripts,'checked-wait.cjs'));
const {validateDecision,deliveredText}=require(path.join(scripts,'guard.cjs'));
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const save=(file,value)=>fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n');
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const line=(file,value)=>fs.appendFileSync(file,JSON.stringify(value)+'\n');
const minutesAgo=minutes=>new Date(Date.now()-minutes*60000).toISOString();
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,ms=6000){const end=Date.now()+ms;while(Date.now()<end){if(check())return;await sleep(40);}throw Error('Timed out');}
function fixture({quietMinutes=1,lastReviewMinutesAgo=1}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'claude-parity-'));
  // The machine's real sleep log must not shorten these windows: a fake sysctl reports a sleep long before the run.
  const bin=path.join(root,'bin');fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin,'sysctl'),'#!/bin/sh\necho "{ sec = 1000000, usec = 0 } x"\necho "{ sec = 1000000, usec = 0 } x"\n',{mode:0o755});
  const project=path.join(root,'config','projects','qa');fs.mkdirSync(project,{recursive:true});
  const source=path.join(root,'source.md');fs.writeFileSync(source,'Parity criterion\n');
  const supervisorId=crypto.randomUUID(),executorId=crypto.randomUUID(),marker='LONG_TASK_BIND:'+crypto.randomUUID();
  const executorLog=path.join(project,executorId+'.jsonl'),supervisorLog=path.join(project,supervisorId+'.jsonl');
  line(supervisorLog,{type:'user',sessionId:supervisorId,cwd:root,entrypoint:'claude-desktop'});
  line(executorLog,{type:'user',sessionId:executorId,cwd:root,entrypoint:'claude-desktop',message:{content:[{type:'text',text:marker}]}});
  const run=path.join(root,'run'),input=path.join(root,'input.json');
  save(input,{dispatchAudit:false,loginSites:[],projectRoot:root,allowedRoots:[root],supervisorId,
    supervisorDesktopId:'local_'+crypto.randomUUID(),executorId,executorDesktopId:'local_'+crypto.randomUUID(),
    executorMarker:marker,executorPrompt:marker+' test',contract:{goal:'Finish on AI time',authorization:'Isolated QA',
      criteria:[{id:'A1',requirement:'Keep work moving',source:'source.md:1',verify:'Replay activity'},{id:'A2',requirement:'Second',source:'source.md:1',verify:'Replay'}],
      sources:[{path:source,sha256:sha(source)}]}});
  const env={...process.env,PATH:bin+path.delimiter+process.env.PATH,CLAUDE_CONFIG_DIR:path.join(root,'config'),CLAUDE_SESSION_ID:supervisorId,CLAUDE_WATCH_SETTLE_MS:'100'};
  execFileSync(process.execPath,[path.join(scripts,'supervise.cjs'),'init',run,input],{env});
  const statePath=path.join(run,'daemon-state.json');
  const state=read(statePath);state.lastExecutorActivityAt=Date.now()-quietMinutes*60000;state.lastProgressReviewAt=Date.now()-lastReviewMinutesAgo*60000;save(statePath,state);
  const subagents=path.join(project,executorId,'subagents');fs.mkdirSync(subagents,{recursive:true});
  return {root,run,env,source,executorId,executorLog,supervisorLog,statePath,subagents,
    patch(change){const value=read(statePath);change(value);save(statePath,value);},
    done(){fs.rmSync(root,{recursive:true,force:true});}};
}
const cmd=(f,name,...args)=>JSON.parse(execFileSync(process.execPath,[path.join(scripts,'supervise.cjs'),name,f.run,...args],{env:f.env,encoding:'utf8',stdio:'pipe'}));
const cmdFails=(f,name,...args)=>spawnSync(process.execPath,[path.join(scripts,'supervise.cjs'),name,f.run,...args],{env:f.env,encoding:'utf8'});
function start(f){const child=spawn(process.execPath,[path.join(scripts,'claude-watch.cjs'),f.run],{env:f.env,stdio:['ignore','pipe','pipe']});child.out='';child.stdout.on('data',chunk=>{child.out+=chunk;});return child;}
async function stopWatch(child){if(child.exitCode===null&&child.signalCode===null){const exited=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGTERM');await exited;}}
const pending=f=>read(f.statePath).pending;
const watching=f=>until(()=>read(f.statePath).phase==='watching');
function agent(dir,id,{minutes,tokens,done=true,endedMinutesAgo=0}){
  const end=Date.now()-endedMinutesAgo*60000,begin=end-minutes*60000;
  const rows=[{type:'user',timestamp:new Date(begin).toISOString(),isSidechain:true,message:{content:'work package'}},
    {type:'assistant',timestamp:new Date(end).toISOString(),isSidechain:true,message:{id:'msg-'+id,model:'claude-sonnet-5-5',stop_reason:done?'end_turn':'tool_use',usage:{output_tokens:tokens},content:[{type:'text',text:'report'}]}}];
  fs.writeFileSync(path.join(dir,'agent-'+id+'.jsonl'),rows.map(row=>JSON.stringify(row)).join('\n')+'\n');
}
const assistant=(f,content,extra={})=>line(f.executorLog,{type:'assistant',uuid:crypto.randomUUID(),timestamp:new Date().toISOString(),message:{id:'m-'+crypto.randomUUID(),stop_reason:'tool_use',content},...extra});
const final=(f,text)=>{line(f.executorLog,{type:'assistant',uuid:crypto.randomUUID(),timestamp:new Date().toISOString(),message:{id:'m-'+crypto.randomUUID(),stop_reason:'end_turn',content:[{type:'text',text}]}});line(f.executorLog,{type:'user',message:{content:'next turn'}});};
// Settle a progress review with a checked observe so the next watcher can run.
function observe(f,event){
  assert.equal(cmd(f,'progress-preflight',event.id).current,true);
  const file=path.join(f.root,'decision-'+event.id+'.json');
  save(file,{eventId:event.id,disposition:'observe',reason:'Checked in test.',progressCheck:{evidence:['test fixture'],finding:'Recorded.'}});
  assert.equal(cmd(f,'decision',file).processed,true);
}

test('a slow package that still produces is recorded, not woken; once it goes quiet it wakes the supervisor once',async()=>{
  const f=fixture();
  agent(f.subagents,'slow',{minutes:30,tokens:30000,done:false,endedMinutesAgo:0});
  save(path.join(f.run,'dispatch.json'),{packages:{inFlight:[{id:'WP-SLOW',handle:'agent:slow',evidence:['wp/WP-SLOW.md'],baseline:{minutes:12,startedAt:minutesAgo(30)}}]}});
  let child=start(f);
  try{
    await watching(f);await sleep(500);
    assert.equal(pending(f),null,'2.5x its baseline but producing: Jay 2026-10-11 wants it recorded, not interrupted');
    await stopWatch(child);
    agent(f.subagents,'slow',{minutes:30,tokens:30000,done:false,endedMinutesAgo:16});
    child=start(f);
    await until(()=>pending(f)?.kind==='progress_review');
    assert.deepEqual(pending(f).reasons,['overdue']);assert.deepEqual(pending(f).overdue,['WP-SLOW']);
    assert.match(child.out,/LONG_TASK_WAKE .*"context":/,'the wake carries a context locator');
    assert.doesNotMatch(child.out,/"pace":/,'the wake no longer pastes the whole event');
  }finally{await stopWatch(child);f.done();}
});

test('a pure overdue check becomes obsolete when its package produces again before the supervisor acts',async()=>{
  const f=fixture();
  agent(f.subagents,'slow',{minutes:30,tokens:30000,done:false,endedMinutesAgo:16});
  save(path.join(f.run,'dispatch.json'),{packages:{inFlight:[{id:'WP-SLOW',handle:'agent:slow',evidence:['wp'],baseline:{minutes:12,startedAt:minutesAgo(30)}}]}});
  const child=start(f);
  try{
    await until(()=>pending(f)?.kind==='progress_review');
    const event=pending(f);await stopWatch(child);
    agent(f.subagents,'slow',{minutes:31,tokens:31000,done:false,endedMinutesAgo:0});
    assert.equal(cmd(f,'progress-preflight',event.id).current,false,'no nudge for a package that recovered');
    assert.equal(pending(f),null);
  }finally{await stopWatch(child);f.done();}
});

test('an hour without a real executor event asks once, even while work looks busy; an approval wait does not',async()=>{
  const f=fixture();
  f.patch(state=>{state.lastRealEventAt=Date.now()-61*60000;});
  agent(f.subagents,'busy',{minutes:5,tokens:5000,done:false});
  let child=start(f);
  try{
    await until(()=>pending(f)?.kind==='progress_review');
    assert.ok(pending(f).reasons.includes('no_event_hour'));assert.ok(pending(f).noEventHour.awakeMinutes>=60);
    await stopWatch(child);observe(f,pending(f));
    child=start(f);await watching(f);await sleep(400);
    assert.equal(pending(f),null,'one question per quiet stretch');
    await stopWatch(child);
    const g=fixture();
    try{
      g.patch(state=>{state.lastRealEventAt=Date.now()-61*60000;state.checkedWait={kind:'user_approval',conditions:[],executorMarker:undefined,executorAt:state.lastExecutorActivityAt};});
      agent(g.subagents,'busy',{minutes:5,tokens:5000,done:false});
      child=start(g);await watching(g);await sleep(500);
      assert.equal(pending(g),null,'only Jay can clear an approval wait; asking hourly only spends turns');
    }finally{await stopWatch(child);g.done();}
  }finally{await stopWatch(child);f.done();}
});

test('a main line that only polls a background job is idle while ready work waits; real work is not',async()=>{
  const f=fixture({quietMinutes:0});
  f.patch(state=>{state.lastExecutorWorkAt=Date.now()-7*60000;});
  save(path.join(f.run,'dispatch.json'),{packages:{ready:[{id:'WP-NEXT'}],inFlight:[]}});
  assistant(f,[{type:'tool_use',id:'t1',name:'TaskOutput',input:{task_id:'x'}}]);
  assistant(f,[{type:'tool_use',id:'t2',name:'Bash',input:{command:'sleep 30'}}]);
  let child=start(f);
  try{
    await until(()=>pending(f)?.kind==='progress_review');
    assert.deepEqual(pending(f).reasons,['idle_with_work']);assert.deepEqual(pending(f).idleWithWork.readyPackages,['WP-NEXT']);
    await stopWatch(child);
    const g=fixture({quietMinutes:0});
    try{
      g.patch(state=>{state.lastExecutorWorkAt=Date.now()-7*60000;});
      save(path.join(g.run,'dispatch.json'),{packages:{ready:[{id:'WP-NEXT'}],inFlight:[]}});
      assistant(g,[{type:'tool_use',id:'t3',name:'Edit',input:{file_path:'/x'}}]);
      child=start(g);await watching(g);await sleep(500);
      assert.equal(pending(g),null,'editing a file is work');
    }finally{await stopWatch(child);g.done();}
  }finally{await stopWatch(child);f.done();}
});

test('an open criterion nobody covers for ten minutes is named for dispatch; a covered one is not',async()=>{
  const f=fixture({quietMinutes:0});
  f.patch(state=>{state.unplanned={A2:Date.now()-11*60000};state.lastExecutorWorkAt=Date.now();});
  save(path.join(f.run,'dispatch.json'),{capacity:{verified:4},acceptance:{items:[{id:'A1',status:'PENDING'},{id:'A2',status:'FAIL'}]},
    packages:{inFlight:[{id:'WP-A1',handle:'agent:none',acceptanceIds:['A1'],evidence:['wp'],baseline:{minutes:30,startedAt:minutesAgo(1)}}]}});
  const child=start(f);
  try{
    await until(()=>pending(f)?.kind==='progress_review');
    assert.ok(pending(f).reasons.includes('unplanned_criteria'));
    assert.deepEqual(pending(f).unplannedCriteria.criteria,['A2']);assert.equal(pending(f).unplannedCriteria.freeCapacity,3);
  }finally{await stopWatch(child);f.done();}
});

test('an instruction past its deadline reroutes first and is the supervisor\'s own on the second miss',async()=>{
  const f=fixture();
  final(f,'Need a ruling on K1.\nLONG_TASK_EVENT {"kind":"question"}');
  let child=start(f);
  try{
    await until(()=>pending(f)?.kind==='question');await stopWatch(child);
    const event=pending(f),file=path.join(f.root,'reply.json');
    assert.throws(()=>validateDecision({allowedRoots:[f.root]},{criteria:[]},event,{eventId:event.id,disposition:'reply',reply:'x',instruction:{what:'x',doneWhen:'y',deadlineMinutes:500}}),/1-240/);
    save(file,{eventId:event.id,disposition:'reply',reply:'Use the staging account.',instruction:{what:'Rerun K1 on staging',doneWhen:'K1 result in the snapshot',deadlineMinutes:20},
      delivery:{marker:'LONG_TASK_DELIVERY:'+event.id,status:'queued',messageId:'msg-1'}});
    assert.equal(cmd(f,'decision',file).processed,true);
    const recorded=read(f.statePath).instruction;
    assert.equal(recorded.what,'Rerun K1 on staging');assert.equal(recorded.deadlineMs,20*60000);
    // Nothing has happened since the instruction: the last real event predates it.
    f.patch(state=>{state.instruction.sentAt=Date.now()-21*60000;state.lastRealEventAt=Date.now()-22*60000;});
    child=start(f);
    await until(()=>pending(f)?.kind==='progress_review');
    assert.equal(pending(f).instructionOverdue.misses,1);assert.match(pending(f).instructionOverdue.handling,/改道/);
    await stopWatch(child);observe(f,pending(f));
    f.patch(state=>{state.instruction.sentAt=Date.now()-41*60000;state.lastRealEventAt=Date.now()-42*60000;});
    child=start(f);
    await until(()=>pending(f)?.kind==='progress_review');
    assert.equal(pending(f).instructionOverdue.misses,2);assert.match(pending(f).instructionOverdue.handling,/不通知使用者/);
  }finally{await stopWatch(child);f.done();}
});

test('a reply that waits on the supervisor\'s ruling reaches the supervisor as a question, whatever it was marked',async()=>{
  const f=fixture(),child=start(f);
  try{
    await watching(f);
    final(f,'K1 is ready; waiting for the supervisor ruling before the release step.\nLONG_TASK_EVENT {"kind":"progress","nextAction":"Wait for the ruling","waitMinutes":60}');
    await until(()=>pending(f)?.kind==='question');
  }finally{await stopWatch(child);f.done();}
});

test('a success of the same command clears its failure count, so only uninterrupted failures are a repeat',async()=>{
  const f=fixture(),child=start(f);
  const run=(id,error)=>{assistant(f,[{type:'tool_use',id,name:'Bash',input:{command:'npm test'}}]);
    line(f.executorLog,{type:'user',uuid:crypto.randomUUID(),timestamp:new Date().toISOString(),message:{content:[{type:'tool_result',tool_use_id:id,is_error:error,content:error?'Exit code 1':'ok'}]}});};
  try{
    await watching(f);
    run('a',true);run('b',true);run('c',false);run('d',true);
    await until(()=>read(f.statePath).failedCommands?.['npm test']?.count===1);
  }finally{await stopWatch(child);f.done();}
});

test('a compaction summary that quotes an old delivery marker is not a receipt; the real forwarded message is',async()=>{
  const f=fixture();
  f.patch(state=>{state.unconfirmedDeliveries={e1:{requires:['LONG_TASK_DELIVERY:e1'],messageId:'m1',queuedAt:new Date().toISOString()}};});
  line(f.executorLog,{type:'user',isCompactSummary:true,isVisibleInTranscriptOnly:true,message:{content:'Summary: earlier the supervisor sent LONG_TASK_DELIVERY:e1 ...'}});
  let child=start(f);
  try{
    await watching(f);await sleep(300);
    assert.ok(read(f.statePath).unconfirmedDeliveries.e1,'8 real summaries carried markers; a summary is history');
    line(f.executorLog,{type:'user',origin:{kind:'peer'},isMeta:true,message:{content:'Another Claude session sent a message:\nLONG_TASK_DELIVERY:e1\nUse staging.'}});
    await until(()=>!read(f.statePath).unconfirmedDeliveries.e1);
    assert.equal(deliveredText({type:'user',isCompactSummary:true,message:{content:'LONG_TASK_DELIVERY:x'}}),'');
  }finally{await stopWatch(child);f.done();}
});

test('only Jay typing lifts an approval wait: current transcripts mark him origin human; summaries and forwards do not',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'claude-wait-')),log=path.join(root,'sup.jsonl');
  try{
    fs.writeFileSync(log,'');
    const state={checkedWait:{kind:'user_approval',conditions:[],supervisorOffset:0}},binding={supervisorLog:log};
    line(log,{type:'user',isCompactSummary:true,message:{content:'Jay approved the release earlier.'}});
    line(log,{type:'user',origin:{kind:'peer'},isMeta:true,message:{content:'Another session: approved'}});
    checkedWait.supervisorInput(state,binding);
    assert.ok(state.checkedWait,'a replayed summary or a forwarded chat is not Jay answering');
    line(log,{type:'user',origin:{kind:'human'},promptSource:'sdk',message:{content:'核准，發布吧'}});
    checkedWait.supervisorInput(state,binding);
    assert.equal(state.checkedWait,undefined,'before this fix origin-marked human rows never lifted the wait');
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('a pause stops clock wakes but the executor\'s own events still arrive; resume restarts the clocks',async()=>{
  const f=fixture();
  line(f.supervisorLog,{type:'user',origin:{kind:'human'},timestamp:new Date().toISOString(),message:{content:'先暫停整個任務'}});
  assert.equal(cmd(f,'pause','先暫停整個任務').paused,true);
  agent(f.subagents,'slow',{minutes:30,tokens:30000,done:false,endedMinutesAgo:16});
  save(path.join(f.run,'dispatch.json'),{packages:{inFlight:[{id:'WP-SLOW',handle:'agent:slow',evidence:['wp'],baseline:{minutes:12,startedAt:minutesAgo(30)}}]}});
  let child=start(f);
  try{
    await watching(f);await sleep(500);
    assert.equal(pending(f),null,'paused: no clock wake');
    final(f,'Done with step 1.\nLONG_TASK_EVENT {"kind":"question"}');
    await until(()=>pending(f)?.kind==='question');
    await stopWatch(child);
    assert.equal(cmd(f,'resume','繼續').resumed,true);
    assert.equal(fs.existsSync(path.join(f.run,'PAUSED.json')),false);
    const history=JSON.parse(fs.readFileSync(path.join(f.run,'pause-history.jsonl'),'utf8').trim());
    assert.equal(history.quote,'先暫停整個任務');assert.equal(history.resumeQuote,'繼續');
  }finally{await stopWatch(child);f.done();}
});

test('pause and stop take only words received this turn, never a quote replayed by compaction',()=>{
  const f=fixture();
  try{
    line(f.supervisorLog,{type:'user',origin:{kind:'human'},message:{content:'停止監督'}});
    line(f.supervisorLog,{type:'assistant',message:{id:'a1',stop_reason:'end_turn',content:[{type:'text',text:'ok'}]}});
    line(f.supervisorLog,{type:'user',isCompactSummary:true,message:{content:'Earlier Jay said 暫停全部工作.'}});
    line(f.supervisorLog,{type:'user',origin:{kind:'human'},message:{content:'看一下進度'}});
    assert.match(cmdFails(f,'pause','暫停全部工作').stderr,/壓縮後重現/,'a summary quote is history (2026-10-12: a stale pause cost 5 hours)');
    assert.match(cmdFails(f,'stop','停止監督').stderr,/this turn/,'an earlier turn\'s words are not this turn\'s');
    assert.notEqual(cmdFails(f,'stop').status,0,'stop needs Jay\'s words');
    line(f.supervisorLog,{type:'user',origin:{kind:'peer'},isMeta:true,message:{content:'Another Claude session sent a message: 暫停全部工作'}});
    assert.equal(cmd(f,'pause','暫停全部工作').paused,true,'a forwarded instruction received this turn counts');
  }finally{f.done();}
});

test('auto mode is reported once, a refusal of a new work item again, and the switch to bypass once more',async()=>{
  const f=fixture({quietMinutes:0});
  line(f.executorLog,{type:'user',origin:{kind:'peer'},isMeta:true,permissionMode:'auto',message:{content:'continue'}});
  let child=start(f);
  try{
    await until(()=>pending(f)?.kind==='progress_review');
    assert.deepEqual(pending(f).reasons,['permission_review']);assert.equal(pending(f).permission.permissionMode,'auto');
    await stopWatch(child);observe(f,pending(f));
    assistant(f,[{type:'tool_use',id:'d1',name:'Bash',input:{command:'cd app && docker compose up -d'}}]);
    line(f.executorLog,{type:'user',uuid:crypto.randomUUID(),message:{content:[{type:'tool_result',tool_use_id:'d1',is_error:true,
      content:'Permission for this action was denied by the Claude Code auto mode classifier. Reason: [Permission Grant]. If you have other tasks...'}]}});
    child=start(f);
    await until(()=>pending(f)?.kind==='progress_review');
    assert.deepEqual(pending(f).reasons,['permission_review']);assert.equal(pending(f).permission.newRejections[0].item,'docker compose');
    await stopWatch(child);observe(f,pending(f));
    line(f.executorLog,{type:'user',origin:{kind:'human'},permissionMode:'bypassPermissions',message:{content:'繼續'}});
    child=start(f);
    await until(()=>pending(f)?.kind==='progress_review');
    assert.deepEqual(pending(f).reasons,['permission_changed']);
  }finally{await stopWatch(child);f.done();}
});

test('a rate limit is a known wait: no silence wake while it runs, one wake at its reset',async()=>{
  const f=fixture({quietMinutes:20,lastReviewMinutesAgo:20});
  // The run was bound before the limit hit; a limit from before the binding belongs to another run.
  const bindingFile=path.join(f.run,'binding.json'),binding=read(bindingFile);binding.createdAt=minutesAgo(40);save(bindingFile,binding);
  line(f.executorLog,{type:'assistant',isApiErrorMessage:true,error:'rate_limit',apiErrorStatus:429,timestamp:minutesAgo(20),
    message:{id:'rl',model:'<synthetic>',stop_reason:'stop_sequence',content:[{type:'text',text:"You've hit your session limit"}]}});
  let child=start(f);
  try{
    await watching(f);await sleep(500);
    assert.equal(pending(f),null,'the executor and supervisor share the subscription limit; waking now only fails');
    assert.ok(read(f.statePath).rateLimit.until>Date.now());
    assert.match(fs.readFileSync(path.join(f.run,'監督儀表板.md'),'utf8'),/限速中/);
    await stopWatch(child);
    f.patch(state=>{state.rateLimit.until=Date.now()-1000;});
    child=start(f);
    await until(()=>pending(f)?.kind==='progress_review');
    assert.ok(pending(f).reasons.includes('rate_limit_reset'));assert.ok(pending(f).rateLimit.until);
  }finally{await stopWatch(child);f.done();}
});

test('the reset time is read from Claude\'s own notice, with five hours when it names none',()=>{
  const at=Date.parse('2026-08-13T19:20:36.664Z');
  assert.equal(new Date(signals.resetAfter("You've hit your session limit · resets 3:40am (Asia/Taipei)",at).until).toISOString(),'2026-08-13T19:40:00.000Z');
  assert.equal(new Date(signals.resetAfter("You've hit your limit · resets 8pm (Asia/Taipei)",at).until).toISOString(),'2026-08-14T12:00:00.000Z');
  assert.equal(signals.resetAfter('no time',at).until,at+5*3600000);
});

test('a scheduled turn in a supervised chat is reported so the automation can be paused',async()=>{
  const f=fixture({quietMinutes:0});
  line(f.executorLog,{type:'user',turnOrigin:'scheduled',promptSource:'system',isMeta:true,message:{content:'Scheduled check: read the run and nudge'}});
  const child=start(f);
  try{
    await until(()=>pending(f)?.kind==='progress_review');
    assert.deepEqual(pending(f).reasons,['automation_found']);assert.equal(pending(f).automations[0].chat,'executor');
  }finally{await stopWatch(child);f.done();}
});

test('an executor below Opus at high effort is reported once with the desktop chat to switch',async()=>{
  const f=fixture({quietMinutes:0});
  assistant(f,[{type:'text',text:'working'}],{effort:'medium',message:{id:'m1',model:'claude-sonnet-5-5',stop_reason:'tool_use',content:[{type:'text',text:'working'}]}});
  let child=start(f);
  try{
    await until(()=>pending(f)?.kind==='progress_review');
    assert.deepEqual(pending(f).reasons,['executor_model']);
    assert.equal(pending(f).executorModel.model,'claude-sonnet-5-5');assert.match(pending(f).executorModel.executorDesktopId,/^local_/);
    await stopWatch(child);
    const g=fixture({quietMinutes:0});
    try{
      assistant(g,[{type:'text',text:'working'}],{effort:'high',message:{id:'m2',model:'claude-opus-5-5',stop_reason:'tool_use',content:[{type:'text',text:'working'}]}});
      child=start(g);await watching(g);await sleep(500);
      assert.equal(pending(g),null);
    }finally{await stopWatch(child);g.done();}
  }finally{await stopWatch(child);f.done();}
});

test('one context call returns the event, brief, authorization and rules; an old event id is refused',async()=>{
  const f=fixture();
  final(f,'Which account should K1 use?\nLONG_TASK_EVENT {"kind":"question"}');
  const child=start(f);
  try{
    await until(()=>pending(f)?.kind==='question');await stopWatch(child);
    const event=pending(f),value=cmd(f,'context',event.id);
    assert.equal(value.eventId,event.id);assert.equal(value.detail.kind,'question');
    assert.equal(value.authorization.original,'Isolated QA');assert.ok(value.brief.user);assert.ok('settings' in value.brief.executor);
    assert.match(value.instructions,/三關/);assert.equal(value.decisionPath,path.join(f.run,'decision-'+event.id+'.json'));
    assert.ok(fs.existsSync(value.event.path));
    assert.notEqual(cmdFails(f,'context','old-event').status,0);
  }finally{await stopWatch(child);f.done();}
});

test('Jay can add a criterion that must pass; an archived source moves only with its exact hash',()=>{
  const f=fixture();
  try{
    const quote=path.join(f.root,'quote.md');fs.writeFileSync(quote,'Jay: 加一條 A3，手機版也要測\n');
    const binding=read(path.join(f.run,'binding.json'));
    const input=path.join(f.root,'amend.json');
    save(input,{id:'add-a3',contractSha256:binding.contractSha256,authority:{role:'user',quote:'加一條 A3，手機版也要測',locator:'supervisor chat',at:new Date().toISOString(),source:{path:quote,sha256:sha(quote)}},
      changes:[{id:'A3',action:'add',requirement:'Mobile works',verify:'Run on mobile viewport'}]});
    cmd(f,'amend',input);
    assert.ok(cmd(f,'effective-contract').criteria.some(item=>item.id==='A3'&&item.added));
    const moved=path.join(f.root,'archive','source.md');fs.mkdirSync(path.dirname(moved));fs.copyFileSync(f.source,moved);fs.rmSync(f.source);
    const relocation=path.join(f.root,'relocate.json');
    save(relocation,{schema:1,entries:[{originalPath:f.source,relocatedPath:moved,sha256:sha(moved)}]});
    assert.equal(cmd(f,'relocate-sources',relocation).relocated,1);
    assert.ok(cmd(f,'brief').status,'the run still loads after the archive move');
  }finally{f.done();}
});
