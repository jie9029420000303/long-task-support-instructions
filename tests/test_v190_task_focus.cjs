// v1.9.0 (Jay 2026-11-19: 「現在開工」), the supervisor half: three changes that keep a supervisor on its task.
// 1. The missed-start reminder looked only at messages. 2026-11-17 zone E: a supervisor that had run three commands in
//    the 45 seconds after a review arrived was told "no model output detected" (9 such reminders in the audit).
// 2. A checked wait ended the moment the executor moved, and that end was reviewed at once. Zone E reviews 112 and 114
//    and A WebRPA 16-18 woke the supervisor because the executor had started on the instruction it was just given; the
//    decision format then accepted only a made-up external wait (5 such reviews in the audit).
// 3. Jay 2026-11-18: 「技能裡面要監看資源這件事情完全拔掉，監督任務就是專注目標任務達成，系統的事情不要管」. v1.8.0's disk
//    reminder had every supervisor report the disk on its own; one made up a 3 GiB threshold, held a step back and
//    sent four clean-up forms.
// Each test fails if the earlier behaviour is put back.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawn,spawnSync,execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const codex=path.join(root,'codex/.agents/skills/long-task-supervisor'),claude=path.join(root,'claude-code/.claude/skills/long-task-supervisor');
const adapters=[['codex',codex],['claude',claude]];
const save=(file,value)=>fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n');
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
async function until(check,ms=12000){const end=Date.now()+ms;while(Date.now()<end){if(check())return;await new Promise(resolve=>setTimeout(resolve,50));}throw Error('Timed out');}

// ---- 1. the missed-start reminder ----
const response=require(path.join(codex,'scripts/supervisor-response.cjs'));
const replay=read(path.join(__dirname,'fixtures/v190-busy-supervisor.json'));
test('the 2026-11-17 replay: three finished commands and no new message is a supervisor at work',()=>{
  const armed=response.activityMarker(replay.before);
  assert.equal(response.working({thread:{status:{type:'idle'}},...replay.after},armed),'new_activity','the newest turn gained three commands; the last message is the same one');
  assert.equal(response.working({thread:{status:replay.status},...replay.after},armed),'thread_active','the App itself reported the chat active');
  const lastMessage=detail=>detail.turns[0].items.filter(item=>item.type==='agentMessage').at(-1).id;
  assert.equal(lastMessage(replay.before),lastMessage(replay.after),'this is why a message-only check called it silent');
});
test('a chat that did nothing after the delivery still gets the reminder',()=>{
  const idle={thread:{status:{type:'idle'}},turns:[{id:'t1',status:'completed',completedAt:1,items:[{type:'agentMessage',id:'m1'}]}]};
  const armed=response.activityMarker(idle);
  assert.equal(response.working(idle,armed),null);
  const delivered={...idle,turns:[{...idle.turns[0],items:[...idle.turns[0].items,{type:'userMessage',id:'u1',text:'LONG_TASK_DELIVERY:review-x'}]}]};
  assert.equal(response.working(delivered,armed),null,'the delivered review itself is not the model working');
  assert.equal(response.working({turns:[{id:'t2',status:'inProgress',items:[]}]},armed),'turn_in_progress');
  assert.equal(response.working(idle,undefined),null,'a record armed before this check existed has no marker: status alone decides');
  assert.equal(response.working({...idle,thread:{status:'active'}},undefined),'thread_active');
});
function wakeFixture(extra={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'v190-wake-')),source=path.join(dir,'source.txt');fs.writeFileSync(source,'criterion\n');
  const run=path.join(dir,'run');fs.mkdirSync(run);
  save(path.join(run,'contract.json'),{goal:'g',authorization:'isolated test',criteria:[{id:'A1',requirement:'r',source:'source.txt:1',verify:'inspect'}],sources:[{path:source,sha256:sha(source)}]});
  save(path.join(run,'binding.json'),{platform:'codex',supervisorId:'supervisor-qa',executorId:'executor-qa',projectRoot:dir,allowedRoots:[dir],callerTurnId:'supervisor-turn',contractSha256:sha(path.join(run,'contract.json')),createdAt:new Date().toISOString()});
  save(path.join(run,'daemon-state.json'),{phase:'starting',cursor:null,seen:[],messages:[],pending:null,inflight:null,reads:0,starts:0});
  const mock=path.join(dir,'mock.json'),sent=path.join(dir,'sent.json'),commands=path.join(dir,'commands-ran');
  save(mock,{supervisorId:'supervisor-qa',executorId:'executor-qa',final:'A real blocker needs review.\nLONG_TASK_EVENT {"kind":"blocked"}',supervisorCommandsGate:commands,...extra});
  const child=spawn(process.execPath,[path.join(codex,'scripts/native-watch.cjs'),run],{env:{...process.env,CODEX_HOME:path.join(dir,'empty-home'),CODEX_APP_TOOLS_SERVER_PATH:path.join(__dirname,'mock-codex-app-server.cjs'),
    MOCK_CODEX_FIXTURE:mock,MOCK_CODEX_SENT:sent,CODEX_SUPERVISOR_WAKE_MS:'400',CODEX_SUPERVISOR_DECISION_POLL_MS:'20'},stdio:['ignore','pipe','pipe']});
  let stderr='';child.stderr.on('data',chunk=>stderr+=chunk);
  const stop=async()=>{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await new Promise(resolve=>child.once('exit',resolve));}fs.rmSync(dir,{recursive:true,force:true});};
  return {run,commands,sent:()=>fs.existsSync(sent)?read(sent):[],state:()=>read(path.join(run,'daemon-state.json')),stderr:()=>stderr,stop};
}
test('the watcher sends no reminder to a supervisor that ran commands after the review arrived',async()=>{
  const f=wakeFixture();
  try{
    await until(()=>f.sent().length===1&&f.state().supervisorWake?.['executor-turn-1']?.deliveredAt);
    fs.writeFileSync(f.commands,'three commands finished\n');
    await until(()=>f.state().supervisorWake['executor-turn-1'].workingBecause==='new_activity');
    await new Promise(resolve=>setTimeout(resolve,500));
    assert.deepEqual(f.sent().filter(text=>text.includes('wake-review-')),[],'the same last message, three new commands: no "nothing detected" reminder');
    assert.equal(f.sent().length,1,'and the review itself is not sent again');
  }finally{await f.stop();}
  assert.doesNotMatch(f.stderr(),/Error:|Delivery uncertain|protocol_error/);
});

// ---- 2. a checked wait that ends because the executor went back to work ----
for(const [name,skill] of adapters)test(name+': a wait ended only by the executor moving is recorded, not reviewed; the other three ends are reviewed',()=>{
  const {remember,unchanged,logRelease}=require(path.join(skill,'scripts/checked-wait.cjs'));
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'v190-wait-'));
  try{
    const now=Date.now(),base=()=>({lastExecutorActivityAt:now-60000,lastExecutorActivityMarker:'e1',lastSupervisorInputMarker:'u1',lastProgressReviewAt:now-5000});
    const wait=extra=>({eventId:'review-1',wait:{kind:'user_approval',conditions:[],...extra}});
    let state=base();remember(state,wait(),{});
    assert.equal(unchanged(state,now),true,'nothing moved: the wait holds');
    state.lastExecutorActivityMarker='e2';state.lastExecutorActivityAt=now;
    assert.equal(unchanged(state,now),false);assert.equal(state.checkedWait,undefined,'the wait is over either way');
    assert.deepEqual([state.waitReleased.reasons,state.waitReleased.review,state.waitReleased.eventId],[['executor_activity'],false,'review-1']);
    assert.equal(state.lastProgressReviewAt,now-5000,'the quiet clock is not forced to fire');
    logRelease(dir,state);logRelease(dir,state);
    const lines=fs.readFileSync(path.join(dir,'wait-releases.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
    assert.equal(lines.length,1,'one line per ended wait');assert.deepEqual([lines[0].reasons,lines[0].review],[['executor_activity'],false]);
    state=base();remember(state,wait(),{});assert.equal(state.waitReleased,undefined,'a new wait starts clean');
    state.lastSupervisorInputMarker='u2';unchanged(state,now);
    assert.deepEqual([state.waitReleased.reasons,state.waitReleased.review,state.lastProgressReviewAt],[['user_input'],true,0],'Jay wrote in the supervisor chat');
    state=base();remember(state,wait({kind:'external_result',resumeAt:new Date(now+1000).toISOString()}),{});unchanged(state,now+2000);
    assert.deepEqual([state.waitReleased.reasons,state.waitReleased.review],[['resume_at'],true],'the deadline came');
    const result=path.join(dir,'result.json');
    state=base();remember(state,wait({kind:'external_result',conditions:[{path:result,sha256:null}]}),{});fs.writeFileSync(result,'done');
    state.lastExecutorActivityMarker='e2';unchanged(state,now);
    assert.deepEqual([state.waitReleased.reasons,state.waitReleased.review],[['executor_activity','condition_changed'],true],'the awaited result arrived while the executor also moved: reviewed');
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('codex: the quiet clock runs on from the activity that ended the wait',()=>{
  const {due,eventFor,working}=require(path.join(codex,'scripts/progress-review.cjs')),{remember}=require(path.join(codex,'scripts/checked-wait.cjs'));
  const {PROGRESS_REVIEW_MS}=require(path.join(codex,'scripts/guard.cjs'));
  const now=Date.now(),state={lastExecutorActivityAt:now-3600000,lastSupervisorActivityAt:now-3600000,lastExecutorActivityMarker:'e1',lastProgressReviewAt:now-3600000};
  remember(state,{eventId:'review-1',wait:{kind:'user_approval',conditions:[]}},{});
  assert.equal(due(state,now),false,'an hour of quiet under a checked wait is not reviewed');
  state.lastExecutorActivityMarker='e2';state.lastExecutorActivityAt=now;
  assert.equal(due(state,now),false,'the executor started working: no review');
  assert.equal(due(state,now+PROGRESS_REVIEW_MS-1000),false);
  assert.equal(due(state,now+PROGRESS_REVIEW_MS+1000),true,'fifteen minutes of nothing after that is silence again');
  assert.equal(working(state,now+60000),true);assert.equal(working(state,now+PROGRESS_REVIEW_MS+1000),false);
  assert.equal(eventFor({...state},now+60000,{reasons:['wait_changed']}).executorWorking,true);
  assert.equal('executorWorking' in eventFor({...state},now,{reasons:['silence']}),false);
});
for(const [name,skill] of adapters)test(name+': a changed wait reviewed while the executor works is observed without a made-up wait',()=>{
  const {validateDecision}=require(path.join(skill,'scripts/guard.cjs'));
  const observe=id=>({eventId:id,disposition:'observe',reason:'The executor is carrying out the instruction it was given.',progressCheck:{evidence:['executor rollout'],finding:'working on the instruction'}});
  const event=extra=>({id:'progress-review-9',kind:'progress_review',...extra});
  assert.equal(validateDecision({allowedRoots:[os.tmpdir()]},{},event({reasons:['wait_changed'],executorWorking:true}),observe('progress-review-9')).disposition,'observe');
  assert.throws(()=>validateDecision({allowedRoots:[os.tmpdir()]},{},event({reasons:['wait_changed'],executorWorking:false}),observe('progress-review-9')),/checked wait/,'nothing moves: say what is waited for');
  assert.throws(()=>validateDecision({allowedRoots:[os.tmpdir()]},{},event({reasons:['wait_changed']}),observe('progress-review-9')),/checked wait/,'an event written before this field existed keeps the earlier rule');
  assert.throws(()=>validateDecision({allowedRoots:[os.tmpdir()]},{},event({reasons:['silence'],executorWorking:true}),observe('progress-review-9')),/checked wait/,'silence keeps its rule');
});

// ---- 3. nothing watches the machine ----
function home(settings){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'v190-home-')),config=path.join(dir,'home');fs.mkdirSync(config);
  if(settings)save(path.join(config,'capacity.json'),settings);
  // What v1.8.0 would have left behind a minute ago: slow, due a restart and 0.1 GiB free.
  const at=new Date(),local=new Date(at.getTime()-at.getTimezoneOffset()*60000).toISOString().slice(0,10);
  fs.mkdirSync(path.join(config,'samples'));
  fs.writeFileSync(path.join(config,'samples','machine-'+local+'.jsonl'),JSON.stringify({at:at.toISOString(),slow:true,restartHint:true,commandMs:900,swapFiles:42,uptimeDays:9,diskFreeGiB:0.1,diskLow:true,diskCritical:true})+'\n');
  return {dir,config,close:()=>fs.rmSync(dir,{recursive:true,force:true})};
}
for(const [name,skill] of adapters)test(name+': machine.cjs keeps the limits Jay set and has nothing that samples, hints or notifies',()=>{
  const h=home({totalAgents:8,stagger:{batch:3,seconds:30}});
  try{
    const tool=require(path.join(skill,'scripts/machine.cjs'));
    assert.deepEqual(Object.keys(tool).sort(),['config','configFile','dispatchLimit','otherRuns','recordStart','rotate','staggerWait','status','temporary']);
    const status=spawnSync(process.execPath,[path.join(skill,'scripts/machine.cjs'),'status'],{encoding:'utf8',env:{...process.env,LONG_TASK_HOME:h.config}});
    assert.deepEqual(Object.keys(JSON.parse(status.stdout)).sort(),['agentsInFlight','config','configFile','runs']);assert.equal(JSON.parse(status.stdout).config.totalAgents,8);
    const sample=spawnSync(process.execPath,[path.join(skill,'scripts/machine.cjs'),'sample'],{encoding:'utf8',env:{...process.env,LONG_TASK_HOME:h.config}});
    assert.notEqual(sample.status,0,'there is no sample command');
    assert.equal(fs.readdirSync(path.join(h.config,'samples')).length,1,'and nothing was written');
  }finally{h.close();}
});
for(const [name,skill] of adapters)test(name+': the launchd guard checks the watchers and neither samples the machine nor sends a disk notice',()=>{
  const h=home({totalAgents:8});
  try{
    // A configured recipient, pointed at a closed local port: a notice, if one were still sent, could not leave the machine.
    save(path.join(h.config,'notify.json'),{telegram:{chatId:'c',keychainService:'none'}});
    const before=fs.readFileSync(path.join(h.config,'samples',fs.readdirSync(path.join(h.config,'samples'))[0]),'utf8');
    const out=execFileSync(process.execPath,[path.join(skill,'scripts/watch-guard.cjs'),'check'],{encoding:'utf8',env:{...process.env,LONG_TASK_HOME:h.config,LONG_TASK_DISK_FREE_BYTES:String(0.1*2**30),
      LONG_TASK_NOTIFY_CONFIG:path.join(h.config,'notify.json'),LONG_TASK_TELEGRAM_TOKEN:'t',LONG_TASK_TELEGRAM_API:'http://127.0.0.1:9',LONG_TASK_NOTIFY_RETRY_MS:'10'}});
    assert.deepEqual(Object.keys(JSON.parse(out)).sort(),['at','runs'],'the guard still checks every registered run');
    const names=fs.readdirSync(path.join(h.config,'samples'));
    assert.equal(names.length,1);assert.equal(fs.readFileSync(path.join(h.config,'samples',names[0]),'utf8'),before,'0.1 GiB free adds no sample line');
    const left=fs.readdirSync(h.config).filter(file=>!['capacity.json','notify.json','samples','runs'].includes(file));
    assert.deepEqual(left,[],'no notice record, sent or pending: '+left.join(','));
  }finally{h.close();}
});
for(const [name,skill] of adapters)test(name+': the supervisor brief carries no machine state even when an old sample says slow, restart and disk critical',()=>{
  const h=home({totalAgents:8});
  try{
    const run=path.join(h.dir,'run');fs.mkdirSync(run);const source=path.join(run,'source.txt');fs.writeFileSync(source,'criterion\n');
    save(path.join(run,'contract.json'),{goal:'g',authorization:'isolated test',criteria:[{id:'A1',requirement:'r',source:'source.txt:1',verify:'inspect'}],sources:[{path:source,sha256:sha(source)}]});
    const log=path.join(run,'brief-executor.jsonl');fs.writeFileSync(log,'');
    save(path.join(run,'binding.json'),{platform:name,executorId:'brief-executor',supervisorId:'supervisor',projectRoot:run,allowedRoots:[run],contractSha256:sha(path.join(run,'contract.json')),executorLog:log,supervisorLog:log});
    save(path.join(run,'daemon-state.json'),{phase:'watching',messages:[],pending:null});
    const out=spawnSync(process.execPath,[path.join(skill,'scripts/supervise.cjs'),'brief',run],{encoding:'utf8',env:{...process.env,LONG_TASK_HOME:h.config,CODEX_HOME:h.dir,CLAUDE_CONFIG_DIR:h.dir}});
    assert.equal(out.status,0,out.stderr);
    const brief=JSON.parse(out.stdout);
    assert.equal('machine' in brief,false);assert.doesNotMatch(out.stdout,/diskFreeGiB|restartHint|swapFiles|diskCritical/);
  }finally{h.close();}
});
test('a closed lid wakes no supervisor: neither clock has a machine_slept reason, and sleep still comes off the elapsed time',()=>{
  for(const file of [path.join(codex,'scripts/supervisor-clock.cjs'),path.join(codex,'scripts/native-watch.cjs'),path.join(claude,'scripts/claude-watch.cjs')])
    assert.doesNotMatch(fs.readFileSync(file,'utf8'),/machine_slept|machineSlept/,path.basename(file));
  for(const [,skill] of adapters){
    const pace=require(path.join(skill,'scripts/pace.cjs')),now=Date.now(),minutes=n=>new Date(now-n*60000).toISOString();
    const [item]=pace.inFlight({executorId:'none',executorLog:path.join(os.tmpdir(),'v190-no-such-log.jsonl')},{packages:{inFlight:[{id:'WP-NAP',handle:'main',evidence:['wp'],baseline:{minutes:12,startedAt:minutes(19),basis:'measured'}}]}},now,[{from:minutes(17),to:minutes(9)}]).packages;
    assert.deepEqual([item.sleptMinutes,Math.round(item.elapsedMinutes)],[8,11],'19 minutes minus 8 asleep');
  }
});
test('the rules say the supervisor stays on its task, and none of the removed prompts is left in them',()=>{
  const files=adapters.flatMap(([,skill])=>[path.join(skill,'SKILL.md'),...fs.readdirSync(path.join(skill,'references')).map(file=>path.join(skill,'references',file))]);
  const text=files.map(file=>fs.readFileSync(file,'utf8')).join('\n');
  for(const gone of ['machine_slept','brief.machine','criticalDiskGiB','lowDiskGiB','restartSwapFiles','slowCommandMs','接電源','CPU／記憶體'])assert.equal(text.includes(gone),false,gone);
  for(const [name,skill] of adapters){
    const runtime=fs.readFileSync(path.join(skill,'references/runtime.md'),'utf8');
    assert.match(runtime,/不監看整機資源/,name);assert.match(runtime,/不盤點整台電腦、不提清理方案、不自訂空間或負載門檻/,name);
    assert.match(runtime,/totalAgents/,name+': the fixed limits are still documented');
    assert.match(fs.readFileSync(path.join(skill,'SKILL.md'),'utf8'),/監督只專注目標任務達成，不監看或盤點整機資源/,name);
  }
});
