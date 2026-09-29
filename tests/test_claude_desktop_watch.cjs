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
  const env={...process.env,CLAUDE_WATCH_SETTLE_MS:'600',CLAUDE_CONFIG_DIR:path.join(root,'claude-config'),CLAUDE_SESSION_ID:supervisorId};
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

test('earlier turn text cannot make a thinking row swallow the real final question',async()=>{
  // Trimmed rows 241-243 of a real Goal II desktop transcript: both final blocks have one message.id.
  const rows=fs.readFileSync(path.join(__dirname,'fixtures/claude-final-three-rows.jsonl'),'utf8').trim().split('\n');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'claude-final-boundary-'));
  const project=path.join(root,'claude-config','projects','qa');fs.mkdirSync(project,{recursive:true});
  const source=path.join(root,'source.md');fs.writeFileSync(source,'Criterion\n');
  const supervisorId=crypto.randomUUID(),executorId=crypto.randomUUID(),marker='LONG_TASK_BIND:'+crypto.randomUUID();
  const executorLog=path.join(project,executorId+'.jsonl');
  line(path.join(project,supervisorId+'.jsonl'),{type:'user',sessionId:supervisorId,cwd:root,entrypoint:'claude-desktop'});
  line(executorLog,{type:'user',sessionId:executorId,cwd:root,entrypoint:'claude-desktop',
    message:{content:[{type:'text',text:marker+' test'}]}});
  const input=path.join(root,'input.json'),run=path.join(root,'run');
  fs.writeFileSync(input,JSON.stringify({projectRoot:root,allowedRoots:[root],supervisorId,
    supervisorDesktopId:'local_'+crypto.randomUUID(),executorId,executorDesktopId:'local_'+crypto.randomUUID(),
    executorMarker:marker,executorPrompt:marker+' test',contract:{goal:'Catch final question',authorization:'Isolated QA',
      criteria:[{id:'A1',requirement:'Final question must reach supervisor',source:'source.md:1',verify:'Replay transcript'}],
      sources:[{path:source,sha256:sha(source)}]}}));
  const env={...process.env,CLAUDE_WATCH_SETTLE_MS:'600',CLAUDE_CONFIG_DIR:path.join(root,'claude-config'),CLAUDE_SESSION_ID:supervisorId};
  execFileSync(process.execPath,[path.join(scripts,'supervise.cjs'),'init',run,input],{env});
  const child=spawn(process.execPath,[path.join(scripts,'claude-watch.cjs'),run],{env,stdio:['ignore','pipe','pipe']});
  let errors='';child.stderr.on('data',chunk=>errors+=chunk);
  try{
    await until(()=>fs.existsSync(path.join(run,'native-ready.json')));
    // A previous assistant message in the same turn supplies text before the final thinking block.
    line(executorLog,{type:'assistant',uuid:crypto.randomUUID(),message:{id:'msg_earlier_tool',
      stop_reason:'tool_use',content:[{type:'text',text:'Previous progress before tools'}]}});
    fs.appendFileSync(executorLog,rows[0]+'\n');
    await new Promise(resolve=>setTimeout(resolve,200));
    assert.equal(JSON.parse(fs.readFileSync(path.join(run,'daemon-state.json'))).pending,null);
    fs.appendFileSync(executorLog,rows[1]+'\n');
    const finalOffset=fs.statSync(executorLog).size;
    fs.appendFileSync(executorLog,rows[2]+'\n');
    line(executorLog,{type:'assistant',uuid:crypto.randomUUID(),message:{id:'msg_next',
      stop_reason:'tool_use',content:[{type:'text',text:'Next message'}]}});
    await until(()=>JSON.parse(fs.readFileSync(path.join(run,'daemon-state.json'))).pending?.id==='42079699-079a-4eea-8d3b-22c1b96aaf73');
    const state=JSON.parse(fs.readFileSync(path.join(run,'daemon-state.json')));
    assert.equal(state.pending.kind,'question');
    assert.equal(state.pending.text.includes('Previous progress before tools'),false);
    assert.equal(state.executorOffset,finalOffset);
    assert.equal(errors,'');
  }finally{child.kill('SIGTERM');fs.rmSync(root,{recursive:true,force:true});}
});

test('replayed progress uses the original reply time instead of extending its deadline',async()=>{
  // A desktop supervisor can reconnect after a missed background wake; old waits must already be due.
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'claude-replayed-wait-'));
  const project=path.join(root,'claude-config','projects','qa');fs.mkdirSync(project,{recursive:true});
  const source=path.join(root,'source.md');fs.writeFileSync(source,'Criterion\n');
  const supervisorId=crypto.randomUUID(),executorId=crypto.randomUUID(),marker='LONG_TASK_BIND:'+crypto.randomUUID();
  const executorLog=path.join(project,executorId+'.jsonl');
  line(path.join(project,supervisorId+'.jsonl'),{type:'user',sessionId:supervisorId,cwd:root,entrypoint:'claude-desktop'});
  line(executorLog,{type:'user',sessionId:executorId,cwd:root,entrypoint:'claude-desktop',
    message:{content:[{type:'text',text:marker+' test'}]}});
  const input=path.join(root,'input.json'),run=path.join(root,'run');
  fs.writeFileSync(input,JSON.stringify({projectRoot:root,allowedRoots:[root],supervisorId,
    supervisorDesktopId:'local_'+crypto.randomUUID(),executorId,executorDesktopId:'local_'+crypto.randomUUID(),
    executorMarker:marker,executorPrompt:marker+' test',contract:{goal:'Keep wait deadlines',authorization:'Isolated QA',
      criteria:[{id:'A1',requirement:'Replay does not postpone a wake',source:'source.md:1',verify:'Replay old progress'}],
      sources:[{path:source,sha256:sha(source)}]}}));
  const env={...process.env,CLAUDE_WATCH_SETTLE_MS:'150',CLAUDE_CONFIG_DIR:path.join(root,'claude-config'),CLAUDE_SESSION_ID:supervisorId};
  execFileSync(process.execPath,[path.join(scripts,'supervise.cjs'),'init',run,input],{env});
  const writtenAt=new Date(Date.now()-120000).toISOString(),id=crypto.randomUUID();
  line(executorLog,{type:'assistant',uuid:id,timestamp:writtenAt,message:{id:'msg_old_progress',
    stop_reason:'end_turn',content:[{type:'text',text:'Background work still running.\n'+
      'LONG_TASK_EVENT {"kind":"progress","nextAction":"Check the job","waitMinutes":1}'}]}});
  const child=spawn(process.execPath,[path.join(scripts,'claude-watch.cjs'),run],{env,stdio:['ignore','pipe','pipe']});
  let errors='';child.stderr.on('data',chunk=>errors+=chunk);
  try{
    await until(()=>JSON.parse(fs.readFileSync(path.join(run,'daemon-state.json'))).pending?.kind==='continue');
    const state=JSON.parse(fs.readFileSync(path.join(run,'daemon-state.json')));
    assert.equal(state.pending.id,id);
    assert.equal(state.pending.nextAction,'Check the job');
    assert.deepEqual(state.seen,[id]);
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
  const env={...process.env,PATH:emptyBin,CLAUDE_WATCH_SETTLE_MS:'150',CLAUDE_CONFIG_DIR:path.join(root,'claude-config'),CLAUDE_SESSION_ID:supervisorId};
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

test('a waiting reply with a merge approval block wakes the supervisor immediately',async()=>{
  // Redacted structure of the Rillet executor reply that was silently treated as background waiting.
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'rillet-waiting-block-'));
  const project=path.join(root,'claude-config','projects','qa');fs.mkdirSync(project,{recursive:true});
  const source=path.join(root,'source.md');fs.writeFileSync(source,'Criterion\n');
  const supervisorId=crypto.randomUUID(),executorId=crypto.randomUUID(),marker='LONG_TASK_BIND:'+crypto.randomUUID();
  const executorLog=path.join(project,executorId+'.jsonl');
  line(path.join(project,supervisorId+'.jsonl'),{type:'user',sessionId:supervisorId,cwd:root,entrypoint:'claude-desktop'});
  line(executorLog,{type:'user',sessionId:executorId,cwd:root,entrypoint:'claude-desktop',message:{content:[{type:'text',text:marker}]}});
  const run=path.join(root,'run'),input=path.join(root,'input.json');
  fs.writeFileSync(input,JSON.stringify({projectRoot:root,allowedRoots:[root],supervisorId,
    supervisorDesktopId:'local_'+crypto.randomUUID(),executorId,executorDesktopId:'local_'+crypto.randomUUID(),executorMarker:marker,
    executorPrompt:marker+' test',contract:{goal:'Catch actionable waiting reply',authorization:'Isolated QA',
      criteria:[{id:'A1',requirement:'Review blocked merge',source:'source.md:1',verify:'Replay transcript'}],
      sources:[{path:source,sha256:sha(source)}]}}));
  const env={...process.env,CLAUDE_WATCH_SETTLE_MS:'150',CLAUDE_CONFIG_DIR:path.join(root,'claude-config'),CLAUDE_SESSION_ID:supervisorId};
  execFileSync(process.execPath,[path.join(scripts,'supervise.cjs'),'init',run,input],{env});
  const child=spawn(process.execPath,[path.join(scripts,'claude-watch.cjs'),run],{env,stdio:['ignore','pipe','pipe']});
  try{
    await until(()=>fs.existsSync(path.join(run,'native-ready.json')));
    const id=crypto.randomUUID(),messageId='msg-rillet-block';
    line(executorLog,{type:'assistant',uuid:crypto.randomUUID(),message:{id:messageId,
      content:[{type:'thinking',thinking:'[redacted]'}],stop_reason:'end_turn'}});
    line(executorLog,{type:'assistant',uuid:id,message:{id:messageId,stop_reason:'end_turn',content:[{type:'text',text:
      '需要 Jay 決定的阻塞（最急）：PR #26 合併 develop 被自動化權限審查擋下。背景子代理仍在跑。\n'+
      'LONG_TASK_EVENT {"kind":"waiting","nextAction":"等 WP-W1 回報；同時等 Jay 對 P-3 合併發版的授權"}'}]}});
    await until(()=>JSON.parse(fs.readFileSync(path.join(run,'daemon-state.json'))).pending?.id===id);
    const state=JSON.parse(fs.readFileSync(path.join(run,'daemon-state.json')));
    assert.equal(state.pending.kind,'blocked');
    assert.match(state.pending.text,/權限審查擋下/);
  }finally{child.kill('SIGTERM');fs.rmSync(root,{recursive:true,force:true});}
});
