const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const scripts=process.env.CODEX_SUPERVISOR_SCRIPTS||path.resolve(__dirname,'../codex/.agents/skills/long-task-supervisor/scripts');
const {activityMarker,supervisorPollFromThread,observeActivity,due,eventFor}=require(path.join(scripts,'progress-review.cjs'));
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
  const mock=path.join(root,'mock.json'),sent=path.join(root,'sent.json'),activityGate=path.join(root,'activity'),supervisorActivityGate=path.join(root,'supervisor-activity');
  save(mock,{supervisorId:binding.supervisorId,executorId:binding.executorId,noTurn:true,activityGate,supervisorActivityGate});
  let child;
  function start() {
    child=spawn(process.execPath,[path.join(scripts,'native-watch.cjs'),run],{env:{...process.env,CODEX_APP_TOOLS_SERVER_PATH:path.join(__dirname,'mock-codex-app-server.cjs'),MOCK_CODEX_FIXTURE:mock,MOCK_CODEX_SENT:sent},stdio:['ignore','pipe','pipe']});
    return child;
  }
  async function stop() {if(child?.exitCode===null){child.kill('SIGTERM');await new Promise(resolve=>child.once('exit',resolve));}}
  return {root,run,sent,activityGate,supervisorActivityGate,contract,binding,start,stop};
}
const reply=eventId=>({eventId,disposition:'reply',progressCheck:{evidence:['executor thread latest turn and dispatch snapshot'],finding:'No activity for 15 minutes; background job state is unknown',guidance:'Check the background job and continue an independent ready item.'},reply:'Progress check: Check the background job and continue an independent ready item.'});

test('15-minute idle threshold requires both chats to have no new messages',()=>{
  const now=Date.now(),poll={cursor:'v1',latestTurn:{id:'t1',status:'inProgress'},latestAssistantMessageId:'a1'};
  const supervisor={cursor:'s1',latestTurn:{id:'s1',status:'completed'},latestAssistantMessageId:'sa1'};
  const state={lastExecutorActivityAt:now-16*60000,lastExecutorActivityMarker:activityMarker(poll),
    lastSupervisorActivityAt:now-14*60000,lastSupervisorActivityMarker:activityMarker(supervisor)};
  assert.equal(due(state,now),false);
  assert.equal(due(state,now+60000),true);
  assert.equal(observeActivity(state,poll,{},now+60000),activityMarker(poll));
  assert.equal(due(state,now+60000),true);
  observeActivity(state,{...supervisor,cursor:'s2',latestToolMarkerId:'tool-2'},{},now+60000,'supervisor');
  assert.equal(due(state,now+60000),true);
  observeActivity(state,{...supervisor,latestAssistantMessageId:'sa2'},{},now+60000,'supervisor');
  assert.equal(due(state,now+60000),false);
  const first=eventFor(state,now),second=eventFor(state,now);
  assert.notEqual(first.id,second.id);
  assert.equal(first.supervisorActivityMarker,state.lastSupervisorActivityMarker);
  state.lastProgressReviewAt=now;
  assert.equal(due(state,now+14*60000),false);
  assert.equal(due(state,now+16*60000),true);
});

test('supervisor read ignores tool-only changes and tracks the last visible message',()=>{
  const turn={id:'t1',items:[{type:'userMessage',id:'u1'},{type:'commandExecution',id:'tool2'},{type:'agentMessage',id:'a3'}]};
  assert.equal(activityMarker(supervisorPollFromThread({turns:[turn]})),activityMarker({latestTurn:turn,latestAssistantMessageId:'a3'}));
});

test('supervisor message suppresses an idle prompt even while executor remains quiet',async()=>{
  const f=fixture();let stderr='';
  try {
    const state=read(path.join(f.run,'daemon-state.json'));
    state.lastSupervisorActivityAt=Date.now()-PROGRESS_REVIEW_MS-60000;
    state.lastSupervisorActivityMarker=activityMarker({latestAssistantMessageId:'supervisor-old-message',latestTurn:{id:'supervisor-old-turn'}});
    save(path.join(f.run,'daemon-state.json'),state);
    fs.writeFileSync(f.supervisorActivityGate,'new visible supervisor message\n');
    f.start().stderr.on('data',chunk=>stderr+=chunk);
    await until(()=>read(path.join(f.run,'daemon-state.json')).reads>=1);
    const observed=read(path.join(f.run,'daemon-state.json'));
    assert.equal(observed.pending,null);
    assert.equal(due(observed),false);
    assert.equal(fs.existsSync(f.sent),false);
  } finally {await f.stop();fs.rmSync(f.root,{recursive:true,force:true});}
  assert.equal(stderr,'');
});

test('progress review requires checked evidence and visible guidance',()=>{
  const event={id:'progress-review-1',kind:'progress_review'};
  const check=decision=>validateDecision({}, {}, event, decision);
  assert.throws(()=>check({eventId:event.id,disposition:'observe',reason:'waiting'}),/checked evidence/);
  assert.throws(()=>check({eventId:event.id,disposition:'reply',reply:'Please continue'}),/checked evidence/);
  assert.throws(()=>check({...reply(event.id),reply:'Different text'}),/guidance in the visible/);
  assert.equal(check(reply(event.id)).disposition,'reply');
});

test('resident watcher sends a checked progress intervention, then rechecks after another idle interval',async()=>{
  const f=fixture();let stderr='';
  try {
    f.start().stderr.on('data',chunk=>stderr+=chunk);
    await until(()=>read(path.join(f.run,'daemon-state.json')).pending?.id==='progress-review-1');
    await until(()=>fs.existsSync(f.sent));
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
    await until(()=>read(f.sent).length>=3);
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

test('checked approval wait survives idle time and restart, but a new human message releases it',async()=>{
  const f=fixture();let stderr='';
  try{
    f.start().stderr.on('data',chunk=>stderr+=chunk);
    await until(()=>read(path.join(f.run,'daemon-state.json')).pending?.kind==='progress_review');
    save(path.join(f.run,'decision-progress-review-1.json'),{eventId:'progress-review-1',disposition:'observe',reason:'Only an already requested approval remains; no independent work is ready.',
      progressCheck:{evidence:['executor final and authorization ledger'],finding:'The approval condition is unchanged.'},wait:{kind:'user_approval',conditions:[]}});
    await until(()=>read(path.join(f.run,'daemon-state.json')).checkedWait);
    await f.stop();
    const state=read(path.join(f.run,'daemon-state.json'));
    state.lastProgressReviewAt=state.lastExecutorActivityAt=state.lastSupervisorActivityAt=Date.now()-24*3600000;
    state.checkedWait.executorAt=state.lastExecutorActivityAt;
    save(path.join(f.run,'daemon-state.json'),state);
    f.start().stderr.on('data',chunk=>stderr+=chunk);
    await until(()=>read(path.join(f.run,'daemon-state.json')).reads>state.reads);
    assert.equal(read(f.sent).length,1);assert.equal(read(path.join(f.run,'daemon-state.json')).pending,null);
    fs.writeFileSync(f.supervisorActivityGate,'human approval');
    await until(()=>read(path.join(f.run,'daemon-state.json')).pending?.id==='progress-review-2',22000);
    assert.equal(read(path.join(f.run,'daemon-state.json')).checkedWait,undefined);
    assert.equal(read(f.sent).some(text=>text.includes('answer-progress-review-1')),false);
  }finally{await f.stop();fs.rmSync(f.root,{recursive:true,force:true});}
  assert.equal(stderr,'');
});

test('external result, existing deadline and executor messages release a checked wait immediately',()=>{
  const {remember}=require(path.join(scripts,'checked-wait.cjs'));
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'checked-wait-result-'));
  try{
    const result=path.join(root,'result.json'),state={lastExecutorActivityAt:Date.now(),lastSupervisorActivityAt:Date.now(),lastExecutorActivityMarker:'e',lastSupervisorInputMarker:'u'};
    const wait={kind:'external_result',conditions:[{path:result,sha256:null}]};
    validateDecision({allowedRoots:[root]}, {}, {id:'x',kind:'blocked'},{eventId:'x',disposition:'observe',reason:'Background result is not available.',wait});
    remember(state,{eventId:'x',wait},{});assert.equal(due(state),false);
    fs.writeFileSync(result,'done');assert.equal(due(state),true);
    remember(state,{eventId:'y',wait:{kind:'external_result',conditions:[],resumeAt:new Date(Date.now()+1000).toISOString()}},{});
    assert.equal(due(state,Date.now()+2000),true);
    remember(state,{eventId:'z',wait:{kind:'user_approval',conditions:[]}},{});
    state.lastExecutorActivityMarker='new';assert.equal(due(state),true);
    assert.throws(()=>validateDecision({allowedRoots:[root]}, {}, {id:'x',kind:'blocked'},{eventId:'x',disposition:'observe',reason:'Wait',wait:{kind:'external_result',conditions:[]}}),/observable result or deadline/);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('Codex approval arriving during a pending wait review is preserved through checkpoint and decision',()=>{
  const {remember,unchanged}=require(path.join(scripts,'checked-wait.cjs'));
  const state=JSON.parse(JSON.stringify({pendingSupervisorInputMarker:null,lastExecutorActivityMarker:'old',lastExecutorActivityAt:Date.now(),lastSupervisorInputMarker:'new-approval'}));
  remember(state,{eventId:'review',wait:{kind:'user_approval',conditions:[]}},{});
  assert.equal(unchanged(state),false);assert.equal(state.checkedWait,undefined);
});
