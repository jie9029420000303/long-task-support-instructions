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
async function until(check,ms=12000) {
  const end=Date.now()+ms;
  while(Date.now()<end) {if(check()) return;await new Promise(resolve=>setTimeout(resolve,80));}
  throw Error('Timed out waiting for watcher state');
}

test('resident Codex watcher reads exact final, confirms one delivery, and accepts one revision',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'supervision-watch-'));
  const source=path.join(root,'source.txt'),candidate=path.join(root,'candidate.txt'),manifest=path.join(root,'manifest.json');
  fs.writeFileSync(source,'Required output: alpha LF beta LF\n');fs.writeFileSync(candidate,'alpha\nbeta\n');
  save(manifest,{files:[{path:candidate,sha256:sha(candidate)}]});
  const contract={goal:'Produce exact two-line file',authorization:'Isolated QA',criteria:[{id:'A1',requirement:'Exact two-line file',source:'source.txt:1',verify:'Read bytes'}],sources:[{path:source,sha256:sha(source)}]};
  const run=path.join(root,'run');fs.mkdirSync(run);
  save(path.join(run,'contract.json'),contract);
  const supervisorId='supervisor-qa',executorId='executor-qa';
  save(path.join(run,'binding.json'),{platform:'codex',projectRoot:root,allowedRoots:[root,run],
    supervisorId,executorId,callerTurnId:'supervisor-turn',contractSha256:sha(path.join(run,'contract.json'))});
  save(path.join(run,'daemon-state.json'),{phase:'starting',cursor:null,seen:[],messages:[],pending:null,inflight:null,reads:0,starts:0});
  const final='QA result submitted.\nLONG_TASK_EVENT '+JSON.stringify({kind:'submission',revision:'sha256:'+sha(manifest),manifest});
  const fixture=path.join(root,'mock.json'),sentFile=path.join(root,'sent.json');
  save(fixture,{supervisorId,executorId,final});
  const child=spawn(process.execPath,[path.join(scripts,'native-watch.cjs'),run],{
    env:{...process.env,CODEX_APP_TOOLS_SERVER_PATH:path.join(__dirname,'mock-codex-app-server.cjs'),MOCK_CODEX_FIXTURE:fixture,MOCK_CODEX_SENT:sentFile},stdio:['ignore','pipe','pipe']});
  let stderr='';child.stderr.on('data',chunk=>stderr+=chunk.toString());
  try {
    await until(()=>fs.existsSync(path.join(run,'native-ready.json')));
    await until(()=>{const s=JSON.parse(fs.readFileSync(path.join(run,'daemon-state.json')));return s.pending?.kind==='submission' && s.messages.length===1;});
    const state=JSON.parse(fs.readFileSync(path.join(run,'daemon-state.json')));
    assert.equal(state.pending.revision,'sha256:'+sha(manifest));
    assert.equal(state.pid,child.pid);
    const receipt=JSON.parse(fs.readFileSync(path.join(run,'receipt-review-executor-turn-1.json')));
    assert.equal(receipt.confirmed,true);
    assert.equal(JSON.parse(fs.readFileSync(sentFile)).length,1);
    save(path.join(run,'decision-executor-turn-1.json'),{eventId:'executor-turn-1',disposition:'accept',revision:state.pending.revision,
      results:[{id:'A1',status:'PASS',method:'Read exact bytes',expected:'alpha LF beta LF',actual:'alpha LF beta LF',evidence:[{path:candidate,sha256:sha(candidate)}]}]});
    try {
      await until(()=>JSON.parse(fs.readFileSync(path.join(run,'daemon-state.json'))).phase==='accepted');
    } catch (error) {
      throw Error(error.message+'; state='+fs.readFileSync(path.join(run,'daemon-state.json'),'utf8')+'; stderr='+stderr);
    }
    const checked=JSON.parse(require('node:child_process').execFileSync(process.execPath,
      [path.join(scripts,'supervise.cjs'),'decision',run,path.join(run,'decision-executor-turn-1.json')],{encoding:'utf8'}));
    assert.equal(checked.valid,true);
    assert.equal(checked.processed,true);
    assert.equal(JSON.parse(fs.readFileSync(sentFile)).length,1);
  } finally {child.kill('SIGTERM');fs.rmSync(root,{recursive:true,force:true});}
  assert.equal(stderr,'');
});

test('Codex observe sends no executor reply, preserves approval, and continues to a new submission',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'supervision-observe-'));
  const source=path.join(root,'source.txt'),candidate=path.join(root,'candidate.txt'),manifest=path.join(root,'manifest.json');
  fs.writeFileSync(source,'Required output: done\n');fs.writeFileSync(candidate,'done\n');
  save(manifest,{files:[{path:candidate,sha256:sha(candidate)}]});
  const contract={goal:'Finish after a known approval block',authorization:'Isolated QA',criteria:[{id:'A1',requirement:'Exact output',source:'source.txt:1',verify:'Read bytes'}],sources:[{path:source,sha256:sha(source)}]};
  const run=path.join(root,'run');fs.mkdirSync(run);
  save(path.join(run,'contract.json'),contract);
  const supervisorId='supervisor-qa',executorId='executor-qa';
  save(path.join(run,'binding.json'),{platform:'codex',projectRoot:root,allowedRoots:[root,run],supervisorId,executorId,callerTurnId:'supervisor-turn',contractSha256:sha(path.join(run,'contract.json'))});
  save(path.join(run,'daemon-state.json'),{phase:'starting',cursor:null,seen:[],messages:[],pending:null,inflight:null,reads:0,starts:0});
  const finals=[
    'PR #26 is still waiting for Jay approval.\nLONG_TASK_EVENT {"kind":"blocked"}',
    'Candidate ready.\nLONG_TASK_EVENT '+JSON.stringify({kind:'submission',revision:'sha256:'+sha(manifest),manifest})
  ];
  const fixture=path.join(root,'mock.json'),sentFile=path.join(root,'sent.json'),secondTurnGate=path.join(root,'allow-second-turn');
  save(fixture,{supervisorId,executorId,finals,secondTurnGate});
  const start=()=>spawn(process.execPath,[path.join(scripts,'native-watch.cjs'),run],{env:{...process.env,CODEX_APP_TOOLS_SERVER_PATH:path.join(__dirname,'mock-codex-app-server.cjs'),MOCK_CODEX_FIXTURE:fixture,MOCK_CODEX_SENT:sentFile},stdio:['ignore','pipe','pipe']});
  let child=start(),stderr='';child.stderr.on('data',chunk=>stderr+=chunk.toString());
  try {
    await until(()=>JSON.parse(fs.readFileSync(path.join(run,'daemon-state.json'))).pending?.id==='executor-turn-1');
    save(path.join(run,'decision-executor-turn-1.json'),{eventId:'executor-turn-1',disposition:'observe',reason:'This exact merge approval is already pending; do not repeat it to the executor.',pendingApprovals:['Merge PR #26 into develop']});
    await until(()=>JSON.parse(fs.readFileSync(path.join(run,'daemon-state.json'))).resolved?.['executor-turn-1']);
    child.kill('SIGTERM');await new Promise(resolve=>child.once('exit',resolve));
    const observed=JSON.parse(fs.readFileSync(path.join(run,'daemon-state.json')));
    assert.equal(observed.resolved['executor-turn-1'].decision.reason,'This exact merge approval is already pending; do not repeat it to the executor.');
    assert.equal(JSON.parse(fs.readFileSync(sentFile)).length,1);
    fs.writeFileSync(secondTurnGate,'go\n');
    child=start();child.stderr.on('data',chunk=>stderr+=chunk.toString());
    await until(()=>JSON.parse(fs.readFileSync(path.join(run,'daemon-state.json'))).pending?.id==='executor-turn-2');
    const state=JSON.parse(fs.readFileSync(path.join(run,'daemon-state.json')));
    assert.equal(state.pending.kind,'submission');
    assert.equal(state.resolved['executor-turn-1'].decision.disposition,'observe');
    assert.deepEqual(state.resolved['executor-turn-1'].decision.pendingApprovals,['Merge PR #26 into develop']);
    const sends=JSON.parse(fs.readFileSync(sentFile));
    assert.equal(sends.length,2);
    assert.equal(sends.some(message=>message.includes('LONG_TASK_DELIVERY:answer-executor-turn-1')),false);
  } finally {child.kill('SIGTERM');fs.rmSync(root,{recursive:true,force:true});}
  assert.equal(stderr,'');
});

test('Codex observe honors an existing STOP and does not restart watching',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'supervision-observe-stop-'));
  const source=path.join(root,'source.txt');fs.writeFileSync(source,'Criterion\n');
  const contract={goal:'Stop after recording a known block',authorization:'Isolated QA',criteria:[{id:'A1',requirement:'Remain stopped',source:'source.txt:1',verify:'Read state'}],sources:[{path:source,sha256:sha(source)}]};
  const run=path.join(root,'run');fs.mkdirSync(run);save(path.join(run,'contract.json'),contract);
  const supervisorId='supervisor-qa',executorId='executor-qa';
  save(path.join(run,'binding.json'),{platform:'codex',projectRoot:root,allowedRoots:[root,run],supervisorId,executorId,callerTurnId:'supervisor-turn',contractSha256:sha(path.join(run,'contract.json'))});
  save(path.join(run,'daemon-state.json'),{phase:'starting',cursor:null,seen:[],messages:[],pending:null,inflight:null,reads:0,starts:0});
  const fixture=path.join(root,'mock.json'),sentFile=path.join(root,'sent.json');
  save(fixture,{supervisorId,executorId,final:'Known approval remains pending.\nLONG_TASK_EVENT {"kind":"blocked"}'});
  const child=spawn(process.execPath,[path.join(scripts,'native-watch.cjs'),run],{env:{...process.env,CODEX_APP_TOOLS_SERVER_PATH:path.join(__dirname,'mock-codex-app-server.cjs'),MOCK_CODEX_FIXTURE:fixture,MOCK_CODEX_SENT:sentFile},stdio:['ignore','pipe','pipe']});
  try {
    await until(()=>JSON.parse(fs.readFileSync(path.join(run,'daemon-state.json'))).pending?.id==='executor-turn-1');
    fs.writeFileSync(path.join(run,'STOP'),'stop\n');
    save(path.join(run,'decision-executor-turn-1.json'),{eventId:'executor-turn-1',disposition:'observe',reason:'Record the known approval while honoring STOP.',pendingApprovals:['Merge PR #26 into develop']});
    await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Watcher did not stop')),6000);child.once('exit',()=>{clearTimeout(timer);resolve();});});
    const state=JSON.parse(fs.readFileSync(path.join(run,'daemon-state.json')));
    assert.equal(state.phase,'stopped');assert.equal(state.pending.id,'executor-turn-1');
    assert.equal(state.resolved?.['executor-turn-1'],undefined);
    assert.equal(fs.existsSync(path.join(run,'STOP')),true);
    const sends=fs.existsSync(sentFile)?JSON.parse(fs.readFileSync(sentFile)):[];
    assert.ok(sends.length<=1,'STOP may arrive before the review was sent; it must never cause a second send');
    assert.equal(sends.some(text=>text.includes('LONG_TASK_DELIVERY:answer-')),false);
  } finally {child.kill('SIGTERM');fs.rmSync(root,{recursive:true,force:true});}
});

test('App-owned parent recovers a late receipt from saved inflight without sending the message again',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'receipt-recovery-'));
  const source=path.join(root,'source.txt');fs.writeFileSync(source,'Keep the delivery unique');
  const run=path.join(root,'run');fs.mkdirSync(run);
  save(path.join(run,'contract.json'),{goal:'Recover a delayed delivery',authorization:'Isolated fixture',criteria:[{id:'A1',requirement:'Send once',source:'source.txt',verify:'Read receipts'}],sources:[{path:source,sha256:sha(source)}]});
  const supervisorId='supervisor-qa',executorId='executor-qa',fixture=path.join(root,'mock.json'),sent=path.join(root,'sent.json'),receiptGate=path.join(root,'receipt-ready');
  save(path.join(run,'binding.json'),{platform:'codex',projectRoot:root,allowedRoots:[root],supervisorId,executorId,callerTurnId:'qa-turn',contractSha256:sha(path.join(run,'contract.json'))});
  save(path.join(run,'daemon-state.json'),{phase:'starting',seen:[],messages:[],pending:null,inflight:null,reads:0});
  save(fixture,{supervisorId,executorId,final:'Waiting for a known approval.\nLONG_TASK_EVENT {"kind":"blocked"}',receiptGate});
  const child=spawn(process.execPath,[path.join(scripts,'run-watch.cjs'),run],{env:{...process.env,CODEX_APP_TOOLS_SERVER_PATH:path.join(__dirname,'mock-codex-app-server.cjs'),MOCK_CODEX_FIXTURE:fixture,MOCK_CODEX_SENT:sent,CODEX_HOME:path.join(root,'isolated-codex')},stdio:['ignore','pipe','pipe']});
  try{
    await until(()=>fs.existsSync(sent));
    await until(()=>JSON.parse(fs.readFileSync(path.join(run,'runtime-state.json'))).launches.length>=2,25000);
    assert.equal(JSON.parse(fs.readFileSync(sent)).length,1);
    assert.ok(JSON.parse(fs.readFileSync(path.join(run,'daemon-state.json'))).inflight);
    fs.writeFileSync(receiptGate,'late readback now visible');
    await until(()=>JSON.parse(fs.readFileSync(path.join(run,'daemon-state.json'))).inflight===null);
    assert.equal(JSON.parse(fs.readFileSync(sent)).length,1);
    const state=JSON.parse(fs.readFileSync(path.join(run,'daemon-state.json')));assert.equal(state.messages.length,1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(run,'receipt-review-executor-turn-1.json'))).confirmed,true);
    fs.writeFileSync(path.join(run,'STOP'),'user stop');
    await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Parent did not honor STOP')),6000);child.once('exit',()=>{clearTimeout(timer);resolve();});});
    assert.equal(JSON.parse(fs.readFileSync(path.join(run,'runtime-state.json'))).phase,'stopped');
  }finally{child.kill('SIGTERM');fs.rmSync(root,{recursive:true,force:true});}
});
