const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawn,execFileSync}=require('node:child_process');
const {ownerAlive}=require(path.join(process.env.CLAUDE_SUPERVISOR_SCRIPTS||path.resolve(__dirname,'../claude-code/.claude/skills/long-task-supervisor/scripts'),'handoff-lib.cjs'));
const scripts=process.env.CLAUDE_SUPERVISOR_SCRIPTS||path.resolve(__dirname,'../claude-code/.claude/skills/long-task-supervisor/scripts');
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const line=(file,value)=>fs.appendFileSync(file,JSON.stringify(value)+'\n');
const save=(file,value)=>fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n');
async function until(check,ms=7000){const end=Date.now()+ms;while(Date.now()<end){if(check())return;await new Promise(resolve=>setTimeout(resolve,40));}throw Error('Timed out');}
function fixture(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'claude-handoff-')),project=path.join(root,'config','projects','qa');fs.mkdirSync(project,{recursive:true});
  const source=path.join(root,'source.md');fs.writeFileSync(source,'Criterion\n');
  const supervisorId=crypto.randomUUID(),executorId=crypto.randomUUID(),marker='LONG_TASK_BIND:'+crypto.randomUUID();
  const executorLog=path.join(project,executorId+'.jsonl');
  line(path.join(project,supervisorId+'.jsonl'),{type:'user',sessionId:supervisorId,cwd:root,entrypoint:'claude-desktop'});
  line(executorLog,{type:'user',sessionId:executorId,cwd:root,entrypoint:'claude-desktop',message:{content:[{type:'text',text:marker}]}});
  const run=path.join(root,'run'),input=path.join(root,'input.json');
  save(input,{dispatchAudit:false,projectRoot:root,allowedRoots:[root],supervisorId,supervisorDesktopId:'local_'+crypto.randomUUID(),executorId,executorDesktopId:'local_'+crypto.randomUUID(),executorMarker:marker,executorPrompt:marker+' test',contract:{goal:'Persist handoff',authorization:'Isolated QA',criteria:[{id:'A1',requirement:'One event',source:'source.md:1',verify:'Read state'}],sources:[{path:source,sha256:sha(source)}]}});
  const env={...process.env,CLAUDE_CONFIG_DIR:path.join(root,'config'),CLAUDE_SESSION_ID:supervisorId,CLAUDE_WATCH_SETTLE_MS:'100',CLAUDE_HANDOFF_WAIT_MS:'5000'};
  execFileSync(process.execPath,[path.join(scripts,'supervise.cjs'),'init',run,input],{env});
  return {root,run,env,executorLog,supervisorId};
}
function eventFile(f,id,text){const file=path.join(f.root,id+'.json'),lineText=text+'\nLONG_TASK_EVENT '+JSON.stringify({id,kind:'question'});save(file,{id,kind:'question',text:lineText});return {file,lineText};}

test('inactive watcher handoff persists pending before issuing one notification and unknown never retries',()=>{
  const f=fixture(),id=crypto.randomUUID(),event=eventFile(f,id,'Need contract review.');
  try{
    const first=JSON.parse(execFileSync(process.execPath,[path.join(scripts,'handoff.cjs'),'prepare',f.run,event.file],{env:f.env,encoding:'utf8'}));
    assert.equal(first.ready,true);assert.equal(first.eventId,id);assert.equal(fs.existsSync(first.pendingReceipt),true);
    assert.equal(first.finalEventLine,'LONG_TASK_EVENT '+JSON.stringify({id,kind:'question'}));assert.match(first.message,new RegExp(f.run.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
    const state=JSON.parse(fs.readFileSync(path.join(f.run,'daemon-state.json')));assert.equal(state.pending.id,id);
    const second=JSON.parse(execFileSync(process.execPath,[path.join(scripts,'handoff.cjs'),'prepare',f.run,event.file],{env:f.env,encoding:'utf8'}));
    assert.equal(second.ready,false);assert.equal(second.retryAllowed,false);
    const receipt=path.join(f.root,'receipt.json');save(receipt,{eventId:id,delivery:{status:'unknown'},marker:first.marker});
    const recorded=JSON.parse(execFileSync(process.execPath,[path.join(scripts,'handoff.cjs'),'receipt',f.run,receipt],{env:f.env,encoding:'utf8'}));
    assert.equal(recorded.retryAllowed,false);assert.equal(recorded.reconcile.length,3);
    assert.throws(()=>execFileSync(process.execPath,[path.join(scripts,'handoff.cjs'),'receipt',f.run,receipt],{env:f.env,stdio:'pipe'}),/Command failed/);
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('active watcher is the only daemon-state writer and returns a readable pending receipt',async()=>{
  const f=fixture(),id=crypto.randomUUID(),event=eventFile(f,id,'Wake the paused supervisor.');
  const child=spawn(process.execPath,[path.join(scripts,'claude-watch.cjs'),f.run],{env:f.env,stdio:['ignore','pipe','pipe']});
  try{
    await until(()=>fs.existsSync(path.join(f.run,'watcher.lock')));
    const result=JSON.parse(execFileSync(process.execPath,[path.join(scripts,'handoff.cjs'),'prepare',f.run,event.file],{env:f.env,encoding:'utf8'}));
    assert.equal(result.ready,true);assert.equal(JSON.parse(fs.readFileSync(result.pendingReceipt)).pending,true);
    await new Promise(resolve=>child.once('exit',resolve));
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.run,'daemon-state.json'))).pending.id,id);
    assert.equal(fs.existsSync(path.join(f.run,'handoff-request-'+id+'.json')),false);
  }finally{child.kill('SIGTERM');fs.rmSync(f.root,{recursive:true,force:true});}
});

test('watcher reloads daemon state after taking ownership and cannot overwrite a handoff won in between',async()=>{
  const f=fixture(),id=crypto.randomUUID(),event=eventFile(f,id,'Win the ownership race.'),preload=path.join(f.root,'inject-handoff.cjs');
  try{
    fs.writeFileSync(preload,`const fs=require('node:fs');const cp=require('node:child_process');const original=fs.writeFileSync;let injected=false;fs.writeFileSync=function(file,...args){if(!injected&&file===${JSON.stringify(path.join(f.run,'watcher.lock'))}){injected=true;const env={...process.env};delete env.NODE_OPTIONS;const result=cp.spawnSync(process.execPath,[${JSON.stringify(path.join(scripts,'handoff.cjs'))},'prepare',${JSON.stringify(f.run)},${JSON.stringify(event.file)}],{env,encoding:'utf8'});if(result.status!==0)throw Error(result.stderr||'handoff injection failed');}return original.call(this,file,...args);};\n`);
    const child=spawn(process.execPath,[path.join(scripts,'claude-watch.cjs'),f.run],{env:{...f.env,NODE_OPTIONS:'--require='+preload},stdio:['ignore','pipe','pipe']});
    const result=await new Promise(resolve=>{let out='',err='';child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>err+=x);child.on('exit',code=>resolve({code,out,err}));});
    const state=JSON.parse(fs.readFileSync(path.join(f.run,'daemon-state.json')));
    assert.equal(result.code,0);assert.equal(result.err,'');
    assert.equal(state.pending.id,id);assert.equal(state.phase,'awaiting_decision');
    assert.equal(fs.existsSync(path.join(f.run,'handoff-ack-'+id+'.json')),true);
    assert.equal(fs.existsSync(path.join(f.run,'watcher.lock')),false);
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('watcher treats EPERM ownership as alive and does not rewrite daemon state without the lock',()=>{
  const f=fixture(),preload=path.join(f.root,'eperm.cjs'),lock=path.join(f.run,'watcher.lock'),statePath=path.join(f.run,'daemon-state.json');
  try{
    save(lock,{pid:424242,at:'owner'});
    fs.writeFileSync(preload,"process.kill=()=>{const error=Error('denied');error.code='EPERM';throw error;};\n");
    const before=fs.readFileSync(statePath,'utf8'),lockBefore=fs.readFileSync(lock,'utf8');
    assert.throws(()=>execFileSync(process.execPath,[path.join(scripts,'claude-watch.cjs'),f.run],{env:{...f.env,NODE_OPTIONS:'--require='+preload},stdio:'pipe'}),/Command failed/);
    assert.equal(fs.readFileSync(statePath,'utf8'),before);
    assert.equal(fs.readFileSync(lock,'utf8'),lockBefore);
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('stale watcher lock is reclaimed, EPERM means alive, and processed IDs cannot qualify again',()=>{
  assert.equal(ownerAlive(123,()=>{const error=Error('denied');error.code='EPERM';throw error;}),true);
  assert.equal(ownerAlive(123,()=>{const error=Error('gone');error.code='ESRCH';throw error;}),false);
  const f=fixture(),id=crypto.randomUUID(),event=eventFile(f,id,'Recover stale ownership.');
  try{
    save(path.join(f.run,'watcher.lock'),{pid:99999999,at:'stale'});
    const first=JSON.parse(execFileSync(process.execPath,[path.join(scripts,'handoff.cjs'),'prepare',f.run,event.file],{env:f.env,encoding:'utf8'}));
    assert.equal(first.ready,true);assert.equal(fs.existsSync(path.join(f.run,'watcher.lock')),false);
    const state=JSON.parse(fs.readFileSync(path.join(f.run,'daemon-state.json')));state.pending=null;state.seen.push(id);state.phase='idle';save(path.join(f.run,'daemon-state.json'),state);
    fs.unlinkSync(first.notification);
    assert.throws(()=>execFileSync(process.execPath,[path.join(scripts,'handoff.cjs'),'prepare',f.run,event.file],{env:f.env,stdio:'pipe'}),/Command failed/);
    assert.equal(fs.existsSync(first.notification),false);
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('full handoff body is hashed and same id with a changed prefix is rejected',()=>{
  const f=fixture(),id=crypto.randomUUID(),suffix='x'.repeat(9000),one=eventFile(f,id,'A'+suffix),other=path.join(f.root,'changed.json');
  try{
    execFileSync(process.execPath,[path.join(scripts,'handoff.cjs'),'prepare',f.run,one.file],{env:f.env});
    save(other,{id,kind:'question',text:'B'+suffix+'\nLONG_TASK_EVENT '+JSON.stringify({id,kind:'question'})});
    assert.throws(()=>execFileSync(process.execPath,[path.join(scripts,'handoff.cjs'),'prepare',f.run,other],{env:f.env,stdio:'pipe'}),/Command failed/);
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('notification qualification is exclusive across concurrent prepare calls',async()=>{
  const f=fixture(),id=crypto.randomUUID(),event=eventFile(f,id,'Concurrent prepare.');
  try{
    const run=()=>new Promise(resolve=>{const child=spawn(process.execPath,[path.join(scripts,'handoff.cjs'),'prepare',f.run,event.file],{env:f.env,stdio:['ignore','pipe','pipe']});let out='',err='';child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>err+=x);child.on('exit',code=>resolve({code,out,err}));});
    const results=await Promise.all([run(),run()]),ready=results.filter(row=>row.code===0).map(row=>JSON.parse(row.out)).filter(row=>row.ready);
    assert.equal(ready.length,1);assert.equal(results.filter(row=>row.code===0).length>=1,true);
    assert.equal(fs.existsSync(path.join(f.run,'handoff-notification-'+id+'.json')),true);
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('STOP during pending receipt wait never produces notification qualification',async()=>{
  const f=fixture(),id=crypto.randomUUID(),event=eventFile(f,id,'Stop while waiting.');
  try{
    const sleeper=spawn(process.execPath,['-e','setTimeout(()=>{},2000)'],{stdio:'ignore'});
    save(path.join(f.run,'watcher.lock'),{pid:sleeper.pid,at:'test'});
    const env={...f.env,CLAUDE_HANDOFF_WAIT_MS:'250'};
    const run=new Promise(resolve=>{const child=spawn(process.execPath,[path.join(scripts,'handoff.cjs'),'prepare',f.run,event.file],{env,stdio:['ignore','pipe','pipe']});let out='',err='';child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>err+=x);child.on('exit',code=>resolve({code,out,err}));});
    await until(()=>fs.existsSync(path.join(f.run,'handoff-request-'+id+'.json')));fs.writeFileSync(path.join(f.run,'STOP'),'stop\n');
    const result=await run;sleeper.kill('SIGTERM');assert.notEqual(result.code,0);assert.match(result.err,/timed out/);
    assert.equal(fs.existsSync(path.join(f.run,'handoff-notification-'+id+'.json')),false);
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('persisted handoff stays authoritative when the visible final uses the same id with a shorter summary',async()=>{
  const f=fixture(),id=crypto.randomUUID(),event=eventFile(f,id,'Persisted final.');
  try{
    execFileSync(process.execPath,[path.join(scripts,'handoff.cjs'),'prepare',f.run,event.file],{env:f.env});
    let state=JSON.parse(fs.readFileSync(path.join(f.run,'daemon-state.json')));state.seen.push(id);state.pending=null;state.phase='idle';save(path.join(f.run,'daemon-state.json'),state);
    const messageId='msg-'+crypto.randomUUID();
    line(f.executorLog,{type:'assistant',uuid:crypto.randomUUID(),message:{id:messageId,content:[{type:'thinking',thinking:'meta'}],stop_reason:'end_turn'}});
    line(f.executorLog,{type:'assistant',uuid:crypto.randomUUID(),message:{id:messageId,content:[{type:'text',text:event.lineText}],stop_reason:'end_turn'}});
    line(f.executorLog,{type:'assistant',uuid:crypto.randomUUID(),message:{id:'next',content:[{type:'text',text:'boundary'}],stop_reason:'tool_use'}});
    let child=spawn(process.execPath,[path.join(scripts,'claude-watch.cjs'),f.run],{env:f.env,stdio:['ignore','pipe','pipe']});
    await until(()=>JSON.parse(fs.readFileSync(path.join(f.run,'daemon-state.json'))).phase==='watching');
    await new Promise(resolve=>setTimeout(resolve,250));assert.equal(JSON.parse(fs.readFileSync(path.join(f.run,'daemon-state.json'))).pending,null);child.kill('SIGTERM');await new Promise(resolve=>child.once('exit',resolve));
    state=JSON.parse(fs.readFileSync(path.join(f.run,'daemon-state.json')));state.phase='idle';save(path.join(f.run,'daemon-state.json'),state);
    // Real desktop runs persist the complete event before native delivery, then may write a shorter
    // user-facing final. Treating that summary as tampering stops supervision after a valid handoff.
    const summary='Short visible summary.\nLONG_TASK_EVENT '+JSON.stringify({id,kind:'question'});
    line(f.executorLog,{type:'assistant',uuid:crypto.randomUUID(),message:{id:'summary',content:[{type:'text',text:summary}],stop_reason:'end_turn'}});
    line(f.executorLog,{type:'assistant',uuid:crypto.randomUUID(),message:{id:'after',content:[{type:'text',text:'boundary'}],stop_reason:'tool_use'}});
    child=spawn(process.execPath,[path.join(scripts,'claude-watch.cjs'),f.run],{env:f.env,stdio:['ignore','pipe','pipe']});
    await until(()=>JSON.parse(fs.readFileSync(path.join(f.run,'daemon-state.json'))).phase==='watching');
    await new Promise(resolve=>setTimeout(resolve,250));
    state=JSON.parse(fs.readFileSync(path.join(f.run,'daemon-state.json')));
    assert.equal(state.pending,null);assert.equal(state.error,undefined);assert.equal(state.seen.includes(id),true);
    assert.match(fs.readFileSync(path.join(f.run,'handoff-'+id+'.json'),'utf8'),/Persisted final\./);
    const next='Next real question.\nLONG_TASK_EVENT '+JSON.stringify({kind:'question'});
    line(f.executorLog,{type:'assistant',uuid:crypto.randomUUID(),message:{id:'next-real',content:[{type:'text',text:next}],stop_reason:'end_turn'}});
    line(f.executorLog,{type:'assistant',uuid:crypto.randomUUID(),message:{id:'next-boundary',content:[{type:'text',text:'boundary'}],stop_reason:'tool_use'}});
    await until(()=>JSON.parse(fs.readFileSync(path.join(f.run,'daemon-state.json'))).pending?.text.includes('Next real question.'));
    state=JSON.parse(fs.readFileSync(path.join(f.run,'daemon-state.json')));
    assert.equal(state.pending.kind,'question');assert.equal(state.phase,'awaiting_decision');
    if(child.exitCode===null){child.kill('SIGTERM');await new Promise(resolve=>child.once('exit',resolve));}
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('an explicit transcript id without a persisted handoff is rejected',async()=>{
  const f=fixture(),id=crypto.randomUUID();
  try{
    const text='Unregistered id.\nLONG_TASK_EVENT '+JSON.stringify({id,kind:'question'});
    line(f.executorLog,{type:'assistant',uuid:crypto.randomUUID(),message:{id:'unregistered',content:[{type:'text',text}],stop_reason:'end_turn'}});
    line(f.executorLog,{type:'assistant',uuid:crypto.randomUUID(),message:{id:'boundary',content:[{type:'text',text:'boundary'}],stop_reason:'tool_use'}});
    const child=spawn(process.execPath,[path.join(scripts,'claude-watch.cjs'),f.run],{env:f.env,stdio:['ignore','pipe','pipe']});
    await until(()=>JSON.parse(fs.readFileSync(path.join(f.run,'daemon-state.json'))).phase==='error');
    assert.match(JSON.parse(fs.readFileSync(path.join(f.run,'daemon-state.json'))).error.message,/no persisted handoff/);child.kill('SIGTERM');
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('STOP and accepted runs reject new handoff without clearing their state',()=>{
  for(const mode of ['STOP','accepted']){
    const f=fixture(),id=crypto.randomUUID(),event=eventFile(f,id,'Forbidden wake.');
    try{
      if(mode==='STOP')fs.writeFileSync(path.join(f.run,'STOP'),'stop\n');else{const state=JSON.parse(fs.readFileSync(path.join(f.run,'daemon-state.json')));state.phase='accepted';save(path.join(f.run,'daemon-state.json'),state);}
      const before=fs.readFileSync(path.join(f.run,'daemon-state.json'),'utf8');
      assert.throws(()=>execFileSync(process.execPath,[path.join(scripts,'handoff.cjs'),'prepare',f.run,event.file],{env:f.env,stdio:'pipe'}),/Command failed/);
      assert.equal(fs.readFileSync(path.join(f.run,'daemon-state.json'),'utf8'),before);
    }finally{fs.rmSync(f.root,{recursive:true,force:true});}
  }
});
