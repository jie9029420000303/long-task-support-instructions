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
function decide(f,event,decision){const file=path.join(f.run,'decision-'+event.id+'.json');save(file,{eventId:event.id,...decision});return file;}
function withHome(home,fn){const old=process.env.CODEX_HOME;process.env.CODEX_HOME=home;try{return fn();}finally{if(old===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=old;}}

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
    assert.deepEqual(event.reasons,['executor_blocked']);assert.equal(event.executorBlocked[0].command,stuck);
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
    assert.deepEqual(event.reasons,['repeat']);assert.deepEqual(event.failedCommands.map(item=>[item.command,item.count]),[[command,3]]);
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

test('an overdue package with fresh output stays model-free, but silence on that package is still reviewed',async()=>{
  const f=fixture({createdMinutesAgo:40});
  subagent(f.home,'executor-qa','/root/producing',{turns:[{start:minutesAgo(30),end:minutesAgo(0.3),tokens:12000},{start:minutesAgo(0.2),tokens:20}]});
  save(path.join(f.run,'dispatch.json'),{packages:{inFlight:[{id:'WP-PRODUCING',handle:'/root/producing',evidence:['wp'],baseline:{minutes:12,startedAt:minutesAgo(30),basis:'measured'}}]}});
  f.start();
  try{
    await until(()=>fs.existsSync(path.join(f.run,'clock.jsonl')));
    assert.equal(pending(f),null);assert.equal(sends(f).length,0);
    assert.ok(read(path.join(f.run,'clock.jsonl')).open.includes('overdue:WP-PRODUCING'),'overrun remains recorded for audit');
    assert.equal(read(f.statePath).clockAnnounced?.['overdue:WP-PRODUCING@'+read(path.join(f.run,'dispatch.json')).packages.inFlight[0].baseline.startedAt],undefined,'fresh output must not consume the later stall notification');
  }finally{await f.stop();}
});

test('successful completion breaks a failure streak instead of waking on scattered old failures',async()=>{
  const f=fixture({createdMinutesAgo:30}),command='npm run import';
  for(const [minutes,exit_code] of [[9,1],[8,1],[7,0],[6,1]])line(f.executorLog,{timestamp:minutesAgo(minutes),type:'event_msg',payload:{type:'item_completed',item:{type:'CommandExecution',command:['/bin/zsh','-lc',command],exit_code,status:exit_code?'failed':'completed'}}});
  f.start();
  try{
    await until(()=>fs.existsSync(path.join(f.run,'clock.jsonl')));
    assert.equal(pending(f),null);assert.equal(sends(f).length,0);
    assert.equal(read(f.statePath).failedCommands[command].count,1);
  }finally{await f.stop();}
});


test('bridge wait failure still delivers the exact question once through the same bound read API',async()=>{
  const f=fixture({final:'Need the approved source.\nLONG_TASK_EVENT {"kind":"question"}'});
  const mock=read(f.mock);mock.waitError={code:-32000,message:'MCP error -32000: Codex app tool request failed'};save(f.mock,mock);
  f.start();
  try{
    await until(()=>pending(f)?.kind==='question'&&sends(f).length===1);
    const state=read(f.statePath);
    assert.equal(state.waitFallback.tool,'wait_threads');
    assert.equal(state.reads,1);assert.equal(state.pending.id,'executor-turn-1');
    assert.ok(state.pending.text.includes('Need the approved source.'));
    assert.equal(state.phase,'awaiting_decision');
  }finally{await f.stop();}
});

test('a wait permission rejection remains an error, never a read fallback',async()=>{
  const f=fixture();const mock=read(f.mock);mock.waitError={code:-32000,message:'Permission denied'};save(f.mock,mock);f.start();
  try{
    await until(()=>read(f.statePath).phase==='error');
    const state=read(f.statePath);assert.match(state.error.message,/Permission denied/);
    assert.equal(state.waitFallback,undefined);assert.equal(sends(f).length,0);
  }finally{await f.stop();}
});


test('fallback keeps checking active work locally without waking a model',async()=>{
  const f=fixture();const mock=read(f.mock);
  mock.waitError={code:-32000,message:'MCP error -32000: Codex app tool request failed'};mock.readTurnStatus='inProgress';save(f.mock,mock);
  f.env.CODEX_WATCH_IDLE_SLEEP_MS='40';f.start();
  try{
    await until(()=>read(f.statePath).reads>=2);
    const state=read(f.statePath);assert.equal(state.phase,'watching');
    assert.equal(state.pending,null);assert.equal(sends(f).length,0);
    assert.equal(state.waitFallback.tool,'wait_threads');
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

test('an overdue package whose process is still running and a quiet log does not wake the supervisor',async()=>{
  const f=fixture({createdMinutesAgo:40}),{spawn:start}=require('node:child_process');
  const worker=start('sleep',['30'],{detached:true,stdio:'ignore'});
  const resources=path.join(f.run,'resources'),evidence=path.join(resources,'import.log');
  fs.mkdirSync(resources);fs.writeFileSync(evidence,'started\n');
  const old=(Date.now()-20*60000)/1000;fs.utimesSync(evidence,old,old);
  save(path.join(f.run,'resources.json'),{resources:[{id:'import',pgid:worker.pid}]});
  save(path.join(f.run,'dispatch.json'),{packages:{inFlight:[{id:'WP-IMPORT',handle:'resource:import',evidence:[evidence],baseline:{minutes:10,startedAt:minutesAgo(30),basis:'measured import'}}]}});
  f.start();
  try{
    await until(()=>fs.existsSync(path.join(f.run,'clock.jsonl')));
    assert.equal(pending(f),null,'running work past its baseline is recorded, not interrupted');
    assert.ok(read(path.join(f.run,'clock.jsonl')).open.includes('overdue:WP-IMPORT'));
  }finally{try{process.kill(-worker.pid);}catch{}await f.stop();}
});
