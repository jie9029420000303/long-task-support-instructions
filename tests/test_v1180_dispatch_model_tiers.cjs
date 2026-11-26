// v1.18.0 (Jay 2026-11-26, decisions 2, 26, 31 and 33-35). What each test pins:
// - an OpenAI subscription account with its own stop line (prolite 95%) is skipped by every role once its weekly use
//   reaches the line, without pausing it, so Jay keeps the rest for himself;
// - the mainline is told at once, by the watcher and without the supervisor, when it edits code, runs a test or sleeps
//   itself, and the supervisor is woken only when it does so again in the same turn (11/20 onward workspace E's Sonnet
//   mainline sent 7 subagents but edited 178 code files, ran 83 tests and slept 75 times itself); documents, status
//   files, work packages and evidence are not code;
// - the supervisor reasons at xhigh where a case is judged and at High for every other event, so the quota saved goes
//   to the mainline; an open-source supervisor stays at its pinned max;
// - a criterion that failed six times and was studied wakes the supervisor once to put the question to Jay.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const scripts=process.env.CODEX_SUPERVISOR_SCRIPTS||path.resolve(__dirname,'../codex/.agents/skills/long-task-supervisor/scripts');
const quota=require(path.join(scripts,'claude-quota.cjs'));
const clock=require(path.join(scripts,'supervisor-clock.cjs'));
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const save=(file,value)=>fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n');
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const peek=file=>{try{return read(file);}catch{return null;}};
const line=(file,value)=>fs.appendFileSync(file,JSON.stringify(value)+'\n');
const iso=ms=>new Date(ms).toISOString();
const DAY=86400000;
const opus='anthropic/claude-opus-5-5';
async function until(check,ms=15000){const end=Date.now()+ms;while(Date.now()<end){if(check())return;await new Promise(resolve=>setTimeout(resolve,50));}throw Error('Timed out');}
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));

test('an OpenAI subscription account at its own stop line is skipped by every role, and one under it still serves',()=>{
  const now=Date.now(),week=Math.floor((now+2*DAY)/1000);
  const reading=used=>({accounts:[
    {provider:'openai',id:'__main__',label:'prolite',plan:'prolite',upstreamAccountKey:'uai1_pro',paused:false,quota:{weeklyPercent:used,weeklyResetAt:week}},
    // The pool slot of the same account carries the line Jay set in OpenCodex.
    {provider:'openai',id:'chatgpt-pool',label:'prolite',plan:'prolite',upstreamAccountKey:'uai1_pro',paused:false,autoSwitchThresholdOverride:95,quota:{weeklyPercent:used,weeklyResetAt:week}}]});
  assert.equal(quota.evaluateOpenAI(reading(94),now).held,false,'94% used is under the 95% line');
  const at=quota.evaluateOpenAI(reading(95),now);
  assert.deepEqual([at.held,at.accounts.length,at.accounts[0].line],[true,1,95],'the main and pool slot are one account with one line');
  assert.equal(at.resetAt,week*1000,'it serves again after its weekly reset');
});

test('the mainline\'s own edits, tests and sleeps are found, and documents, status files, work packages and evidence are not code',()=>{
  const patch=file=>({type:'custom_tool_call',name:'apply_patch',input:'*** Begin Patch\n*** Update File: '+file+'\n@@\n-a\n+b\n*** End Patch'});
  const shell=cmd=>({type:'function_call',name:'exec_command',arguments:JSON.stringify({cmd})});
  assert.deepEqual(clock.selfWorkOf(patch('/repo/src/app.js')),[{kind:'edit',item:'/repo/src/app.js'}]);
  assert.deepEqual(clock.selfWorkOf(shell('cd /repo && npm test')).map(hit=>hit.kind),['test']);
  assert.deepEqual(clock.selfWorkOf(shell('sleep 120')).map(hit=>hit.kind),['sleep']);
  assert.deepEqual(clock.selfWorkOf(shell("sed -i '' 's/a/b/' src/config.json")).map(hit=>hit.kind),['edit']);
  // The mainline's own work: Git, deployment and the dispatch tools.
  for(const cmd of ['git merge --no-ff claude/x','git commit -m "x"','node scripts/dispatch.cjs mark RUN wp P1 {}','./deploy.sh production'])
    assert.deepEqual(clock.selfWorkOf(shell(cmd)),[],cmd);
  const run='/runs/e',wp='/repo/.codex/long-task/wp';
  const work={hits:['/repo/README.md','/runs/e/state.md',wp+'/P1.md','/repo/evidence/shot.png','/repo/src/app.js'].map(item=>({kind:'edit',item,at:iso(Date.now())}))};
  assert.deepEqual(clock.selfWorkHits(work,run,wp).map(hit=>hit.item),['/repo/src/app.js']);
  const prompt=clock.selfWorkPrompt([{kind:'edit',item:'/repo/src/app.js'},{kind:'test',item:'npm test'}]);
  assert.match(prompt,/^LONG_TASK_SELF_WORK：/);assert.match(prompt,/改程式或設定：\/repo\/src\/app\.js/);assert.match(prompt,/跑測試：npm test/);
  assert.match(prompt,/這一則不叫醒監督/);
});

function fixture({final=null,history=null}={}){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'codex-v1180-')));
  const home=path.join(root,'codex-home'),source=path.join(root,'source.txt');fs.writeFileSync(source,'Keep the work moving\n');
  const contract={goal:'Finish',authorization:'Isolated QA',criteria:[{id:'A1',requirement:'Keep work moving',source:'source.txt:1',verify:'Replay'}],sources:[{path:source,sha256:sha(source)}]};
  const run=path.join(root,'run');fs.mkdirSync(run);save(path.join(run,'contract.json'),contract);
  const binding={platform:'codex',projectRoot:root,allowedRoots:[root,run],supervisorId:'supervisor-qa',executorId:'executor-qa',callerTurnId:'supervisor-turn',
    contractSha256:sha(path.join(run,'contract.json')),createdAt:iso(Date.now()-60000),modelPolicy:'automatic'};
  save(path.join(run,'binding.json'),binding);
  save(path.join(run,'daemon-state.json'),{phase:'starting',cursor:null,seen:[],messages:[],pending:null,inflight:null,reads:0,starts:0,
    lastExecutorActivityAt:Date.now(),lastProgressReviewAt:Date.now()});
  if(history)fs.writeFileSync(path.join(run,'acceptance-history.jsonl'),history.map(row=>JSON.stringify(row)).join('\n')+'\n');
  const day=new Date(),dir=path.join(home,'sessions',String(day.getFullYear()),String(day.getMonth()+1).padStart(2,'0'),String(day.getDate()).padStart(2,'0'));
  fs.mkdirSync(dir,{recursive:true});
  const log=id=>path.join(dir,'rollout-t-'+id+'.jsonl');
  for(const id of ['executor-qa','supervisor-qa']){
    line(log(id),{timestamp:binding.createdAt,type:'session_meta',payload:{id}});
    line(log(id),{timestamp:binding.createdAt,type:'turn_context',payload:{turn_id:id+'-turn',model:opus,effort:'xhigh',approval_policy:'never'}});
  }
  const sent=path.join(root,'sent.json'),mockFile=path.join(root,'mock.json'),usage=path.join(root,'usage.jsonl');
  fs.writeFileSync(usage,JSON.stringify({conversationId:'unrelated',status:200})+'\n');
  save(mockFile,{supervisorId:binding.supervisorId,executorId:binding.executorId,...(final?{final}:{noTurn:true})});
  const env={...process.env,CODEX_HOME:home,CODEX_APP_TOOLS_SERVER_PATH:path.join(__dirname,'mock-codex-app-server.cjs'),MOCK_CODEX_FIXTURE:mockFile,MOCK_CODEX_SENT:sent,
    OPENCODEX_MODEL_CATALOG:path.join(__dirname,'fixtures/model-routing-catalog.json'),OPENCODEX_USAGE_FILE:usage,OPENCODEX_QUOTA_FILE:path.join(root,'quota-cache.json'),
    OPENCODEX_HOME:path.join(root,'opencodex'),CHROME_RELAY_BIN:path.join(root,'no-relay'),CODEX_WATCH_IDLE_SLEEP_MS:'200',CODEX_SUPERVISOR_DECISION_POLL_MS:'100',
    LONG_TASK_HOME:path.join(root,'long-task-home')};
  delete env.CODEX_THREAD_ID;delete env.CODEX_TURN_ID;
  let child;
  return {root,run,log,statePath:path.join(run,'daemon-state.json'),
    start(){child=spawn(process.execPath,[path.join(scripts,'native-watch.cjs'),run],{env,stdio:['ignore','pipe','pipe']});},
    calls(){const file=sent+'.args.json';return fs.existsSync(file)?read(file):[];},
    async stop(){if(child?.exitCode===null){child.kill('SIGTERM');await new Promise(resolve=>child.once('exit',resolve));}fs.rmSync(root,{recursive:true,force:true});}};
}

test('the first self-work of a turn gets one fixed note to the mainline only; doing it again in that turn is kept for the supervisor',async()=>{
  const f=fixture(),executorLog=f.log('executor-qa');
  const edit=file=>line(executorLog,{timestamp:iso(Date.now()),type:'response_item',payload:{type:'custom_tool_call',name:'apply_patch',call_id:crypto.randomUUID(),
    input:'*** Begin Patch\n*** Update File: '+file+'\n@@\n-a\n+b\n*** End Patch'}});
  try{
    f.start();
    await until(()=>peek(f.statePath)?.reads>0);
    line(executorLog,{timestamp:iso(Date.now()),type:'event_msg',payload:{type:'task_started',turn_id:'turn-1'}});
    edit(path.join(f.root,'notes.md'));
    await delay(1200);
    assert.ok(!f.calls().some(call=>/LONG_TASK_SELF_WORK/.test(call.prompt)),'a document is not code');
    edit(path.join(f.root,'src','app.js'));
    await until(()=>f.calls().some(call=>/LONG_TASK_SELF_WORK/.test(call.prompt)));
    const notes=f.calls().filter(call=>/LONG_TASK_SELF_WORK/.test(call.prompt));
    assert.deepEqual(notes.map(call=>call.threadId),['executor-qa'],'the note goes to the mainline, the supervisor is not woken');
    assert.match(notes[0].prompt,/src\/app\.js/);
    await delay(300);
    edit(path.join(f.root,'src','other.js'));
    await until(()=>peek(f.statePath)?.selfWorkEscalated);
    const escalated=read(f.statePath).selfWorkEscalated;
    assert.equal(escalated.turnId,'turn-1');assert.match(escalated.hits[0].item,/other\.js/);
    assert.equal(f.calls().filter(call=>/LONG_TASK_SELF_WORK/.test(call.prompt)).length,1,'no second note: the supervisor takes it from here');
  }finally{await f.stop();}
});

test('the supervisor judges a submission at xhigh and handles a question at High',async()=>{
  const keep=fs.mkdtempSync(path.join(os.tmpdir(),'v1180-candidate-')),file=path.join(keep,'candidate.txt'),manifest=path.join(keep,'manifest.json');
  fs.writeFileSync(file,'alpha\n');save(manifest,{files:[{path:file,sha256:sha(file)}]});
  const submission=fixture({final:'QA result submitted.\nLONG_TASK_EVENT '+JSON.stringify({kind:'submission',revision:'sha256:'+sha(manifest),manifest})});
  const question=fixture({final:'Which value should I write?\nLONG_TASK_EVENT {"kind":"question"}'});
  try{
    submission.start();question.start();
    const woken=f=>f.calls().find(call=>call.threadId==='supervisor-qa'&&call.model);
    await until(()=>woken(submission)&&woken(question));
    assert.deepEqual([woken(submission).model,woken(submission).thinking],[opus,'xhigh']);
    assert.deepEqual([woken(question).model,woken(question).thinking],[opus,'high']);
  }finally{await submission.stop();await question.stop();fs.rmSync(keep,{recursive:true,force:true});}
});

test('a criterion failed six times and studied wakes the supervisor once to put the question to Jay; the executor is not told',async()=>{
  const at=iso(Date.now()-60000),fail=n=>({kind:'verdict',criterionId:'A1',outcome:'FAIL',source:'executor',packageId:'P'+n,reason:'totals off '+n,at});
  const study=n=>({kind:'reset',criterionId:'A1',mode:'research',cycle:n,directCauses:['cause '+n],commonCause:'upstream '+n,solution:'fix '+n,at});
  const history=[fail(1),fail(2),study(1),fail(3),fail(4),study(2),fail(5),fail(6),study(3)];
  const f=fixture({history});
  try{
    f.start();
    await until(()=>f.calls().some(call=>/LONG_TASK_REWORK_DECISION/.test(call.prompt)));
    const asks=f.calls().filter(call=>/LONG_TASK_REWORK_DECISION/.test(call.prompt));
    assert.deepEqual(asks.map(call=>call.threadId),['supervisor-qa']);
    for(const part of ['A1','已 6 次不合格','kind rework_decision','四段寫齊','只走 Veda','rework.cjs resume','fix 3'])assert.ok(asks[0].prompt.includes(part),part);
    await delay(1500);
    assert.equal(f.calls().filter(call=>/LONG_TASK_REWORK_DECISION/.test(call.prompt)).length,1,'once per round');
  }finally{await f.stop();}
});

