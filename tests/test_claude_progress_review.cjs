const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawn,execFileSync}=require('node:child_process');
const scripts=process.env.CLAUDE_SUPERVISOR_SCRIPTS||path.resolve(__dirname,'../claude-code/.claude/skills/long-task-supervisor/scripts');
const {validateDecision,PROGRESS_REVIEW_MS}=require(path.join(scripts,'guard.cjs'));
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const save=(file,value)=>fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n');
const line=(file,value)=>fs.appendFileSync(file,JSON.stringify(value)+'\n');
async function until(check,ms=6000){const end=Date.now()+ms;while(Date.now()<end){if(check())return;await new Promise(resolve=>setTimeout(resolve,40));}throw Error('Timed out waiting for progress review');}
function fixture(quietMinutes=16){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'claude-progress-review-'));
  const project=path.join(root,'config','projects','qa');fs.mkdirSync(project,{recursive:true});
  const source=path.join(root,'source.md');fs.writeFileSync(source,'Review criterion\n');
  const supervisorId=crypto.randomUUID(),executorId=crypto.randomUUID(),marker='LONG_TASK_BIND:'+crypto.randomUUID();
  const executorLog=path.join(project,executorId+'.jsonl');
  line(path.join(project,supervisorId+'.jsonl'),{type:'user',sessionId:supervisorId,cwd:root,entrypoint:'claude-desktop'});
  line(executorLog,{type:'user',sessionId:executorId,cwd:root,entrypoint:'claude-desktop',message:{content:[{type:'text',text:marker}]}});
  const run=path.join(root,'run'),input=path.join(root,'input.json');
  save(input,{dispatchAudit:false,projectRoot:root,allowedRoots:[root],supervisorId,
    supervisorDesktopId:'local_'+crypto.randomUUID(),executorId,executorDesktopId:'local_'+crypto.randomUUID(),
    executorMarker:marker,executorPrompt:marker+' test',contract:{goal:'Keep executor moving',authorization:'Isolated QA',
      criteria:[{id:'A1',requirement:'Follow up on stalled work',source:'source.md:1',verify:'Replay activity'}],
      sources:[{path:source,sha256:sha(source)}]}});
  const env={...process.env,CLAUDE_CONFIG_DIR:path.join(root,'config'),CLAUDE_SESSION_ID:supervisorId,CLAUDE_WATCH_SETTLE_MS:'100'};
  execFileSync(process.execPath,[path.join(scripts,'supervise.cjs'),'init',run,input],{env});
  const statePath=path.join(run,'daemon-state.json'),state=JSON.parse(fs.readFileSync(statePath));
  state.lastExecutorActivityAt=Date.now()-quietMinutes*60000;save(statePath,state);
  return {root,run,env,executorLog,statePath};
}
function command(f,name,...args){return JSON.parse(execFileSync(process.execPath,[path.join(scripts,'supervise.cjs'),name,f.run,...args],{env:f.env,encoding:'utf8',stdio:'pipe'}));}
function start(f){return spawn(process.execPath,[path.join(scripts,'claude-watch.cjs'),f.run],{env:f.env,stdio:['ignore','pipe','pipe']});}

test('fourteen quiet minutes stay below the fifteen-minute review threshold',async()=>{
  assert.equal(PROGRESS_REVIEW_MS,15*60000);
  const f=fixture(14),child=start(f);
  try{
    await until(()=>JSON.parse(fs.readFileSync(f.statePath)).phase==='watching');
    await new Promise(resolve=>setTimeout(resolve,250));
    assert.equal(JSON.parse(fs.readFileSync(f.statePath)).pending,null);
  }finally{child.kill('SIGTERM');fs.rmSync(f.root,{recursive:true,force:true});}
});

test('quiet work produces a visible follow-up, then repeats after another interval without new executor activity',async()=>{
  const f=fixture();let child=start(f);
  try{
    await until(()=>JSON.parse(fs.readFileSync(f.statePath)).pending?.kind==='progress_review');
    await until(()=>!fs.existsSync(path.join(f.run,'watcher.lock')));
    const state=JSON.parse(fs.readFileSync(f.statePath)),event=state.pending;
    assert.throws(()=>validateDecision({}, {criteria:[]},event,{eventId:event.id,disposition:'observe',reason:'Quiet'}),/visible executor follow-up/);
    assert.throws(()=>validateDecision({}, {criteria:[]},event,{eventId:event.id,disposition:'reply',reply:'Status?'}),/checked evidence/);
    const progressCheck={evidence:['executor transcript: no activity for 16 minutes','dispatch.json: in-flight package still listed'],
      finding:'No new result; in-flight status needs verification before calling this blocked.',
      guidance:'Check the in-flight handle, collect any finished result, and report the blocker and next step.'};
    assert.throws(()=>validateDecision({}, {criteria:[]},event,{eventId:event.id,disposition:'reply',reply:'Status?',progressCheck}),/guidance in the visible executor reply/);
    const premature=path.join(f.root,'premature.json');save(premature,{eventId:event.id,disposition:'reply',reply:'Status?'});
    assert.throws(()=>command(f,'decision',premature),/Command failed/);
    assert.equal(command(f,'progress-preflight',event.id).current,true);
    const marker='LONG_TASK_DELIVERY:'+event.id;
    const reply='No new result is visible. '+progressCheck.guidance;
    line(f.executorLog,{type:'user',origin:{kind:'agent'},message:{content:[{type:'text',text:marker+'\nStatus?'}]}});
    const decision=path.join(f.root,'decision.json');
    save(decision,{eventId:event.id,disposition:'reply',reply,progressCheck,
      delivery:{marker,status:'delivered',messageId:'desktop-message-1'}});
    assert.throws(()=>command(f,'decision',decision),/Command failed/);
    line(f.executorLog,{type:'user',origin:{kind:'agent'},message:{content:[{type:'text',text:marker+'\n'+reply}]}});
    assert.equal(command(f,'decision',decision).processed,true);
    child=start(f);await until(()=>JSON.parse(fs.readFileSync(f.statePath)).phase==='watching');
    await new Promise(resolve=>setTimeout(resolve,250));
    const resumed=JSON.parse(fs.readFileSync(f.statePath));
    assert.equal(resumed.pending,null);
    assert.equal(resumed.resolved[event.id].decision.delivery.marker,marker);
    assert.deepEqual(resumed.resolved[event.id].decision.progressCheck,progressCheck);
    assert.equal(resumed.lastProgressReviewAt>Date.now()-PROGRESS_REVIEW_MS,true);
    child.kill('SIGTERM');await new Promise(resolve=>child.once('exit',resolve));
    resumed.lastProgressReviewAt=Date.now()-16*60000;save(f.statePath,resumed);
    child=start(f);
    await until(()=>JSON.parse(fs.readFileSync(f.statePath)).pending?.kind==='progress_review');
    const repeated=JSON.parse(fs.readFileSync(f.statePath)).pending;
    assert.notEqual(repeated.id,event.id);
    assert.equal(command(f,'progress-preflight',repeated.id).current,true);
  }finally{child.kill('SIGTERM');fs.rmSync(f.root,{recursive:true,force:true});}
});

test('new executor activity before send makes a stale progress prompt obsolete',async()=>{
  const f=fixture();let child=start(f);
  try{
    await until(()=>JSON.parse(fs.readFileSync(f.statePath)).pending?.kind==='progress_review');
    await until(()=>!fs.existsSync(path.join(f.run,'watcher.lock')));
    const event=JSON.parse(fs.readFileSync(f.statePath)).pending;
    line(f.executorLog,{type:'assistant',uuid:crypto.randomUUID(),timestamp:new Date().toISOString(),
      message:{id:'new-tool-step',stop_reason:'tool_use',content:[{type:'text',text:'A new work result is being integrated.'}]}});
    assert.equal(command(f,'progress-preflight',event.id).current,false);
    child=start(f);await until(()=>JSON.parse(fs.readFileSync(f.statePath)).phase==='watching');
    await until(()=>JSON.parse(fs.readFileSync(f.statePath)).lastExecutorActivityAt>Date.now()-60000);
    assert.equal(JSON.parse(fs.readFileSync(f.statePath)).pending,null);
  }finally{child.kill('SIGTERM');fs.rmSync(f.root,{recursive:true,force:true});}
});

test('a real tool result counts as progress but a supervisor delivery alone does not',async()=>{
  const f=fixture();let child=start(f);
  try{
    await until(()=>JSON.parse(fs.readFileSync(f.statePath)).pending?.kind==='progress_review');
    await until(()=>!fs.existsSync(path.join(f.run,'watcher.lock')));
    const event=JSON.parse(fs.readFileSync(f.statePath)).pending;
    line(f.executorLog,{type:'user',timestamp:new Date().toISOString(),message:{content:[{type:'tool_result',content:'Background job produced its next result.'}]}});
    assert.equal(command(f,'progress-preflight',event.id).current,false);
    child=start(f);await until(()=>JSON.parse(fs.readFileSync(f.statePath)).phase==='watching');
    await until(()=>JSON.parse(fs.readFileSync(f.statePath)).lastExecutorActivityAt>Date.now()-60000);
    const afterTool=JSON.parse(fs.readFileSync(f.statePath)).lastExecutorActivityAt;
    line(f.executorLog,{type:'user',origin:{kind:'agent'},message:{content:[{type:'text',text:'LONG_TASK_DELIVERY:another-event'}]}});
    await new Promise(resolve=>setTimeout(resolve,200));
    assert.equal(JSON.parse(fs.readFileSync(f.statePath)).lastExecutorActivityAt,afterTool);
  }finally{child.kill('SIGTERM');fs.rmSync(f.root,{recursive:true,force:true});}
});

test('one approval block cannot freeze the whole run without a user pause source',()=>{
  const event={id:'question-1',kind:'question'},contract={criteria:[]},config={};
  assert.throws(()=>validateDecision(config,contract,event,{eventId:event.id,disposition:'needs_user'}),/Whole-run pause requires/);
  assert.equal(validateDecision(config,contract,event,{eventId:event.id,disposition:'needs_user',wholeRunPauseSource:'user message 123: pause this entire run'}).disposition,'needs_user');
  assert.equal(validateDecision(config,contract,event,{eventId:event.id,disposition:'observe',reason:'Only one operation awaits approval.',pendingApprovals:['Merge PR #26']}).disposition,'observe');
});
