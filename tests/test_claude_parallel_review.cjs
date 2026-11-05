// A full-test tool call is a lead, not proof that agents are idle, a test ran or a rule was broken.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {spawn,spawnSync,execFileSync}=require('node:child_process');
const scripts=path.resolve(__dirname,'../claude-code/.claude/skills/long-task-supervisor/scripts');
const parallel=require(path.join(scripts,'parallel-test-review.cjs'));
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const save=(file,value)=>fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n');
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const line=(file,value)=>fs.appendFileSync(file,JSON.stringify(value)+'\n');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,ms=6000){const end=Date.now()+ms;while(Date.now()<end){if(check())return;await sleep(40);}throw Error('Timed out');}
function fixture(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'claude-parallel-review-')),bin=path.join(root,'bin');fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin,'sysctl'),'#!/bin/sh\necho "{ sec = 1000000, usec = 0 } x"\necho "{ sec = 1000000, usec = 0 } x"\n',{mode:0o755});
  const project=path.join(root,'config','projects','qa');fs.mkdirSync(project,{recursive:true});
  const source=path.join(root,'source.md');fs.writeFileSync(source,'Parallel criterion\n');
  const supervisorId=crypto.randomUUID(),executorId=crypto.randomUUID(),marker='LONG_TASK_BIND:'+crypto.randomUUID();
  const executorLog=path.join(project,executorId+'.jsonl'),supervisorLog=path.join(project,supervisorId+'.jsonl');
  line(supervisorLog,{type:'user',sessionId:supervisorId,cwd:root,entrypoint:'claude-desktop'});
  line(executorLog,{type:'user',sessionId:executorId,cwd:root,entrypoint:'claude-desktop',message:{content:[{type:'text',text:marker}]}});
  const run=path.join(root,'run'),input=path.join(root,'input.json');
  save(input,{dispatchAudit:false,loginSites:[],projectRoot:root,allowedRoots:[root],supervisorId,
    supervisorDesktopId:'local_'+crypto.randomUUID(),executorId,executorDesktopId:'local_'+crypto.randomUUID(),
    executorMarker:marker,executorPrompt:marker+' test',contract:{goal:'Finish safely',authorization:'Isolated test',
      criteria:[{id:'A1',requirement:'Keep useful work moving',source:'source.md:1',verify:'Replay activity'}],sources:[{path:source,sha256:sha(source)}]}});
  const env={...process.env,PATH:bin+path.delimiter+process.env.PATH,CLAUDE_CONFIG_DIR:path.join(root,'config'),CLAUDE_SESSION_ID:supervisorId,CLAUDE_WATCH_SETTLE_MS:'100'};
  execFileSync(process.execPath,[path.join(scripts,'supervise.cjs'),'init',run,input],{env,stdio:'pipe'});
  const subagents=path.join(project,executorId,'subagents');fs.mkdirSync(subagents,{recursive:true});
  const statePath=path.join(run,'daemon-state.json');
  return {root,run,env,executorId,executorLog,subagents,statePath,done(){fs.rmSync(root,{recursive:true,force:true});}};
}
function writeCall(f,id,command,background=false){line(f.executorLog,{type:'assistant',uuid:crypto.randomUUID(),timestamp:new Date().toISOString(),message:{id:crypto.randomUUID(),stop_reason:'tool_use',content:[{type:'tool_use',name:'Bash',id,input:{command,run_in_background:background}}]}});}
function writeAgentPoll(f,id,status){const callId='poll-'+id+'-'+crypto.randomUUID();line(f.executorLog,{type:'assistant',uuid:crypto.randomUUID(),timestamp:new Date().toISOString(),message:{id:crypto.randomUUID(),stop_reason:'tool_use',content:[{type:'tool_use',name:'TaskOutput',id:callId,input:{task_id:id}}]}});writeResult(f,callId,{toolUseResult:{task:{task_id:id,task_type:'local_agent',status}}});}
function writeResult(f,id,{is_error=false,content='done',toolUseResult}={}){line(f.executorLog,{type:'user',timestamp:new Date().toISOString(),...(toolUseResult?{toolUseResult}:{}),message:{content:[{type:'tool_result',tool_use_id:id,is_error,content}]}});}
function writeNotification(f,id,status='completed'){line(f.executorLog,{type:'user',turnOrigin:'task_notification',timestamp:new Date().toISOString(),message:{content:'<task-notification><task-id>'+id+'</task-id><status>'+status+'</status></task-notification>'}});}
function start(f){const p=spawn(process.execPath,[path.join(scripts,'claude-watch.cjs'),f.run],{env:f.env,stdio:['ignore','pipe','pipe']});p.out='';p.stdout.on('data',v=>p.out+=v);return p;}
async function stop(p){if(p.exitCode===null&&p.signalCode===null){const done=new Promise(resolve=>p.once('exit',resolve));p.kill('SIGTERM');await done;}}
const cmd=(f,name,...args)=>JSON.parse(execFileSync(process.execPath,[path.join(scripts,'supervise.cjs'),name,f.run,...args],{env:f.env,encoding:'utf8',stdio:'pipe'}));
const pending=f=>read(f.statePath).pending;
function observe(f,event){assert.equal(cmd(f,'progress-preflight',event.id).current,true);const file=path.join(f.root,'decision.json');save(file,{eventId:event.id,disposition:'observe',reason:'Checked source and real capacity.',progressCheck:{evidence:['test fixture'],finding:'No action before confirming dependencies.'}});assert.equal(cmd(f,'decision',file).processed,true);}

test('only an explicit shell marker or an invoked gate, not comments or reading a gate file, is a lead',()=>{
  assert.equal(parallel.recognized('# LONG_TASK_LONG_TEST\nnpm run verify'),true);
  assert.equal(parallel.recognized('bash /workspace/deploy-gate.sh'),true);
  assert.equal(parallel.recognized('./scripts/full-gate.sh --candidate'),true);
  assert.equal(parallel.recognized('cat /workspace/deploy-gate.sh'),false);
  assert.equal(parallel.recognized('echo "# LONG_TASK_LONG_TEST"'),false);
  assert.equal(parallel.recognized("printf '%s' 'just reading; ./test-gate.sh'"),false);
  assert.equal(parallel.recognized('cat "x; ./test-gate.sh"'),false);
  assert.equal(parallel.recognized('# comment only; ./test-gate.sh\nprintf done'),false);
  assert.equal(parallel.recognized('# LONG_TASK_LONG_TEST'),false);
  assert.equal(parallel.recognized('npm test -- single.test.js'),false);
});
test('only an acknowledged background call wakes once with a locator and no command or secret',async()=>{
  const f=fixture(),secret='synthetic-private-62r4';let child;
  try{
    // A same-named OS process cannot prove this particular tool call was authorized or launched.
    fs.writeFileSync(path.join(f.root,'bin','ps'),'#!/bin/sh\necho "npm run full-suite synthetic-private-62r4"\n',{mode:0o755});
    writeCall(f,'call-long','# LONG_TASK_LONG_TEST\nnpm run full-suite '+secret,true);
    child=start(f);await until(()=>read(f.statePath).phase==='watching');await sleep(250);assert.equal(pending(f),null);
    writeResult(f,'call-long',{toolUseResult:{backgroundTaskId:'task-42',interrupted:false}});
    await until(()=>pending(f)?.reasons?.includes('parallel_test_review'));await stop(child);
    const event=pending(f),testLead=event.parallelTestReview.tests[0];
    assert.equal(testLead.source.path,f.executorLog);assert.equal(testLead.source.callId,'call-long');assert.equal(testLead.status,'unknown');
    assert.equal(JSON.stringify(event).includes(secret),false);assert.equal(JSON.stringify(read(f.statePath)).includes(secret),false);
    const brief=cmd(f,'brief');assert.equal(brief.agentActivity.available,true);assert.deepEqual(brief.agentActivity.agents,[]);
    observe(f,event);child=start(f);await until(()=>read(f.statePath).phase==='watching');await sleep(250);assert.equal(pending(f),null,'restart must not repeat the same call');
  }finally{if(child)await stop(child);f.done();}
});
test('a call finished or rejected before observation is not mistaken for a running test',async()=>{
  for(const is_error of [false,true]){
    const f=fixture();let child;
    try{writeCall(f,'call-fast','bash /tmp/deploy-gate.sh');writeResult(f,'call-fast',{is_error});child=start(f);await until(()=>read(f.statePath).phase==='watching');await sleep(300);assert.equal(pending(f),null);assert.deepEqual(read(f.statePath).parallelTestCandidates,[]);}
    finally{if(child)await stop(child);f.done();}
  }
});
test('a background tool result remains unknown and is not redelivered after the review',async()=>{
  const f=fixture();let child;
  try{writeCall(f,'background-test','# LONG_TASK_LONG_TEST\nnpm test',true);writeResult(f,'background-test',{content:'launched',toolUseResult:{backgroundTaskId:'task-1',interrupted:false}});child=start(f);
    await until(()=>pending(f)?.reasons?.includes('parallel_test_review'));await stop(child);const event=pending(f);
    assert.equal(event.parallelTestReview.tests[0].status,'unknown');observe(f,event);child=start(f);await until(()=>read(f.statePath).phase==='watching');await sleep(250);assert.equal(pending(f),null);
  }finally{if(child)await stop(child);f.done();}
});
test('pause and STOP take precedence over test leads',async()=>{
  const f=fixture();let child;
  try{
    save(path.join(f.run,'PAUSED.json'),{at:new Date().toISOString()});writeCall(f,'paused-test','bash /tmp/deploy-gate.sh',true);
    writeResult(f,'paused-test',{toolUseResult:{backgroundTaskId:'paused-task',interrupted:false}});child=start(f);
    await until(()=>read(f.statePath).phase==='watching');await sleep(250);assert.equal(pending(f),null);
    writeResult(f,'poll',{toolUseResult:{task:{task_id:'paused-task',task_type:'local_bash',status:'completed'}}});
    await until(()=>read(f.statePath).parallelTestCandidates?.length===0);fs.unlinkSync(path.join(f.run,'PAUSED.json'));
    line(f.executorLog,{type:'system',timestamp:new Date().toISOString()});await sleep(250);assert.equal(pending(f),null,'a test completed while paused cannot wake after resume');
  }finally{if(child)await stop(child);f.done();}
  const g=fixture();let stopped;
  try{fs.writeFileSync(path.join(g.run,'STOP'),'test');writeCall(g,'stopped-test','bash /tmp/deploy-gate.sh');stopped=start(g);await new Promise(resolve=>stopped.once('exit',resolve));assert.equal(pending(g),null);}
  finally{if(stopped)await stop(stopped);g.done();}
});
test('unreadable agent source is unknown instead of zero agents',()=>{
  const f=fixture();try{fs.rmSync(f.subagents,{recursive:true});const brief=cmd(f,'brief');assert.equal(brief.agentActivity.available,false);assert.equal(brief.agentActivity.status,'unknown');assert.equal(Object.hasOwn(brief.agentActivity,'agents'),false);}
  finally{f.done();}
});
test('an in-flight transcript started before binding remains visible instead of being silently omitted',()=>{
  const f=fixture();try{
    line(path.join(f.subagents,'agent-existing.jsonl'),{type:'assistant',timestamp:'2020-01-01T00:00:00.000Z',message:{stop_reason:'tool_use',content:[]}});
    const brief=cmd(f,'brief');assert.equal(brief.agentActivity.coverage,'unknown');assert.equal(brief.agentActivity.agents[0].id,'existing');assert.equal(brief.agentActivity.agents[0].status,'no_end_recorded');
  }finally{f.done();}
});
test('only current platform checks suppress a full-capacity lead; absence in the next scan becomes unknown',()=>{
  const startedAt='2026-11-05T01:00:00.000Z',watchStartedAt=Date.parse(startedAt),state={parallelTestCandidates:[{source:{path:'/tmp/transcript',offset:0,callId:'c'},startedAt,confirmedAt:startedAt,commandHash:'sha256:synthetic',status:'started',taskId:'test-1'}]};
  const snapshot={capacity:{verified:2},packages:{inFlight:[{handle:'agent:a'},{handle:'agent:b'}]}};
  const agents={available:true,runs:[{id:'a',done:false},{id:'b',done:false}]};
  const observed={a:{status:'running',at:'2026-11-05T01:00:01.000Z'},b:{status:'running',at:'2026-11-05T01:00:01.000Z'}};
  assert.equal(parallel.take(state,snapshot,agents,observed,watchStartedAt),null);assert.equal(state.parallelTestCandidates.length,1);
  assert.equal(parallel.take(state,snapshot,agents,{},watchStartedAt).tests[0].source.callId,'c','the next scan with no live check is unknown');
  assert.equal(parallel.take(state,snapshot,agents,{},watchStartedAt),null,'each test still produces at most one lead');
  const unknown={parallelTestCandidates:[{source:{callId:'d'},startedAt,status:'started',taskId:'test-2'}]};
  assert.equal(parallel.take(unknown,snapshot).tests[0].source.callId,'d','missing agent status is not treated as full capacity');
  const earlier={parallelTestCandidates:[{source:{callId:'e'},startedAt,confirmedAt:startedAt,status:'started',taskId:'test-3'}]};
  const stale={a:{status:'running',at:'2026-11-05T00:00:00.000Z'},b:{status:'running',at:'2026-11-05T00:00:00.000Z'}};
  const active={available:true,runs:[{id:'a',done:false,lastAt:Date.parse('2026-11-05T01:00:01.000Z')},{id:'b',done:false,lastAt:Date.parse('2026-11-05T01:00:01.000Z')}]};
  assert.equal(parallel.take(earlier,snapshot,active,stale,watchStartedAt).tests[0].source.callId,'e','old running records cannot become live through transcript activity');
  const restarted={parallelTestCandidates:[{source:{callId:'r'},startedAt,confirmedAt:startedAt,status:'started',taskId:'test-4'}]};
  assert.equal(parallel.take(restarted,snapshot,agents,observed,Date.parse('2026-11-05T01:02:00.000Z')).tests[0].source.callId,'r','old running rows replayed after watcher restart are unknown');
});
test('async launch is not a live status and unrelated TaskOutput cannot prove a seat occupied',()=>{
  const state={},observed={},at='2026-11-05T01:00:01.000Z';
  parallel.observeAgentStatus(state,{type:'user',timestamp:at,toolUseResult:{isAsync:true,status:'async_launched',agentId:'a'},message:{content:[{type:'tool_result',tool_use_id:'spawn'}]}},observed);
  assert.deepEqual(observed,{});
  parallel.observeAgentStatus(state,{type:'assistant',message:{content:[{type:'tool_use',name:'TaskOutput',id:'poll',input:{task_id:'b'}}]}},observed);
  parallel.observeAgentStatus(state,{type:'user',timestamp:at,toolUseResult:{task:{task_id:'a',task_type:'local_agent',status:'running'}},message:{content:[{type:'tool_result',tool_use_id:'poll'}]}},observed);
  assert.deepEqual(observed,{},'a status for the wrong task ID cannot prove capacity');
});
test('a progress notification or another task completion cannot clear a test candidate',()=>{
  const state={parallelTestCandidates:[{source:{callId:'call'},taskId:'task-a',status:'started'}]};
  const note=text=>({type:'user',turnOrigin:'task_notification',timestamp:'2026-11-05T01:00:00Z',message:{content:text}});
  parallel.notification(state,note('<task-notification><task-id>task-a</task-id><event>progress</event></task-notification>'));
  parallel.notification(state,note('<task-notification><task-id>task-b</task-id><status>completed</status></task-notification>'));
  assert.equal(state.parallelTestCandidates.length,1);
  parallel.notification(state,note('<task-notification><task-id>task-a</task-id><status>completed</status></task-notification>'));
  assert.equal(state.parallelTestCandidates.length,0);
});
test('watcher rechecks once when a full-capacity observation is followed by unknown status',async()=>{
  const f=fixture();let child;
  try{
    const now=new Date().toISOString(),items=['a','b'].map(id=>({id:'WP-'+id,handle:'agent:'+id,exclusiveResources:[],evidence:['fixture'],baseline:{minutes:30,startedAt:now,basis:'measured'}}));
    save(path.join(f.run,'dispatch.json'),{schemaVersion:1,executorId:f.executorId,planningRevision:'v1',activity:'working',capacity:{verified:2,evidence:['fixture']},
      packages:{ready:[],inFlight:items,returned:[],blocked:[],completed:[],recurringRework:[]}});
    child=start(f);await until(()=>read(f.statePath).phase==='watching');
    // Append the acknowledged test and both fresh platform reads in one atomic batch after the watcher starts.
    const at=new Date(Date.now()+2).toISOString(),records=[
      {type:'assistant',uuid:crypto.randomUUID(),timestamp:at,message:{id:crypto.randomUUID(),stop_reason:'tool_use',content:[{type:'tool_use',name:'Bash',id:'test-full',input:{command:'# LONG_TASK_LONG_TEST\nnpm run full-suite',run_in_background:true}}]}},
      {type:'user',timestamp:at,toolUseResult:{backgroundTaskId:'test-task',interrupted:false},message:{content:[{type:'tool_result',tool_use_id:'test-full',content:'started'}]}}
    ];
    for(const id of ['a','b']){
      line(path.join(f.subagents,'agent-'+id+'.jsonl'),{type:'assistant',timestamp:at,message:{stop_reason:'tool_use',content:[]}});
      records.push({type:'assistant',uuid:crypto.randomUUID(),timestamp:at,message:{id:crypto.randomUUID(),stop_reason:'tool_use',content:[{type:'tool_use',name:'TaskOutput',id:'poll-'+id,input:{task_id:id}}]}});
      records.push({type:'user',timestamp:at,toolUseResult:{task:{task_id:id,task_type:'local_agent',status:'running'}},message:{content:[{type:'tool_result',tool_use_id:'poll-'+id,content:'running'}]}});
    }
    fs.appendFileSync(f.executorLog,records.map(row=>JSON.stringify(row)).join('\n')+'\n');
    // Full in that scan is asserted by the preceding unit test. A later scan with no live response is unknown.
    await until(()=>pending(f)?.reasons?.includes('parallel_test_review'));await stop(child);
    const event=pending(f);assert.equal(event.parallelTestReview.tests.length,1);assert.equal(event.parallelTestReview.tests[0].status,'unknown');
    observe(f,event);child=start(f);await until(()=>read(f.statePath).phase==='watching');await sleep(250);
    assert.equal(pending(f),null,'the unknown capacity reminder is not repeated after restart');
  }finally{if(child)await stop(child);f.done();}
});
test('preflight retires a sole lead when that same task ends and preserves the original event',async()=>{
  const f=fixture();let child;
  try{writeCall(f,'old-call','# LONG_TASK_LONG_TEST\nnpm run full',true);writeResult(f,'old-call',{toolUseResult:{backgroundTaskId:'old-task'}});child=start(f);
    await until(()=>pending(f)?.reasons?.includes('parallel_test_review'));await stop(child);const original=pending(f);writeNotification(f,'old-task');
    const result=cmd(f,'progress-preflight',original.id);assert.equal(result.current,false);assert.equal(result.parallelTestReview.tests[0].status,'ended');
    const state=read(f.statePath);assert.equal(state.pending,null);assert.deepEqual(state.resolved[original.id].event,original);
  }finally{if(child)await stop(child);f.done();}
});
test('a cleared lead cannot erase another reason from the original event',async()=>{
  const f=fixture();let child;
  try{writeCall(f,'mixed-call','# LONG_TASK_LONG_TEST\nnpm run full',true);writeResult(f,'mixed-call',{toolUseResult:{backgroundTaskId:'mixed-task'}});child=start(f);
    await until(()=>pending(f)?.reasons?.includes('parallel_test_review'));await stop(child);
    const state=read(f.statePath);state.pending.reasons.push('executor_blocked');save(f.statePath,state);const original=pending(f);writeNotification(f,'mixed-task');
    const result=cmd(f,'progress-preflight',original.id);assert.equal(result.current,true);assert.equal(result.parallelTestReview.status,'cleared');
    assert.deepEqual(pending(f),original,'mixed event must keep its immutable original evidence');
  }finally{if(child)await stop(child);f.done();}
});
test('unreadable test source stays unknown and the original event remains pending',async()=>{
  const f=fixture();let child;
  try{writeCall(f,'unknown-call','# LONG_TASK_LONG_TEST\nnpm run full',true);writeResult(f,'unknown-call',{toolUseResult:{backgroundTaskId:'unknown-task'}});child=start(f);
    await until(()=>pending(f)?.reasons?.includes('parallel_test_review'));await stop(child);const original=pending(f);fs.renameSync(f.executorLog,f.executorLog+'.unavailable');
    const result=cmd(f,'progress-preflight',original.id);assert.equal(result.current,true);assert.equal(result.parallelTestReview.tests[0].status,'unknown');assert.deepEqual(pending(f),original);
  }finally{if(child)await stop(child);f.done();}
});
test('delivery preflight rechecks a lead if the test ends after progress preflight',async()=>{
  const f=fixture();let child;
  try{writeCall(f,'race-call','# LONG_TASK_LONG_TEST\nnpm run full',true);writeResult(f,'race-call',{toolUseResult:{backgroundTaskId:'race-task'}});child=start(f);
    await until(()=>pending(f)?.reasons?.includes('parallel_test_review'));await stop(child);const event=pending(f),context=cmd(f,'context',event.id),binding=read(path.join(f.run,'binding.json'));
    assert.equal(cmd(f,'progress-preflight',event.id).current,true);writeNotification(f,'race-task');
    const draft=path.join(f.root,'draft.json');save(draft,{eventId:event.id,disposition:'reply',reply:'Check the current test',progressCheck:{evidence:['fixture'],finding:'Check state',guidance:'Check the current test'}});
    const result=spawnSync(process.execPath,[path.join(scripts,'supervise.cjs'),'decision-preflight',f.run,draft,context.event.sha256,binding.contractSha256,'-'],{env:f.env,encoding:'utf8'});
    assert.notEqual(result.status,0,'a completed test must not generate a stale instruction');assert.match(result.stderr,/long-test lead is no longer current/);
    assert.equal(cmd(f,'progress-preflight',event.id).current,false);
  }finally{if(child)await stop(child);f.done();}
});
test('a different background task ending cannot retire the test lead',async()=>{
  const f=fixture();let child;
  try{writeCall(f,'distinct-call','# LONG_TASK_LONG_TEST\nnpm run full',true);writeResult(f,'distinct-call',{toolUseResult:{backgroundTaskId:'actual-task'}});child=start(f);
    await until(()=>pending(f)?.reasons?.includes('parallel_test_review'));await stop(child);const original=pending(f);writeNotification(f,'other-task');
    const result=cmd(f,'progress-preflight',original.id);assert.equal(result.current,true);assert.equal(result.parallelTestReview.status,'unknown');assert.deepEqual(pending(f),original);
  }finally{if(child)await stop(child);f.done();}
});
