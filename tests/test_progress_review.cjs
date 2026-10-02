const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const scripts=path.resolve(__dirname,'../codex/.agents/skills/long-task-supervisor/scripts');
const {activityMarker,observeActivity,due,eventFor}=require(path.join(scripts,'progress-review.cjs'));
const {validateDecision,PROGRESS_REVIEW_MS}=require(path.join(scripts,'guard.cjs'));
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const save=(file,value)=>fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n');
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
async function until(check,ms=12000) {
  const end=Date.now()+ms;
  while(Date.now()<end) {if(check()) return;await new Promise(resolve=>setTimeout(resolve,50));}
  throw Error('Timed out waiting for progress review');
}
function fixture() {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'progress-review-'));
  const source=path.join(root,'source.txt');fs.writeFileSync(source,'Keep the work moving\n');
  const contract={goal:'Continue the task',authorization:'Isolated QA',criteria:[{id:'A1',requirement:'Continue',source:'source.txt:1',verify:'Read state'}],sources:[{path:source,sha256:sha(source)}]};
  const run=path.join(root,'run');fs.mkdirSync(run);save(path.join(run,'contract.json'),contract);
  const binding={platform:'codex',projectRoot:root,allowedRoots:[root,run],supervisorId:'supervisor-qa',executorId:'executor-qa',callerTurnId:'supervisor-turn',contractSha256:sha(path.join(run,'contract.json')),createdAt:new Date(Date.now()-PROGRESS_REVIEW_MS-60000).toISOString()};
  save(path.join(run,'binding.json'),binding);
  const state={phase:'starting',cursor:null,seen:[],messages:[],pending:null,inflight:null,reads:0,starts:0,lastExecutorActivityAt:Date.now()-PROGRESS_REVIEW_MS-60000};
  save(path.join(run,'daemon-state.json'),state);
  const mock=path.join(root,'mock.json'),sent=path.join(root,'sent.json'),activityGate=path.join(root,'activity');
  save(mock,{supervisorId:binding.supervisorId,executorId:binding.executorId,noTurn:true,activityGate});
  let child;
  function start() {
    child=spawn(process.execPath,[path.join(scripts,'native-watch.cjs'),run],{env:{...process.env,CODEX_APP_TOOLS_SERVER_PATH:path.join(__dirname,'mock-codex-app-server.cjs'),MOCK_CODEX_FIXTURE:mock,MOCK_CODEX_SENT:sent},stdio:['ignore','pipe','pipe']});
    return child;
  }
  async function stop() {if(child?.exitCode===null){child.kill('SIGTERM');await new Promise(resolve=>child.once('exit',resolve));}}
  return {root,run,sent,activityGate,contract,binding,start,stop};
}
const reply=eventId=>({eventId,disposition:'reply',progressCheck:{evidence:['executor thread latest turn and dispatch snapshot'],finding:'No activity for 15 minutes; background job state is unknown',guidance:'Check the background job and continue an independent ready item.'},reply:'Progress check: Check the background job and continue an independent ready item.'});

test('15-minute idle threshold uses executor activity and persists unique event IDs',()=>{
  const now=Date.now(),poll={cursor:'v1',latestTurn:{id:'t1',status:'inProgress'}};
  const state={lastExecutorActivityAt:now-14*60000,lastExecutorActivityMarker:activityMarker(poll)};
  assert.equal(due(state,now),false);
  assert.equal(due(state,now+60000),true);
  assert.equal(observeActivity(state,poll,{},now+60000),activityMarker(poll));
  assert.equal(due(state,now+60000),true);
  observeActivity(state,{...poll,cursor:'v2'},{},now+60000);
  assert.equal(due(state,now+60000),false);
  const first=eventFor(state,now),second=eventFor(state,now);
  assert.notEqual(first.id,second.id);
  state.lastProgressReviewAt=now;
  assert.equal(due(state,now+14*60000),false);
  assert.equal(due(state,now+16*60000),true);
});

test('progress review requires checked evidence and visible guidance',()=>{
  const event={id:'progress-review-1',kind:'progress_review'};
  const check=decision=>validateDecision({}, {}, event, decision);
  assert.throws(()=>check({eventId:event.id,disposition:'observe',reason:'waiting'}),/visible executor follow-up/);
  assert.throws(()=>check({eventId:event.id,disposition:'reply',reply:'Please continue'}),/checked evidence/);
  assert.throws(()=>check({...reply(event.id),reply:'Different text'}),/guidance in the visible/);
  assert.equal(check(reply(event.id)).disposition,'reply');
});

test('resident watcher sends a checked progress intervention, then rechecks after another idle interval',async()=>{
  const f=fixture();let stderr='';
  try {
    f.start().stderr.on('data',chunk=>stderr+=chunk);
    await until(()=>read(path.join(f.run,'daemon-state.json')).pending?.id==='progress-review-1');
    assert.match(read(f.sent)[0],/LONG_TASK_DELIVERY:review-progress-review-1/);
    save(path.join(f.run,'decision-progress-review-1.json'),reply('progress-review-1'));
    await until(()=>read(path.join(f.run,'daemon-state.json')).resolved?.['progress-review-1']?.decision);
    let state=read(path.join(f.run,'daemon-state.json'));
    assert.equal(state.messages.filter(item=>item.key==='answer-progress-review-1').length,1);
    assert.match(read(f.sent)[1],/LONG_TASK_DELIVERY:answer-progress-review-1/);
    assert.match(read(f.sent)[1],/Check the background job/);
    await f.stop();
    state=read(path.join(f.run,'daemon-state.json'));
    state.lastProgressReviewAt=Date.now()-PROGRESS_REVIEW_MS-60000;
    save(path.join(f.run,'daemon-state.json'),state);
    f.start().stderr.on('data',chunk=>stderr+=chunk);
    await until(()=>read(path.join(f.run,'daemon-state.json')).pending?.id==='progress-review-2');
    assert.equal(read(f.sent).filter(text=>text.includes('LONG_TASK_DELIVERY:review-progress-review-1')).length,1);
    assert.match(read(f.sent)[2],/LONG_TASK_DELIVERY:review-progress-review-2/);
  } finally {await f.stop();fs.rmSync(f.root,{recursive:true,force:true});}
  assert.equal(stderr,'');
});

test('new executor activity makes an outstanding progress instruction obsolete',async()=>{
  const f=fixture();let stderr='';
  try {
    f.start().stderr.on('data',chunk=>stderr+=chunk);
    await until(()=>read(path.join(f.run,'daemon-state.json')).pending?.id==='progress-review-1');
    fs.writeFileSync(f.activityGate,'new executor activity\n');
    save(path.join(f.run,'decision-progress-review-1.json'),reply('progress-review-1'));
    await until(()=>read(path.join(f.run,'daemon-state.json')).resolved?.['progress-review-1']?.obsolete);
    assert.equal(read(f.sent).some(text=>text.includes('LONG_TASK_DELIVERY:answer-progress-review-1')),false);
    assert.equal(read(path.join(f.run,'daemon-state.json')).pending,null);
  } finally {await f.stop();fs.rmSync(f.root,{recursive:true,force:true});}
  assert.equal(stderr,'');
});
