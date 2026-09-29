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
