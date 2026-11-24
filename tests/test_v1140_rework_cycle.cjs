// v1.14.0 (Jay 2026-11-23/24, handoff V7 items 1, 5, 6 and 7). Each test pins why the behaviour matters to the run:
// - a criterion failing twice waits for research, and research or a stated reason starts a new count; every second
//   cycle reaches Jay through Veda once, never at night (workspace E's I04 failed ten times in 21 hours unstudied);
// - only the execution mainline writes dispatch state, and every write names its writer (2026-11-21..22 eight
//   subagents took themselves for the mainline after compaction and four wrote dispatch state);
// - a model-switch notice says what actually happened and sleep is not counted as silence (2026-11-23 ten notices
//   said 額度限速 with no quota refusal; a switch judged silent after 1,389 seconds asleep);
// - delegated decisions are not pushed but are listed in full in the closing report, and a question about changing
//   acceptance names the criterion it is stuck on.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const ROOT=path.resolve(__dirname,'..');
const CODEX=path.join(ROOT,'codex/.agents/skills/long-task-supervisor/scripts');
const CLAUDE=path.join(ROOT,'claude-code/.claude/skills/long-task-supervisor/scripts');
delete process.env.CODEX_THREAD_ID;delete process.env.CODEX_SESSION_ID;delete process.env.CLAUDE_SESSION_ID;
const save=(file,value)=>fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n');
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function withEnv(values,fn){
  const old=Object.fromEntries(Object.keys(values).map(key=>[key,process.env[key]]));
  for(const [key,value] of Object.entries(values))if(value===undefined)delete process.env[key];else process.env[key]=value;
  try{return fn();}finally{for(const [key,value] of Object.entries(old))if(value===undefined)delete process.env[key];else process.env[key]=value;}
}
function fixture(t,platform='codex'){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'v1140-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const p=name=>path.join(root,name);
  fs.writeFileSync(p('source'),'Isolated contract');fs.writeFileSync(p('executor-prompt.txt'),'Isolated executor');
  save(p('contract.json'),{goal:'fixture',authorization:'test only',sources:[{path:p('source'),sha256:sha(p('source'))}],
    criteria:[{id:'C1',requirement:'report totals match',source:'source:1',verify:'read report'},{id:'C2',requirement:'second',source:'source:1',verify:'read'}]});
  save(p('binding.json'),{platform,supervisorId:'supervisor-chat',executorId:'executor-chat',projectRoot:root,allowedRoots:[root],
    contractSha256:sha(p('contract.json')),promptSha256:sha(p('executor-prompt.txt')),dispatchAudit:{enabled:true,snapshot:'dispatch.json'}});
  save(p('daemon-state.json'),{phase:'watching',pending:null,inflight:null});
  const journal=row=>fs.appendFileSync(p('acceptance-history.jsonl'),JSON.stringify(row)+'\n');
  const fail=(packageId,criterionId='C1')=>journal({kind:'verdict',criterionId,outcome:'FAIL',source:'executor',packageId,reason:'totals off',at:new Date().toISOString()});
  return {root,p,fail,journal,binding:read(p('binding.json'))};
}
const clean=env=>Object.fromEntries(Object.entries(env).filter(([,v])=>v!==undefined));
const run=(scripts,script,args,env={})=>spawnSync(process.execPath,[path.join(scripts,script),...args],{encoding:'utf8',timeout:15000,
  env:clean({...process.env,CODEX_THREAD_ID:undefined,CODEX_SESSION_ID:undefined,...env})});

test('both adapters ship the same rework module',()=>{
  // The count, the hold and the cycle alert must be one rule on both platforms.
  assert.deepEqual(fs.readFileSync(path.join(CODEX,'rework.cjs')),fs.readFileSync(path.join(CLAUDE,'rework.cjs')));
});

for(const [platform,scripts] of [['codex',CODEX],['claude',CLAUDE]]){
  const rework=require(path.join(scripts,'rework.cjs'));
  // A small fix (a typo, a setting) needs no research, but the mainline still says why and what caused each failure;
  // without that record the count could be reset by hand and the hold would mean nothing.
  test(platform+': waive resets a held criterion only with a reason and one direct cause per failure',t=>{
    const f=fixture(t,platform);
    const input=value=>{save(f.p('waive.json'),value);return run(scripts,'rework.cjs',['waive',f.root,f.p('waive.json')]);};
    f.fail('P1');
    let r=input({criterionId:'C1',directCauses:['typo'],reason:'typo fix'});
    assert.equal(r.status,1);assert.match(r.stderr,/累計 2 次/,'one failure is not held, so there is nothing to waive');
    f.fail('P1-retry');
    assert.deepEqual(rework.held(rework.rows(f.root),['C1','C2']),['C1']);
    r=input({criterionId:'C1',directCauses:['typo','typo'],reason:' '});assert.equal(r.status,1);assert.match(r.stderr,/reason/);
    r=input({criterionId:'C1',directCauses:['typo'],reason:'typo fix'});assert.equal(r.status,1);assert.match(r.stderr,/directCauses/);
    r=input({criterionId:'C1',directCauses:['wrong column','same typo'],reason:'a setting value, rerun proves it'});
    assert.equal(r.status,0,r.stderr);
    assert.deepEqual(JSON.parse(r.stdout),{registered:'C1',mode:'waived',cycle:1,alert:false});
    assert.deepEqual(rework.held(rework.rows(f.root),['C1']),[],'the count starts again');
    const status=rework.status(f.root).find(s=>s.criterionId==='C1');
    assert.deepEqual([status.failures,status.cycles,status.totalFailures],[0,1,2],'history keeps every failure');
  });

  // Jay 2026-11-23「循環兩次後，請Veda通知我」: the second cycle raises one open item, and running the check again does
  // not raise it twice; the first cycle raises nothing.
  test(platform+': the second cycle of one criterion raises one rework_cycle item with each cause, once',t=>{
    const f=fixture(t,platform);
    const cycle=n=>{f.fail('P'+n+'a');f.fail('P'+n+'b');
      f.journal({kind:'reset',criterionId:'C1',mode:'research',cycle:n,directCauses:['cause '+n+'a','cause '+n+'b'],commonCause:'upstream '+n,solution:'fix '+n,at:new Date().toISOString()});};
    cycle(1);
    assert.deepEqual(rework.alerts(f.root,f.binding),[]);
    assert.deepEqual(withEnv({CODEX_THREAD_ID:'supervisor-chat',CODEX_SESSION_ID:'supervisor-chat',CLAUDE_SESSION_ID:'supervisor-chat'},()=>rework.raiseAlerts(f.root,f.binding,{title:'會計'})),[]);
    cycle(2);
    const [alert]=rework.alerts(f.root,f.binding);
    assert.equal(alert.cycle,2);assert.equal(alert.total,4);assert.equal(alert.requirement,'report totals match');
    assert.deepEqual(alert.causes,['cause 1a','cause 1b','cause 2a','cause 2b']);
    const raise=()=>withEnv({CODEX_THREAD_ID:'supervisor-chat',CODEX_SESSION_ID:'supervisor-chat',CLAUDE_SESSION_ID:'supervisor-chat'},()=>rework.raiseAlerts(f.root,f.binding,{title:'會計'}));
    assert.deepEqual(raise(),[alert.key]);
    assert.deepEqual(raise(),[],'the same cycle is raised once');
    const items=read(f.p('pending-decisions.json')).items.filter(i=>i.kind==='rework_cycle');
    assert.equal(items.length,1);assert.equal(items[0].status,'open');
    for(const part of ['C1','已循環 2 次','累計不合格 4 次','upstream 1','fix 2','任務：會計'])assert.ok(items[0].ask.includes(part),part);
  });

  // Like an important mail (Jay 2026-11-24): sent once, held from 00:00 to 08:00 Taipei, and only while open.
  test(platform+': Veda gets each open cycle item once and never between midnight and 08:00 Taipei',()=>{
    const items=[{key:'k1',kind:'rework_cycle',status:'open'},{key:'k2',kind:'rework_cycle',status:'answered'},{key:'k3',kind:'acceptance',status:'open'},{key:'k4',kind:'rework_cycle',status:'open'}];
    const taipei=(h,m)=>Date.UTC(2026,10,24,h-8,m);
    const sent=new Set(['veda-k4']),due=at=>rework.vedaDue(items,{sent:key=>sent.has(key),now:at}).map(i=>i.key);
    assert.deepEqual(due(taipei(2,0)),[]);assert.deepEqual(due(taipei(7,59)),[]);
    assert.deepEqual(due(taipei(8,0)),['k1']);assert.deepEqual(due(taipei(23,30)),['k1']);
  });

  // The dispatch tool is the stop, not a prompt line: a subagent's shell carries its own thread ID beside the top
  // session ID, and every write records which conversation made it.
  test(platform+': only the mainline writes dispatch state, and each write records its writer',t=>{
    const f=fixture(t,platform);
    const snapshot={schemaVersion:1,executorId:'executor-chat',planningRevision:'plan-1',activity:'working',capacity:{verified:1,evidence:['fixture']},
      packages:{ready:[],inFlight:[{id:'P1',handle:'main',exclusiveResources:[],evidence:['wp'],acceptanceIds:['C1']}],returned:[],blocked:[],completed:[]},
      acceptance:{revision:'r1',items:[{id:'C1',status:'PENDING',evidence:['source:1']},{id:'C2',status:'PENDING',evidence:['source:1']}]}};
    save(f.p('input.json'),snapshot);
    const sub=run(scripts,'dispatch.cjs',['write',f.root,f.p('input.json')],{CODEX_THREAD_ID:'sub-1',CODEX_SESSION_ID:'top-1'});
    assert.equal(sub.status,1);assert.match(sub.stderr,/子代理不能改派工狀態/);
    assert.equal(fs.existsSync(f.p('dispatch.json')),false,'nothing was written');
    const main=run(scripts,'dispatch.cjs',['write',f.root,f.p('input.json')],{CODEX_THREAD_ID:'top-1',CODEX_SESSION_ID:'top-1'});
    assert.equal(main.status,0,main.stderr);
    const rows=fs.readFileSync(f.p('dispatch-history.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(rows.at(-1).writer,{thread:'top-1',session:'top-1'});
    // Reading stays open to everyone.
    assert.equal(run(scripts,'dispatch.cjs',['summary',f.root],{CODEX_THREAD_ID:'sub-1',CODEX_SESSION_ID:'top-1'}).status,0);
    // Research registration resets a count, so it is the mainline's too.
    f.fail('P1');f.fail('P1b');save(f.p('waive.json'),{criterionId:'C1',directCauses:['a','b'],reason:'setting'});
    const research=run(scripts,'rework.cjs',['waive',f.root,f.p('waive.json')],{CODEX_THREAD_ID:'sub-1',CODEX_SESSION_ID:'top-1'});
    assert.equal(research.status,1);assert.match(research.stderr,/子代理不能登記研究或歸零/);
  });

  // A question about changing acceptance has to say which criterion it is stuck on (Jay 2026-11-24, 代決原則), so the
  // supervisor can check whether the criterion already answers it.
  test(platform+': a question to change acceptance names a current criterion or the goal',t=>{
    const f=fixture(t,platform),pending=require(path.join(scripts,'pending-decisions.cjs'));
    const q=extra=>({key:'acc',kind:'acceptance',ask:'C1 要放寬嗎？',recommend:'A 照原條文',why:'改驗收要你同意',...extra});
    const apply=value=>withEnv({CODEX_THREAD_ID:'supervisor-chat',CODEX_SESSION_ID:'supervisor-chat',CLAUDE_SESSION_ID:'supervisor-chat'},()=>pending.apply(f.root,value,{binding:f.binding}));
    assert.throws(()=>apply({raise:[q({})]}),/criteria/);
    assert.throws(()=>apply({raise:[q({criteria:['Z9']})]}),/criteria/);
    apply({raise:[q({criteria:['C1','C1']})]});
    assert.deepEqual(read(f.p('pending-decisions.json')).items[0].criteria,['C1']);
    apply({raise:[q({key:'goal',ask:'目標要改成只做報表嗎？',criteria:['goal']})]});
    assert.deepEqual(read(f.p('pending-decisions.json')).items[1].criteria,['goal']);
  });

  // Delegations are not pushed (Jay 2026-11-24「只要留在他的專案裡面的結案報告」): the page shows the latest 20 while the
  // run works and every one once it is accepted, so nothing Jay did not see is lost.
  test(platform+': the closing report lists every delegated decision',()=>{
    const dashboard=require(path.join(scripts,'dashboard.cjs'));
    const delegated=Array.from({length:25},(_,i)=>({key:'d'+i,ask:'決定 '+i,choice:'選 '+i,basis:'依據',revert:'改回',at:new Date(Date.UTC(2026,10,24,0,i)).toISOString()}));
    // The Claude page names the ledger pendingDecisions; both get the same list.
    const page=phase=>dashboard.render({binding:{executorId:'e',supervisorId:'s'},state:{phase},snapshot:null,paced:{packages:[]},alive:true,paused:false,ledger:{open:[],delegated},pendingDecisions:{open:[],delegated}});
    const working=page('watching'),closing=page('accepted');
    assert.match(working,/## 監督已代決（25 項）/);assert.match(working,/最近 20 項/);
    assert.ok(working.includes('決定 19')&&!working.includes('決定 20 '),'20 rows while working');
    assert.match(closing,/## 結案報告：監督代決的全部事項（25 項）/);
    for(let i=0;i<25;i++)assert.ok(closing.includes('| 決定 '+i+' |'),'row '+i);
  });
}

test('codex: the switch notice names the real cause, and the silent window counts awake time only',()=>{
  const fallback=require(path.join(CODEX,'model-fallback.cjs')),clock=require(path.join(CODEX,'supervisor-clock.cjs'));
  const reason=hit=>fallback.switchReason(hit,'gpt-6.2-sol',15*60000);
  assert.match(reason({connectionReset:true,status:429}),/OpenCodex 連線中斷.*不是額度被拒/);
  assert.equal(reason({silent:true,failure:true}),'切換後 15 分鐘（不含電腦睡眠）沒有成功回應：');
  assert.match(reason({failure:true,error:'stream closed'}),/連續出錯（stream closed）/);
  assert.equal(reason({status:402,model:'openrouter/meta-muse-ember'}),'OpenRouter 餘額不足：');
  assert.equal(reason({status:429,model:'openrouter/meta-muse-ember'}),'開源順位短暫限速：');
  assert.equal(reason({status:429,model:'anthropic/claude-opus-5-5'}),'額度限速：');
  assert.equal(reason(null),'前面的順位 gpt-6.2-sol 已可再用：');
  assert.equal(fallback.restoreReason({basis:fallback.SILENT_BASIS}),'原模型的失敗暫停已結束。');
  assert.equal(fallback.restoreReason({basis:fallback.OPENROUTER_BASIS}),'原模型的短暫限速已結束。');
  assert.equal(fallback.restoreReason({basis:'weekly'}),'額度已恢復。');
  // 2026-11-23 12:18: 24 minutes on the wall, 1,389 seconds asleep, under a minute awake: not yet silent.
  const from=Date.UTC(2026,10,23,4,18),now=from+24*60000;
  const state={sleeps:[{from:new Date(from+20000).toISOString(),to:new Date(from+20000+1389000).toISOString()}]};
  const awake=clock.awakeSince(state,from,now);
  assert.equal(awake,24*60000-1389000);assert.ok(awake<15*60000);
  // The watcher builds its notice from these functions, not a copy of its own.
  const watch=fs.readFileSync(path.join(CODEX,'native-watch.cjs'),'utf8');
  assert.ok(watch.includes('fallback.switchReason(hit,target,SILENT_SWITCH_MS)')&&watch.includes('fallback.restoreReason(')&&!/function switchReason/.test(watch));
  assert.ok(watch.includes('rework.vedaDue(')&&watch.includes('clock.awakeSince(state,'));
});

