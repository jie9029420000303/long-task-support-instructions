// v1.17.0 (Jay 2026-11-25 chose 甲). Three stops the background program can judge alone used to wake the supervisor model,
// which then sent a fixed reply: a wait whose sources had already finished (工區 E 11/25: "waiting for a file" that
// existed, five times by 18:49), a wait with nothing observable, and a turn that ended with no event ("I will do X next",
// three times by 17:38). Five runs had 291 of them and the executor waited about 596 minutes for the reply. What the
// tests pin: each of the three goes straight back to the executor, and the same kind twice in a row reaches the supervisor.
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
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,ms=8000){
  const end=Date.now()+ms;
  while(Date.now()<end){if(check())return;await delay(25);}
  throw Error('Timed out waiting for Codex watcher state');
}
// finals are the executor's turns in order; the second appears only after the test creates the gate file.
function setup(finals){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'codex-v1170-')),run=path.join(root,'run');fs.mkdirSync(run);
  const source=path.join(root,'source.txt');fs.writeFileSync(source,'criterion\n');
  save(path.join(run,'contract.json'),{goal:'Exercise automatic continuation',authorization:'Isolated test with cross-thread messages',
    criteria:[{id:'A1',requirement:'Keep the executor working',source:'source.txt:1',verify:'Inspect watcher state'}],sources:[{path:source,sha256:sha(source)}]});
  save(path.join(run,'binding.json'),{platform:'codex',projectRoot:root,allowedRoots:[root,run],supervisorId:'supervisor-qa',executorId:'executor-qa',
    callerTurnId:'supervisor-turn',contractSha256:sha(path.join(run,'contract.json')),dispatchAudit:{enabled:false},createdAt:new Date().toISOString()});
  save(path.join(run,'daemon-state.json'),{phase:'starting',cursor:null,seen:[],messages:[],pending:null,inflight:null,reads:0,starts:0});
  const fixture=path.join(root,'mock.json'),sent=path.join(root,'sent.json'),gate=path.join(root,'second-turn');
  save(fixture,{supervisorId:'supervisor-qa',executorId:'executor-qa',finals:finals.map(item=>typeof item==='function'?item(root):item),secondTurnGate:gate});
  const child=spawn(process.execPath,[path.join(scripts,'native-watch.cjs'),run],{env:{...process.env,
    CODEX_APP_TOOLS_SERVER_PATH:path.join(__dirname,'mock-codex-app-server.cjs'),MOCK_CODEX_FIXTURE:fixture,MOCK_CODEX_SENT:sent,
    CODEX_WATCH_IDLE_SLEEP_MS:'25',CODEX_SUPERVISOR_DECISION_POLL_MS:'25',CODEX_WAIT_MINUTE_MS:'60000'},stdio:['ignore','pipe','pipe']});
  let stderr='';child.stderr.on('data',chunk=>stderr+=chunk.toString());
  return {root,run,sent,gate,child,stderr:()=>stderr};
}
async function stop(f){f.child.kill('SIGTERM');await new Promise(resolve=>f.child.once('exit',resolve));fs.rmSync(f.root,{recursive:true,force:true});}
const calls=f=>fs.existsSync(f.sent+'.args.json')?read(f.sent+'.args.json'):[];
const log=f=>fs.existsSync(path.join(f.run,'auto-continue.jsonl'))?fs.readFileSync(path.join(f.run,'auto-continue.jsonl'),'utf8').trim().split('\n').map(JSON.parse):[];
const waiting=(nextAction,waitFor)=>'Waiting.\nLONG_TASK_EVENT '+JSON.stringify({kind:'waiting',nextAction,waitMinutes:30,...(waitFor?{waitFor}:{})});

test('a wait whose result file already exists goes straight back to the executor, naming the file',async()=>{
  // 工區 E 18:49: the executor said it was waiting for a file that had existed for a while.
  const f=setup([root=>{const result=path.join(root,'result.json');save(result,{exit:0});return waiting('Read the result',[{path:result,sha256:null}]);}]);
  try{
    await until(()=>calls(f).length===1&&log(f).length===1);
    await delay(200);
    const sent=calls(f),state=read(path.join(f.run,'daemon-state.json'));
    assert.equal(sent.length,1,'no supervisor round for a wait that is already over');
    assert.equal(sent[0].threadId,'executor-qa');
    assert.match(sent[0].prompt,/LONG_TASK_DELIVERY:auto-executor-turn-1/);
    assert.match(sent[0].prompt,/result\.json/,'the executor learns which result to read');
    assert.deepEqual(log(f).map(item=>[item.kind,item.sentTo]),[['waiting_ready','executor']]);
    assert.equal(state.pending,null);
    assert.equal(state.progressWait,null,'the wait is over once the executor is told');
    assert.equal(Object.values(state.executionWakeReceipts||{}).length,1,'the finished source is recorded, so the periodic path does not send it again');
  }finally{await stop(f);}
  assert.doesNotMatch(f.stderr(),/Error:|Delivery uncertain|protocol_error/);
});

test('a wait with nothing observable goes back to the executor with how to register a source',async()=>{
  const f=setup([waiting('Read the background result')]);
  try{
    await until(()=>calls(f).length===1&&log(f).length===1);
    await delay(200);
    const sent=calls(f);
    assert.equal(sent.length,1);
    assert.equal(sent[0].threadId,'executor-qa');
    assert.match(sent[0].prompt,/resource-ledger/);
    assert.deepEqual(log(f).map(item=>item.kind),['waiting_no_source']);
  }finally{await stop(f);}
  assert.doesNotMatch(f.stderr(),/Error:|Delivery uncertain|protocol_error/);
});

test('a turn that ends with no event resumes the executor on its own last next step',async()=>{
  // 工區 E 17:38: the third turn that only said what it would do next, with nothing done and no subagent sent.
  const f=setup(['Next I will dispatch the three write-back packages.']);
  try{
    await until(()=>calls(f).length===1&&log(f).length===1);
    await delay(200);
    const sent=calls(f);
    assert.equal(sent.length,1);
    assert.equal(sent[0].threadId,'executor-qa');
    assert.match(sent[0].prompt,/回合結束沒有送事件/);
    assert.deepEqual(log(f).map(item=>item.kind),['unmarked_final']);
  }finally{await stop(f);}
  assert.doesNotMatch(f.stderr(),/Error:|Delivery uncertain|protocol_error/);
});

test('the same stop twice in a row reaches the supervisor marked as a repeat',async()=>{
  const f=setup(['Next I will run the tests.','Next I will run the tests.']);
  try{
    await until(()=>calls(f).length===1);
    fs.writeFileSync(f.gate,'');
    await until(()=>read(path.join(f.run,'daemon-state.json')).pending?.id==='executor-turn-2');
    const state=read(path.join(f.run,'daemon-state.json'));
    assert.equal(state.pending.kind,'unmarked_final');
    assert.deepEqual(state.pending.autoContinueRepeat,{kind:'unmarked_final',previousEventId:'executor-turn-1'});
    await until(()=>calls(f).length===2);
    assert.equal(calls(f)[1].threadId,'supervisor-qa','the fixed reply did not help, so the supervisor looks at why');
    assert.deepEqual(log(f).map(item=>item.sentTo),['executor','supervisor']);
  }finally{await stop(f);}
  assert.doesNotMatch(f.stderr(),/Error:|Delivery uncertain|protocol_error/);
});

test('a wait that something observable still runs for reaches the supervisor as before',async()=>{
  const f=setup([root=>waiting('Read the result',[{path:path.join(root,'result.json'),sha256:null}])]);
  try{
    await until(()=>calls(f).length===1);
    assert.equal(calls(f)[0].threadId,'supervisor-qa');
    assert.equal(read(path.join(f.run,'daemon-state.json')).pending.kind,'waiting');
    assert.deepEqual(log(f),[]);
  }finally{await stop(f);}
  assert.doesNotMatch(f.stderr(),/Error:|Delivery uncertain|protocol_error/);
});

test('a paused run does not continue the executor on its own',async()=>{
  const f=setup(['Next I will run the tests.']);
  fs.writeFileSync(path.join(f.run,'PAUSED.json'),'{}');
  try{
    await delay(400);
    assert.equal(calls(f).filter(call=>call.threadId==='executor-qa').length,0);
    assert.deepEqual(log(f),[]);
  }finally{await stop(f);}
});
