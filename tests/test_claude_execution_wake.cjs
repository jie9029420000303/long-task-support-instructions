const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),net=require('node:net');
const api=require('../claude-code/.claude/skills/long-task-supervisor/scripts/execution-watch.cjs');
const {spawn,execFileSync}=require('node:child_process');
const save=(p,v)=>fs.writeFileSync(p,JSON.stringify(v)+'\n');
const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
async function until(check,ms=6000){const end=Date.now()+ms;while(Date.now()<end){if(check())return;await new Promise(r=>setTimeout(r,20));}throw Error('Timed out');}
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'claude-exec-wake-')),run=path.join(root,'run');fs.mkdirSync(run);
 const source=path.join(root,'source');fs.writeFileSync(source,'Isolated QA only');
 const executorId=crypto.randomUUID(),supervisorId=crypto.randomUUID(),env={};
 for(const key of ['CLAUDE_SESSION_ID','CLAUDE_CODE_MESSAGING_SOCKET','CLAUDE_CODE_MESSAGING_TOKEN'])env[key]=process.env[key];
 process.env.CLAUDE_SESSION_ID=executorId;delete process.env.CLAUDE_CODE_MESSAGING_SOCKET;delete process.env.CLAUDE_CODE_MESSAGING_TOKEN;
 t.after(()=>{for(const [key,value]of Object.entries(env))if(value===undefined)delete process.env[key];else process.env[key]=value;fs.rmSync(root,{recursive:true,force:true});});
 const contract={goal:'Isolated completion',authorization:'Only fixtures',criteria:[{id:'A1',requirement:'Execution owns child results',verify:'Inspect isolated messages',source:'source:1'}],sources:[{path:source,sha256:crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex')}]};
 save(path.join(run,'contract.json'),contract);
 save(path.join(run,'binding.json'),{platform:'claude-code',executorId,supervisorId,allowedRoots:[root],projectRoot:root,
  executorLog:path.join(root,executorId+'.jsonl'),contractSha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(run,'contract.json'))).digest('hex')});
 fs.writeFileSync(path.join(root,executorId+'.jsonl'),'');save(path.join(run,'daemon-state.json'),{phase:'watching'});
 save(path.join(run,'dispatch.json'),{packages:{inFlight:[]}});
 const result=path.join(root,'result.json');return {root,run,result,executorId,supervisorId,input:{kind:'waiting',nextAction:'Collect the result and continue',waitMinutes:20,waitFor:[{path:result,sha256:null}]}};
}
async function inbox(t){
 const file=path.join('/tmp','exec-inbox-'+crypto.randomUUID()+'.sock'),messages=[];
 const server=net.createServer(socket=>{let text='';socket.on('data',b=>text+=b);socket.on('end',()=>{messages.push(text.trim().split('\n').map(JSON.parse));socket.end();});});
 await new Promise(r=>server.listen(file,r));
 t.after(async()=>{await new Promise(r=>server.close(r));if(fs.existsSync(file))fs.unlinkSync(file);});return {file,messages};
}
test('own-session inbox delivery uses the native two-line protocol without accepting another target',async t=>{
 const s=await inbox(t),env={CLAUDE_CODE_MESSAGING_SOCKET:s.file,CLAUDE_CODE_MESSAGING_TOKEN:'mock-token-with-newline\nfixture'};
 assert.equal(await api.sendOwn('子代理完成\n請收回',env),true);await until(()=>s.messages.length===1);
 assert.equal(s.messages[0].length,2);assert.equal(s.messages[0][0].type,'auth');
 assert.deepEqual(s.messages[0][1],{type:'user',message:{role:'user',content:'子代理完成\n請收回'}});
 assert.equal('target' in s.messages[0][1],false);
});
test('missing own-session inbox capability is a native fallback, not permission to use a supervisor token',async()=>{
 assert.equal(await api.sendOwn('result',{}),false);
 assert.equal(await api.sendOwn('result',{CLAUDE_CODE_MESSAGING_SOCKET:'/tmp/no-execution-inbox.sock',CLAUDE_CODE_MESSAGING_TOKEN:'mock'}),false);
});
test('a supervisor or another session cannot register or consume an execution-owned result',t=>{
 const f=fixture(t);process.env.CLAUDE_SESSION_ID=f.supervisorId;
 assert.throws(()=>api.register(f.run,f.input),/bound executor itself/);
 assert.equal(fs.existsSync(path.join(f.run,'execution-waits')),false);
});
test('a result appearing early returns through the original executor Bash when own inbox capability is absent',async t=>{
 const f=fixture(t),item=api.register(f.run,f.input),output=[],log=console.log;console.log=x=>output.push(x);
 try{
  const pending=api.watch(f.run);setTimeout(()=>save(f.result,{exit:1}),30);const result=await pending;
  assert.equal(result.fallback,true);assert.equal(result.id,item.id);assert.equal(output.length,1);
  assert.match(output[0],new RegExp('LONG_TASK_EXECUTION_RESUME:'+item.id));
  const state=read(api.paths(f.run,item.id).state);assert.ok(state.readyAt);assert.ok(state.fallbackAt);
  assert.equal(fs.existsSync(api.paths(f.run,item.id).receipt),false,'transport must not manufacture a model-read receipt');
  assert.equal(api.receipt(f.run,item.id).executorId,f.executorId);
 }finally{console.log=log;}
});
test('own inbox and periodic reads share a durable delivery; a socket write is not a consumption receipt',async t=>{
 const f=fixture(t),s=await inbox(t);process.env.CLAUDE_CODE_MESSAGING_SOCKET=s.file;process.env.CLAUDE_CODE_MESSAGING_TOKEN='mock';
 const item=api.register(f.run,f.input),p=api.paths(f.run,item.id);const pending=api.watch(f.run);
 try{
  setTimeout(()=>save(f.result,{exit:0}),30);await until(()=>fs.existsSync(p.state)&&read(p.state).socketWrittenAt);
  await until(()=>s.messages.length===1);assert.equal(fs.existsSync(p.receipt),false);
  api.receipt(f.run,item.id);await new Promise(r=>setTimeout(r,2100));
  assert.equal(s.messages.length,1,'the resident worker must not emit another completion for the same result');
  assert.ok(read(p.receipt).receivedAt);assert.equal(read(p.receipt).passed,undefined);
 }finally{fs.writeFileSync(path.join(f.run,'STOP'),'stop\n');await pending;}
});
test('a user pause holds a completed result until resume and STOP prevents delivery entirely',async t=>{
 const f=fixture(t),s=await inbox(t);process.env.CLAUDE_CODE_MESSAGING_SOCKET=s.file;process.env.CLAUDE_CODE_MESSAGING_TOKEN='mock';
 api.register(f.run,f.input);fs.writeFileSync(path.join(f.run,'PAUSED.json'),'{}');save(f.result,{exit:0});const pending=api.watch(f.run);
 try{
  await new Promise(r=>setTimeout(r,100));assert.equal(s.messages.length,0);
  fs.writeFileSync(path.join(f.run,'STOP'),'stop\n');fs.unlinkSync(path.join(f.run,'PAUSED.json'));
  await pending;assert.equal(s.messages.length,0);
 }finally{fs.writeFileSync(path.join(f.run,'STOP'),'stop\n');await pending;}
});
test('a completion request cannot silently change work or watch results outside its allowed roots',t=>{
 const f=fixture(t),item=api.register(f.run,f.input);
 assert.throws(()=>api.register(f.run,{...f.input,id:item.id,nextAction:'Do different work'}),/different work/);
 assert.throws(()=>api.register(f.run,{...f.input,waitFor:[{path:'/etc/passwd',sha256:null}]}),/allowed roots/);
 assert.throws(()=>api.register(f.run,{...f.input,kind:'question'}),/supervisor handoff/);
});

function supervisorWatcher(f,event){
 const p=path.join(f.run,'binding.json'),binding=read(p),prompt=path.join(f.run,'executor-prompt.txt');fs.writeFileSync(prompt,'bound execution');
 const supervisorLog=path.join(f.root,f.supervisorId+'.jsonl');fs.writeFileSync(supervisorLog,'');
 Object.assign(binding,{supervisorLog,supervisorDesktopId:'local_'+f.supervisorId,executorDesktopId:'local_'+f.executorId,
  createdAt:new Date().toISOString(),dispatchAudit:{enabled:false},promptSha256:crypto.createHash('sha256').update(fs.readFileSync(prompt)).digest('hex')});save(p,binding);
 save(path.join(f.run,'daemon-state.json'),{phase:'idle',executorOffset:0,seen:[],reads:0,pending:null});
 const child=spawn(process.execPath,[path.resolve(__dirname,'../claude-code/.claude/skills/long-task-supervisor/scripts/claude-watch.cjs'),f.run],{
  env:{...process.env,CLAUDE_SESSION_ID:f.supervisorId,CLAUDE_CONFIG_DIR:path.join(f.root,'config'),CLAUDE_WATCH_SETTLE_MS:'20'},stdio:['ignore','pipe','pipe']});
 child.out='';child.err='';child.stdout.on('data',b=>child.out+=b);child.stderr.on('data',b=>child.err+=b);
 fs.appendFileSync(binding.executorLog,JSON.stringify({type:'assistant',uuid:crypto.randomUUID(),timestamp:new Date().toISOString(),
  message:{id:'waiting-message',stop_reason:'end_turn',content:[{type:'text',text:'Background work.\nLONG_TASK_EVENT '+JSON.stringify(event)}]}})+'\n');
 return child;
}
async function stopChild(child){if(child.exitCode!==null||child.signalCode!==null)return;const done=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');await done;}
// The supervisor's observe ruling through the real decision command, then its watcher armed again as context says.
function observeAndRearm(f,eventId){
 const draft=path.join(f.root,'decision-'+eventId+'.json'),env={...process.env,CLAUDE_SESSION_ID:f.supervisorId,CLAUDE_CONFIG_DIR:path.join(f.root,'config')};
 save(draft,{eventId,disposition:'observe',reason:'The declared wait is reasonable; its result returns to the main line.'});
 execFileSync(process.execPath,[path.resolve(__dirname,'../claude-code/.claude/skills/long-task-supervisor/scripts/supervise.cjs'),'decision',f.run,draft],{env,stdio:'pipe'});
 const child=spawn(process.execPath,[path.resolve(__dirname,'../claude-code/.claude/skills/long-task-supervisor/scripts/claude-watch.cjs'),f.run],{
  env:{...env,CLAUDE_WATCH_SETTLE_MS:'20'},stdio:['ignore','pipe','pipe']});
 child.out='';child.err='';child.stdout.on('data',b=>child.out+=b);child.stderr.on('data',b=>child.err+=b);return child;
}
const exited=child=>child.exitCode!==null||child.signalCode!==null;

test('a declared wait reaches the supervisor once; its failed test then returns through the execution inbox without a second detour',async t=>{
 const f=fixture(t),s=await inbox(t);process.env.CLAUDE_CODE_MESSAGING_SOCKET=s.file;process.env.CLAUDE_CODE_MESSAGING_TOKEN='mock';
 const item=api.register(f.run,{...f.input,waitMinutes:.001}),worker=api.watch(f.run);let child=supervisorWatcher(f,item.event);
 try{
  // Jay 2026-11-08: every stop without a named next step reaches the supervisor at once, with what can be observed.
  await until(()=>read(path.join(f.run,'daemon-state.json')).pending?.kind==='waiting');
  const declared=read(path.join(f.run,'daemon-state.json')).pending;
  assert.equal(declared.executionWatch,item.id);assert.equal(declared.completion.observable,true);
  assert.equal(declared.completion.running.length,1);
  await until(()=>exited(child));assert.equal((child.out.match(/LONG_TASK_WAKE/g)||[]).length,1);
  save(f.result,{exit:1});await until(()=>s.messages.length===1);
  child=observeAndRearm(f,declared.id);
  await until(()=>read(path.join(f.run,'daemon-state.json')).phase==='watching');
  await new Promise(r=>setTimeout(r,600));
  assert.equal(read(path.join(f.run,'daemon-state.json')).pending,null,'ordinary completion stays in the execution layer after the old timer expires');
  assert.doesNotMatch(child.out,/LONG_TASK_WAKE/);assert.equal(child.err,'');
  api.receipt(f.run,item.id);
 }finally{fs.writeFileSync(path.join(f.run,'STOP'),'stop\n');await worker;await stopChild(child);}
});

test('a missing execution-native watcher is a recoverable delivery fault for the periodic supervisor after it rules on the wait',async t=>{
 const f=fixture(t),item=api.register(f.run,f.input);let child=supervisorWatcher(f,item.event);
 try{
  await until(()=>read(path.join(f.run,'daemon-state.json')).pending?.kind==='waiting');
  await until(()=>exited(child));
  child=observeAndRearm(f,read(path.join(f.run,'daemon-state.json')).pending.id);
  await until(()=>read(path.join(f.run,'daemon-state.json')).pending?.deliveryRecovery);
  const pending=read(path.join(f.run,'daemon-state.json')).pending;
  assert.equal(pending.kind,'continue');assert.match(pending.text,/原生續接需要恢復/);
  assert.equal(child.err,'');
 }finally{await stopChild(child);}
});

test('a registered next step resumes through the executor own watcher without a supervisor round',async t=>{
 const f=fixture(t),s=await inbox(t);process.env.CLAUDE_CODE_MESSAGING_SOCKET=s.file;process.env.CLAUDE_CODE_MESSAGING_TOKEN='mock';
 const item=api.register(f.run,{kind:'progress',nextAction:'Run the next check'}),worker=api.watch(f.run),child=supervisorWatcher(f,item.event);
 try{
  await until(()=>s.messages.length===1);
  await until(()=>read(path.join(f.run,'daemon-state.json')).progressWait?.event.executionWatch===item.id);
  await new Promise(r=>setTimeout(r,150));
  assert.equal(read(path.join(f.run,'daemon-state.json')).pending,null,'a named next step stays in the execution layer');
  assert.doesNotMatch(child.out,/LONG_TASK_WAKE/);assert.equal(child.err,'');
 }finally{fs.writeFileSync(path.join(f.run,'STOP'),'stop\n');await worker;await stopChild(child);}
});
