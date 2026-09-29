const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawn,execFileSync}=require('node:child_process');
const scripts=path.resolve(__dirname,'../claude-code/.claude/skills/long-task-supervisor/scripts');
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const line=(file,value)=>fs.appendFileSync(file,JSON.stringify(value)+'\n');
async function until(check,ms=6000){const end=Date.now()+ms;while(Date.now()<end){if(check())return;await new Promise(resolve=>setTimeout(resolve,50));}throw Error('Timed out waiting for desktop watcher');}

test('legacy detached runner cannot start a hidden CLI mainline',()=>{
  assert.throws(()=>execFileSync(process.execPath,[path.join(scripts,'run-watch.cjs')],{stdio:'pipe'}),/Command failed/);
});

test('stopped legacy run exits cleanly before desktop binding validation',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'claude-stopped-watch-'));
  try{
    fs.writeFileSync(path.join(root,'binding.json'),JSON.stringify({platform:'claude-code'}));
    fs.writeFileSync(path.join(root,'daemon-state.json'),JSON.stringify({phase:'error',executorOffset:0}));
    fs.writeFileSync(path.join(root,'STOP'),'stopped\n');
    execFileSync(process.execPath,[path.join(scripts,'claude-watch.cjs'),root],{stdio:'pipe'});
    const state=JSON.parse(fs.readFileSync(path.join(root,'daemon-state.json'),'utf8'));
    assert.equal(state.phase,'stopped');
    assert.equal(fs.existsSync(path.join(root,'watcher.lock')),false);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('desktop watcher ignores a thinking-only end_turn and wakes on the real event',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'claude-desktop-watch-'));
  const project=path.join(root,'claude-config','projects','qa');fs.mkdirSync(project,{recursive:true});
  const source=path.join(root,'source.md');fs.writeFileSync(source,'QA criterion\n');
  const supervisorId=crypto.randomUUID(),executorId=crypto.randomUUID(),marker='LONG_TASK_BIND:'+crypto.randomUUID();
  const supervisorLog=path.join(project,supervisorId+'.jsonl'),executorLog=path.join(project,executorId+'.jsonl');
  line(supervisorLog,{type:'user',sessionId:supervisorId,cwd:root,entrypoint:'claude-desktop'});
  line(executorLog,{type:'user',sessionId:executorId,cwd:root,entrypoint:'claude-desktop',message:{content:[{type:'text',text:marker+' test'}]}});
  const input=path.join(root,'input.json'),run=path.join(root,'run');
  fs.writeFileSync(input,JSON.stringify({projectRoot:root,allowedRoots:[root],supervisorId,
    supervisorDesktopId:'local_'+crypto.randomUUID(),executorId,executorDesktopId:'local_'+crypto.randomUUID(),
    executorMarker:marker,executorPrompt:marker+' test',contract:{goal:'Test desktop event',authorization:'Isolated QA',
      criteria:[{id:'A1',requirement:'Valid event',source:'source.md:1',verify:'Read transcript'}],sources:[{path:source,sha256:sha(source)}]}}));
  const env={...process.env,CLAUDE_CONFIG_DIR:path.join(root,'claude-config'),CLAUDE_SESSION_ID:supervisorId};
  execFileSync(process.execPath,[path.join(scripts,'supervise.cjs'),'init',run,input],{env});
  const child=spawn(process.execPath,[path.join(scripts,'claude-watch.cjs'),run],{env,stdio:['ignore','pipe','pipe']});
  let output='',errors='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>errors+=chunk);
  try{
    await until(()=>fs.existsSync(path.join(run,'native-ready.json')));
    const messageId='msg-'+crypto.randomUUID();
    line(executorLog,{type:'assistant',uuid:crypto.randomUUID(),message:{id:messageId,content:[{type:'thinking',thinking:'',signature:'x'}],stop_reason:'end_turn'}});
    await new Promise(resolve=>setTimeout(resolve,250));
    assert.equal(JSON.parse(fs.readFileSync(path.join(run,'daemon-state.json'))).pending,null);
    line(executorLog,{type:'assistant',uuid:crypto.randomUUID(),message:{id:messageId,
      content:[{type:'text',text:'Still working.\nLONG_TASK_EVENT {"kind":"progress","nextAction":"Run QA"}'}],stop_reason:'end_turn'}});
    await until(()=>JSON.parse(fs.readFileSync(path.join(run,'daemon-state.json'))).pending?.kind==='progress');
    const state=JSON.parse(fs.readFileSync(path.join(run,'daemon-state.json')));
    assert.equal(state.pending.nextAction,'Run QA');
    assert.match(output,/LONG_TASK_WAKE/);
    assert.equal(errors,'');
  }finally{child.kill('SIGTERM');fs.rmSync(root,{recursive:true,force:true});}
});

test('real split-turn rows produce one event per reply and delivery works without rg',async()=>{
  // Structural rows from Gateway executor transcript lines 241-242 and 294-295; private text is redacted.
  const rows=fs.readFileSync(path.join(__dirname,'fixtures/claude-split-end-turn.jsonl'),'utf8').trim().split('\n');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'claude-real-split-'));
  const project=path.join(root,'claude-config','projects','qa'),emptyBin=path.join(root,'empty-bin');
  fs.mkdirSync(project,{recursive:true});fs.mkdirSync(emptyBin);
  const source=path.join(root,'source.md');fs.writeFileSync(source,'Criterion\n');
  const supervisorId=crypto.randomUUID(),executorId=crypto.randomUUID(),marker='LONG_TASK_BIND:'+crypto.randomUUID();
  const executorLog=path.join(project,executorId+'.jsonl');
  line(path.join(project,supervisorId+'.jsonl'),{type:'user',sessionId:supervisorId,cwd:root,entrypoint:'claude-desktop'});
  line(executorLog,{type:'user',sessionId:executorId,cwd:root,entrypoint:'claude-desktop',
    message:{content:[{type:'text',text:marker+' test'}]}});
  const input=path.join(root,'input.json'),run=path.join(root,'run');
  fs.writeFileSync(input,JSON.stringify({projectRoot:root,allowedRoots:[root],supervisorId,
    supervisorDesktopId:'local_'+crypto.randomUUID(),executorId,executorDesktopId:'local_'+crypto.randomUUID(),
    executorMarker:marker,executorPrompt:marker+' test',contract:{goal:'Check real split rows',authorization:'Isolated QA',
      criteria:[{id:'A1',requirement:'One event per reply',source:'source.md:1',verify:'Replay transcript'}],
      sources:[{path:source,sha256:sha(source)}]}}));
  const env={...process.env,PATH:emptyBin,CLAUDE_CONFIG_DIR:path.join(root,'claude-config'),CLAUDE_SESSION_ID:supervisorId};
  const script=path.join(scripts,'supervise.cjs');
  execFileSync(process.execPath,[script,'init',run,input],{env});
  const start=()=>spawn(process.execPath,[path.join(scripts,'claude-watch.cjs'),run],{env,stdio:['ignore','pipe','pipe']});
  let child;
  try{
    child=start();
    await until(()=>fs.existsSync(path.join(run,'native-ready.json')));
    fs.appendFileSync(executorLog,rows.slice(0,2).join('\n')+'\n');
    await until(()=>JSON.parse(fs.readFileSync(path.join(run,'daemon-state.json'))).pending?.id==='42079699-079a-4eea-8d3b-22c1b96aaf73');
    await until(()=>!fs.existsSync(path.join(run,'watcher.lock')));
    let state=JSON.parse(fs.readFileSync(path.join(run,'daemon-state.json')));
    assert.equal(state.pending.kind,'question');
    assert.equal(state.seen.includes('c041fcdd-a2d6-48aa-a5db-2839b16203e7'),false);
    const eventId=state.pending.id,deliveryMarker='LONG_TASK_DELIVERY:'+eventId;
    line(executorLog,{type:'user',origin:{kind:'agent'},message:{content:[{type:'text',text:deliveryMarker+'\nContinue'}]}});
    const decisionFile=path.join(root,'decision.json');
    fs.writeFileSync(decisionFile,JSON.stringify({eventId,disposition:'reply',reply:'Continue',
      delivery:{marker:deliveryMarker,status:'delivered',messageId:'desktop-message-1'}}));
    const decided=JSON.parse(execFileSync(process.execPath,[script,'decision',run,decisionFile],{env,encoding:'utf8'}));
    assert.equal(decided.processed,true);
    child=start();
    await until(()=>JSON.parse(fs.readFileSync(path.join(run,'daemon-state.json'))).phase==='watching');
    fs.appendFileSync(executorLog,rows.slice(2).join('\n')+'\n');
    await until(()=>JSON.parse(fs.readFileSync(path.join(run,'daemon-state.json'))).pending?.id==='5ad8c754-fc83-4ee7-ad8c-94a0950745d7');
    state=JSON.parse(fs.readFileSync(path.join(run,'daemon-state.json')));
    assert.deepEqual(state.seen,[eventId]);
    assert.equal(state.pending.kind,'question');
  }finally{child?.kill('SIGTERM');fs.rmSync(root,{recursive:true,force:true});}
});
