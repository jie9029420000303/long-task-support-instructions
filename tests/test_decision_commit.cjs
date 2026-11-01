const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {spawn,spawnSync}=require('node:child_process');
const assert=require('node:assert/strict');
const skill=path.resolve(__dirname,'../codex/.agents/skills/long-task-supervisor'), scripts=path.join(skill,'scripts');
const digest=b=>crypto.createHash('sha256').update(b).digest('hex');
const read=f=>JSON.parse(fs.readFileSync(f));
const children=new Set();process.on('exit',()=>{for(const p of children)try{p.kill('SIGKILL')}catch{}});
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const until=async(fn,description,ms=7000)=>{const end=Date.now()+ms;while(Date.now()<end){if(fn())return;await delay(40);}throw Error('Timed out: '+description);};
function setup(id){
 const run=fs.mkdtempSync(path.join(os.tmpdir(),'decision-test-'));fs.writeFileSync(path.join(run,'source.txt'),'test');
 const contract={goal:'test',authorization:'test',criteria:[{id:'A',requirement:'a',source:'a',verify:'a'}],sources:[{path:path.join(run,'source.txt'),sha256:digest(Buffer.from('test'))}]};
 const cb=JSON.stringify(contract);fs.writeFileSync(path.join(run,'contract.json'),cb);
 const binding={executorId:'exec',supervisorId:'super',callerTurnId:'turn',projectRoot:run,allowedRoots:[run],contractSha256:digest(cb),dispatchAudit:{enabled:false}};
 fs.writeFileSync(path.join(run,'binding.json'),JSON.stringify(binding));
 const event={id,kind:'question',text:'test event',at:'2026-11-01T00:00:00.000Z'};
 const state={phase:'awaiting_decision',cursor:null,seen:[],messages:[{target:'super',key:'review-'+id}],pending:event,inflight:null,reads:0,starts:0,eventQueue:[],supervisorWake:{[id]:{deliveredAt:Date.now(),assistantMarker:'started'}}};
 fs.writeFileSync(path.join(run,'daemon-state.json'),JSON.stringify(state));
 return {run,id,event,draft:path.join(run,'draft-decision-'+id+'.json'),commit:path.join(run,'committed-decision-'+id+'.json'),log:path.join(run,'mock.log')};
}
function start(t,extra={},dir=scripts){const env={...extra,...process.env,CODEX_HOME:t.run,CODEX_APP_TOOLS_SERVER_PATH:path.join(__dirname,'fixtures','mock-decision-app.cjs'),MOCK_LOG:t.log,CODEX_SUPERVISOR_DECISION_POLL_MS:'100',LONG_TASK_RECEIPT_RETRY_MS:'30',CODEX_WATCH_IDLE_SLEEP_MS:'10000'};let err='';const p=spawn(process.execPath,[path.join(dir,'native-watch.cjs'),t.run],{env});p.stderr.on('data',b=>err+=b);p.errorText=()=>err;children.add(p);p.once('exit',()=>children.delete(p));return p;}
function send(t){return spawnSync(process.execPath,[path.join(scripts,'supervise.cjs'),'decision',t.run,t.draft],{encoding:'utf8',env:{...process.env,CODEX_HOME:t.run}});}
function messages(t){return fs.existsSync(t.log)?fs.readFileSync(t.log,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter(x=>x.threadId==='exec'&&x.prompt.includes('LONG_TASK_DELIVERY:answer-')):[];}
async function stop(p){if(p.exitCode===null){p.kill('SIGKILL');await new Promise(r=>p.once('exit',r));}}
(async()=>{
 const t=setup('event1'); const p=start(t); await until(()=>fs.existsSync(path.join(t.run,'native-ready.json')),'ready');
 // Legacy draft and an abandoned/denied submission cannot trigger an answer.
 fs.writeFileSync(t.draft,JSON.stringify({eventId:t.id,disposition:'reply',reply:'approved content'}));
 await delay(500);assert.equal(messages(t).length,0);assert.equal(fs.existsSync(t.commit),false);
 // An incomplete draft fails explicit submission and remains unsent.
 fs.writeFileSync(t.draft,'{"eventId":');assert.notEqual(send(t).status,0);await delay(300);assert.equal(messages(t).length,0);
 fs.writeFileSync(t.draft,JSON.stringify({eventId:t.id,disposition:'reply',reply:'approved content'}));
 const submitted=send(t);assert.equal(submitted.status,0,submitted.stderr);const duplicate=send(t);if(duplicate.status!==0)assert.match(duplicate.stderr,/(Delivery already (in flight|recorded)|Pending event changed during submission|No matching pending or processed event)/);
 // Modifying the original draft after submission cannot change what is sent.
 fs.writeFileSync(t.draft,JSON.stringify({eventId:t.id,disposition:'reply',reply:'modified after submission'}));
 await until(()=>messages(t).length===1,'answer');assert.match(messages(t)[0].prompt,/approved content/);assert.doesNotMatch(messages(t)[0].prompt,/modified after submission/);
 await until(()=>read(path.join(t.run,'daemon-state.json')).resolved?.[t.id],'resolved');
 assert.notEqual(send(t).status,0,'altered processed decision rejected'); await stop(p);
 const restart=start(t);await delay(500);assert.equal(messages(t).length,1,'restart must not resend');await stop(restart);
 // A live legacy watcher must never see the new draft, and the new submit command refuses mixed versions.
 const old=setup('old1'), oldScripts=fs.mkdtempSync(path.join(os.tmpdir(),'legacy-supervisor-scripts-'));
 fs.cpSync(scripts,oldScripts,{recursive:true});fs.copyFileSync(path.join(__dirname,'fixtures','v034-native-watch.cjs'),path.join(oldScripts,'native-watch.cjs'));const op=start(old,{},oldScripts);
 await until(()=>fs.existsSync(path.join(old.run,'native-ready.json')),'legacy watcher ready');
 fs.writeFileSync(old.draft,JSON.stringify({eventId:old.id,disposition:'reply',reply:'new isolated draft'}));
 const oldContext=spawnSync(process.execPath,[path.join(scripts,'supervise.cjs'),'context',old.run,old.id],{encoding:'utf8'});
 assert.notEqual(oldContext.status,0,'new context rejects live old watcher');assert.notEqual(send(old).status,0,'submission rejects live old watcher');
 await delay(400);assert.equal(messages(old).length,0,'legacy watcher ignores new draft');await stop(op);
 // Legacy drafts left after stopping are inert for the new watcher; they cannot be submitted as new drafts.
 fs.writeFileSync(path.join(old.run,'decision-old1.json'),JSON.stringify({eventId:old.id,disposition:'reply',reply:'legacy not approved'}));
 fs.unlinkSync(old.draft);const np=start(old);await delay(400);assert.equal(messages(old).length,0,'new watcher ignores old draft');
 const legacyAttempt=spawnSync(process.execPath,[path.join(scripts,'supervise.cjs'),'decision',old.run,path.join(old.run,'decision-old1.json')],{encoding:'utf8'});
 assert.notEqual(legacyAttempt.status,0,'old draft is never promoted');
 const currentContext=spawnSync(process.execPath,[path.join(scripts,'supervise.cjs'),'context',old.run,old.id],{encoding:'utf8'});
 assert.equal(currentContext.status,0,currentContext.stderr);assert.equal(JSON.parse(currentContext.stdout).decisionPath,old.draft);
 fs.writeFileSync(old.draft,JSON.stringify({eventId:old.id,disposition:'reply',reply:'new reviewed draft'}));assert.equal(send(old).status,0);
 await until(()=>messages(old).length===1,'new watcher after migration');assert.match(messages(old)[0].prompt,/new reviewed draft/);await stop(np);
 // Malformed watcher identity fails closed even if there is no process to signal.
 for(const lockFile of ['watcher.lock','runtime-state.json']) {
  for(const pid of [undefined,null,0,-1,'123','not-a-pid']) {
   const invalid=setup('invalid_'+lockFile.replace('.','_')+'_'+String(pid).replaceAll('-','_'));
   fs.writeFileSync(invalid.draft,JSON.stringify({eventId:invalid.id,disposition:'reply',reply:'must not send'}));
   fs.writeFileSync(path.join(invalid.run,lockFile),JSON.stringify({pid,decisionProtocol:'explicit-decision-v1'}));
   const denied=send(invalid);assert.notEqual(denied.status,0);assert.match(denied.stderr,/Cannot verify watcher PID/);assert.equal(fs.existsSync(invalid.commit),false);
   const context=spawnSync(process.execPath,[path.join(scripts,'supervise.cjs'),'context',invalid.run,invalid.id],{encoding:'utf8'});assert.notEqual(context.status,0);assert.match(context.stderr,/Cannot verify watcher PID/);
  }
 }
 // EPERM while probing a PID is treated as alive; it is never inferred dead.
 {
  const perm=setup('eperm1');const guard=require(path.join(scripts,'decision-commit.cjs'));
  fs.writeFileSync(path.join(perm.run,'watcher.lock'),JSON.stringify({pid:123456}));
  const originalKill=process.kill;process.kill=()=>{const e=Error('permission denied');e.code='EPERM';throw e;};
  try {assert.throws(()=>guard.assertNoLegacyWatcher(perm.run),/Legacy watcher or parent is still running/);}
  finally {process.kill=originalKill;}
 }
 // Missing watcher records are unknown, not proof that it is safe to restart.
 {
  const missing=setup('missing_status');const status=spawnSync(process.execPath,[path.join(scripts,'supervise.cjs'),'status',missing.run],{encoding:'utf8'});assert.equal(status.status,0,status.stderr);
  const result=JSON.parse(status.stdout);assert.equal(result.active,null);assert.equal(result.watch.parentAlive,null);assert.equal(result.watch.restartCommand,null);
 }
 // If parent is dead but child status is unknown, do not suggest an automatic restart.
 {
  const uncertain=setup('unknown_child');fs.writeFileSync(path.join(uncertain.run,'runtime-state.json'),JSON.stringify({pid:99999999,phase:'running'}));
  const status=spawnSync(process.execPath,[path.join(scripts,'supervise.cjs'),'status',uncertain.run],{encoding:'utf8'});assert.equal(status.status,0,status.stderr);
  const result=JSON.parse(status.stdout);assert.equal(result.active,null);assert.equal(result.watch.parentAlive,false);assert.equal(result.watch.restartCommand,null);
 }
 // A genuinely new run has no ready record; after confirming no prior process/lock, initial startup creates it.
 {
  const fresh=setup('new_start');const st=read(path.join(fresh.run,'daemon-state.json'));st.phase='starting';st.pending=null;
  fs.writeFileSync(path.join(fresh.run,'daemon-state.json'),JSON.stringify(st));
  assert.equal(fs.existsSync(path.join(fresh.run,'runtime-state.json')),false);assert.equal(fs.existsSync(path.join(fresh.run,'watcher.lock')),false);
  const env={...process.env,CODEX_HOME:fresh.run,CODEX_APP_TOOLS_SERVER_PATH:path.join(__dirname,'fixtures','mock-decision-app.cjs'),MOCK_LOG:fresh.log,LONG_TASK_REGISTER:'0',CODEX_WATCH_IDLE_SLEEP_MS:'10000'};
  const parent=spawn(process.execPath,[path.join(scripts,'run-watch.cjs'),fresh.run],{env});children.add(parent);parent.once('exit',()=>children.delete(parent));
  await until(()=>fs.existsSync(path.join(fresh.run,'native-ready.json')),'first startup ready');
  await until(()=>{const s=spawnSync(process.execPath,[path.join(scripts,'supervise.cjs'),'status',fresh.run],{encoding:'utf8'});if(s.status)return false;const q=JSON.parse(s.stdout);return q.active===true&&q.watch.parentAlive===true&&q.readVerified===true;},'first startup status');
  parent.kill('SIGTERM');await until(()=>parent.exitCode!==null||parent.signalCode!==null,'first startup parent stops');
 }
 // Status and both restart guards treat EPERM as unknown, never as proof of stopped processes.
 {
  const unknown=setup('eperm_status');const st=read(path.join(unknown.run,'daemon-state.json'));st.pid=91001;
  fs.writeFileSync(path.join(unknown.run,'daemon-state.json'),JSON.stringify(st));
  fs.writeFileSync(path.join(unknown.run,'native-ready.json'),JSON.stringify({pid:91001,executorId:'exec',readVerified:true}));
  fs.writeFileSync(path.join(unknown.run,'runtime-state.json'),JSON.stringify({pid:91002,phase:'running',heartbeatAt:new Date().toISOString()}));
  fs.writeFileSync(path.join(unknown.run,'watcher.lock'),JSON.stringify({pid:91001}));
  const hook=path.join(__dirname,'fixtures','eperm-hook.cjs');const baseEnv={...process.env,CODEX_HOME:unknown.run,CODEX_APP_TOOLS_SERVER_PATH:path.join(__dirname,'fixtures','mock-decision-app.cjs'),MOCK_LOG:unknown.log};
  const status=spawnSync(process.execPath,['-r',hook,path.join(scripts,'supervise.cjs'),'status',unknown.run],{encoding:'utf8',env:baseEnv});assert.equal(status.status,0,status.stderr);
  const result=JSON.parse(status.stdout);assert.equal(result.active,null);assert.equal(result.watch.parentAlive,null);assert.equal(result.watch.restartCommand,null);assert.equal(result.readVerified,true);
  const parent=spawnSync(process.execPath,['-r',hook,path.join(scripts,'run-watch.cjs'),unknown.run],{encoding:'utf8',env:baseEnv,timeout:5000});
  assert.equal(parent.status,0,parent.stderr);assert.equal(JSON.parse(parent.stdout).processNotConfirmedStopped,91002);
  const before=fs.readFileSync(path.join(unknown.run,'daemon-state.json'));
  const child=spawnSync(process.execPath,['-r',hook,path.join(scripts,'native-watch.cjs'),unknown.run],{encoding:'utf8',env:baseEnv,timeout:5000});
  assert.notEqual(child.status,0);assert.match(child.stderr,/PID cannot be verified/);assert.deepEqual(fs.readFileSync(path.join(unknown.run,'daemon-state.json')),before);
  assert.equal(read(path.join(unknown.run,'watcher.lock')).pid,91001);
  const health=require(path.join(scripts,'watch-health.cjs'));const orig=process.kill;process.kill=()=>{const e=Error('EPERM');e.code='EPERM';throw e;};
  try {
   assert.equal(health.alive(91002),true);assert.equal(health.outageOf(unknown.run).processUnknown,true);
   const healthPath=path.join(unknown.run,'watch-health.json');fs.writeFileSync(healthPath,JSON.stringify({open:{key:'existing',since:new Date().toISOString(),kind:'read_failing'},history:[]}));
   await health.check(unknown.run);assert.ok(read(healthPath).open,'unknown process must not claim App recovery');
  }finally{process.kill=orig;}
 }
 // A stopped run cannot submit even with valid input.
 const stopped=setup('event2');fs.writeFileSync(stopped.draft,JSON.stringify({eventId:stopped.id,disposition:'reply',reply:'x'}));fs.writeFileSync(path.join(stopped.run,'STOP'),'stop');assert.notEqual(send(stopped).status,0);assert.equal(fs.existsSync(stopped.commit),false);
 // A stale or concurrent submission lock is fail-closed; it cannot publish a decision.
 const locked=setup('event6');fs.writeFileSync(locked.draft,JSON.stringify({eventId:locked.id,disposition:'reply',reply:'must wait'}));
 fs.writeFileSync(locked.commit+'.lock',JSON.stringify({pid:999999}));const refused=send(locked);assert.notEqual(refused.status,0);assert.equal(fs.existsSync(locked.commit),false);
 // The saved event must match the event that was submitted; corrupted committed content is rejected.
 const c=require(path.join(scripts,'decision-commit.cjs'));const binding=read(path.join(t.run,'binding.json')),contract=read(path.join(t.run,'contract.json'));
 assert.throws(()=>c.load(t.run,binding,contract,{...t.event,text:'changed'}),/event changed/);
 const saved=read(t.commit);saved.snapshotName='invalid';fs.writeFileSync(t.commit,JSON.stringify(saved));assert.throws(()=>c.load(t.run,binding,contract,t.event),/Invalid submission pointer/);
 // A rejected submitted pointer triggers a safe reminder: fix the new draft, preserve snapshot, then resubmit.
 const bad=setup('bad1');fs.writeFileSync(bad.draft,JSON.stringify({eventId:bad.id,disposition:'reply',reply:'reviewed after correction'}));assert.equal(send(bad).status,0);
 const bp=read(bad.commit), snap=path.join(bad.run,bp.snapshotName), originalSnapshot=fs.readFileSync(snap);
 fs.writeFileSync(bad.commit,JSON.stringify({...bp,snapshotName:'corrupt'}));
 const badWatch=start(bad,{CODEX_SUPERVISOR_WAKE_MS:'120'});
 await until(()=>fs.existsSync(bad.log)&&fs.readFileSync(bad.log,'utf8').includes('決策未套用'),'rejection reminder');
 const reminder=fs.readFileSync(bad.log,'utf8');assert.ok(reminder.includes('draft-decision-bad1.json'));assert.ok(reminder.includes('不要修改已提交快照或指標'));assert.equal(messages(bad).length,0);
 assert.equal(send(bad).status,0);await until(()=>messages(bad).length===1,'resubmitted rejected decision');assert.deepEqual(fs.readFileSync(snap),originalSnapshot);await stop(badWatch);
 // A duplicate submission must not claim success when its previously saved snapshot is missing or corrupted.
 for (const condition of ['missing','damaged']) {
  const broken=setup('snapshot_'+condition);fs.writeFileSync(broken.draft,JSON.stringify({eventId:broken.id,disposition:'reply',reply:'previously submitted'}));
  assert.equal(send(broken).status,0);const originalPointer=fs.readFileSync(broken.commit), pointer=read(broken.commit), snapshot=path.join(broken.run,pointer.snapshotName);
  if(condition==='missing')fs.unlinkSync(snapshot);else fs.writeFileSync(snapshot,'damaged evidence');
  const bpWatcher=start(broken,{CODEX_SUPERVISOR_WAKE_MS:'120'});
  await until(()=>read(path.join(broken.run,'daemon-state.json')).decisionErrors?.[broken.id],'broken snapshot rejected by watcher');
  const repeat=send(broken);assert.notEqual(repeat.status,0);assert.match(repeat.stderr,/snapshot missing or damaged.*manually reconcile/i);
  fs.writeFileSync(broken.draft,JSON.stringify({eventId:broken.id,disposition:'reply',reply:'different decision'}));const changed=send(broken);assert.notEqual(changed.status,0);assert.match(changed.stderr,/snapshot missing or damaged.*manually reconcile/i);
  assert.deepEqual(fs.readFileSync(broken.commit),originalPointer,'pointer is preserved');
  if(condition==='missing')assert.equal(fs.existsSync(snapshot),false,'missing snapshot is not silently recreated');
  else assert.equal(fs.readFileSync(snapshot,'utf8'),'damaged evidence','damaged snapshot is not overwritten');
  assert.equal(messages(broken).length,0,'damaged or missing snapshot cannot send');await stop(bpWatcher);
 }
 // A submitted answer whose delivery was interrupted is reconciled after restart, without a second send.
 const retry=setup('event4'), held=start(retry,{MOCK_HOLD_ANSWER:'1'});await until(()=>fs.existsSync(path.join(retry.run,'native-ready.json')),'retry ready');
 fs.writeFileSync(retry.draft,JSON.stringify({eventId:retry.id,disposition:'reply',reply:'once only'}));assert.equal(send(retry).status,0);
 await until(()=>messages(retry).length===1,'original send before restart');await stop(held);
 const resumed=start(retry);await until(()=>read(path.join(retry.run,'daemon-state.json')).resolved?.[retry.id],'receipt reconciliation after restart');
 assert.equal(messages(retry).length,1);await stop(resumed);
 // needs_user can be revised only after the watcher has acknowledged that intermediate disposition.
 const wait=setup('event5'), wp=start(wait);await until(()=>fs.existsSync(path.join(wait.run,'native-ready.json')),'wait ready');
 fs.writeFileSync(wait.draft,JSON.stringify({eventId:wait.id,disposition:'needs_user'}));assert.equal(send(wait).status,0);
 await until(()=>read(path.join(wait.run,'daemon-state.json')).phase==='needs_user'&&read(path.join(wait.run,'daemon-state.json')).waitingDecisionSha256,'needs user acknowledged');
 const firstSnapshot=path.join(wait.run,read(wait.commit).snapshotName), firstBytes=fs.readFileSync(firstSnapshot);
 fs.writeFileSync(wait.draft,JSON.stringify({eventId:wait.id,disposition:'reply',reply:'user resolved'}));assert.equal(send(wait).status,0);
 await until(()=>messages(wait).length===1,'revised needs user sent');assert.deepEqual(fs.readFileSync(firstSnapshot),firstBytes,'prior submitted snapshot remains unchanged');assert.notEqual(read(wait.commit).snapshotName,path.basename(firstSnapshot));await stop(wp);
 // Legacy in-flight answer with no submitted snapshot must stop without sending or resending.
 const legacy=setup('event3'),state=read(path.join(legacy.run,'daemon-state.json'));state.inflight={target:'exec',key:'answer-event3',prompt:'legacy payload',at:new Date().toISOString(),phase:'sending'};fs.writeFileSync(path.join(legacy.run,'daemon-state.json'),JSON.stringify(state));
 const lp=start(legacy);await until(()=>lp.exitCode!==null,'legacy reconciliation stop');assert.equal(messages(legacy).length,0);assert.match(lp.errorText(),/manual receipt reconciliation/);assert.equal(read(path.join(legacy.run,'daemon-state.json')).phase,'needs_reconcile');
 console.log('PASS: unsubmitted draft / simulated denied call, partial draft, submission, duplicate, post-submit edit, legacy watcher parallel and migration, rejected reminder and resubmission, missing/damaged snapshot duplicate rejection, restart deduplication and receipt recovery, needs_user revision, stopped run, submission lock and malformed watcher PID, unknown child prevents restart, first startup without ready, EPERM status and both restart guards and no false recovery, changed event/content, legacy inflight fail-closed');
})().catch(e=>{console.error(e);process.exitCode=1;});
