const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawn}=require('node:child_process');

const scripts=process.env.CODEX_SUPERVISOR_SCRIPTS||path.resolve(__dirname,'../codex/.agents/skills/long-task-supervisor/scripts');
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const save=(file,value)=>fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n');
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
async function until(check,ms=8000){
  const end=Date.now()+ms;
  while(Date.now()<end){if(check())return;await new Promise(resolve=>setTimeout(resolve,25));}
  throw Error('Timed out waiting for Codex watcher state');
}
function setup(final,extraEnv={},extraFixture={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'codex-waiting-')),run=path.join(root,'run');fs.mkdirSync(run);
  const source=path.join(root,'source.txt');fs.writeFileSync(source,'criterion\n');
  save(path.join(run,'contract.json'),{goal:'Exercise event routing',authorization:'Isolated test with cross-thread messages',
    criteria:[{id:'A1',requirement:'Route exactly once',source:'source.txt:1',verify:'Inspect watcher state'}],sources:[{path:source,sha256:sha(source)}]});
  const supervisorId='supervisor-qa',executorId='executor-qa';
  save(path.join(run,'binding.json'),{platform:'codex',projectRoot:root,allowedRoots:[root,run],supervisorId,executorId,
    callerTurnId:'supervisor-turn',contractSha256:sha(path.join(run,'contract.json')),dispatchAudit:{enabled:false},createdAt:new Date().toISOString()});
  save(path.join(run,'daemon-state.json'),{phase:'starting',cursor:null,seen:[],messages:[],pending:null,inflight:null,reads:0,starts:0});
  const fixture=path.join(root,'mock.json'),sent=path.join(root,'sent.json');save(fixture,{supervisorId,executorId,final:typeof final==='function'?final(root):final,
    ...(typeof extraFixture==='function'?extraFixture(root):extraFixture)});
  const child=spawn(process.execPath,[path.join(scripts,'native-watch.cjs'),run],{env:{...process.env,
    CODEX_APP_TOOLS_SERVER_PATH:path.join(__dirname,'mock-codex-app-server.cjs'),MOCK_CODEX_FIXTURE:fixture,MOCK_CODEX_SENT:sent,
    CODEX_WATCH_IDLE_SLEEP_MS:'25',CODEX_SUPERVISOR_DECISION_POLL_MS:'25',CODEX_WAIT_MINUTE_MS:'150',...extraEnv},stdio:['ignore','pipe','pipe']});
  let stderr='';child.stderr.on('data',chunk=>stderr+=chunk.toString());
  return {root,run,sent,fixture,child,stderr:()=>stderr};
}
async function stop(f){f.child.kill('SIGTERM');await new Promise(resolve=>f.child.once('exit',resolve));fs.rmSync(f.root,{recursive:true,force:true});}

for(const [label,event] of [
  ['waiting',{kind:'waiting',nextAction:'Read the background result',waitMinutes:1}],
  ['progress with waitMinutes',{kind:'progress',nextAction:'Read the background result',waitMinutes:1}],
])test(label+' without an observable source resumes its executor once at the fallback time',async()=>{
  const f=setup('Background command is running.\nLONG_TASK_EVENT '+JSON.stringify(event));
  try{
    await until(()=>Boolean(read(path.join(f.run,'daemon-state.json')).progressWait));
    assert.equal(fs.existsSync(f.sent),false,'declared wait must not immediately send a continuation');
    await until(()=>fs.existsSync(f.sent)&&read(f.sent).length===1);
    const state=read(path.join(f.run,'daemon-state.json'));
    await until(()=>read(path.join(f.run,'daemon-state.json')).progressWait===null);
    assert.equal(state.pending,null);
    assert.equal(read(f.sent)[0].includes('LONG_TASK_DELIVERY:continue-executor-turn-1'),true);
    assert.equal(read(f.sent+'.args.json')[0].threadId,'executor-qa','an ordinary wait must not create a supervisor model round');
  }finally{await stop(f);}
  assert.doesNotMatch(f.stderr(),/Error:|Delivery uncertain|protocol_error/);
});

test('a completed result resumes the executor before the timer and both paths deliver it only once',async()=>{
  const f=setup(root=>'A test is running.\nLONG_TASK_EVENT '+JSON.stringify({kind:'waiting',nextAction:'Collect and inspect the test result',waitMinutes:30,
    waitFor:[{path:path.join(root,'result.json'),sha256:null}]}));
  try{
    await until(()=>Boolean(read(path.join(f.run,'daemon-state.json')).progressWait));
    const deadline=read(path.join(f.run,'daemon-state.json')).progressWait.deadline;
    save(path.join(f.root,'result.json'),{exit:1});
    await until(()=>fs.existsSync(f.sent)&&read(f.sent).length===1);
    assert.ok(Date.now()<deadline,'completion must not wait for the old countdown');
    assert.equal(read(f.sent+'.args.json')[0].threadId,'executor-qa');
    await new Promise(resolve=>setTimeout(resolve,180));
    assert.equal(read(f.sent).length,1,'the periodic path must share the completion receipt');
    assert.equal(read(path.join(f.run,'daemon-state.json')).pending,null);
  }finally{await stop(f);}
  assert.doesNotMatch(f.stderr(),/Error:|Delivery uncertain|protocol_error/);
});

for(const marker of ['STOP','PAUSED.json'])test(marker+' prevents an execution completion from bypassing a user hold',async()=>{
  const f=setup(root=>'A test is running.\nLONG_TASK_EVENT '+JSON.stringify({kind:'waiting',nextAction:'Collect results',waitMinutes:30,
    waitFor:[{path:path.join(root,'result.json'),sha256:null}]}));
  try{
    await until(()=>Boolean(read(path.join(f.run,'daemon-state.json')).progressWait));
    fs.writeFileSync(path.join(f.run,marker),marker==='PAUSED.json'?'{}':'stop\n');save(path.join(f.root,'result.json'),{exit:0});
    await new Promise(resolve=>setTimeout(resolve,200));assert.equal(fs.existsSync(f.sent),false);
  }finally{
    if(f.child.exitCode===null)await stop(f);else fs.rmSync(f.root,{recursive:true,force:true});
  }
});

test('waiting with a user authorization or release blocker wakes the supervisor immediately',async()=>{
  const f=setup('需要使用者授權發布，背景工作不能自行完成。\nLONG_TASK_EVENT '+JSON.stringify({kind:'waiting',nextAction:'發布',waitMinutes:30}));
  try{
    await until(()=>read(path.join(f.run,'daemon-state.json')).pending?.kind==='blocked');
    assert.equal(read(path.join(f.run,'daemon-state.json')).progressWait,undefined);
    await until(()=>fs.existsSync(f.sent)&&read(f.sent).length===1);
  }finally{await stop(f);}
  assert.doesNotMatch(f.stderr(),/Error:|Delivery uncertain|protocol_error/);
});

test('ordinary progress still sends one immediate executor continuation',async()=>{
  const f=setup('Continue the work.\nLONG_TASK_EVENT '+JSON.stringify({kind:'progress',nextAction:'Run the next check'}));
  try{
    await until(()=>fs.existsSync(f.sent)&&read(f.sent).length===1);
    const state=read(path.join(f.run,'daemon-state.json'));
    assert.equal(state.pending,null);
    assert.equal(read(f.sent)[0].includes('LONG_TASK_DELIVERY:continue-executor-turn-1'),true);
  }finally{await stop(f);}
  assert.doesNotMatch(f.stderr(),/Error:|Delivery uncertain|protocol_error/);
});

test('ordinary progress during a user pause waits for resume instead of waking its executor',async()=>{
  const f=setup(root=>{fs.writeFileSync(path.join(root,'run','PAUSED.json'),'{}');return 'Continue work.\nLONG_TASK_EVENT {"kind":"progress","nextAction":"Do the existing next step"}';});
  try{
    await until(()=>read(path.join(f.run,'daemon-state.json')).progressWait?.immediate);
    await new Promise(r=>setTimeout(r,100));assert.equal(fs.existsSync(f.sent),false);
    fs.unlinkSync(path.join(f.run,'PAUSED.json'));await until(()=>fs.existsSync(f.sent)&&read(f.sent).length===1);
    assert.equal(read(f.sent+'.args.json')[0].threadId,'executor-qa');
  }finally{await stop(f);}
});

test('completion from a different executor snapshot stays blocked until ownership is corrected',async()=>{
  const f=setup(root=>'Waiting.\nLONG_TASK_EVENT '+JSON.stringify({kind:'waiting',nextAction:'Read the result',waitMinutes:30,
    waitFor:[{path:path.join(root,'result.json'),sha256:null}]}));
  try{
    await until(()=>Boolean(read(path.join(f.run,'daemon-state.json')).progressWait));
    save(path.join(f.run,'dispatch.json'),{executorId:'different-executor',packages:{inFlight:[]}});save(path.join(f.root,'result.json'),{exit:0});
    await new Promise(r=>setTimeout(r,120));assert.equal(fs.existsSync(f.sent),false);
    save(path.join(f.run,'dispatch.json'),{executorId:'executor-qa',packages:{inFlight:[]}});
    await until(()=>fs.existsSync(f.sent)&&read(f.sent).length===1);
    assert.equal(read(f.sent+'.args.json')[0].threadId,'executor-qa');
  }finally{await stop(f);}
});

test('a mismatched readback identity cannot authorize an execution continuation',async()=>{
  const f=setup(root=>'Waiting.\nLONG_TASK_EVENT '+JSON.stringify({kind:'waiting',nextAction:'Read the result',waitMinutes:30,
    waitFor:[{path:path.join(root,'result.json'),sha256:null}]}),{},root=>({badExecutorReadGate:path.join(root,'bad-read')}));
  try{
    await until(()=>Boolean(read(path.join(f.run,'daemon-state.json')).progressWait));
    fs.writeFileSync(path.join(f.root,'bad-read'),'bad');save(path.join(f.root,'result.json'),{exit:0});
    await until(()=>Boolean(read(path.join(f.run,'daemon-state.json')).error));
    assert.equal(fs.existsSync(f.sent),false);
  }finally{if(f.child.exitCode===null&&f.child.signalCode===null)await stop(f);else fs.rmSync(f.root,{recursive:true,force:true});}
});

test('a delivered review with no supervisor model output gets one wake fallback without resending the event',async()=>{
  const f=setup('A real blocker needs review.\nLONG_TASK_EVENT {"kind":"blocked"}',{CODEX_SUPERVISOR_WAKE_MS:'80'});
  try{
    await until(()=>fs.existsSync(f.sent)&&read(f.sent).length===2);
    await new Promise(resolve=>setTimeout(resolve,180));
    const sent=read(f.sent);
    assert.equal(sent.length,2);
    assert.equal(sent.filter(text=>text.startsWith('LONG_TASK_DELIVERY:review-executor-turn-1')).length,1);
    assert.equal(sent.filter(text=>text.startsWith('LONG_TASK_DELIVERY:wake-review-executor-turn-1')).length,1);
    assert.equal(sent[1].includes('不要重建或重送業務事件'),true);
  }finally{await stop(f);}
  assert.doesNotMatch(f.stderr(),/Error:|Delivery uncertain|protocol_error/);
});

test('STOP after the review delivery suppresses the wake fallback',async()=>{
  const f=setup('A real blocker needs review.\nLONG_TASK_EVENT {"kind":"blocked"}',{CODEX_SUPERVISOR_WAKE_MS:'120'});
  try{
    await until(()=>fs.existsSync(f.sent)&&read(f.sent).length===1);
    fs.writeFileSync(path.join(f.run,'STOP'),'user stop\n');
    await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Watcher did not honor STOP')),3000);
      f.child.once('exit',()=>{clearTimeout(timer);resolve();});});
    assert.equal(read(f.sent).length,1);
  }finally{
    f.child.kill('SIGTERM');
    fs.rmSync(f.root,{recursive:true,force:true});
  }
  assert.doesNotMatch(f.stderr(),/Error:|Delivery uncertain|protocol_error/);
});
