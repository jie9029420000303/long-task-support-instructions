// v1.5.0 (Jay 2026-11-12/13), from the audit of A WebRPA's supervisor, executor and 347 subagents over 11/07-11/12:
// 16 formal versions in five days, 7 of them under 100 changed lines, with 38% of subagent tokens spent on releasing,
// deploying and re-collecting evidence ("還沒有定版舊作發版部署跟重測，太智障了"); 7.2 hours standing still behind
// questions for Jay ("等我回覆期間，跟這沒關係的工作應該要求執行主線繼續做，而不是整個停下來等我"); 11 out-of-scope choices
// sent to him although a recommendation existed ("有推薦就照推薦做，連30分鐘都不要等"); 23 hours of main-line work with
// no subagent running; 194 of 552 packages were documents; and 45 of 91 dispatch reviews of three kinds only recorded.
// These tests pin the rules on both platforms so neither drifts back.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const ROOT=path.resolve(__dirname,'..');
const read=rel=>fs.readFileSync(path.join(ROOT,rel),'utf8');
const CX='codex/.agents/skills/',CL='claude-code/.claude/skills/';
const PLATFORMS=[
  {name:'codex',supervisor:CX+'long-task-supervisor/',orchestrator:CX+'goal-orchestrator/',held:['ready_capacity','snapshot_mismatch','untracked_agent']},
  {name:'claude',supervisor:CL+'long-task-supervisor/',orchestrator:CL+'long-task-orchestrator/',held:['ready_capacity','wp_mismatch','agent_untracked']},
];
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const save=(file,value)=>fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n');
function withEnv(values,fn){
  const old=Object.fromEntries(Object.keys(values).map(key=>[key,process.env[key]]));Object.assign(process.env,values);
  try{return fn();}finally{for(const [key,value] of Object.entries(old))if(value===undefined)delete process.env[key];else process.env[key]=value;}
}

test('the shared spec keeps formal releases for the fixed version and lets unrelated work go on while Jay is asked',()=>{
  const spec=read('SPEC.md');
  for(const copy of [CX+'goal-orchestrator/references/spec.md',CL+'long-task-orchestrator/references/spec.md'])assert.equal(read(copy),spec,copy);
  for(const marker of ['31. 候選版與定版','不合併發版分支、不打正式版號、不發 Release','先收進缺陷清單','受監督時由監督判定並通知執行端，執行端不自行發版','定版後各做一次',
    '照條文在定版後做','預發行版本字串','帶版本內容的文件在定版前列為受阻','預估超過 5 分鐘的測試','通過才部署、送驗（正式發版留到定版，見不變量 31）',
    '沒有明確推薦的超出契約目標或範圍的變更','連30分鐘都不要等','先由程式複查 3 分鐘','只在監督已逐條寫明每個未通過條文依賴哪個待決事項、且沒有可派工作包時靜音'])
    assert.ok(spec.includes(marker),marker);
  // The old wording released every interim version and waited 30 minutes for an answer.
  assert.ok(!spec.includes('通過才發版、部署、送驗'));
  assert.ok(!spec.includes('30 分鐘無人答覆'));
});

test('each supervisor fixes the version itself, decides a recommended out-of-scope choice, and names the work that goes on',()=>{
  for(const p of PLATFORMS){
    const acceptance=read(p.supervisor+'references/acceptance.md');
    for(const marker of ['**候選版與定版**','太智障了','缺陷先收清單','定版由監督判定','定版後各做一次','照條文在定版後做','由監督以使用者原話登記修訂後才改用本節','預發行版本字串'])
      assert.ok(acceptance.includes(marker),p.name+': '+marker);
    assert.ok(acceptance.indexOf('**候選版與定版**')<acceptance.indexOf('**測試分工**'),p.name+': the version policy comes before the test split');
    const skill=read(p.supervisor+'SKILL.md');
    for(const marker of ['只出中途候選','定版由監督判定、定版後才正式發版與寫文件','沒有明確推薦的超出契約目標或範圍的變更','同一則回覆點名執行端接著做的','dependsOn'])
      assert.ok(skill.includes(marker),p.name+': '+marker);
    assert.ok(!skill.includes('只發一版並一起送驗'),p.name);
    const authorization=read(p.supervisor+'references/authorization.md');
    for(const marker of ['**超出契約目標或範圍的方向選擇有明確推薦**','**可撤回的執行細節不等答覆**','**超出契約目標或範圍的變更而沒有明確推薦**','不整條停下等回覆','要縮窄或改寫既有驗收條文的仍屬改驗收條件'])
      assert.ok(authorization.includes(marker),p.name+': '+marker);
    assert.ok(authorization.indexOf('**超出契約目標或範圍的方向選擇有明確推薦**')<authorization.indexOf('仍要停下來問使用者'),p.name+': a recommended choice is on the do-it list');
    assert.ok(!authorization.includes('**執行端提問 30 分鐘沒人答**'),p.name);
    // What still waits for Jay is unchanged.
    for(const kept of ['**改驗收條件**','**刪除或永久改動既有資料**','**開工時沒授權或超出授權上限的帳號密碼、付費、正式部署**','**會讓歷史回不去的 Git 操作**','**寄信與不是測試的正式對外發送**','**推翻使用者明示的禁令**','**使用者在契約自設的核准關卡**','**要使用者本人到場或操作，或只有他知道的事實**'])
      assert.ok(authorization.includes(kept),p.name+': still asked: '+kept);
    const review=read(p.supervisor+'references/event-review.md');
    for(const marker of ['用 `delegate`（kind `major_change`）登記後回覆、不等使用者','同一則回覆點名執行端接著做的','dependsOn:[{id:未通過條文 ID','由監督用 reply 通知執行端定版'])
      assert.ok(review.includes(marker),p.name+': '+marker);
    assert.ok(!review.includes('執行端提問 30 分鐘沒人答時'),p.name);
    const dispatch=read(p.supervisor+'references/dispatch.md');
    for(const marker of ['先由程式複查 3 分鐘','LONG_TASK_DISPATCH_HOLD_MS=0','跨版本可重用的準備工作','定版前列 blocked（kind `dependency`','--estimate <模型>','同時交回多包時一次收完'])
      assert.ok(dispatch.includes(marker),p.name+': '+marker);
    assert.ok(!dispatch.includes('文件排在最後、最終回歸，都列 ready'),p.name+': versioned documents wait for the fixed version');
    assert.ok(!dispatch.includes('發布說明等準備工作'),p.name);
    const runtime=read(p.supervisor+'references/runtime.md');
    for(const marker of ['dependsOn','沒寫或沒寫全就照發','沒有明確推薦的超出契約目標或範圍的變更'])assert.ok(runtime.includes(marker),p.name+': '+marker);
    const formats=read(p.supervisor+'references/formats.md');
    for(const marker of ['只出中途候選','主線只調度','不等監督答覆','--estimate','候選版與定版：','"dependsOn":[{"id"'])assert.ok(formats.includes(marker),p.name+': '+marker);
    assert.ok(!formats.includes('提問 30 分鐘沒人答'),p.name);
  }
});

test('each executor ships interim candidates by commit, keeps long tests off the main line and holds versioned documents',()=>{
  for(const p of PLATFORMS){
    const text=read(p.orchestrator+'SKILL.md')+read(p.orchestrator+'references/execution.md');
    for(const marker of ['這一版只是中途候選','不合併發版分支、不打版號、不發 Release','先收進缺陷清單','主線不自行發版','預估超過 5 分鐘的測試','輸出寫進檔案、主線只讀摘要',
      '定版前列 blocked（kind `dependency`','不等監督答覆','連30分鐘都不要等','已授權的發版動作也只在定版後做一次','--estimate','同時交回多包','照條文在定版後做'])
      assert.ok(text.includes(marker),p.name+': '+marker);
    for(const gone of ['通過才發版、部署、送驗','提問 30 分鐘沒人答','文件排在最後、最終回歸','發布說明等準備工作'])assert.ok(!text.includes(gone),p.name+': '+gone);
  }
});

test('behavioral cases 66 to 68 are shared word for word and both adapters say how to check them',()=>{
  for(const number of [66,67,68]){
    const common=read('tests/behavioral-cases.md').split('\n').find(line=>line.startsWith(number+'. '));
    assert.ok(common,'common case '+number);
    for(const p of PLATFORMS){
      const row=read(p.orchestrator+'references/behavioral-cases.md').split('\n').find(line=>line.startsWith('| '+number+' |'));
      assert.ok(row,p.name+' '+number);
      const cells=row.replace(/^\|\s*/,'').replace(/\s*\|$/,'').split(' | ');
      assert.equal(cells.length,3,p.name+' '+number);
      assert.equal(cells[1],common.slice(4),p.name+' '+number);
      assert.ok(cells[2].trim().length>40,p.name+' '+number+': a way to check it');
    }
  }
});

for(const p of PLATFORMS)test(p.name+': an approval wait silences the idle reviews only when every open criterion is tied to a pending item still open',()=>{
  const wait=require(path.join(ROOT,p.supervisor,'scripts/checked-wait.cjs'));
  const snapshot=(ready=[])=>({acceptance:{items:[{id:'A1',status:'PASS'},{id:'A2',status:'FAIL'},{id:'A3',status:'PENDING'},{id:'A4',status:'EXCLUDED'}]},packages:{ready}});
  const open=new Set(['c14-onsite']),approval={kind:'user_approval',conditions:[]};
  const depends=ids=>({...approval,dependsOn:ids.map(id=>({id,pendingKey:'c14-onsite',reason:'needs Jay at the office PC'}))});
  // A wait recorded without saying what depended on Jay kept the whole line quiet.
  assert.equal(wait.silencesIdle(approval,snapshot(),open),false,'no list of dependencies');
  assert.equal(wait.silencesIdle(depends(['A2']),snapshot(),open),false,'A3 is open and unexplained');
  assert.equal(wait.silencesIdle(depends(['A2','A3']),snapshot(),open),true,'every open criterion waits on Jay');
  assert.equal(wait.silencesIdle(depends(['A2','A3']),snapshot([{id:'READY'}]),open),false,'a ready package is work');
  assert.equal(wait.silencesIdle(depends(['A2','A3']),snapshot(),new Set()),false,'the pending item was answered');
  assert.equal(wait.silencesIdle({kind:'external_result',conditions:[]},snapshot(),open),false);
  assert.equal(wait.silencesIdle(undefined,snapshot(),open),false);
  assert.equal(wait.silencesIdle(approval,{packages:{ready:[]}},open),true,'a run without an acceptance table keeps the earlier behaviour');
  assert.equal(wait.silencesIdle(approval,{acceptance:{items:[{id:'A1',status:'PASS'}]},packages:{ready:[]}},open),true,'nothing open');
  const config={allowedRoots:[os.tmpdir()]};
  assert.doesNotThrow(()=>wait.validateWait(config,depends(['A2','A3'])));
  assert.throws(()=>wait.validateWait(config,{...approval,dependsOn:[{id:'A2',pendingKey:'c14-onsite'}]}),/dependsOn/);
  assert.throws(()=>wait.validateWait(config,{...approval,dependsOn:'A2'}),/dependsOn/);
  assert.throws(()=>wait.validateWait(config,{kind:'external_result',conditions:[],resumeAt:new Date(Date.now()+60000).toISOString(),dependsOn:[]}),/dependsOn/);
  const state={};wait.remember(state,{eventId:'e1',wait:depends(['A2','A3'])},{});
  assert.equal(state.checkedWait.dependsOn.length,2,'the recorded wait keeps its dependencies for the clock');
});

for(const p of PLATFORMS)test(p.name+': three dispatch leads are re-checked for 3 minutes before they wake the supervisor; others wake at once',()=>{
  const {hold}=require(path.join(ROOT,p.supervisor,'scripts/dispatch-audit.cjs'));
  const state={},t0=Date.parse('2026-11-13T02:00:00Z'),minute=60000;
  const lead=(kind,key)=>({kind,key,affected:[key],detail:{}});
  const leads=p.held.map((kind,at)=>lead(kind,'k'+at)),urgent=lead('returned_unintegrated','urgent');
  assert.deepEqual(hold(state,[...leads,urgent],3*minute,t0).map(item=>item.key),['urgent'],'held kinds wait, the rest pass');
  assert.deepEqual(hold(state,leads,3*minute,t0+2*minute),[],'still inside the hold');
  // k1 cleared by itself before the hold ended: it is dropped, and a later return starts a new hold.
  const remaining=[leads[0],leads[2]];
  assert.deepEqual(hold(state,remaining,3*minute,t0+3*minute).map(item=>item.key),['k0','k2'],'still present after 3 minutes');
  assert.deepEqual(hold(state,[leads[1]],3*minute,t0+4*minute),[],'a lead that came back is new');
  assert.deepEqual(hold(state,[leads[1]],3*minute,t0+7*minute).map(item=>item.key),['k1']);
  assert.deepEqual(hold({},leads,0,t0).map(item=>item.key),['k0','k1','k2'],'0 turns the hold off');
  const watcher=read(p.supervisor+'scripts/'+(p.name==='codex'?'native-watch.cjs':'claude-watch.cjs'));
  assert.ok(watcher.includes('audit.newIssues=holdDispatch(state,audit.newIssues);'),p.name+': the watcher applies the hold before forming the event');
});

function codexRun(){
  const X=path.join(ROOT,CX,'long-task-supervisor/scripts');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'v150-codex-')),home=path.join(root,'codex-home'),source=path.join(root,'source.txt');fs.writeFileSync(source,'Keep the work moving\n');
  const run=path.join(root,'run');fs.mkdirSync(run);fs.mkdirSync(home);
  save(path.join(run,'contract.json'),{goal:'Finish',authorization:'Isolated QA',criteria:[{id:'A1',requirement:'First',source:'source.txt:1',verify:'Replay'},{id:'A2',requirement:'Second',source:'source.txt:1',verify:'Replay'}],sources:[{path:source,sha256:sha(source)}]});
  const binding={platform:'codex',projectRoot:root,allowedRoots:[root,run],supervisorId:'supervisor-qa',executorId:'executor-qa',callerTurnId:'supervisor-turn',
    contractSha256:sha(path.join(run,'contract.json')),createdAt:new Date(Date.now()-180*60000).toISOString(),dispatchAudit:{enabled:true,snapshot:'dispatch.json'}};
  save(path.join(run,'binding.json'),binding);
  const freshClock=()=>{for(const key of Object.keys(require.cache))if(key.endsWith('supervisor-clock.cjs'))delete require.cache[key];return require(path.join(X,'supervisor-clock.cjs'));};
  return {X,root,home,run,binding,check:state=>withEnv({CODEX_HOME:home},()=>freshClock().check(run,binding,state))};
}

test('Codex clock: while Jay is asked, an open criterion nobody tied to his answer still raises the idle and hourly reviews',()=>{
  const f=codexRun();
  try{
    save(path.join(f.run,'dispatch.json'),{schemaVersion:1,executorId:'executor-qa',planningRevision:'p1',activity:'waiting',capacity:{verified:4,evidence:['spawn_agent tool']},
      packages:{ready:[],inFlight:[],returned:[],blocked:[{id:'C14',kind:'user',exclusiveResources:[],evidence:['wp/C14.md'],acceptanceIds:['A1']}],completed:[],recurringRework:[]},
      acceptance:{revision:'r1',items:[{id:'A1',status:'PENDING',evidence:['wp/C14.md']},{id:'A2',status:'FAIL',evidence:['wp/D2.md']}]}});
    const ledger=status=>save(path.join(f.run,'pending-decisions.json'),{schema:1,items:[{key:'c14-onsite',status,kind:'user_action',ask:'到辦公室電腦按確認',recommend:'今天下午',why:'只有本人能按',options:[]}]});
    ledger('open');
    const quiet=wait=>({lastRealEventAt:Date.now()-120*60000,lastExecutorActivityAt:Date.now()-120*60000,lastLoginCheckAt:Date.now(),lastAutomationCheckAt:Date.now(),lastHealthAt:Date.now(),checkedWait:wait});
    const reasons=wait=>f.check(quiet(wait))?.reasons||[];
    const approval={kind:'user_approval',conditions:[]};
    const tied=ids=>({...approval,dependsOn:ids.map(id=>({id,pendingKey:'c14-onsite',reason:'needs the office PC'}))});
    let found=reasons(approval);
    assert.ok(found.includes('idle_with_work')&&found.includes('no_event_hour'),'an approval wait with no dependencies does not quiet the line: '+found);
    found=reasons(tied(['A1']));
    assert.ok(found.includes('idle_with_work'),'A2 does not depend on Jay: '+found);
    found=reasons(tied(['A1','A2']));
    assert.ok(!found.includes('idle_with_work')&&!found.includes('no_event_hour'),'every open criterion waits on the open item: '+found);
    // Jay answers: the item closes and the same wait no longer explains the idle line.
    ledger('answered');
    found=reasons(tied(['A1','A2']));
    assert.ok(found.includes('idle_with_work'),'once answered, the wait stops silencing: '+found);
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('collect takes several packages in one validated write and mark --estimate fills the baseline in the same step',()=>{
  for(const p of PLATFORMS){
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'v150-collect-')),run=path.join(root,'run'),state=path.join(root,'state'),wp=path.join(state,'wp');
    fs.mkdirSync(run);fs.mkdirSync(wp,{recursive:true});
    const source=path.join(root,'source');fs.writeFileSync(source,'criterion\n');
    save(path.join(run,'contract.json'),{goal:'collect',authorization:'isolated test',criteria:[{id:'A1',requirement:'one',source:'source:1',verify:'inspect'},{id:'A2',requirement:'two',source:'source:1',verify:'inspect'}],sources:[{path:source,sha256:sha(source)}]});
    const executorId=p.name==='codex'?'executor-qa':crypto.randomUUID();
    // A Claude binding names the executor transcript; its subagent transcripts are found beside it.
    save(path.join(run,'binding.json'),{platform:p.name,projectRoot:root,allowedRoots:[root,run],executorId,supervisorId:p.name==='codex'?'supervisor-qa':crypto.randomUUID(),executorLog:path.join(root,'transcripts',executorId+'.jsonl'),
      contractSha256:sha(path.join(run,'contract.json')),dispatchAudit:{enabled:true,snapshot:'dispatch.json'}});
    const script=path.join(ROOT,p.supervisor,'scripts/dispatch.cjs');
    const cli=args=>execFileSync(process.execPath,[script,...args],{stdio:'pipe',encoding:'utf8',env:{...process.env,CODEX_HOME:path.join(root,'empty-home'),CLAUDE_CONFIG_DIR:path.join(root,'empty-config')}});
    const flight=id=>'{"list":"inFlight","handle":"agent:'+id+'","baseline":{"minutes":20,"startedAt":"2026-11-13T01:00:00Z","basis":"pace"}}';
    for(const id of ['B1','B2'])fs.writeFileSync(path.join(wp,id+'.md'),'[工作包] id='+id+'；依賴：無\n[狀態] '+flight(id)+'\n[驗收條目] '+(id==='B1'?'A1':'A2')+'\n');
    fs.writeFileSync(path.join(wp,'B3.md'),'[工作包] id=B3；依賴：無\n[狀態] {"list":"ready"}\n[驗收條目] A2\n');
    const base=path.join(root,'base.json');save(base,{capacity:{verified:3,evidence:['platform:list_agents']},acceptance:{revision:'r1',items:['A1','A2'].map(id=>({id,status:'PENDING',evidence:['plan']}))}});
    try{
      cli(['from-wp',run,state,'--base',base,'--revision','p1']);
      const report=path.join(root,'report.md');fs.writeFileSync(report,'passed\n');
      const r1=path.join(root,'r1.json'),r2=path.join(root,'r2.json'),files=[path.join(run,'dispatch.json'),path.join(wp,'B1.md'),path.join(wp,'B2.md')];
      save(r1,{status:{list:'completed',handle:'agent:B1',evidence:[report]},acceptance:[{id:'A1',status:'PASS',evidence:[report]}]});
      save(r2,{status:{list:'completed',handle:'agent:B2',evidence:[path.join(root,'missing.md')]},acceptance:[]});
      const before=files.map(file=>fs.readFileSync(file,'utf8'));
      // One bad result leaves every package and the snapshot as they were.
      assert.throws(()=>cli(['collect',run,state,'B1',r1,'B2',r2]),error=>/does not exist/.test(error.stderr),p.name);
      assert.deepEqual(files.map(file=>fs.readFileSync(file,'utf8')),before,p.name);
      assert.throws(()=>cli(['collect',run,state,'B1',r1,'B1',r1]),error=>/named twice/.test(error.stderr),p.name);
      assert.throws(()=>cli(['collect',run,state,'B1',r1,'B2']),error=>/Usage/.test(error.stderr),p.name+': an id without its result file');
      save(r2,{status:{list:'completed',handle:'agent:B2',evidence:[report]},acceptance:[{id:'A2',status:'FAIL',evidence:[report]}]});
      const out=JSON.parse(cli(['collect',run,state,'B1',r1,'B2',r2]));
      assert.deepEqual(out.acceptance,[{id:'A1',status:'PASS'},{id:'A2',status:'FAIL'}],p.name);assert.equal(out.packages.completed,2,p.name);assert.equal(out.packages.inFlight,0,p.name);
      for(const id of ['B1','B2'])assert.match(fs.readFileSync(path.join(wp,id+'.md'),'utf8'),/^\[狀態\] \{"list":"completed"/m,p.name);
      const marked=JSON.parse(cli(['mark',run,state,'B3','{"list":"inFlight","handle":"agent:B3"}','--estimate','sonnet:30000:4']));
      assert.equal(marked.packages.inFlight,1,p.name);
      const baseline=JSON.parse(fs.readFileSync(path.join(run,'dispatch.json'),'utf8')).packages.inFlight[0].baseline;
      assert.equal(baseline.estimatedOutputTokens,30000,p.name);assert.equal(baseline.toolMinutes,4,p.name);assert.ok(baseline.minutes>4,p.name);
      assert.ok(Number.isFinite(Date.parse(baseline.startedAt))&&/tokens\/s/.test(baseline.basis),p.name+': the same formula as pace.cjs estimate');
      assert.throws(()=>cli(['mark',run,state,'B3','{"list":"ready"}','--estimate','sonnet']),error=>/inFlight/.test(error.stderr),p.name);
    }finally{fs.rmSync(root,{recursive:true,force:true});}
  }
});

test('Codex: context reports whether the watch runs and a committed decision returns the turn-end status',()=>{
  const scripts=path.join(ROOT,CX,'long-task-supervisor/scripts');
  const run=fs.mkdtempSync(path.join(os.tmpdir(),'v150-status-'));
  try{
    const source=path.join(run,'source.txt');fs.writeFileSync(source,'Original human instruction');
    save(path.join(run,'contract.json'),{goal:'QA',authorization:'Original human instruction',criteria:[{id:'A1',requirement:'Check',source:'source.txt:1',verify:'Read'}],sources:[{path:source,sha256:sha(source)}]});
    save(path.join(run,'binding.json'),{supervisorId:'supervisor',executorId:'executor',allowedRoots:[run],createdAt:new Date().toISOString(),contractSha256:sha(path.join(run,'contract.json'))});
    const event={id:'progress-1',kind:'progress_review',reasons:['overdue']};
    save(path.join(run,'daemon-state.json'),{pending:event,messages:[],phase:'awaiting_decision'});
    const cli=(...args)=>JSON.parse(execFileSync(process.execPath,[path.join(scripts,'supervise.cjs'),...args],{encoding:'utf8',env:{...process.env,CODEX_HOME:path.join(run,'empty-home')}}));
    const context=cli('context',run,event.id);
    // No watcher process in this fixture: the turn must still run the start command, and the fields say so.
    assert.equal(context.watch.phase,'awaiting_decision');assert.ok('active' in context.watch&&context.watch.active!==true);
    assert.ok('orphaned' in context.watch.watch&&'remountCommand' in context.watch.watch&&'restartCommand' in context.watch.watch);
    assert.match(context.watch.nowTaipei,/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    assert.equal(context.watch.pendingDecision.eventId,event.id);
    const draft=context.decisionPath;
    save(draft,{eventId:event.id,disposition:'observe',reason:'Still producing; the estimate was short.',progressCheck:{evidence:['pace'],finding:'running'}});
    const decided=cli('decision',run,draft);
    assert.equal(decided.valid,true);assert.equal(decided.submitted,true);
    assert.equal(decided.status.phase,'awaiting_decision');assert.ok('watch' in decided.status&&'pendingDecision' in decided.status&&'questionPush' in decided.status);
    // A state the status cannot read is reported in place, never thrown: the supervisor then checks by hand.
    save(path.join(run,'daemon-state.json'),{pending:null,phase:'watching',resolved:{[event.id]:{event,decisionSha256:sha(draft)}}});
    const again=cli('decision',run,draft);
    assert.equal(again.processed,true);assert.equal(typeof again.status.unavailable,'string');
  }finally{fs.rmSync(run,{recursive:true,force:true});}
});
