const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawn,execFileSync}=require('node:child_process');
const codex=path.resolve(__dirname,'../codex/.agents/skills/long-task-supervisor/scripts');
const claude=path.resolve(__dirname,'../claude-code/.claude/skills/long-task-supervisor/scripts');
const save=(file,value)=>fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n');
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
async function until(check,ms=10000){const end=Date.now()+ms;while(Date.now()<end){if(check())return;await new Promise(resolve=>setTimeout(resolve,50));}throw Error('Timed out');}
function snapshot(executorId,overrides={}){
  const base={schemaVersion:1,executorId,planningRevision:'plan-1',activity:'working',capacity:{verified:2,evidence:['platform:list_agents']},packages:{
    ready:[],inFlight:[],returned:[],blocked:[],completed:[],recurringRework:[]},updatedAt:'2026-09-30T00:00:00Z'};
  return {...base,...overrides,packages:{...base.packages,...(overrides.packages||{})}};
}
function fixture(prefix,platform,difficultPath=false){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),prefix)),run=path.join(root,difficultPath?'含 空白(測試)':'run');fs.mkdirSync(run);
  const source=path.join(root,'source');fs.writeFileSync(source,'criterion\n');
  const contract={goal:'audit dispatch',authorization:'isolated test',criteria:[{id:'A1',requirement:'audit',source:'source:1',verify:'inspect'}],sources:[{path:source,sha256:sha(source)}]};
  save(path.join(run,'contract.json'),contract);
  const executorId=platform==='codex'?'executor-qa':crypto.randomUUID();
  const binding={platform,projectRoot:root,allowedRoots:[root,run],executorId,supervisorId:platform==='codex'?'supervisor-qa':crypto.randomUUID(),contractSha256:sha(path.join(run,'contract.json')),dispatchAudit:{enabled:true,snapshot:'dispatch.json'}};
  save(path.join(run,'binding.json'),binding);
  return {root,run,source,contract,binding,executorId};
}

test('both installable skills ship byte-identical dispatch audit and writer',()=>{
  for(const file of ['dispatch-audit.cjs','dispatch.cjs'])assert.deepEqual(fs.readFileSync(path.join(codex,file)),fs.readFileSync(path.join(claude,file)));
});

test('deterministic audit ignores transition underdispatch and flags exclusive overlap without read-read loopholes',()=>{
  const {derive}=require(path.join(codex,'dispatch-audit.cjs'));
  const ready={id:'B1',independent:true,safe:true,dependencies:[],exclusiveResources:[],evidence:['plan:B1']};
  assert.deepEqual(derive(snapshot('x',{activity:'dispatching',packages:{ready:[ready]}})),[]);
  const issues=derive(snapshot('x',{packages:{ready:[ready],inFlight:[
    {id:'B2',handle:'agent-2',exclusiveResources:[{key:'worktree:/repo',kind:'worktree'}],evidence:['agent:2']},
    {id:'B3',handle:'agent-3',exclusiveResources:[{key:'worktree:/repo',kind:'worktree'}],evidence:['agent:3']}
  ]}}));
  assert.deepEqual(issues.map(item=>item.kind).sort(),['resource_conflict']);
  const occupiedReady={...ready,exclusiveResources:[{key:'worktree:/busy',kind:'worktree'}]};
  assert.equal(derive(snapshot('x',{packages:{ready:[occupiedReady],inFlight:[
    {id:'B2',handle:'agent-2',exclusiveResources:[{key:'worktree:/busy',kind:'worktree'}],evidence:['agent:2']}
  ]}})).some(item=>item.kind==='ready_capacity'),false);
  const sameDb=[
    {...ready,id:'B4',exclusiveResources:[{key:'db:test',kind:'database'}]},
    {...ready,id:'B5',exclusiveResources:[{key:'db:test',kind:'database'}]}
  ];
  const readyIssue=derive(snapshot('x',{packages:{ready:sameDb}})).find(item=>item.kind==='ready_capacity');
  assert.deepEqual(readyIssue.detail.exclusiveConflictGroups,[{resource:'db:test',packages:['B4','B5']}]);
  assert.equal(derive(snapshot('x',{packages:{ready:sameDb}})).some(item=>item.kind==='resource_conflict'),false);
  const clean=derive(snapshot('x',{packages:{inFlight:[
    {id:'B2',handle:'agent-2',exclusiveResources:[{key:'worktree:/a',kind:'worktree'}],evidence:['agent:2']},
    {id:'B3',handle:'agent-3',exclusiveResources:[{key:'worktree:/b',kind:'worktree'}],evidence:['agent:3']}
  ]}}));
  assert.deepEqual(clean,[]);
});

test('atomic writer validates concrete snapshot and timestamp-only changes remain deduplicated across state reload',()=>{
  const f=fixture('dispatch-writer-','codex');
  try{
    const input=path.join(f.root,'input.json');save(input,snapshot(f.executorId,{packages:{ready:[{id:'B1',independent:true,safe:true,dependencies:[],exclusiveResources:[],evidence:['plan:B1']}]}}));
    execFileSync(process.execPath,[path.join(codex,'dispatch.cjs'),'write',f.run,input]);
    const helper=require(path.join(codex,'dispatch-audit.cjs')),state={};
    let result=helper.inspect(f.run,f.binding,state);assert.equal(result.newIssues.length,1);assert.equal(result.newIssues[0].kind,'ready_capacity');const firstEvent=helper.eventFor(result);helper.markAnnounced(state,firstEvent);
    const persisted=JSON.parse(JSON.stringify(state)),changed=JSON.parse(fs.readFileSync(path.join(f.run,'dispatch.json')));changed.updatedAt='2026-09-30T01:00:00Z';changed.planningRevision='plan-2';save(input,changed);
    execFileSync(process.execPath,[path.join(codex,'dispatch.cjs'),'write',f.run,input]);
    result=helper.inspect(f.run,f.binding,persisted);assert.equal(result.newIssues.length,0);
    changed.packages.ready.push({id:'B2',independent:true,safe:true,dependencies:[],exclusiveResources:[],evidence:['plan:B2']});save(input,changed);
    execFileSync(process.execPath,[path.join(codex,'dispatch.cjs'),'write',f.run,input]);
    result=helper.inspect(f.run,f.binding,persisted);assert.equal(result.newIssues.length,1);assert.deepEqual(result.newIssues[0].affected,['B1','B2']);
    helper.inspect(f.run,f.binding,persisted);save(input,snapshot(f.executorId));execFileSync(process.execPath,[path.join(codex,'dispatch.cjs'),'write',f.run,input]);helper.inspect(f.run,f.binding,persisted);
    save(input,snapshot(f.executorId,{packages:{ready:[{id:'B1',independent:true,safe:true,dependencies:[],exclusiveResources:[],evidence:['plan:B1']}]}}));execFileSync(process.execPath,[path.join(codex,'dispatch.cjs'),'write',f.run,input]);
    const recurringEvent=helper.eventFor(helper.inspect(f.run,f.binding,persisted));assert.notEqual(recurringEvent.id,firstEvent.id);
    const invalid=snapshot(f.executorId);invalid.capacity.evidence=[];save(input,invalid);
    assert.throws(()=>execFileSync(process.execPath,[path.join(codex,'dispatch.cjs'),'write',f.run,input],{stdio:'pipe'}),/Command failed/);
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('Claude preflight treats an empty-evidence snapshot as invalid and cancels stale advice',()=>{
  const f=fixture('dispatch-empty-evidence-','claude-code'),helper=require(path.join(claude,'dispatch-audit.cjs'));
  try{
    const prompt=path.join(f.run,'executor-prompt.txt');fs.writeFileSync(prompt,'prompt');Object.assign(f.binding,{promptSha256:sha(prompt)});save(path.join(f.run,'binding.json'),f.binding);
    save(path.join(f.run,'dispatch.json'),snapshot(f.executorId,{packages:{ready:[{id:'A',independent:true,safe:true,dependencies:[],exclusiveResources:[],evidence:['plan:A']}]}}));
    const state={phase:'awaiting_decision',seen:[],pending:null},event=helper.eventFor(helper.inspect(f.run,f.binding,state));helper.markAnnounced(state,event);state.pending=event;save(path.join(f.run,'daemon-state.json'),state);
    const invalid=snapshot(f.executorId);invalid.capacity.evidence=[];save(path.join(f.run,'dispatch.json'),invalid);
    const checked=JSON.parse(execFileSync(process.execPath,[path.join(claude,'supervise.cjs'),'dispatch-preflight',f.run,event.id],{encoding:'utf8'}));
    assert.equal(checked.current,false);const after=JSON.parse(fs.readFileSync(path.join(f.run,'daemon-state.json')));assert.equal(after.pending,null);
    assert.equal(helper.inspect(f.run,f.binding,after).newIssues[0].kind,'snapshot_invalid');
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('preflight of resolved issue A does not consume unrelated new issue B',()=>{
  const f=fixture('dispatch-overlap-','codex'),helper=require(path.join(codex,'dispatch-audit.cjs')),state={};
  try{
    save(path.join(f.run,'dispatch.json'),snapshot(f.executorId,{packages:{ready:[{id:'A',independent:true,safe:true,dependencies:[],exclusiveResources:[],evidence:['plan:A']}]}}));
    const eventA=helper.eventFor(helper.inspect(f.run,f.binding,state));helper.markAnnounced(state,eventA);
    save(path.join(f.run,'dispatch.json'),snapshot(f.executorId,{packages:{recurringRework:[{id:'B',count:2,evidence:['attempts:B']}]}}));
    assert.equal(helper.stillCurrent(f.run,f.binding,state,eventA).current,false);
    const eventB=helper.eventFor(helper.inspect(f.run,f.binding,state));assert.ok(eventB);assert.deepEqual(eventB.issues.map(item=>item.affected),[['B']]);
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('stale bundled event releases the still-current member for a new review',()=>{
  const f=fixture('dispatch-bundle-','codex'),helper=require(path.join(codex,'dispatch-audit.cjs')),state={};
  try{
    const ready={id:'A',independent:true,safe:true,dependencies:[],exclusiveResources:[],evidence:['plan:A']},returned={id:'B',integrated:false,resultEvidence:['result:B']};
    save(path.join(f.run,'dispatch.json'),snapshot(f.executorId,{activity:'waiting',packages:{ready:[ready],returned:[returned]}}));
    const bundled=helper.eventFor(helper.inspect(f.run,f.binding,state));helper.markAnnounced(state,bundled);assert.equal(bundled.issues.length,2);
    save(path.join(f.run,'dispatch.json'),snapshot(f.executorId,{activity:'waiting',packages:{returned:[returned]}}));
    assert.equal(helper.stillCurrent(f.run,f.binding,state,bundled).current,false);helper.releaseAnnounced(state,bundled);
    const followup=helper.eventFor(helper.inspect(f.run,f.binding,state));assert.deepEqual(followup.issues.map(item=>item.kind),['returned_unintegrated']);assert.notEqual(followup.id,bundled.id);
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('Claude watcher routes missing attached snapshot and preflight cancels obsolete instruction before desktop send',async()=>{
  const f=fixture('dispatch-claude-','claude-code',true);
  const log=path.join(f.root,'executor.jsonl'),prompt=path.join(f.run,'executor-prompt.txt');fs.writeFileSync(log,'');fs.writeFileSync(prompt,'prompt');
  Object.assign(f.binding,{executorDesktopId:'local_'+crypto.randomUUID(),executorLog:log,promptSha256:sha(prompt)});save(path.join(f.run,'binding.json'),f.binding);
  save(path.join(f.run,'daemon-state.json'),{phase:'idle',executorOffset:0,turnText:[],seen:[],pending:null,reads:0});
  const child=spawn(process.execPath,[path.join(claude,'claude-watch.cjs'),f.run],{stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',b=>output+=b);
  try{
    await until(()=>JSON.parse(fs.readFileSync(path.join(f.run,'daemon-state.json'))).pending?.kind==='dispatch_review');
    let state=JSON.parse(fs.readFileSync(path.join(f.run,'daemon-state.json')));assert.equal(state.pending.issues[0].kind,'snapshot_missing');assert.deepEqual(state.pending.preflightArgv.slice(-3),['dispatch-preflight',f.run,state.pending.id]);
    save(path.join(f.run,'dispatch.json'),snapshot(f.executorId,{packages:{recurringRework:[{id:'B',count:2,evidence:['attempts:B']}]}}));
    const checked=JSON.parse(execFileSync(process.execPath,[path.join(claude,'supervise.cjs'),'dispatch-preflight',f.run,state.pending.id],{encoding:'utf8'}));
    assert.equal(checked.current,false);state=JSON.parse(fs.readFileSync(path.join(f.run,'daemon-state.json')));assert.equal(state.pending,null);assert.equal(state.resolved[checked.eventId].obsolete,true);
    await new Promise(resolve=>child.exitCode!==null?resolve():child.once('exit',resolve));
    const second=spawn(process.execPath,[path.join(claude,'claude-watch.cjs'),f.run],{stdio:['ignore','pipe','pipe']});
    try{await until(()=>JSON.parse(fs.readFileSync(path.join(f.run,'daemon-state.json'))).pending?.issues?.some(item=>item.affected.includes('B')));}finally{second.kill('SIGTERM');}
  }finally{child.kill('SIGTERM');fs.rmSync(f.root,{recursive:true,force:true});}
});

test('runtime attach is observed by an already-running Claude watcher, malformed snapshot is actionable, and STOP suppresses audit',async()=>{
  const f=fixture('dispatch-attach-','claude-code'),log=path.join(f.root,'executor.jsonl'),prompt=path.join(f.run,'executor-prompt.txt');fs.writeFileSync(log,'');fs.writeFileSync(prompt,'prompt');
  f.binding.dispatchAudit.enabled=false;Object.assign(f.binding,{executorDesktopId:'local_'+crypto.randomUUID(),executorLog:log,promptSha256:sha(prompt)});save(path.join(f.run,'binding.json'),f.binding);
  save(path.join(f.run,'daemon-state.json'),{phase:'idle',executorOffset:0,turnText:[],seen:[],pending:null,reads:0});save(path.join(f.run,'dispatch.json'),{bad:true});
  const child=spawn(process.execPath,[path.join(claude,'claude-watch.cjs'),f.run],{stdio:['ignore','pipe','pipe']});
  try{
    await until(()=>JSON.parse(fs.readFileSync(path.join(f.run,'daemon-state.json'))).phase==='watching');
    execFileSync(process.execPath,[path.join(claude,'supervise.cjs'),'attach-dispatch',f.run]);
    await until(()=>JSON.parse(fs.readFileSync(path.join(f.run,'daemon-state.json'))).pending?.issues?.[0]?.kind==='snapshot_invalid');
  }finally{child.kill('SIGTERM');}
  const stopped=fixture('dispatch-stop-','claude-code'),stoppedLog=path.join(stopped.root,'executor.jsonl'),stoppedPrompt=path.join(stopped.run,'executor-prompt.txt');fs.writeFileSync(stoppedLog,'');fs.writeFileSync(stoppedPrompt,'prompt');
  Object.assign(stopped.binding,{executorDesktopId:'local_'+crypto.randomUUID(),executorLog:stoppedLog,promptSha256:sha(stoppedPrompt)});save(path.join(stopped.run,'binding.json'),stopped.binding);save(path.join(stopped.run,'daemon-state.json'),{phase:'idle',executorOffset:0,seen:[],pending:null,reads:0});fs.writeFileSync(path.join(stopped.run,'STOP'),'stop\n');
  execFileSync(process.execPath,[path.join(claude,'claude-watch.cjs'),stopped.run]);assert.equal(JSON.parse(fs.readFileSync(path.join(stopped.run,'daemon-state.json'))).phase,'stopped');assert.equal(JSON.parse(fs.readFileSync(path.join(stopped.run,'daemon-state.json'))).pending,null);
  fs.rmSync(f.root,{recursive:true,force:true});fs.rmSync(stopped.root,{recursive:true,force:true});
});

test('Codex watcher reissues the surviving member of a stale bundle without delivering obsolete executor advice',async()=>{
  const f=fixture('dispatch-codex-','codex');
  Object.assign(f.binding,{callerTurnId:'supervisor-turn'});save(path.join(f.run,'binding.json'),f.binding);
  save(path.join(f.run,'daemon-state.json'),{phase:'starting',cursor:null,seen:[],messages:[],pending:null,inflight:null,reads:0,starts:0});
  save(path.join(f.run,'dispatch.json'),snapshot(f.executorId,{activity:'waiting',packages:{
    ready:[{id:'B2',independent:true,safe:true,dependencies:[],exclusiveResources:[],evidence:['plan:B2']}],
    inFlight:[{id:'B1',handle:'agent-1',exclusiveResources:[{key:'worktree:/one',kind:'worktree'}],evidence:['agent:1']}],
    returned:[{id:'B0',integrated:false,resultEvidence:['result:B0']}]
  }}));
  const fixtureFile=path.join(f.root,'mock.json'),sent=path.join(f.root,'sent.json');save(fixtureFile,{supervisorId:f.binding.supervisorId,executorId:f.executorId,final:'',noTurn:true});
  const env={...process.env,CODEX_APP_TOOLS_SERVER_PATH:path.join(__dirname,'mock-codex-app-server.cjs'),MOCK_CODEX_FIXTURE:fixtureFile,MOCK_CODEX_SENT:sent};
  let child=spawn(process.execPath,[path.join(codex,'native-watch.cjs'),f.run],{env,stdio:['ignore','pipe','pipe']});
  try{
    await until(()=>JSON.parse(fs.readFileSync(path.join(f.run,'daemon-state.json'))).pending?.kind==='dispatch_review');
    let state=JSON.parse(fs.readFileSync(path.join(f.run,'daemon-state.json')));assert.deepEqual(state.pending.issues.map(x=>x.kind).sort(),['ready_capacity','returned_unintegrated']);
    await until(()=>fs.existsSync(sent)&&JSON.parse(fs.readFileSync(sent)).length===1);
    child.kill('SIGTERM');await new Promise(resolve=>child.once('exit',resolve));
    child=spawn(process.execPath,[path.join(codex,'native-watch.cjs'),f.run],{env,stdio:['ignore','pipe','pipe']});
    await until(()=>JSON.parse(fs.readFileSync(path.join(f.run,'daemon-state.json'))).pid===child.pid);
    await new Promise(resolve=>setTimeout(resolve,250));assert.equal(JSON.parse(fs.readFileSync(sent)).length,1);
    save(path.join(f.run,'dispatch.json'),snapshot(f.executorId,{activity:'waiting',packages:{returned:[{id:'B0',integrated:false,resultEvidence:['result:B0']}]}}));
    save(path.join(f.run,'decision-'+state.pending.id+'.json'),{eventId:state.pending.id,disposition:'reply',reply:'Add agents'});
    await until(()=>JSON.parse(fs.readFileSync(path.join(f.run,'daemon-state.json'))).resolved?.[state.pending.id]?.obsolete===true);
    await until(()=>{const current=JSON.parse(fs.readFileSync(path.join(f.run,'daemon-state.json')));return current.pending?.id!==state.pending.id&&current.pending?.issues?.length===1&&current.pending.issues[0].kind==='returned_unintegrated';});
    await until(()=>JSON.parse(fs.readFileSync(sent)).length===2);
    fs.writeFileSync(path.join(f.run,'STOP'),'stop\n');
    assert.equal(JSON.parse(fs.readFileSync(sent)).some(prompt=>prompt.includes('Add agents')),false);
  }finally{child.kill('SIGTERM');fs.rmSync(f.root,{recursive:true,force:true});}
});
