// The Codex supervisor's own clock and AI-speed baselines, ported from the Claude adapter (Jay 2026-10-07/08). In the
// GDB engine-direct run the supervisor checked progress 0 times in 6.4 hours; a package ran 72 minutes against a
// 13-minute median, a command sat behind a permission prompt for 93 minutes and two lid-closed sleeps stopped the
// run for 78. Code confirms the work moves and stays within its token-speed baseline; only a real problem wakes the
// model, because each model check re-reads the supervisor's whole context. The Codex App tools only show messages,
// so subagent speed, tool calls and command results come from the rollouts Codex keeps under CODEX_HOME/sessions.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const scripts=process.env.CODEX_SUPERVISOR_SCRIPTS||path.resolve(__dirname,'../codex/.agents/skills/long-task-supervisor/scripts');
const {validateDecision}=require(path.join(scripts,'guard.cjs'));
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const save=(file,value)=>fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n');
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const line=(file,value)=>fs.appendFileSync(file,JSON.stringify(value)+'\n');
const minutesAgo=minutes=>new Date(Date.now()-minutes*60000).toISOString();
async function until(check,ms=12000){const end=Date.now()+ms;while(Date.now()<end){if(check())return;await new Promise(resolve=>setTimeout(resolve,50));}throw Error('Timed out waiting for the Codex supervisor clock');}
function today(home){
  const now=new Date(),dir=path.join(home,'sessions',String(now.getFullYear()),String(now.getMonth()+1).padStart(2,'0'),String(now.getDate()).padStart(2,'0'));
  fs.mkdirSync(dir,{recursive:true});return dir;
}
// A Codex subagent rollout: session_meta naming its agent path and root thread, then turns with output totals.
function subagent(home,executorId,agentPath,{turns,model='gpt-5.6-sol'}){
  const id=crypto.randomUUID(),file=path.join(today(home),'rollout-t-'+id+'.jsonl');
  line(file,{timestamp:turns[0].start,type:'session_meta',payload:{id,session_id:executorId,parent_thread_id:executorId,thread_source:'subagent',agent_path:agentPath}});
  line(file,{timestamp:turns[0].start,type:'turn_context',payload:{model}});
  let total=0;
  for(const turn of turns){
    line(file,{timestamp:turn.start,type:'event_msg',payload:{type:'task_started'}});
    total+=turn.tokens;
    line(file,{timestamp:turn.end||turn.start,type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{output_tokens:total}}}});
    if(turn.end)line(file,{timestamp:turn.end,type:'event_msg',payload:{type:'task_complete'}});
  }
  return id;
}
function fixture({createdMinutesAgo=1,quietMinutes=0,dispatchAudit=false,final}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'codex-supervisor-clock-'));
  const home=path.join(root,'codex-home'),source=path.join(root,'source.txt');fs.writeFileSync(source,'Keep the work moving\n');
  const contract={goal:'Finish on AI time',authorization:'Isolated QA',criteria:[{id:'A1',requirement:'Keep work moving',source:'source.txt:1',verify:'Replay activity'}],sources:[{path:source,sha256:sha(source)}]};
  const run=path.join(root,'run');fs.mkdirSync(run);save(path.join(run,'contract.json'),contract);
  const binding={platform:'codex',projectRoot:root,allowedRoots:[root,run],supervisorId:'supervisor-qa',executorId:'executor-qa',callerTurnId:'supervisor-turn',
    contractSha256:sha(path.join(run,'contract.json')),...(dispatchAudit?{dispatchAudit:{enabled:true,snapshot:'dispatch.json'}}:{}),createdAt:minutesAgo(createdMinutesAgo)};
  save(path.join(run,'binding.json'),binding);
  save(path.join(run,'daemon-state.json'),{phase:'starting',cursor:null,seen:[],messages:[],pending:null,inflight:null,reads:0,starts:0,
    lastExecutorActivityAt:Date.now()-quietMinutes*60000,lastProgressReviewAt:Date.now()-quietMinutes*60000});
  const executorLog=path.join(today(home),'rollout-t-executor-qa.jsonl');
  line(executorLog,{timestamp:binding.createdAt,type:'session_meta',payload:{id:'executor-qa',session_id:'executor-qa'}});
  const mock=path.join(root,'mock.json'),sent=path.join(root,'sent.json'),activityGate=path.join(root,'activity');
  save(mock,{supervisorId:binding.supervisorId,executorId:binding.executorId,...(final?{final}:{noTurn:true}),activityGate});
  const bin=path.join(root,'bin');fs.mkdirSync(bin);
  const env={...process.env,CODEX_HOME:home,PATH:bin+':'+process.env.PATH,CODEX_APP_TOOLS_SERVER_PATH:path.join(__dirname,'mock-codex-app-server.cjs'),MOCK_CODEX_FIXTURE:mock,MOCK_CODEX_SENT:sent};
  let child;
  return {root,home,run,binding,executorLog,sent,activityGate,mock,env,statePath:path.join(run,'daemon-state.json'),
    start(){child=spawn(process.execPath,[path.join(scripts,'native-watch.cjs'),run],{env,stdio:['ignore','pipe','pipe']});return child;},
    async stop(){if(child?.exitCode===null){child.kill('SIGTERM');await new Promise(resolve=>child.once('exit',resolve));}fs.rmSync(root,{recursive:true,force:true});},
    // A fake sysctl stands in for the kernel's last sleep.
    kernelSleep(fromMinutesAgo,toMinutesAgo){
      const sec=minutes=>Math.floor((Date.now()-minutes*60000)/1000);
      fs.writeFileSync(path.join(bin,'sysctl'),'#!/bin/sh\necho "{ sec = '+sec(fromMinutesAgo)+', usec = 712345 } slept"\necho "{ sec = '+sec(toMinutesAgo)+', usec = 0 } woke"\n',{mode:0o755});
    }};
}
const pending=f=>read(f.statePath).pending;
const sends=f=>fs.existsSync(f.sent)?read(f.sent):[];
function decide(f,event,decision){const file=path.join(f.run,'draft-decision-'+event.id+'.json');save(file,{eventId:event.id,...decision});require('node:child_process').execFileSync(process.execPath,[path.join(scripts,'supervise.cjs'),'decision',f.run,file],{env:f.env,encoding:'utf8'});return file;}
function withHome(home,fn){const old=process.env.CODEX_HOME;process.env.CODEX_HOME=home;try{return fn();}finally{if(old===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=old;}}

// Jay 2026-11-08 (WEB 20:57: 180 of a 659-second stop were only the 3-minute read): the executor's rollout closing a turn
// ends the wait between reads, so the stop reaches its next owner within seconds; the periodic read stays the fallback.
async function idleWatcher(f){
  Object.assign(f.env,{CODEX_WATCH_IDLE_SLEEP_MS:'60000',CODEX_IDLE_SLICE_MS:'50'});f.start();
  await until(()=>read(f.statePath).executorLog===f.executorLog&&read(f.statePath).reads>=1);
  await new Promise(resolve=>setTimeout(resolve,400));
}
test('a finished executor turn is read within seconds instead of at the next periodic read',async()=>{
  const f=fixture({final:'Continue.\nLONG_TASK_EVENT {"kind":"progress","nextAction":"Run the next check"}'}),gate=path.join(f.root,'turn-ended');
  save(f.mock,{...read(f.mock),noTurnUntil:gate});
  try{
    await idleWatcher(f);assert.equal(sends(f).length,0);
    const ended=Date.now();fs.writeFileSync(gate,'done');
    line(f.executorLog,{timestamp:new Date().toISOString(),type:'event_msg',payload:{type:'task_complete',turn_id:'executor-turn-1'}});
    await until(()=>sends(f).length===1,8000);
    assert.ok(Date.now()-ended<4000,'read within seconds, not after the 60-second periodic read');
    assert.match(sends(f)[0],/LONG_TASK_DELIVERY:continue-executor-turn-1/);
  }finally{await f.stop();}
});
test('a turn the platform failed reaches the supervisor within seconds; a usage limit keeps its 2 minutes',async()=>{
  for(const [info,wakes] of [[{response_stream_disconnected:{http_status_code:null}},true],[{usage_limit_exceeded:{http_status_code:429}},false]]){
    const f=fixture();
    try{
      await idleWatcher(f);const failed=Date.now();
      line(f.executorLog,{timestamp:new Date().toISOString(),type:'event_msg',payload:{type:'task_complete',
        error:{message:'stream disconnected before completion',codex_error_info:info}}});
      if(wakes){
        await until(()=>pending(f)?.reasons?.includes('platform_error'),8000);
        assert.ok(Date.now()-failed<4000,'a failed turn reaches the supervisor at once, not after 2 minutes or the next read');
        assert.equal(pending(f).platformError.kind,'response_stream_disconnected');
      }else{
        await new Promise(resolve=>setTimeout(resolve,2500));
        assert.equal(pending(f),null,'a usage limit waits 2 minutes for the model switch to resume the executor');
        assert.equal(read(f.statePath).platformError.kind,'usage_limit_exceeded');
      }
    }finally{await f.stop();}
  }
});

function parallelGate(f){
  const command='bash scripts/deploy-gate.sh',now=new Date().toISOString();
  line(f.executorLog,{timestamp:now,type:'response_item',payload:{type:'custom_tool_call',name:'exec',call_id:'test-gate',
    input:'await tools.exec_command({cmd:'+JSON.stringify(command)+'});'}});
  line(f.executorLog,{timestamp:now,type:'event_msg',payload:{type:'item_started',item:{type:'CommandExecution',process_id:'fake-gate',command:['/bin/sh','-c',command]}}});
  line(f.executorLog,{timestamp:now,type:'response_item',payload:{type:'custom_tool_call_output',call_id:'test-gate',output:'Script running with cell ID fake:gate'}});
  return ()=>line(f.executorLog,{timestamp:new Date().toISOString(),type:'event_msg',payload:{type:'item_completed',item:{type:'CommandExecution',process_id:'fake-gate',command:['/bin/sh','-c',command],exit_code:0}}});
}
const parallelReply=event=>({disposition:'reply',reply:'Check parallel opportunities now.',
  progressCheck:{evidence:['source position'],finding:'The test looked active.',guidance:'Check parallel opportunities now.'}});

test('parallel test already finished before decision never sends a stale executor instruction',async()=>{
  const f=fixture(),finish=parallelGate(f);f.start();
  try{
    await until(()=>pending(f)?.reasons?.includes('parallel_test_review'));
    const event=pending(f);await until(()=>sends(f).some(text=>text.includes('review-'+event.id)));
    finish();decide(f,event,parallelReply(event));
    await until(()=>read(f.statePath).resolved?.[event.id]?.obsolete);
    assert.equal(sends(f).some(text=>text.includes('answer-'+event.id)),false);
  }finally{await f.stop();}
});

test('parallel test stale in a mixed review keeps the other reason in a new immutable event',async()=>{
  const f=fixture({createdMinutesAgo:80}),finish=parallelGate(f);f.start();
  try{
    await until(()=>pending(f)?.reasons?.includes('parallel_test_review'));
    const event=pending(f);assert.ok(event.reasons.includes('no_event_hour'));
    await until(()=>sends(f).some(text=>text.includes('review-'+event.id)));
    const saved=fs.readFileSync(path.join(f.run,'review-event-'+event.id+'.json'),'utf8');
    finish();decide(f,event,parallelReply(event));
    await until(()=>read(f.statePath).resolved?.[event.id]?.supersededBy);
    const previous=read(f.statePath).resolved[event.id],replacement=previous.supersededBy;
    await until(()=>pending(f)?.id===replacement);
    assert.notEqual(replacement,event.id);assert.ok(pending(f).reasons.includes('no_event_hour'));
    assert.equal(pending(f).reasons.includes('parallel_test_review'),false);
    assert.equal(fs.readFileSync(path.join(f.run,'review-event-'+event.id+'.json'),'utf8'),saved);
    assert.equal(sends(f).some(text=>text.includes('answer-'+event.id)),false);
  }finally{await f.stop();}
});

test('parallel test decision is rechecked after a newly observed agent appears',async()=>{
  const f=fixture();parallelGate(f);f.start();
  try{
    await until(()=>pending(f)?.reasons?.includes('parallel_test_review'));
    const event=pending(f);await until(()=>sends(f).some(text=>text.includes('review-'+event.id)));
    subagent(f.home,'executor-qa','/root/newly-dispatched',{turns:[{start:minutesAgo(.1),tokens:100}]});
    decide(f,event,parallelReply(event));
    await until(()=>read(f.statePath).resolved?.[event.id]?.supersededBy);
    const replacement=read(f.statePath).resolved[event.id].supersededBy;
    await until(()=>pending(f)?.id===replacement);
    assert.ok(pending(f).reasons.includes('parallel_test_review'),'changed records require a fresh review, not an assumed full seat');
    assert.equal(sends(f).some(text=>text.includes('answer-'+event.id)),false,'the old decision must not be sent');
  }finally{await f.stop();}
});

test('parallel review brief reports observed agents without treating missing sources as zero',async()=>{
  const f=fixture();
  try{
    const runBrief=()=>JSON.parse(require('node:child_process').execFileSync(process.execPath,[path.join(scripts,'supervise.cjs'),'brief',f.run],{env:f.env,encoding:'utf8'}));
    subagent(f.home,'executor-qa','/root/working',{turns:[{start:minutesAgo(1),tokens:100}]});
    const found=runBrief().agentActivity;assert.equal(found.coverage,'partial');assert.deepEqual(found.observedActive.map(item=>item.id),['/root/working']);
    fs.unlinkSync(f.executorLog);
    const missing=runBrief().agentActivity;assert.equal(missing.coverage,'unknown');assert.deepEqual(missing.observedActive,[]);
  }finally{await f.stop();}
});

test('subagent speed comes from this executor\'s own rollouts, counting turn time but not the waits between turns',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'codex-pace-')),home=path.join(root,'home');
  try{
    // Three finished packages at 100 tokens/s; two of them waited 50 and 30 minutes between their turns.
    subagent(home,'exec-1','/root/a',{turns:[{start:minutesAgo(40),end:minutesAgo(30),tokens:60000}]});
    subagent(home,'exec-1','/root/b',{turns:[{start:minutesAgo(70),end:minutesAgo(65),tokens:30000},{start:minutesAgo(15),end:minutesAgo(10),tokens:30000}]});
    subagent(home,'exec-1','/root/c',{turns:[{start:minutesAgo(40),end:minutesAgo(37.5),tokens:15000},{start:minutesAgo(7.5),end:minutesAgo(5),tokens:15000}]});
    subagent(home,'exec-other','/root/a',{turns:[{start:minutesAgo(40),end:minutesAgo(39),tokens:900000}]});
    const pace=require(path.join(scripts,'pace.cjs'));
    withHome(home,()=>{
      const binding={executorId:'exec-1',createdAt:minutesAgo(80)},runs=pace.agentRuns(binding);
      assert.equal(runs.length,3,'another executor\'s subagents are not this run\'s');
      const measured=pace.speed(runs);
      assert.equal(measured['gpt-5.6-sol'].tokensPerSecond,100,'two 5-minute turns of 30000 tokens are 100 tok/s, not 60000 tokens over the 60 minutes between them');
      assert.equal(measured['gpt-5.6-sol'].samples,3);
      assert.deepEqual(pace.speed(runs.slice(0,2)),{},'two samples are not a measurement');
      const fallback=pace.baseline({model:'gpt-5.6-sol'},{});
      assert.equal(fallback.tokensPerSecond,pace.DEFAULTS['gpt-5.6-sol'].tokensPerSecond);assert.match(fallback.basis,/default/);
      // Handles are agent paths: a finished agent left in the snapshot is stale, not overdue.
      const paced=pace.inFlight(binding,{packages:{inFlight:[{id:'A',handle:'/root/a',baseline:{minutes:2,startedAt:minutesAgo(40)}},{id:'T',handle:'npm test',evidence:[]}]}});
      assert.equal(paced.packages[0].finished,true);assert.equal(paced.packages[0].ratio,null);
      assert.equal(paced.packages[1].process,true);assert.equal(paced.packages[1].baselineMissing,true);
    });
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('a package past 1.5x its baseline wakes the supervisor while the executor is busy, and busy work does not void it',async()=>{
  const f=fixture({createdMinutesAgo:40});
  subagent(f.home,'executor-qa','/root/slow',{turns:[{start:minutesAgo(30),tokens:12000}]});
  save(path.join(f.run,'dispatch.json'),{packages:{inFlight:[{id:'WP-SLOW',handle:'/root/slow',evidence:['wp/WP-SLOW.md'],
    baseline:{minutes:12,startedAt:minutesAgo(30),basis:'19817 output tokens ÷ 34.9 tokens/s'}}]}});
  f.start();
  try{
    await until(()=>pending(f)?.kind==='progress_review');
    const event=pending(f);
    assert.deepEqual(event.reasons,['overdue']);assert.deepEqual(event.overdue,['WP-SLOW']);
    assert.equal(event.pace.packages[0].ratio,2.5);
    await until(()=>sends(f).some(text=>text.includes(event.id)));
    assert.match(sends(f).at(-1),/brief/);assert.match(sends(f).at(-1),/overdue/);
    // The executor keeps working; an overdue check is meant for exactly that, so it stays current.
    fs.writeFileSync(f.activityGate,'busy');
    assert.equal(validateDecision(f.binding,read(path.join(f.run,'contract.json')),event,{eventId:event.id,disposition:'observe',reason:'On pace after review',
      progressCheck:{evidence:['pace and executor tail'],finding:'Long package, still producing'}}).disposition,'observe','a clock review needs no checked wait');
    decide(f,event,{disposition:'observe',reason:'Package is long but still producing',progressCheck:{evidence:['brief pace'],finding:'Output still growing'}});
    await until(()=>read(f.statePath).resolved?.[event.id]);
    const resolved=read(f.statePath).resolved[event.id];
    assert.equal(resolved.obsolete,undefined);assert.equal(resolved.decision.disposition,'observe');
    assert.equal(sends(f).filter(text=>!text.includes('review-')).length,0,'observe sends nothing to the executor');
  }finally{await f.stop();}
});

test('a silence review still needs a checked wait to observe',()=>{
  const f=fixture();
  try{
    for(const event of [{id:'q1',kind:'progress_review'},{id:'q2',kind:'progress_review',reasons:['silence']}])
      assert.throws(()=>validateDecision(f.binding,read(path.join(f.run,'contract.json')),event,{eventId:event.id,disposition:'observe',reason:'quiet',
        progressCheck:{evidence:['thread'],finding:'nothing new'}}),/checked wait/);
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('subagents still producing keep a quiet executor from counting as silence',async()=>{
  const f=fixture({createdMinutesAgo:20,quietMinutes:20});
  subagent(f.home,'executor-qa','/root/busy',{turns:[{start:minutesAgo(18),end:minutesAgo(0.2),tokens:5000},{start:minutesAgo(0.1),tokens:100}]});
  f.start();
  try{
    await until(()=>fs.existsSync(path.join(f.run,'clock.jsonl')));
    await new Promise(resolve=>setTimeout(resolve,300));
    assert.equal(pending(f),null);
    const record=read(path.join(f.run,'clock.jsonl'));
    assert.ok(Date.parse(record.subagentAt)>Date.now()-60000,'the 30-minute record shows when subagents last moved');
  }finally{await f.stop();}
});

function execCall(f,callId,command,minutes){
  line(f.executorLog,{timestamp:minutesAgo(minutes),type:'response_item',payload:{type:'custom_tool_call',name:'exec',call_id:callId,
    input:'text(await tools.exec_command({cmd:'+JSON.stringify(command)+',yield_time_ms:10000}));'}});
}
test('a command with no result and no process for 5 minutes is reported as needing the user',async()=>{
  const stuck='bash archive_case_'+crypto.randomUUID().replace(/-/g,'')+'.sh uat3';
  const f=fixture({createdMinutesAgo:10});execCall(f,'call_stuck',stuck,6);
  f.start();
  try{
    await until(()=>pending(f)?.kind==='progress_review');
    const event=pending(f);
    assert.deepEqual(event.reasons,['executor_blocked']);assert.equal(event.executorBlocked[0].summary,'指令操作尚未開始');
    const source=event.executorBlocked[0].source;assert.equal(source.path,f.executorLog);assert.ok(Number.isInteger(source.offset));
    const original=JSON.parse(fs.readFileSync(source.path).subarray(source.offset).toString().split('\n')[0]);assert.equal(original.payload.call_id,'call_stuck');assert.ok(original.payload.input.includes(stuck));assert.ok(!JSON.stringify(event).includes(stuck));
    await until(()=>sends(f).some(text=>text.includes(event.id)));
    assert.match(sends(f).at(-1),/executor_blocked/);
  }finally{await f.stop();}
});

test('a command really running, one already answered, or one whose call ran something is not blocked',async()=>{
  const f=fixture({createdMinutesAgo:10}),marker='running_suite_'+crypto.randomUUID().replace(/-/g,'');
  const runner=spawn('/bin/sh',['-c','sleep 30; echo '+marker],{stdio:'ignore'});
  execCall(f,'call_ran','bash second_step_'+crypto.randomUUID().replace(/-/g,'')+'.sh',9);
  line(f.executorLog,{timestamp:minutesAgo(8),type:'event_msg',payload:{type:'item_completed',item:{type:'CommandExecution',command:['/bin/zsh','-lc','first step'],exit_code:0,status:'completed'}}});
  execCall(f,'call_done','bash finished_'+crypto.randomUUID().replace(/-/g,'')+'.sh',8);
  line(f.executorLog,{timestamp:minutesAgo(7),type:'response_item',payload:{type:'custom_tool_call_output',call_id:'call_done',output:'ok'}});
  execCall(f,'call_running','sleep 30; echo '+marker,6);
  f.start();
  try{
    await until(()=>fs.existsSync(path.join(f.run,'clock.jsonl')));
    await new Promise(resolve=>setTimeout(resolve,300));
    assert.equal(pending(f),null);
    const open=read(f.statePath).openTools;
    assert.deepEqual(Object.keys(open).sort(),['call_ran','call_running']);
    assert.equal(open.call_running.ran,undefined,'only the live process keeps this call from counting as blocked');
  }finally{runner.kill('SIGTERM');await f.stop();}
});

test('the same command failing three times wakes the supervisor once, and a review starts the count again',async()=>{
  const f=fixture({createdMinutesAgo:30}),command='npm run test:e2e -- --grep checkout';
  // A failure from before the run was bound is not this run's retry loop.
  line(f.executorLog,{timestamp:minutesAgo(40),type:'event_msg',payload:{type:'item_completed',item:{type:'CommandExecution',command:['/bin/zsh','-lc',command],exit_code:1,status:'failed'}}});
  for(const minutes of [9,6,3])line(f.executorLog,{timestamp:minutesAgo(minutes),type:'event_msg',payload:{type:'item_completed',item:{type:'CommandExecution',command:['/bin/zsh','-lc',command],exit_code:1,status:'failed'}}});
  f.start();
  try{
    await until(()=>pending(f)?.kind==='progress_review');
    const event=pending(f);
    assert.deepEqual(event.reasons,['repeat']);assert.deepEqual(event.failedCommands.map(item=>[item.commandHash,item.count]),[['sha256:'+crypto.createHash('sha256').update(command).digest('hex'),3]]);
    const source=event.failedCommands[0].source;assert.equal(source.path,f.executorLog);assert.ok(Number.isInteger(source.offset));
    assert.equal(JSON.parse(fs.readFileSync(source.path).subarray(source.offset).toString().split('\n')[0]).payload.item.command.at(-1),command);assert.ok(!JSON.stringify(event).includes(command));
    decide(f,event,{disposition:'reply',reply:'Progress check: stop rerunning the full checkout suite; read the first failure and fix it.',
      progressCheck:{evidence:['executor rollout'],finding:'Same failure three times',guidance:'stop rerunning the full checkout suite; read the first failure and fix it.'}});
    await until(()=>read(f.statePath).resolved?.[event.id]);
    assert.deepEqual(read(f.statePath).failedCommands,{});
  }finally{await f.stop();}
});

test('a sleep after binding is reported once and its minutes do not count against a package; one before binding is not',async()=>{
  const before=fixture({createdMinutesAgo:1});before.kernelSleep(90,80);before.start();
  try{
    await until(()=>fs.existsSync(path.join(before.run,'clock.jsonl')));
    await new Promise(resolve=>setTimeout(resolve,300));
    assert.equal(pending(before),null);assert.deepEqual(read(before.statePath).sleeps||[],[]);
  }finally{await before.stop();}
  const f=fixture({createdMinutesAgo:30});f.kernelSleep(17,9);
  subagent(f.home,'executor-qa','/root/napped',{turns:[{start:minutesAgo(19),tokens:9000}]});
  save(path.join(f.run,'dispatch.json'),{packages:{inFlight:[{id:'WP-NAP',handle:'/root/napped',evidence:['wp'],baseline:{minutes:12,startedAt:minutesAgo(19),basis:'measured'}}]}});
  f.start();
  try{
    await until(()=>pending(f)?.kind==='progress_review');
    const event=pending(f);
    assert.deepEqual(event.reasons,['machine_slept'],'19 minutes minus 8 asleep is 11, inside the 12-minute baseline');
    assert.equal(event.machineSlept.length,1);assert.equal(event.pace.packages[0].sleptMinutes,8);
  }finally{await f.stop();}
});

test('the same next step reported twice becomes a stalled event after one continuation',async()=>{
  const step='LONG_TASK_EVENT {"kind":"progress","nextAction":"rerun the import"}';
  const f=fixture();save(f.mock,{supervisorId:'supervisor-qa',executorId:'executor-qa',finals:[step,step]});
  f.start();
  try{
    await until(()=>pending(f)?.kind==='stalled');
    assert.equal(sends(f).filter(text=>text.includes('長任務續接')).length,1);
  }finally{await f.stop();}
});

test('a missing snapshot waits until the executor has seen the run path, then is reviewed',async()=>{
  const quiet=fixture({dispatchAudit:true});quiet.start();
  try{
    await until(()=>fs.existsSync(path.join(quiet.run,'clock.jsonl')));
    await new Promise(resolve=>setTimeout(resolve,300));
    assert.equal(pending(quiet),null,'the binding message may still be queued');
  }finally{await quiet.stop();}
  const f=fixture({dispatchAudit:true});
  save(f.mock,{supervisorId:'supervisor-qa',executorId:'executor-qa',noTurn:true,final:'Bound to '+f.run+'; writing the first snapshot'});
  f.start();
  try{
    await until(()=>pending(f)?.kind==='dispatch_review');
    assert.equal(pending(f).issues[0].kind,'snapshot_missing');
  }finally{await f.stop();}
});

test('an overdue package with fresh output still wakes for the supervisor to assess',async()=>{
  const f=fixture({createdMinutesAgo:40});
  subagent(f.home,'executor-qa','/root/producing',{turns:[{start:minutesAgo(30),end:minutesAgo(0.3),tokens:12000},{start:minutesAgo(0.2),tokens:20}]});
  save(path.join(f.run,'dispatch.json'),{packages:{inFlight:[{id:'WP-PRODUCING',handle:'/root/producing',evidence:['wp'],baseline:{minutes:12,startedAt:minutesAgo(30),basis:'measured'}}]}});
  f.start();
  try{
    await until(()=>pending(f)?.kind==='progress_review');const event=pending(f);
    assert.ok(event.reasons.includes('overdue'));assert.deepEqual(event.overdue,['WP-PRODUCING']);
    assert.ok(Date.parse(event.pace.packages[0].lastActivityAt)>Date.now()-60000,'the package was still producing');
    await until(()=>sends(f).some(text=>text.includes(event.id)));
  }finally{await f.stop();}
});

test('successful completion breaks a failure streak instead of waking on scattered old failures',async()=>{
  const f=fixture({createdMinutesAgo:30}),command='npm run import';
  for(const [minutes,exit_code] of [[9,1],[8,1],[7,0],[6,1]])line(f.executorLog,{timestamp:minutesAgo(minutes),type:'event_msg',payload:{type:'item_completed',item:{type:'CommandExecution',command:['/bin/zsh','-lc',command],exit_code,status:exit_code?'failed':'completed'}}});
  f.start();
  try{
    await until(()=>read(f.statePath).failedCommands?.['sha256:'+crypto.createHash('sha256').update(command).digest('hex')]?.count===1);
    assert.equal(pending(f),null);assert.equal(sends(f).length,0);
    assert.equal(read(f.statePath).failedCommands['sha256:'+crypto.createHash('sha256').update(command).digest('hex')].count,1);
  }finally{await f.stop();}
});


// 2026-10-28: wait_threads failed once the supervisor's turn ended and the run reconnected for 9 hours; since v0.34.0
// the watcher reads the executor with read_thread only.
test('the watcher delivers the exact question once through read_thread and never calls wait_threads',async()=>{
  const f=fixture({final:'Need the approved source.\nLONG_TASK_EVENT {"kind":"question"}'});
  const mock=read(f.mock);mock.waitError={code:-32000,message:'MCP error -32000: Codex app tool request failed'};save(f.mock,mock);
  f.start();
  try{
    await until(()=>pending(f)?.kind==='question'&&sends(f).length===1);
    const state=read(f.statePath);
    assert.equal(fs.readFileSync(f.sent+'.tools','utf8').split('\n').includes('wait_threads'),false);
    assert.equal(state.waitFallback,undefined);
    assert.equal(state.reads,1);assert.equal(state.pending.id,'executor-turn-1');
    assert.ok(state.pending.text.includes('Need the approved source.'));
    assert.equal(state.phase,'awaiting_decision');
  }finally{await f.stop();}
});

test('a read permission rejection stops with the error and is recorded as a read outage',async()=>{
  const f=fixture(),errors=path.join(f.root,'read-errors');fs.writeFileSync(errors,'99');
  const mock=read(f.mock);mock.readErrorFile=errors;mock.readErrorMessage='Permission denied';save(f.mock,mock);f.start();
  try{
    await until(()=>read(f.statePath).phase==='error');
    const state=read(f.statePath);assert.match(state.error.message,/Permission denied/);
    assert.equal(state.appHealth.kind,'read');assert.ok(state.appHealth.failingSince);
    assert.equal(state.readRetries,undefined,'only the App bridge failure is retried');assert.equal(sends(f).length,0);
  }finally{await f.stop();}
});

// 2026-10-29: the App returned the bridge failure without its "MCP error -32000: " prefix and the retry never engaged.
test('a bridge failure without the MCP prefix is retried like the prefixed one',async()=>{
  const f=fixture({final:'Need the approved source.\nLONG_TASK_EVENT {"kind":"question"}'}),errors=path.join(f.root,'read-errors');
  fs.writeFileSync(errors,'2');const mock=read(f.mock);mock.readErrorFile=errors;mock.readErrorMessage='Codex app tool request failed';save(f.mock,mock);
  f.env.LONG_TASK_READ_RETRY_MS='50';f.start();
  try{
    await until(()=>pending(f)?.kind==='question'&&sends(f).length===1);
    const state=read(f.statePath);
    assert.notEqual(state.phase,'error');assert.equal(state.readRetries.length,2);
    assert.equal(state.appHealth.failingSince,undefined,'a read that worked ends the outage');
  }finally{await f.stop();}
});

// 2026-10-19 V32: the executor's last 8 turns at 20000 characters each no longer fit and the watcher stopped for 3 hours.
// 2026-11-13 OPS: App 26.1106 reworded the reply; the watcher matched only the old text and restarted in a loop.
for(const [label,sizeLimitText] of [['the first wording',undefined],['the App 26.1106 wording','Thread history exceeds the read size limit. Try fewer turns. A single oversized turn cannot be read by this tool.']])
test('a read over the size limit is shrunk instead of failing the same way every time ('+label+')',async()=>{
  const f=fixture({final:'Need the approved source.\nLONG_TASK_EVENT {"kind":"question"}'});
  const mock=read(f.mock);mock.sizeLimitChars=50000;if(sizeLimitText)mock.sizeLimitText=sizeLimitText;save(f.mock,mock);f.start();
  try{
    await until(()=>pending(f)?.kind==='question'&&sends(f).length===1);
    const state=read(f.statePath);
    assert.ok(state.readShrinks.length>=2);assert.equal(state.readShrinks.at(-1).to.turnLimit,2);
    assert.ok(state.pending.text.includes('Need the approved source.'));
  }finally{await f.stop();}
});

// 2026-10-11 equity re-review: one transient read_thread bridge error ended a live watcher with a pending event.
test('a transient read failure is retried and the watcher keeps delivering instead of stopping',async()=>{
  const f=fixture({final:'Need the approved source.\nLONG_TASK_EVENT {"kind":"question"}'}),errors=path.join(f.root,'read-errors');
  fs.writeFileSync(errors,'2');const mock=read(f.mock);mock.readErrorFile=errors;save(f.mock,mock);
  f.env.LONG_TASK_READ_RETRY_MS='50';f.start();
  try{
    await until(()=>pending(f)?.kind==='question'&&sends(f).length===1);
    const state=read(f.statePath);
    assert.notEqual(state.phase,'error');assert.equal(state.readRetries.length,2);
    assert.equal(fs.readFileSync(errors,'utf8'),'0');
  }finally{await f.stop();}
});

test('a read that keeps failing still stops with the original error after the retries',async()=>{
  const f=fixture(),errors=path.join(f.root,'read-errors');
  fs.writeFileSync(errors,'99');const mock=read(f.mock);mock.readErrorFile=errors;save(f.mock,mock);
  f.env.LONG_TASK_READ_RETRY_MS='50';f.start();
  try{
    await until(()=>read(f.statePath).phase==='error');
    assert.match(read(f.statePath).error.message,/Codex app tool request failed/);assert.equal(sends(f).length,0);
  }finally{await f.stop();}
});


test('reading keeps checking active work locally without waking a model',async()=>{
  const f=fixture();const mock=read(f.mock);
  mock.readTurnStatus='inProgress';save(f.mock,mock);
  f.env.CODEX_WATCH_IDLE_SLEEP_MS='40';f.start();
  try{
    await until(()=>read(f.statePath).reads>=2);
    const state=read(f.statePath);assert.equal(state.phase,'watching');
    assert.equal(state.pending,null);assert.equal(sends(f).length,0);
    assert.equal(fs.readFileSync(f.sent+'.tools','utf8').split('\n').includes('wait_threads'),false);
  }finally{await f.stop();}
});

// Jay 2026-10-11: an executor can report a baseline so long that a stuck package never counts as overdue. An hour
// with no real executor event is asked about once, even while subagents look busy.
test('an hour without a real executor event wakes the supervisor once even when an inflated baseline hides the stall',async()=>{
  const f=fixture({createdMinutesAgo:70});
  subagent(f.home,'executor-qa','/root/inflated',{turns:[{start:minutesAgo(65),tokens:10},{start:minutesAgo(0.5),tokens:10}]});
  save(path.join(f.run,'dispatch.json'),{packages:{inFlight:[{id:'WP-INFLATED',handle:'/root/inflated',evidence:['wp'],baseline:{minutes:600,startedAt:minutesAgo(65),basis:'executor estimate'}}]}});
  f.start();
  try{
    await until(()=>pending(f)?.kind==='progress_review');
    const event=pending(f);
    assert.deepEqual(event.reasons,['no_event_hour'],'the inflated package is not overdue, so only the hour catches it');
    assert.ok(event.noEventHour.awakeMinutes>=60);
    assert.equal(read(f.statePath).clockAnnounced['no_event_hour:'+Date.parse(f.binding.createdAt)]!==undefined,true,'one question per quiet stretch');
    assert.equal(validateDecision(f.binding,read(path.join(f.run,'contract.json')),event,{eventId:event.id,disposition:'observe',reason:'Asked and on pace',
      progressCheck:{evidence:['brief'],finding:'baseline reviewed'}}).disposition,'observe','an hourly check is not a silence review and needs no checked wait');
  }finally{await f.stop();}
});

test('a real executor event restarts the hour, so a run that keeps reporting is never asked',async()=>{
  const f=fixture({createdMinutesAgo:70}),state=read(f.statePath);
  save(f.statePath,{...state,lastRealEventAt:Date.now()-10*60000});
  f.start();
  try{
    await until(()=>fs.existsSync(path.join(f.run,'clock.jsonl')));
    assert.equal(pending(f),null);assert.equal(sends(f).length,0);
  }finally{await f.stop();}
});

test('an overdue package with a running process still wakes for assessment',async()=>{
  const f=fixture({createdMinutesAgo:40}),{spawn:start}=require('node:child_process');
  const worker=start('sleep',['30'],{detached:true,stdio:'ignore'});
  const resources=path.join(f.run,'resources'),evidence=path.join(resources,'import.log');
  fs.mkdirSync(resources);fs.writeFileSync(evidence,'started\n');
  const old=(Date.now()-20*60000)/1000;fs.utimesSync(evidence,old,old);
  save(path.join(f.run,'resources.json'),{resources:[{id:'import',pgid:worker.pid}]});
  save(path.join(f.run,'dispatch.json'),{packages:{inFlight:[{id:'WP-IMPORT',handle:'resource:import',evidence:[evidence],baseline:{minutes:10,startedAt:minutesAgo(30),basis:'measured import'}}]}});
  f.start();
  try{
    await until(()=>pending(f)?.kind==='progress_review');const event=pending(f);
    assert.ok(event.reasons.includes('overdue'));assert.deepEqual(event.overdue,['WP-IMPORT']);
    assert.equal(event.pace.packages[0].alive,true,'the process is still alive at the overdue review');
  }finally{try{process.kill(-worker.pid);}catch{}await f.stop();}
});

// Claude adapter parity (Jay 2026-10-11): a main line that only polls one background job while criteria are open
// leaves every subagent seat empty; the GDB run spent 10.2 of 23.7 hours like that. Five quiet minutes wake once.
function poll(f,minutes){line(f.executorLog,{timestamp:minutesAgo(minutes),type:'response_item',payload:{type:'function_call',name:'write_stdin',call_id:'p'+minutes,arguments:JSON.stringify({session_id:7,chars:''})}});}
function work(f,minutes){line(f.executorLog,{timestamp:minutesAgo(minutes),type:'response_item',payload:{type:'function_call',name:'exec_command',call_id:'w'+minutes,arguments:JSON.stringify({cmd:'npm test'})}});}
// exec_command hands back a session after its yield time; the job keeps running and the main line only polls it.
function yielded(f,minutes){line(f.executorLog,{timestamp:minutesAgo(minutes),type:'response_item',payload:{type:'function_call_output',call_id:'w'+minutes,output:'Process running with session ID 7'}});}
test('a main line only polling a background job with criteria open wakes the supervisor once to push dispatch',async()=>{
  const f=fixture({createdMinutesAgo:10,quietMinutes:8});
  work(f,8);yielded(f,8);poll(f,3);poll(f,1);
  save(path.join(f.run,'dispatch.json'),{acceptance:{items:[{id:'A1',status:'PASS'},{id:'A2',status:'PENDING'}]},packages:{ready:[{id:'WP-NEXT'}],inFlight:[]}});
  f.start();
  try{
    await until(()=>pending(f)?.kind==='progress_review');
    const event=pending(f);
    assert.deepEqual(event.reasons,['idle_with_work']);
    assert.deepEqual(event.idleWithWork.openCriteria,['A2']);assert.deepEqual(event.idleWithWork.readyPackages,['WP-NEXT']);
    assert.ok(event.idleWithWork.idleMinutes>=5,'polling the job does not count as work');
    assert.equal(validateDecision(f.binding,read(path.join(f.run,'contract.json')),event,{eventId:event.id,disposition:'observe',reason:'Only user approval left',
      progressCheck:{evidence:['brief'],finding:'waiting on approval'}}).disposition,'observe','an idle-work review is not a silence review');
  }finally{await f.stop();}
});

test('an idle executor with every criterion passed and nothing ready is left alone',async()=>{
  const f=fixture({createdMinutesAgo:10,quietMinutes:8});
  save(path.join(f.run,'dispatch.json'),{acceptance:{items:[{id:'A1',status:'PASS'}]},packages:{ready:[],inFlight:[]}});
  f.start();
  try{
    await until(()=>fs.existsSync(path.join(f.run,'clock.jsonl')));
    assert.equal(pending(f),null);assert.equal(sends(f).length,0);
  }finally{await f.stop();}
});

// Document time budget (Jay 2026-10-15): GDB v1.2.0 spent more than 12 hours on documents after 76 minutes of development,
// with 11 supervisor round trips and no one asking whether the time was still worth it. The clock wakes the supervisor
// once at half the budget and once when it is spent, with the numbers; under half it stays quiet.
// Since v0.34.0 only document-writing time counts (Jay 2026-10-29): the fixture records the minutes already used.
const budgetSnapshot=(usedMinutes,f)=>{const startedAt=minutesAgo(300),state=read(f.statePath);state.docTime={key:startedAt,ms:usedMinutes*60000,at:Date.now()};save(f.statePath,state);
  return {docBudget:{startedAt,devMinutes:76,minutes:114,basis:'開發 76 分鐘 × 1.5'},
  acceptance:{items:[{id:'A1',status:'PASS'}]},packages:{ready:[],inFlight:[]}};};

test('a document budget past half wakes the supervisor once with the budget numbers',async()=>{
  const f=fixture({createdMinutesAgo:10});
  save(path.join(f.run,'dispatch.json'),budgetSnapshot(60,f));
  f.start();
  try{
    await until(()=>pending(f)?.kind==='progress_review');
    assert.deepEqual(pending(f).reasons,['doc_budget']);
    const budget=pending(f).docBudget;
    assert.equal(budget.stage,'half');assert.equal(budget.budgetMinutes,114);assert.equal(budget.devMinutes,76);assert.ok(budget.usedMinutes>=59);
  }finally{await f.stop();}
});

test('a spent document budget wakes as spent, and one under half stays quiet',async()=>{
  const spent=fixture({createdMinutesAgo:10}),quiet=fixture({createdMinutesAgo:10});
  save(path.join(spent.run,'dispatch.json'),budgetSnapshot(120,spent));
  save(path.join(quiet.run,'dispatch.json'),budgetSnapshot(20,quiet));
  spent.start();quiet.start();
  try{
    await until(()=>pending(spent)?.kind==='progress_review');
    assert.deepEqual(pending(spent).reasons,['doc_budget']);assert.equal(pending(spent).docBudget.stage,'spent');
    await until(()=>fs.existsSync(path.join(quiet.run,'clock.jsonl')));
    await new Promise(resolve=>setTimeout(resolve,300));
    assert.equal(pending(quiet),null);assert.equal(sends(quiet).length,0);
  }finally{await spent.stop();await quiet.stop();}
});

test('an executor running real commands in one long turn is not idle even without new messages',async()=>{
  const f=fixture({createdMinutesAgo:10,quietMinutes:8});
  work(f,0.5);
  save(path.join(f.run,'dispatch.json'),{acceptance:{items:[{id:'A1',status:'PENDING'}]},packages:{ready:[],inFlight:[]}});
  f.start();
  try{
    await until(()=>fs.existsSync(path.join(f.run,'clock.jsonl')));
    assert.equal(pending(f),null);assert.ok(!read(path.join(f.run,'clock.jsonl')).open.includes('idle_with_work'));
  }finally{await f.stop();}
});

// v0.33.0 (2026-10-16 GDB): the main line's own package (handle "main") kept driving the platform browser while its
// evidence list lagged. Reading only evidence file mtimes called it a stalled process 6 times in 7 hours, and 4 of those
// reviews sent the executor back to rewrite its records instead of testing. The executor's own work is main's activity.
test("a main-line package takes its activity from the executor's own work and is never a stalled process",()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'codex-main-line-')),home=path.join(root,'home'),evidence=path.join(root,'checkpoint.json');
  fs.writeFileSync(evidence,'{}');const old=Date.now()-40*60000;fs.utimesSync(evidence,old/1000,old/1000);
  try{
    const pace=require(path.join(scripts,'pace.cjs'));
    withHome(home,()=>{
      const binding={executorId:'exec-1',createdAt:minutesAgo(60)};
      const snapshot={packages:{inFlight:[{id:'G3-main',handle:'main',evidence:[evidence],baseline:{minutes:8,startedAt:minutesAgo(50)}}]}};
      const workAt=Date.now()-60000,paced=pace.inFlight(binding,snapshot,Date.now(),[],workAt),item=paced.packages[0];
      assert.equal(item.process,false,'the main line is not a test process');assert.equal(item.main,true);
      assert.equal(Date.parse(item.lastActivityAt),workAt,'its latest real tool call, not the 40-minute-old checkpoint');
      assert.equal(paced.processActivityAt,workAt,'its work still keeps the run from counting as silent');
      const quiet=pace.inFlight(binding,snapshot,Date.now(),[]).packages[0];
      assert.ok(Math.abs(Date.parse(quiet.lastActivityAt)-old)<1000,'without executor work the evidence still counts');
      assert.equal(quiet.process,false);
      const tests=pace.inFlight(binding,{packages:{inFlight:[{id:'T',handle:'resource:r1',evidence:[evidence]}]}},Date.now(),[],workAt).packages[0];
      assert.equal(tests.process,true,'a test process still reads only its own evidence');assert.ok(Math.abs(Date.parse(tests.lastActivityAt)-old)<1000);
    });
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('a main line still working with a 20-minute-old checkpoint does not wake the supervisor as a stalled process',async()=>{
  const f=fixture({createdMinutesAgo:40}),evidence=path.join(f.root,'checkpoint.json');
  fs.writeFileSync(evidence,'{}');const old=(Date.now()-20*60000)/1000;fs.utimesSync(evidence,old,old);
  work(f,1);
  save(path.join(f.run,'dispatch.json'),{packages:{inFlight:[{id:'G3-main-a11y',handle:'main',evidence:[evidence],baseline:{minutes:300,startedAt:minutesAgo(30),basis:'measured'}}]}});
  f.start();
  try{
    await until(()=>fs.existsSync(path.join(f.run,'clock.jsonl')));
    assert.equal(pending(f),null,'a main line still driving the browser is not stalled');
  }finally{await f.stop();}
});
