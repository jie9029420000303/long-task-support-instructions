const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {execFileSync,spawn}=require('node:child_process');
const scripts=path.resolve(__dirname,'../codex/.agents/skills/long-task-supervisor/scripts');
const audit=require(path.join(scripts,'dispatch-audit.cjs')),response=require(path.join(scripts,'supervisor-response.cjs'));
const contracts=require(path.join(scripts,'contract-state.cjs'));
const save=(f,d)=>fs.writeFileSync(f,JSON.stringify(d,null,2)+'\n');
const sha=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const empty=()=>({ready:[],inFlight:[],returned:[],blocked:[],completed:[],recurringRework:[]});
const snapshot=()=>({schemaVersion:1,executorId:'executor-qa',planningRevision:'original',activity:'working',capacity:{verified:19,evidence:['platform:20 including main']},packages:empty()});
async function until(check,ms=10000){const end=Date.now()+ms;while(Date.now()<end){if(check())return;await new Promise(r=>setTimeout(r,25));}throw Error('Timed out');}
async function stopChild(child){
  if(!child||child.exitCode!==null||child.signalCode!==null)return;
  let timer;const exited=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGTERM');
  try{await Promise.race([exited,new Promise((_,reject)=>{timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('watcher did not stop'));},3000);})]);}
  finally{clearTimeout(timer);}
}

test('a completed review is distinguished from commentary, an old turn, unknown timestamps and an active discussion',()=>{
  const delivered=Date.parse('2026-11-08T00:00:00Z');
  const detail=(status,completedAt,threadStatus='idle')=>({thread:{status:{type:threadStatus}},turns:[{id:'review-turn',status,completedAt}]});
  assert.equal(response.closedWithoutDecision(detail('inProgress',delivered+1000),delivered),null);
  assert.equal(response.closedWithoutDecision(detail('completed',delivered-1000),delivered),null);
  assert.equal(response.closedWithoutDecision(detail('completed',undefined),delivered),null);
  assert.equal(response.closedWithoutDecision(detail('completed',delivered+1000,'active'),delivered),null);
  assert.equal(response.closedWithoutDecision(detail('completed',(delivered+1000)/1000),delivered).turnId,'review-turn');
  assert.equal(response.closedWithoutDecision(detail('interrupted',new Date(delivered+1000).toISOString()),delivered).status,'interrupted');
});

test('temporary send throttling does not overwrite platform seats or silently lift a resource limit',()=>{
  const s=snapshot();s.capacity.throttle={limit:5,reason:'local sends refused',evidence:['measured-429'],reviewWhen:'recheck after the send window clears'};
  s.packages.inFlight=Array.from({length:5},(_,i)=>({id:'A'+i,handle:'/root/a'+i,exclusiveResources:[],evidence:['source']}));
  s.packages.ready=[{id:'NEXT',independent:true,safe:true,dependencies:[],exclusiveResources:[],evidence:['source']}];
  audit.parse(s,{executorId:s.executorId});
  assert.equal(audit.derive(s).some(x=>x.kind==='ready_capacity'),false);
  const view=audit.planReview(s,{contractSha256:'contract'});
  assert.equal(view.capacity.verified,19);assert.equal(view.capacity.dispatchLimit,5);assert.equal(view.capacity.free,0);
  s.packages.inFlight.pop();assert.equal(audit.derive(s).find(x=>x.kind==='ready_capacity').detail.freeCapacity,1);
  assert.equal(s.capacity.throttle.limit,5,'reconciliation does not auto-increase concurrency');
  delete s.capacity.throttle.reviewWhen;assert.throws(()=>audit.parse(s,{executorId:s.executorId}),/reviewWhen/);
});

test('returned work is collected while another package still runs, with no reminder during actual integration',()=>{
  const s=snapshot();s.packages.inFlight=[{id:'LONG',handle:'/root/long',exclusiveResources:[],evidence:['source']}];
  s.packages.returned=[{id:'SHORT',integrated:false,resultEvidence:['result']}];
  assert.deepEqual(audit.derive(s).find(x=>x.kind==='returned_unintegrated').affected,['SHORT']);
  s.activity='integrating';assert.equal(audit.derive(s).some(x=>x.kind==='returned_unintegrated'),false);
});

test('completed dependencies only invite review; a user approval or missing input remains blocked',()=>{
  const s=snapshot(),binding={contractSha256:'contract'};
  s.packages.completed=[{id:'BASE',acceptanceIds:[],evidence:['result']}];
  s.packages.blocked=['dependency','user_action','external:missing source'].map((kind,i)=>({id:'B'+i,kind,dependencies:['BASE'],exclusiveResources:[],evidence:['source']}));
  assert.deepEqual(audit.derive(s,binding).filter(x=>x.kind==='dependency_ready_review').map(x=>x.affected),[['B0']]);
  assert.equal(s.packages.blocked.length,3,'the program does not clear authorizations or fabricate ready work');
});

for(const platform of ['codex','claude-code'])test('three source-backed discussion updates survive timestamp changes and a reconstructed caller before collect unlocks the next package: '+platform,()=>{
  const platformScripts=path.resolve(__dirname,platform==='codex'?'../codex/.agents/skills/long-task-supervisor/scripts':'../claude-code/.claude/skills/long-task-supervisor/scripts');
  const platformAudit=require(path.join(platformScripts,'dispatch-audit.cjs'));
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dispatch-continuity-')),run=path.join(root,'run'),wp=path.join(root,'wp');fs.mkdirSync(run);fs.mkdirSync(wp);
  try{
    const source=path.join(root,'source.txt');fs.writeFileSync(source,'Continue authorized work; discussion does not approve deployment.\n');
    const contract={goal:'Finish A and B',authorization:'Isolated QA only',criteria:['A1','B1'].map(id=>({id,requirement:id,verify:'read evidence',source:'source.txt:1'})),sources:[{path:source,sha256:sha(source)}]};
    save(path.join(run,'contract.json'),contract);
    const binding={platform,supervisorId:(platform==='codex'?process.env.CODEX_THREAD_ID:process.env.CLAUDE_SESSION_ID)||'supervisor-qa',executorId:'executor-qa',projectRoot:root,allowedRoots:[root],contractSha256:sha(path.join(run,'contract.json')),createdAt:new Date().toISOString(),dispatchAudit:{enabled:true}};
    save(path.join(run,'binding.json'),binding);save(path.join(run,'daemon-state.json'),{phase:'watching',messages:[],pending:null,inflight:null});
    fs.writeFileSync(path.join(wp,'A.md'),'[工作包] id=A；依賴：無\n[狀態] {"list":"inFlight","handle":"/root/a"}\n[驗收條目] A1\n[共用資源] 無\n');
    fs.writeFileSync(path.join(wp,'B.md'),'[工作包] id=B；依賴：A\n[狀態] {"list":"blocked","kind":"dependency"}\n[驗收條目] B1\n[共用資源] 無\n');
    const base=path.join(root,'base.json');save(base,{capacity:snapshot().capacity,acceptance:{revision:'candidate',items:['A1','B1'].map(id=>({id,status:'PENDING',evidence:[source]}))}});
    const cli=(...args)=>JSON.parse(execFileSync(process.execPath,[path.join(platformScripts,'dispatch.cjs'),...args],{encoding:'utf8'}));
    cli('from-wp',run,root,'--base',base,'--reviewed','Initial scope and resource review');
    const auditState={};
    for(let i=1;i<=3;i++){
      contracts.append(run,binding,{id:'DISCUSSION-'+i,contractSha256:binding.contractSha256,authority:{role:'user',quote:'Continue authorized work',locator:'isolated user message '+i,at:new Date().toISOString(),source:{path:source,sha256:sha(source)}},changes:[{action:'authorization',id:'AUTH-'+i,scope:'isolated QA',instruction:'Continue A and B; no production permission'}]});
      cli('from-wp',run,root,'--revision','timestamp-only-'+i);
      let view=cli('reconcile',run);assert.equal(view.reviewRequired,true,'rewriting time/revision cannot acknowledge the new user decision');
      let found=platformAudit.inspect(run,binding,auditState);const event=platformAudit.eventFor(found);assert.ok(event.issues.some(x=>x.kind==='planning_review'));platformAudit.markAnnounced(auditState,event);
      assert.equal(platformAudit.inspect(run,binding,auditState).newIssues.length,0,'one event per unchanged decision version');
      cli('from-wp',run,root,'--reviewed','Checked both criteria, dependencies and unchanged authorization boundaries');
      assert.equal(cli('reconcile',run).reviewRequired,false);
      assert.equal(platformAudit.inspect(run,binding,auditState).issues.some(x=>x.kind==='planning_review'),false);
    }
    const result=path.join(root,'result.json');save(result,{status:{list:'completed',acceptanceIds:['A1'],evidence:[source]},acceptance:[{id:'A1',status:'PASS',evidence:[source]}]});
    const collected=cli('collect',run,root,'A',result);
    assert.deepEqual(collected.reconciliation.dependenciesReady,[{id:'B',dependencies:['A']}]);
    assert.equal(JSON.parse(fs.readFileSync(path.join(run,'dispatch.json'))).packages.blocked[0].id,'B');
    const next=cli('mark',run,root,'B','{"list":"ready"}','--reviewed','Verified A output and B isolated scope');
    assert.deepEqual(next.reconciliation.eligible,['B']);assert.equal(next.reconciliation.capacity.free,19);
    assert.equal(contracts.effective(run,binding).authorization,'Isolated QA only');
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('a watcher recovers a review that spoke but did not decide, deduplicates across restart and applies its eventual ruling',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'decision-continuity-')),run=path.join(root,'run');fs.mkdirSync(run);
  const source=path.join(root,'source.txt');fs.writeFileSync(source,'Do isolated work only');
  const contract={goal:'Isolated review',authorization:'QA only',criteria:[{id:'A1',requirement:'QA',source:'source:1',verify:'read'}],sources:[{path:source,sha256:sha(source)}]};
  save(path.join(run,'contract.json'),contract);
  const binding={platform:'codex',supervisorId:'supervisor-qa',executorId:'executor-qa',projectRoot:root,allowedRoots:[root],callerTurnId:'supervisor-turn',contractSha256:sha(path.join(run,'contract.json')),createdAt:new Date().toISOString()};
  save(path.join(run,'binding.json'),binding);save(path.join(run,'daemon-state.json'),{phase:'starting',cursor:null,seen:[],messages:[],pending:null,inflight:null,reads:0,starts:0});
  const fixture=path.join(root,'mock.json'),sent=path.join(root,'sent.json'),activity=path.join(root,'model-spoke'),completed=path.join(root,'turn-ended');
  save(fixture,{supervisorId:binding.supervisorId,executorId:binding.executorId,final:'Need review.\nLONG_TASK_EVENT {"kind":"question"}',supervisorActivityGate:activity,supervisorCompletedGate:completed});
  const env={...process.env,CODEX_HOME:path.join(root,'empty-home'),CODEX_APP_TOOLS_SERVER_PATH:path.join(__dirname,'mock-codex-app-server.cjs'),MOCK_CODEX_FIXTURE:fixture,MOCK_CODEX_SENT:sent,CODEX_SUPERVISOR_WAKE_MS:'30',CODEX_SUPERVISOR_DECISION_POLL_MS:'20'};
  let child,stderr='';const start=()=>{child=spawn(process.execPath,[path.join(scripts,'native-watch.cjs'),run],{env,stdio:['ignore','pipe','pipe']});child.stderr.on('data',b=>stderr+=b);};
  const state=()=>JSON.parse(fs.readFileSync(path.join(run,'daemon-state.json'))),calls=()=>fs.existsSync(sent)?JSON.parse(fs.readFileSync(sent)):[];
  const stop=()=>stopChild(child);
  try{
    start();await until(()=>state().pending?.kind==='question'&&state().messages.length===1);
    fs.writeFileSync(activity,'spoke');await until(()=>state().supervisorWake?.['executor-turn-1']?.modelStartedAt);
    assert.equal(calls().some(x=>x.includes('LONG_TASK_DELIVERY:decision-required-')),false,'a live discussion is not interrupted');
    fs.writeFileSync(completed,'closed');
    await until(()=>state().supervisorWake?.['executor-turn-1']?.completionWakeSentAt);
    assert.equal(calls().filter(x=>x.includes('LONG_TASK_DELIVERY:decision-required-')).length,1);
    await stop();start();await until(()=>state().pid===child.pid);
    await new Promise(r=>setTimeout(r,100));assert.equal(calls().filter(x=>x.includes('LONG_TASK_DELIVERY:decision-required-')).length,1);
    const decision=path.join(run,'draft-decision-executor-turn-1.json');save(decision,{eventId:'executor-turn-1',disposition:'observe',reason:'The known approval remains pending; other work is unaffected.'});
    execFileSync(process.execPath,[path.join(scripts,'supervise.cjs'),'decision',run,decision],{encoding:'utf8'});
    await until(()=>state().resolved?.['executor-turn-1']);assert.equal(state().pending,null);
    assert.equal(calls().filter(x=>x.includes('LONG_TASK_DELIVERY:answer-executor-turn-1')).length,0,'observe neither approves nor sends a spurious reply');
  }finally{await stop();fs.rmSync(root,{recursive:true,force:true});}
  assert.equal(stderr,'');
});

test('the existing keep-loaded timer still runs behind a pending review, and a user pause suppresses it',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pending-keep-loaded-')),run=path.join(root,'run');fs.mkdirSync(run);
  const source=path.join(root,'source');fs.writeFileSync(source,'QA only');
  save(path.join(run,'contract.json'),{goal:'QA',authorization:'QA only',criteria:[{id:'A1',requirement:'QA',verify:'read',source:'source:1'}],sources:[{path:source,sha256:sha(source)}]});
  const binding={platform:'codex',supervisorId:'supervisor-qa',executorId:'executor-qa',projectRoot:root,allowedRoots:[root],callerTurnId:'qa',contractSha256:sha(path.join(run,'contract.json')),createdAt:new Date().toISOString()};
  save(path.join(run,'binding.json'),binding);save(path.join(run,'daemon-state.json'),{phase:'starting',cursor:null,seen:[],messages:[],pending:null,inflight:null,reads:0,starts:0});
  const fixture=path.join(root,'mock.json'),sent=path.join(root,'sent.json');save(fixture,{supervisorId:binding.supervisorId,executorId:binding.executorId,final:'Review needed.\nLONG_TASK_EVENT {"kind":"question"}'});
  const child=spawn(process.execPath,[path.join(scripts,'native-watch.cjs'),run],{env:{...process.env,CODEX_HOME:path.join(root,'empty-home'),CODEX_APP_TOOLS_SERVER_PATH:path.join(__dirname,'mock-codex-app-server.cjs'),MOCK_CODEX_FIXTURE:fixture,MOCK_CODEX_SENT:sent,CODEX_KEEPALIVE_MS:'30',CODEX_SUPERVISOR_DECISION_POLL_MS:'10',CODEX_SUPERVISOR_WAKE_MS:'10000'},stdio:['ignore','pipe','pipe']});
  let stderr='';child.stderr.on('data',b=>stderr+=b);
  const state=()=>JSON.parse(fs.readFileSync(path.join(run,'daemon-state.json'))),count=()=>JSON.parse(fs.readFileSync(sent)).filter(x=>x.includes('LONG_TASK_DELIVERY:keepalive-')).length;
  try{
    await until(()=>state().pending?.kind==='question'&&state().messages.some(x=>x.key.startsWith('keepalive-')));
    fs.writeFileSync(path.join(run,'PAUSED.json'),'{}');await new Promise(r=>setTimeout(r,35));const before=count();
    await new Promise(r=>setTimeout(r,80));assert.equal(count(),before);assert.equal(state().pending.id,'executor-turn-1');
  }finally{await stopChild(child);fs.rmSync(root,{recursive:true,force:true});}
  assert.equal(stderr,'');
});
