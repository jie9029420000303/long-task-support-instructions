// The supervisor's own clock and AI-speed baselines (Jay 2026-10-07). In the GDB engine-direct run the supervisor
// checked progress 0 times in 6.4 hours: every executor event declared a human-style wait, any new executor step
// cleared the wait's deadline, and the silence check never fired while subagents were busy. A 72-minute package
// against a 13-minute median went unasked. These tests hold the replacement: the supervisor checks on its own
// schedule, a package past 1.5x its token-speed baseline is checked at once, and repeated failures are surfaced.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawn,execFileSync}=require('node:child_process');
const scripts=process.env.CLAUDE_SUPERVISOR_SCRIPTS||path.resolve(__dirname,'../claude-code/.claude/skills/long-task-supervisor/scripts');
const {validateDecision}=require(path.join(scripts,'guard.cjs'));
const pace=require(path.join(scripts,'pace.cjs'));
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const save=(file,value)=>fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n');
const line=(file,value)=>fs.appendFileSync(file,JSON.stringify(value)+'\n');
const minutesAgo=minutes=>new Date(Date.now()-minutes*60000).toISOString();
async function until(check,ms=6000){const end=Date.now()+ms;while(Date.now()<end){if(check())return;await new Promise(resolve=>setTimeout(resolve,40));}throw Error('Timed out waiting for the supervisor clock');}
function fixture({lastReviewMinutesAgo=1,quietMinutes=1}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'claude-supervisor-clock-'));
  const project=path.join(root,'config','projects','qa');fs.mkdirSync(project,{recursive:true});
  const source=path.join(root,'source.md');fs.writeFileSync(source,'Clock criterion\n');
  const supervisorId=crypto.randomUUID(),executorId=crypto.randomUUID(),marker='LONG_TASK_BIND:'+crypto.randomUUID();
  const executorLog=path.join(project,executorId+'.jsonl');
  line(path.join(project,supervisorId+'.jsonl'),{type:'user',sessionId:supervisorId,cwd:root,entrypoint:'claude-desktop'});
  line(executorLog,{type:'user',sessionId:executorId,cwd:root,entrypoint:'claude-desktop',message:{content:[{type:'text',text:marker}]}});
  const run=path.join(root,'run'),input=path.join(root,'input.json');
  save(input,{dispatchAudit:false,projectRoot:root,allowedRoots:[root],supervisorId,
    supervisorDesktopId:'local_'+crypto.randomUUID(),executorId,executorDesktopId:'local_'+crypto.randomUUID(),
    executorMarker:marker,executorPrompt:marker+' test',contract:{goal:'Finish on AI time',authorization:'Isolated QA',
      criteria:[{id:'A1',requirement:'Keep work moving',source:'source.md:1',verify:'Replay activity'}],
      sources:[{path:source,sha256:sha(source)}]}});
  const env={...process.env,CLAUDE_CONFIG_DIR:path.join(root,'config'),CLAUDE_SESSION_ID:supervisorId,CLAUDE_WATCH_SETTLE_MS:'100'};
  execFileSync(process.execPath,[path.join(scripts,'supervise.cjs'),'init',run,input],{env});
  const statePath=path.join(run,'daemon-state.json'),state=JSON.parse(fs.readFileSync(statePath));
  state.lastExecutorActivityAt=Date.now()-quietMinutes*60000;state.lastProgressReviewAt=Date.now()-lastReviewMinutesAgo*60000;save(statePath,state);
  const subagents=path.join(project,executorId,'subagents');fs.mkdirSync(subagents,{recursive:true});
  return {root,run,env,executorId,executorLog,statePath,subagents};
}
function command(f,name,...args){return JSON.parse(execFileSync(process.execPath,[path.join(scripts,'supervise.cjs'),name,f.run,...args],{env:f.env,encoding:'utf8',stdio:'pipe'}));}
function start(f){return spawn(process.execPath,[path.join(scripts,'claude-watch.cjs'),f.run],{env:f.env,stdio:['ignore','pipe','pipe']});}
const pending=f=>JSON.parse(fs.readFileSync(f.statePath)).pending;
// A subagent transcript: `minutes` long, `tokens` output tokens, finished or still running.
function agent(dir,id,{minutes,tokens,done=true,model='claude-sonnet-5-5',endedMinutesAgo=0}){
  const end=Date.now()-endedMinutesAgo*60000,start=end-minutes*60000;
  const rows=[{type:'user',timestamp:new Date(start).toISOString(),isSidechain:true,message:{content:'work package'}},
    {type:'assistant',timestamp:new Date(end).toISOString(),isSidechain:true,message:{id:'msg-'+id,model,stop_reason:done?'end_turn':'tool_use',usage:{output_tokens:tokens},content:[{type:'text',text:'report'}]}}];
  fs.writeFileSync(path.join(dir,'agent-'+id+'.jsonl'),rows.map(row=>JSON.stringify(row)).join('\n')+'\n');
}

test('the baseline comes from this run\'s measured tokens per second, with defaults only before three samples',()=>{
  const runs=[{model:'m',done:true,seconds:600,outputTokens:60000},{model:'m',done:true,seconds:1200,outputTokens:60000},{model:'m',done:true,seconds:300,outputTokens:30000}];
  assert.deepEqual(pace.speed(runs.slice(0,2)),{},'two samples are not a measurement');
  const measured=pace.speed(runs);
  assert.equal(measured.m.tokensPerSecond,100);assert.equal(measured.m.outputTokens,60000);assert.equal(measured.m.samples,3);
  const value=pace.baseline({model:'m',estimatedOutputTokens:30000,toolMinutes:4},measured);
  assert.equal(value.minutes,9,'30000 tokens / 100 tok/s = 5 min, plus 4 measured tool minutes');
  const fallback=pace.baseline({model:'claude-sonnet-5-5'},{});
  assert.equal(fallback.tokensPerSecond,pace.DEFAULTS['claude-sonnet-5-5'].tokensPerSecond);
  assert.match(fallback.basis,/default/);
});

test('the review interval fires while the executor is busy and stays deliverable through new activity',async()=>{
  const f=fixture({lastReviewMinutesAgo:31,quietMinutes:0});let child=start(f);
  try{
    await until(()=>pending(f)?.kind==='progress_review');
    const event=pending(f);
    assert.deepEqual(event.reasons,['interval']);
    line(f.executorLog,{type:'assistant',uuid:crypto.randomUUID(),timestamp:new Date().toISOString(),message:{id:'busy',stop_reason:'tool_use',content:[{type:'text',text:'still integrating'}]}});
    await until(()=>!fs.existsSync(path.join(f.run,'watcher.lock')));
    assert.equal(command(f,'progress-preflight',event.id).current,true,'a busy executor is exactly when the clock must still check');
    const progressCheck={evidence:['dispatch.json and subagent transcripts'],finding:'Every package is inside its baseline.'};
    assert.equal(validateDecision({},{criteria:[]},event,{eventId:event.id,disposition:'observe',reason:'On pace',progressCheck}).disposition,'observe',
      'a normal-pace finding is recorded without messaging the executor');
    const decision=path.join(f.root,'interval.json');save(decision,{eventId:event.id,disposition:'observe',reason:'On pace',progressCheck});
    assert.equal(command(f,'decision',decision).processed,true);
    assert.equal(JSON.parse(fs.readFileSync(f.statePath)).lastProgressReviewAt>Date.now()-60000,true);
  }finally{child.kill('SIGTERM');fs.rmSync(f.root,{recursive:true,force:true});}
});

test('a quiet review still needs a verified wait to observe',()=>{
  const progressCheck={evidence:['transcript'],finding:'Nothing moved.'};
  for(const event of [{id:'q1',kind:'progress_review'},{id:'q2',kind:'progress_review',reasons:['silence']}])
    assert.throws(()=>validateDecision({},{criteria:[]},event,{eventId:event.id,disposition:'observe',reason:'Quiet',progressCheck}),/checked wait/);
});

test('ten quiet minutes inside the interval and baselines do not wake the supervisor',async()=>{
  const f=fixture({lastReviewMinutesAgo:10,quietMinutes:10});
  agent(f.subagents,'aaa',{minutes:5,tokens:20000,done:false});
  save(path.join(f.run,'dispatch.json'),{packages:{inFlight:[{id:'WP-1',handle:'agent:aaa',evidence:['wp/WP-1.md'],
    baseline:{minutes:12,startedAt:minutesAgo(5),basis:'47118 tokens / 66.9 tok/s'}}]}});
  const child=start(f);
  try{
    await until(()=>JSON.parse(fs.readFileSync(f.statePath)).phase==='watching');
    await new Promise(resolve=>setTimeout(resolve,400));
    assert.equal(pending(f),null);
  }finally{child.kill('SIGTERM');fs.rmSync(f.root,{recursive:true,force:true});}
});

test('a package past 1.5x its baseline is checked at once and only once',async()=>{
  const f=fixture();
  agent(f.subagents,'slow',{minutes:19,tokens:30000,done:false});
  save(path.join(f.run,'dispatch.json'),{packages:{inFlight:[{id:'WP-SLOW',handle:'agent:slow',evidence:['wp/WP-SLOW.md'],
    baseline:{minutes:12,startedAt:minutesAgo(19),basis:'47118 tokens / 66.9 tok/s'}}]}});
  let child=start(f);
  try{
    await until(()=>pending(f)?.kind==='progress_review');
    const event=pending(f);
    assert.deepEqual(event.reasons,['overdue']);assert.deepEqual(event.overdue,['WP-SLOW']);
    const item=event.pace.packages.find(value=>value.id==='WP-SLOW');
    assert.equal(item.ratio>=1.5,true);assert.equal(item.outputTokens,30000);
    await until(()=>!fs.existsSync(path.join(f.run,'watcher.lock')));
    assert.equal(command(f,'progress-preflight',event.id).current,true);
    const decision=path.join(f.root,'overdue.json');
    save(decision,{eventId:event.id,disposition:'observe',reason:'Subagent still writing; output growing.',progressCheck:{evidence:['agent-slow.jsonl'],finding:'Behind baseline but producing.'}});
    assert.equal(command(f,'decision',decision).processed,true);
    child=start(f);await until(()=>JSON.parse(fs.readFileSync(f.statePath)).phase==='watching');
    await new Promise(resolve=>setTimeout(resolve,400));
    assert.equal(pending(f),null,'the same overdue package is not announced again; the interval keeps watching it');
  }finally{child.kill('SIGTERM');fs.rmSync(f.root,{recursive:true,force:true});}
});

test('three identical failing commands are surfaced as repeated work',async()=>{
  const f=fixture(),child=start(f);
  try{
    await until(()=>JSON.parse(fs.readFileSync(f.statePath)).phase==='watching');
    for(let i=0;i<3;i++){
      const id='toolu_'+i;
      line(f.executorLog,{type:'assistant',uuid:crypto.randomUUID(),timestamp:new Date().toISOString(),message:{id:'step-'+i,stop_reason:'tool_use',content:[{type:'tool_use',id,name:'Bash',input:{command:'python3 -m pytest tests/test_x.py'}}]}});
      line(f.executorLog,{type:'user',uuid:crypto.randomUUID(),timestamp:new Date().toISOString(),message:{content:[{type:'tool_result',tool_use_id:id,is_error:true,content:'Exit code 1\n1 failed'}]}});
    }
    // The clock checks once a minute; a fresh watcher checks at once.
    child.kill('SIGTERM');await new Promise(resolve=>child.once('exit',resolve));
    const restarted=start(f);
    try{
      await until(()=>pending(f)?.kind==='progress_review');
      const event=pending(f);
      assert.deepEqual(event.reasons,['repeat']);
      assert.deepEqual(event.failedCommands.map(item=>[item.command,item.count]),[['python3 -m pytest tests/test_x.py',3]]);
    }finally{restarted.kill('SIGTERM');}
  }finally{child.kill('SIGTERM');fs.rmSync(f.root,{recursive:true,force:true});}
});

test('the same next action reported twice is treated as stalled',async()=>{
  const f=fixture();let child=start(f);
  const final=(text,id)=>line(f.executorLog,{type:'assistant',uuid:crypto.randomUUID(),timestamp:new Date().toISOString(),message:{id,stop_reason:'end_turn',content:[{type:'text',text}]}});
  try{
    await until(()=>JSON.parse(fs.readFileSync(f.statePath)).phase==='watching');
    final('Waiting.\nLONG_TASK_EVENT {"kind":"progress","nextAction":"Wait for both test lines","waitMinutes":20}','m1');
    line(f.executorLog,{type:'user',message:{content:'next turn'}});
    await new Promise(resolve=>setTimeout(resolve,400));
    assert.equal(pending(f),null,'the first report is a declared wait');
    final('Still waiting.\nLONG_TASK_EVENT {"kind":"progress","nextAction":"Wait for both test lines","waitMinutes":20}','m2');
    line(f.executorLog,{type:'user',message:{content:'next turn'}});
    await until(()=>pending(f)?.kind==='stalled');
  }finally{child.kill('SIGTERM');fs.rmSync(f.root,{recursive:true,force:true});}
});

test('the supervisor recomputes the executor baseline and flags a large mismatch',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'claude-pace-')),executorId='e1',log=path.join(root,executorId+'.jsonl');
  const dir=path.join(root,executorId,'subagents');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(log,'');
  try{
    for(const id of ['a','b','c'])agent(dir,id,{minutes:10,tokens:60000,endedMinutesAgo:30});
    agent(dir,'live',{minutes:4,tokens:9000,done:false});
    const snapshot={packages:{inFlight:[{id:'WP-L',handle:'agent:live',evidence:['wp'],baseline:{minutes:40,startedAt:minutesAgo(4),basis:'human guess'}}]}};
    const result=pace.inFlight({executorLog:log,executorId},snapshot);
    assert.equal(result.speed['claude-sonnet-5-5'].tokensPerSecond,100);
    const item=result.packages[0];
    assert.equal(item.supervisorBaselineMinutes,10);assert.equal(item.executorBaselineMinutes,40);assert.equal(item.mismatch,true);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
