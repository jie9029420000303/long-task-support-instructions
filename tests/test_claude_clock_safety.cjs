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

test('actual refusal and repeated failures keep secrets only in the source transcript',async()=>{
 const f=fixture(),secret='synthetic-secret-7u8v9w0x',command='secure-tool '+secret;f.patch(s=>{s.executorSettings={permissionMode:'auto'};});
 for(let n=0;n<3;n++){const id='call'+n;assistant(f,[{type:'tool_use',name:'Bash',id,input:{command}}]);line(f.executorLog,{type:'user',timestamp:new Date().toISOString(),message:{content:[{type:'tool_result',tool_use_id:id,is_error:true,content:'Permission denied by the Claude Code auto mode classifier. Reason: '+secret}]}});}
 const child=start(f);try{await until(()=>pending(f)?.kind==='progress_review');await stopWatch(child);const st=read(f.statePath),event=pending(f);assert.ok(event.reasons.includes('permission_review'));assert.ok(event.reasons.includes('repeat'));assert.equal(event.failedCommands[0].count,3);assert.equal(event.failedCommands[0].commandHash,'sha256:'+crypto.createHash('sha256').update(command).digest('hex'));assert.equal(JSON.stringify(st).includes(secret),false);assert.equal(JSON.stringify(event).includes(secret),false);const pointer=event.permission.newRejections[0].source;assert.equal(pointer.path,f.executorLog);assert.ok(Number.isInteger(pointer.offset));const original=JSON.parse(fs.readFileSync(pointer.path).subarray(pointer.offset).toString().split('\n')[0]);assert.ok(JSON.stringify(original).includes(secret));}
 finally{await stopWatch(child);f.done();}
});
test('legacy state is sanitized while the existing failure streak continues from the transcript',async()=>{
 const f=fixture(),secret='synthetic-secret-2a3b4c5d',command='legacy-tool '+secret;assistant(f,[{type:'tool_use',name:'Bash',id:'old-call',input:{command}}]);f.patch(s=>{s.executorOffset=fs.statSync(f.executorLog).size;s.openTools={'old-call':{command,at:new Date().toISOString()}};s.failedCommands={[command]:{count:2,lastAt:new Date().toISOString()}};s.reviewRejections=[{callId:'prior',item:command,reason:secret,at:new Date().toISOString()}];s.clockAnnounced={'rejected:prior':true,['rejected-item:'+command]:true};});
 line(f.executorLog,{type:'user',timestamp:new Date().toISOString(),message:{content:[{type:'tool_result',tool_use_id:'old-call',is_error:true,content:'failed'}]}});const child=start(f);try{await until(()=>pending(f)?.reasons?.includes('repeat'));await stopWatch(child);const state=read(f.statePath);assert.equal(JSON.stringify(state).includes(secret),false);assert.equal(pending(f).failedCommands[0].count,3);assert.equal(pending(f).failedCommands[0].source.path,f.executorLog);assert.ok(fs.readFileSync(f.executorLog,'utf8').includes(secret));}
 finally{await stopWatch(child);f.done();}
});
test('legacy pending event is displayed safely and its decision preflight still detects changes',()=>{
 const f=fixture(),secret='synthetic-secret-1m2n3b4v',event={id:'legacy-event',kind:'progress_review',reasons:['permission_review'],permission:{newRejections:[{callId:'old',at:new Date().toISOString(),item:secret,reason:secret}]},failedCommands:[{command:'tool '+secret,count:3}],executorBlocked:[{id:'blocked',command:'tool '+secret}]};
 try{f.patch(s=>{s.phase='awaiting_decision';s.pending=event;s.progressReviewPreflight=event.id;s.reviewRejections=event.permission.newRejections;});const context=cmd(f,'context',event.id),saved=fs.readFileSync(context.event.path,'utf8');assert.equal(saved.includes(secret),false);assert.equal(JSON.stringify(context.brief).includes(secret),false);assert.ok(saved.includes('originalEventSha256'));const draft=path.join(f.root,'legacy-decision.json');save(draft,{eventId:event.id,disposition:'reply',reply:'Check original source',progressCheck:{evidence:['transcript'],finding:'Review refusal',guidance:'Check original source'}});const binding=read(path.join(f.run,'binding.json'));const check=(hash)=>spawnSync(process.execPath,[path.join(scripts,'supervise.cjs'),'decision-preflight',f.run,draft,hash,binding.contractSha256,'-'],{env:f.env,encoding:'utf8'});assert.equal(check(context.event.sha256).status,0);f.patch(s=>{s.pending.permission.newRejections[0].reason+='changed';});assert.notEqual(check(context.event.sha256).status,0,'changing even hidden source data invalidates the preflight');assert.ok(JSON.stringify(read(f.statePath).pending).includes(secret),'original evidence remains intact');}
 finally{f.done();}
});
test('blocked operation uses source locator without copying its command',async()=>{
 const f=fixture(),secret='synthetic-secret-5z6x7c8v',command='missing-operation '+secret;fs.writeFileSync(path.join(f.root,'bin','ps'),'#!/bin/sh\necho unrelated\n',{mode:0o755});line(f.executorLog,{type:'assistant',uuid:crypto.randomUUID(),timestamp:minutesAgo(6),message:{id:'blocked-msg',stop_reason:'tool_use',content:[{type:'tool_use',name:'Bash',id:'blocked-call',input:{command}}]}});const child=start(f);try{await until(()=>pending(f)?.reasons?.includes('executor_blocked'));await stopWatch(child);const state=read(f.statePath),event=pending(f);assert.equal(JSON.stringify(state).includes(secret),false);assert.equal(JSON.stringify(event).includes(secret),false);assert.equal(event.executorBlocked[0].summary,'指令操作尚未開始');assert.equal(event.executorBlocked[0].source.path,f.executorLog);assert.ok(Number.isInteger(event.executorBlocked[0].source.offset));assert.ok(fs.readFileSync(f.executorLog,'utf8').includes(secret));}
 finally{await stopWatch(child);f.done();}
});
test('platform error preserves a source locator without leaking its synthetic secret',async()=>{
 const f=fixture(),secret='synthetic-secret-4h5j6k7l',text='server failure '+secret,bindingFile=path.join(f.run,'binding.json'),binding=read(bindingFile);binding.createdAt=minutesAgo(15);save(bindingFile,binding);f.patch(s=>{s.lastExecutorWorkAt=Date.now()-10*60000;});line(f.executorLog,{type:'assistant',uuid:'synthetic-error-row',isApiErrorMessage:true,error:'server_error',apiErrorStatus:500,timestamp:minutesAgo(5),message:{id:'error-msg',model:'<synthetic>',stop_reason:'stop_sequence',content:[{type:'text',text}]}});const child=start(f);
 try{await until(()=>pending(f)?.reasons?.includes('platform_error'));await stopWatch(child);const state=read(f.statePath),event=pending(f);assert.equal(JSON.stringify(state).includes(secret),false);assert.equal(JSON.stringify(event).includes(secret),false);assert.equal(JSON.stringify(cmd(f,'brief')).includes(secret),false);assert.equal(event.platformError.source.path,f.executorLog);assert.ok(Number.isInteger(event.platformError.source.offset));assert.equal(event.platformError.textSha256,crypto.createHash('sha256').update(text).digest('hex'));assert.ok(fs.readFileSync(f.executorLog,'utf8').includes(secret));}
 finally{await stopWatch(child);f.done();}
});
test('subagent rate limit retains its reset and source without exposing error text',()=>{
 const f=fixture(),secret='synthetic-secret-7s8d9f0g',file=path.join(f.subagents,'agent-test.jsonl'),text="You've hit your limit · resets 11:59pm (UTC) "+secret;try{line(file,{type:'assistant',uuid:'limit-row',isSidechain:true,isApiErrorMessage:true,error:'rate_limit',timestamp:new Date().toISOString(),message:{content:[{type:'text',text}]}});const binding=read(path.join(f.run,'binding.json')),pace=require(path.join(scripts,'pace.cjs')).inFlight(binding,{packages:{inFlight:[]}});assert.equal(pace.rateLimits.length,1);assert.ok(pace.rateLimits[0].rateLimit.until>Date.now());assert.equal(pace.rateLimits[0].rateLimit.source.path,file);assert.equal(JSON.stringify(pace).includes(secret),false);assert.ok(fs.readFileSync(file,'utf8').includes(secret));}
 finally{f.done();}
});
