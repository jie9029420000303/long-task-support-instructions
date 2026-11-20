const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const scripts = path.resolve(__dirname, '../codex/.agents/skills/long-task-supervisor/scripts');
const review = require(path.join(scripts,'review-context.cjs'));
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const write = (file, obj) => fs.writeFileSync(file, JSON.stringify(obj));
const read = file => JSON.parse(fs.readFileSync(file));

function isolated(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'v111-workflow-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const run = path.join(root, 'run');
  const wp = path.join(root, 'wp');
  fs.mkdirSync(run);
  fs.mkdirSync(wp);
  const source = path.join(root, 'scope.txt');
  fs.writeFileSync(source, 'Run the browser in the office Windows test environment.');
  const contract = {goal:'Validate browser login', authorization:'Isolated local tests only',
    sources:[{path:source,sha256:sha(source)}], criteria:[
      {id:'E1',requirement:'Record the target host inventory',source:'scope.txt:1',verify:'Read the inventory'},
      {id:'E2',requirement:'Run login',source:'scope.txt:1',verify:'Read the target host receipt'}]};
  const contractFile = path.join(run, 'contract.json');
  write(contractFile, contract);
  const binding = {platform:'codex', projectRoot:root, allowedRoots:[root], executorId:'executor', supervisorId:'supervisor',
    contractSha256:sha(contractFile), callerTurnId:'test-turn', dispatchAudit:{enabled:true}};
  write(path.join(run, 'binding.json'), binding);
  const call = (script, ...args) => spawnSync(process.execPath,[path.join(scripts, script),...args],{
    encoding:'utf8', timeout:5000, env:{...process.env,CODEX_HOME:root,LONG_TASK_REGISTER:'0'}
  });
  const state = path.join(run, 'daemon-state.json');
  const snapshot = path.join(run, 'dispatch.json');
  const base = path.join(root, 'base.json');
  write(base, {capacity:{verified:2,evidence:['isolated fixture']}});
  const makeWP = (id, tags, status) => {
    const file = path.join(wp,id+'.md');
    fs.writeFileSync(file,['[工作包] id='+id+'；類型=C 研究','[驗收條目] E1 E2',...tags,'[狀態] '+JSON.stringify(status)].join('\n')+'\n');
    return file;
  };
  const snapshotFromWP = () => ok(call('dispatch.cjs','from-wp',run,root,'--base',base));
  const collect = (id, input) => {
    const file = path.join(root,'collect.json');
    write(file,input);
    return call('dispatch.cjs','collect',run,root,id,file);
  };
  const submit = (event, decision) => {
    review.persist(run,event);
    write(state, {phase:'awaiting_decision', pending:event, seen:[], messages:[], eventQueue:[]});
    const file = path.join(run,'draft-decision-'+event.id+'.json');
    write(file, {eventId:event.id,...decision});
    return call('supervise.cjs','decision',run,file);
  };
  return {root,run,source,snapshot,makeWP,snapshotFromWP,collect,submit,call};
}
function ok(result) { assert.equal(result.status,0,result.stderr||String(result.error)); }
function refused(result) { assert.notEqual(result.status,0,'unexpectedly accepted the original failure'); }

function compactExecutor(f) {
  const dir=path.join(f.root,'sessions','2026','11','20');
  fs.mkdirSync(dir,{recursive:true});
  const old=path.join(dir,'rollout-2026-11-20T12-00-00-executor.jsonl');
  const next=path.join(dir,'rollout-2026-11-20T12-30-00-executor_segment.jsonl');
  const meta=JSON.stringify({type:'session_meta',payload:{id:'executor'}})+'\n';
  fs.writeFileSync(old,meta);
  fs.writeFileSync(next,meta+JSON.stringify({type:'compacted',payload:{message:'Continue from persisted task records.'}})+'\n');
  const probe=`
    const [clock,old,offset]=process.argv.slice(1);
    const state={executorLog:old,executorOffset:Number(offset)},binding={executorId:'executor'};
    const reader=require(clock).readExecutor;
    const moved=reader(state,binding),current=reader(state,binding);
    process.stdout.write(JSON.stringify({moved,current,file:state.executorLog}));
  `;
  const result=spawnSync(process.execPath,['-e',probe,path.join(scripts,'supervisor-clock.cjs'),old,String(fs.statSync(old).size)],
    {encoding:'utf8',timeout:5000,env:{...process.env,CODEX_HOME:f.root}});
  ok(result);
  const record=JSON.parse(result.stdout);
  assert.equal(record.moved.reason,'segment_changed');
  assert.equal(record.current.readable,true);
  assert.equal(record.file,next);
}

// Exercise the actual send-and-confirm and observe paths with no connection to a live conversation.
async function consume(f,event) {
  const log=path.join(f.root,'mock-messages.jsonl');
  const watcher=spawn(process.execPath,[path.join(scripts,'native-watch.cjs'),f.run],{
    env:{...process.env,CODEX_HOME:f.root,LONG_TASK_REGISTER:'0',MOCK_LOG:log,
      CODEX_APP_TOOLS_SERVER_PATH:path.join(__dirname,'fixtures/mock-decision-app.cjs'),
      LONG_TASK_RECEIPT_RETRY_MS:'30',CODEX_WATCH_IDLE_SLEEP_MS:'10000'},stdio:['ignore','ignore','pipe']});
  const exited=new Promise(resolve=>watcher.once('exit',resolve));
  let error='';
  watcher.stderr.on('data',chunk=>{error+=chunk;});
  try {
    const deadline=Date.now()+7000;
    while(Date.now()<deadline) {
      const state=read(path.join(f.run,'daemon-state.json'));
      if(state.resolved?.[event.id]){
        return (fs.existsSync(log)?fs.readFileSync(log,'utf8'):'').split('\n').filter(Boolean).map(JSON.parse)
          .filter(row=>row.threadId==='executor' && row.prompt.includes('LONG_TASK_DELIVERY:answer-'+event.id));
      }
      if(watcher.exitCode!==null || watcher.signalCode!==null)break;
      await new Promise(resolve=>setTimeout(resolve,30));
    }
    assert.fail('Watcher did not consume the committed event: '+error);
  } finally {
    if(watcher.exitCode===null && watcher.signalCode===null)watcher.kill('SIGKILL');
    await exited;
  }
}

test('WebRPA environmental evidence must actually address every assigned question before integration', t => {
  const f=isolated(t);
  const questions=['Which tools are installed on Windows?','What is this run authorized to do?'];
  const file=f.makeWP('RESOURCES',['[待回答問題] '+JSON.stringify(questions)],{list:'inFlight',handle:'main'});
  f.snapshotFromWP();
  const result={status:{list:'completed',acceptanceIds:['E1'],evidence:[f.source]}};
  const original=fs.readFileSync(file,'utf8');
  refused(f.collect('RESOURCES',result));
  assert.equal(fs.readFileSync(file,'utf8'),original);
  assert.equal(read(f.snapshot).packages.inFlight.length,1);
  const answers=[
    {question:questions[0],finding:'The Windows inventory records Node and PostgreSQL.',evidence:[f.source]},
    {question:questions[1],finding:'The inventory does not attest to authorization for this run.',evidence:[f.source],gap:true}
  ];
  result.status.answers=[answers[0], answers[0]];
  refused(f.collect('RESOURCES',result));
  result.status.answers=answers.map((a,i)=>i?{...a,evidence:[path.join(f.root,'missing-report')]}:a);
  refused(f.collect('RESOURCES',result));
  compactExecutor(f);
  assert.deepEqual(read(f.snapshot).packages.inFlight[0].questions,questions);
  result.status.answers=answers;
  result.status.list='returned';
  result.status.resultEvidence=[f.source];
  result.status.integrated=false;
  ok(f.collect('RESOURCES',result));
  assert.ok(read(f.snapshot).packages.returned[0].answers[1].gap);
});

test('a package spanning the field worker and cloud service needs the actual target evidence for both before dispatch',t=>{
  const f=isolated(t);
  const file=f.makeWP('SPLIT',['[部署元件] '+JSON.stringify(['field-worker','cloud-api'])],{list:'ready'});
  const fromWP=()=>f.call('dispatch.cjs','from-wp',f.run,f.root,'--base',path.join(f.root,'base.json'));
  const inventory=path.join(f.root,'deployment-targets.json');
  const specification=path.join(f.root,'deployment-spec.md');
  fs.writeFileSync(specification,'The office Windows workers own browser control. The cloud service accepts work in the production Compose stack. Verify each on its own host.\n');
  const windows={component:'field-worker',runtime:'Office Windows host',identity:'First and second office workers with separate process IDs',
    dependencies:'Reach the private cloud field gateway',configuration:'No public listener; local browser control',
    verify:'Read both worker heartbeats and host version on Windows.',source:specification};
  const cloud={component:'cloud-api',runtime:'Cloud production Compose stack',identity:'Application container of the approved release',
    dependencies:'Cloud database and gateway',configuration:'Browser execution disabled in cloud',
    verify:'Read image identity and cloud service health.',source:specification};
  const original=fs.readFileSync(file,'utf8');
  refused(fromWP());
  write(inventory,{targets:[windows]});
  refused(fromWP());
  write(inventory,{targets:[windows,{...cloud,source:path.join(f.root,'nonexistent-cloud-receipt')}]});
  refused(fromWP());
  assert.equal(fs.readFileSync(file,'utf8'),original);
  assert.equal(fs.existsSync(f.snapshot),false);
  write(inventory,{targets:[windows,cloud]});
  ok(fromWP());
  assert.deepEqual(read(f.snapshot).packages.ready.map(w=>w.id),['SPLIT']);
  write(inventory,{targets:[cloud]});
  refused(f.call('dispatch.cjs','mark',f.run,f.root,'SPLIT',JSON.stringify({list:'inFlight',handle:'main'})));
  assert.deepEqual(read(f.snapshot).packages.ready.map(w=>w.id),['SPLIT'],'unverified field work cannot start on the strength of the cloud inventory alone');
});

test('a blocked package awaiting field inventory leaves the inventory research itself dispatchable',t=>{
  const f=isolated(t);
  f.makeWP('FIELD', ['[部署元件] ["field-worker"]'],
    {list:'blocked',kind:'dependency',reason:'The target inventory has not been established.',dependencies:['INVENTORY']});
  f.makeWP('INVENTORY',[],{list:'ready'});
  f.snapshotFromWP();
  const start=id=>f.call('dispatch.cjs','mark',f.run,f.root,id,JSON.stringify({list:'inFlight',handle:'main'}));
  ok(start('INVENTORY'));
  refused(start('FIELD'));
  assert.deepEqual(read(f.snapshot).packages.inFlight.map(w=>w.id),['INVENTORY']);
});

test('idle with no active owner cannot end in a bare observe, while a genuine external result can resume work',t=>{
  const f=isolated(t);
  f.makeWP('LOGIN',[],{list:'blocked',kind:'external',reason:'Windows-compatible launcher needed'});
  f.snapshotFromWP();
  const event={id:'progress-review-160',kind:'progress_review',reasons:['idle_with_work'],at:'2026-11-20T14:33:25.190Z',
    idleWithWork:{idleMinutes:6,openCriteria:['E1'],readyPackages:[]},pace:{packages:[]}};
  const observe={disposition:'observe',reason:'Still waiting for compatible software',
    progressCheck:{evidence:[f.source],finding:'Nothing is in flight'}};
  refused(f.submit(event,observe));
  refused(f.submit(event,{...observe,wait:{kind:'user_approval',conditions:[]}}));
  const userEvent={...event,id:'waiting-on-authorization'};
  const wait={kind:'user_approval',conditions:[],dependsOn:[{id:'E1',pendingKey:'windows-access',reason:'The specified account needs authorization.'}]};
  refused(f.submit(userEvent,{...observe,wait}));
  write(path.join(f.run,'pending-decisions.json'),{schema:1,items:[{key:'windows-access',status:'open',
    kind:'credential',ask:'May the task use the specified Windows test account?',recommend:'Approve temporary access.',
    why:'Only Jay can authorize this account.',options:[],history:[]}]});
  ok(f.submit(userEvent,{...observe,wait}));
  observe.wait={kind:'external_result',conditions:[{path:path.join(f.root,'vendor-result'),sha256:null}]};
  ok(f.submit(event,observe));
  const waiting=require(path.join(scripts,'checked-wait.cjs'));
  const state={};
  waiting.remember(state,{eventId:event.id,...observe},{});
  assert.equal(waiting.unchanged(state),true);
  fs.writeFileSync(observe.wait.conditions[0].path,'Compatible launcher is available');
  assert.equal(waiting.unchanged(state),false);
  assert.equal(state.waitReleased.review,true,'a changed external condition returns this item to supervisor review');
});

test('research during an ownerless stall must reach the executor with a checkable source and next action',async t=>{
  const f=isolated(t);
  f.makeWP('LOGIN',[],{list:'blocked',kind:'external',reason:'The only Windows launcher has an incompatible version'});
  f.snapshotFromWP();
  const event={id:'idle-login',kind:'progress_review',reasons:['idle_with_work'],
    idleWithWork:{idleMinutes:6,openCriteria:['E2'],readyPackages:[]},pace:{packages:[]}};
  const guidance='Schedule a Windows compatibility probe and return the effective launcher version.';
  const reply={disposition:'reply',reply:guidance,progressCheck:{evidence:[f.source],
    finding:'The target versions differ and no package owns the next action.',guidance}};
  refused(f.submit(event,reply));
  const report=path.join(f.root,'research-report.md');
  const research={source:report,assessment:'The isolated path preserves the target and the existing authorization.',nextAction:guidance};
  refused(f.submit(event,{...reply,unblockResearch:research}));
  fs.writeFileSync(report,'Public upstream documentation and the target inventory support an isolated compatibility probe.\n');
  ok(f.submit(event,{...reply,unblockResearch:research}));
  const commit=read(path.join(f.run,'committed-decision-'+event.id+'.json'));
  const record=read(path.join(f.run,commit.snapshotName));
  assert.deepEqual(record.decision.unblockResearch,research);
  assert.ok(record.decision.reply.includes(guidance));
  const messages=await consume(f,event);
  assert.equal(messages.length,1);
  assert.ok(messages[0].prompt.includes(guidance));
  assert.equal(read(path.join(f.run,'receipt-answer-'+event.id+'.json')).confirmed,true);
});

test('a covered second overdue tick stays quiet only while its delivered action still covers the current work',t=>{
  const f=isolated(t);
  const now=Date.now(), expiry=now+60000, startedAt=new Date(now-8*60000).toISOString();
  f.makeWP('WP-E1961',[],{list:'inFlight',handle:'agent:one',baseline:{startedAt,minutes:2.43,basis:'Measured fixture runtime'}});
  f.snapshotFromWP();
  const prior={id:'progress-review-216',kind:'progress_review',reasons:['overdue'],overdue:['WP-E1961'],
    pace:{packages:[{id:'WP-E1961',handle:'agent:one',startedAt,executorBaselineMinutes:2.43,ratio:2.6}]}};
  const snapshot=read(f.snapshot);
  const followup=require(path.join(scripts,'review-followup.cjs'));
  const covered=followup.coverage(snapshot,prior,prior.overdue,expiry);
  assert.equal(covered.length,1);
  const clockScript=`
    const fs=require('node:fs'), path=require('node:path');
    const [scripts,run,input]=process.argv.slice(1);
    const {now,state}=JSON.parse(fs.readFileSync(input));
    Date.now=()=>now;
    const binding=JSON.parse(fs.readFileSync(path.join(run,'binding.json')));
    const event=require(path.join(scripts,'supervisor-clock.cjs')).check(run,binding,state,true);
    process.stdout.write(JSON.stringify({event,state}));
  `;
  const tick=(time,state)=>{
    const input=path.join(f.root,'clock-input.json');
    write(input,{now:time,state});
    const result=spawnSync(process.execPath,['-e',clockScript,scripts,f.run,input],{encoding:'utf8',timeout:5000,env:{...process.env,CODEX_HOME:f.root}});
    ok(result);
    return JSON.parse(result.stdout);
  };
  const state={executorSettings:{model:'fixture'},lastExecutorWorkAt:now,lastHealthAt:now,lastAutomationCheckAt:now,coveredOverdue:covered};
  assert.deepEqual(tick(now,{...state,coveredOverdue:[]}).event.overdue,['WP-E1961'],'legacy or undelivered instructions grant no coverage');
  const quiet=tick(now,state);
  assert.ok(!quiet.event?.overdue?.length,'E217 adds only the already addressed timing tick');
  const failed={'fixture':{count:3,lastAt:new Date(now).toISOString()}};
  const concurrent=tick(now,{...state,failedCommands:failed});
  assert.ok(concurrent.event.reasons.includes('repeat'),'another simultaneous actionable signal survives');
  assert.ok(!concurrent.event.overdue.length);
  assert.deepEqual(tick(expiry+1,quiet.state).event?.overdue,['WP-E1961'],'when coverage expires the unannounced tier must become visible again');
  const revised=structuredClone(snapshot);
  revised.packages.inFlight[0].evidence.push(f.source);
  write(f.snapshot,revised);
  assert.deepEqual(tick(now+1,quiet.state).event?.overdue,['WP-E1961'],'new package evidence can require a new action during the instruction window');
});

test('routine observations reach the next package collection once without a new executor instruction',async t=>{
  const f=isolated(t);
  f.makeWP('PROBE',[],{list:'inFlight',handle:'main'});
  f.snapshotFromWP();
  const event={id:'paced-probe',kind:'progress_review',reasons:['overdue'],overdue:['PROBE']};
  const note='When returning the existing probe, include its effective executable path.';
  const decision={eventId:event.id,disposition:'observe',reason:'The probe is running.',collectionNote:note,
    progressCheck:{evidence:[f.source],finding:'Current work is making progress.'}};
  ok(f.submit(event,decision));
  assert.deepEqual(await consume(f,event),[],'a routine note must not initiate an executor turn');
  const input={status:{list:'returned',resultEvidence:[f.source],integrated:false}};
  const first=f.collect('PROBE',input);
  ok(first);
  assert.deepEqual(JSON.parse(first.stdout).collectionNotes,[{eventId:event.id,note}]);
  const repeat=f.collect('PROBE',input);
  ok(repeat);
  assert.deepEqual(JSON.parse(repeat.stdout).collectionNotes||[],[]);
});

test('work area E applies only the delivered ruling for this package and submission',t=>{
  const f=isolated(t);
  const manifest=path.join(f.root,'staged-manifest.json');
  write(manifest,{scope:'Partial evidence for fixed host version only'});
  const revision='sha256:'+sha(manifest);
  const file=f.makeWP('WP-E142',[],{list:'blocked',kind:'dependency',reason:'Waiting for stage ruling',submission:{revision,manifest}});
  f.makeWP('OTHER',[],{list:'blocked',kind:'external',reason:'Unrelated submission still waiting'});
  f.snapshotFromWP();
  const event={kind:'submission',id:'submission-e142',at:new Date().toISOString(),manifest,revision};
  const decision={eventId:event.id,disposition:'reply',packageRulings:[{id:'WP-E142',accepted:['E1'],remaining:['E2']}],
    reply:'Accept the staged source inventory. The candidate and original-document verification are still outstanding.'};
  ok(f.submit(event,decision));
  const commit=read(path.join(f.run,'committed-decision-'+event.id+'.json'));
  const signed=read(path.join(f.run,commit.snapshotName));
  const key='answer-'+event.id;
  const receipt={key,target:'executor',promptSha256:crypto.createHash('sha256').update(decision.reply).digest('hex'),sent:true,confirmed:true,at:new Date().toISOString()};
  const payload={status:{list:'inFlight',handle:'main',evidence:[manifest]},ruling:{eventId:event.id,revision}};
  const before=fs.readFileSync(file,'utf8');
  refused(f.collect('WP-E142',payload));
  assert.equal(fs.readFileSync(file,'utf8'),before);
  write(path.join(f.run,'daemon-state.json'),{phase:'watching',seen:[event.id],pending:null,
    messages:[{target:'executor',key}],resolved:{[event.id]:{event,decision,decisionSha256:signed.decisionSha256}}});
  const receiptFile=path.join(f.run,'receipt-'+key+'.json');
  write(receiptFile,{...receipt,confirmed:false});
  refused(f.collect('WP-E142',payload));
  write(receiptFile,{...receipt,target:'some-other-thread'});
  refused(f.collect('WP-E142',payload));
  write(receiptFile,receipt);
  compactExecutor(f);
  refused(f.collect('OTHER',payload));
  refused(f.collect('WP-E142',{...payload,ruling:{...payload.ruling,revision:'sha256:'+'0'.repeat(64)}}));
  refused(f.collect('WP-E142',{...payload,status:{list:'completed',acceptanceIds:['E1','E2'],evidence:[manifest]}}));
  assert.equal(fs.readFileSync(file,'utf8'),before);
  ok(f.collect('WP-E142',payload));
  assert.deepEqual(read(f.snapshot).packages.inFlight.map(w=>w.id),['WP-E142']);
  ok(f.collect('WP-E142',payload));
  assert.deepEqual(read(f.snapshot).packages.blocked.map(w=>w.id),['OTHER']);
  const sentBack={list:'returned',resultEvidence:[manifest],integrated:false};
  ok(f.call('dispatch.cjs','mark',f.run,f.root,'WP-E142',JSON.stringify(sentBack)));
  const later=fs.readFileSync(file,'utf8');
  f.collect('WP-E142',payload);
  assert.equal(fs.readFileSync(file,'utf8'),later,'a repeated old receipt cannot roll the package back after a new handoff');
  assert.deepEqual(read(f.snapshot).packages.returned.map(w=>w.id),['WP-E142']);
});
