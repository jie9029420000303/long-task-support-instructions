// Third batch (Jay 2026-10-11, "全部照你的建議"): fewer interruptions for Jay, faster dispatch. Each test pins why a rule
// exists: a nag that wasted half a day, a model refused for quota, an instruction nobody acted on, a criterion no
// package covered while seats sat free (10/11 GDB: one subagent in flight 69% of 390 minutes with 12 criteria open).
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawn,execFileSync}=require('node:child_process');
const scripts=process.env.CODEX_SUPERVISOR_SCRIPTS||path.resolve(__dirname,'../codex/.agents/skills/long-task-supervisor/scripts');
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const save=(file,value)=>fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n');
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const line=(file,value)=>fs.appendFileSync(file,JSON.stringify(value)+'\n');
const minutesAgo=minutes=>new Date(Date.now()-minutes*60000).toISOString();
const hashId=id=>crypto.createHash('sha256').update(id).digest('hex').slice(0,32);
async function until(check,ms=15000){const end=Date.now()+ms;while(Date.now()<end){if(check())return;await new Promise(resolve=>setTimeout(resolve,50));}throw Error('Timed out');}
function today(home){
  const now=new Date(),dir=path.join(home,'sessions',String(now.getFullYear()),String(now.getMonth()+1).padStart(2,'0'),String(now.getDate()).padStart(2,'0'));
  fs.mkdirSync(dir,{recursive:true});return dir;
}
function withEnv(values,fn){
  const old=Object.fromEntries(Object.keys(values).map(key=>[key,process.env[key]]));Object.assign(process.env,values);
  try{return fn();}finally{for(const [key,value] of Object.entries(old))if(value===undefined)delete process.env[key];else process.env[key]=value;}
}
// The clock checks at most once a minute per process; each unit check loads it fresh.
function freshClock(){for(const key of Object.keys(require.cache))if(key.endsWith('supervisor-clock.cjs'))delete require.cache[key];return require(path.join(scripts,'supervisor-clock.cjs'));}
function fixture({settings,quietMinutes=0,createdMinutesAgo=1,finals,mock={}}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'codex-batch3-'));
  const home=path.join(root,'codex-home'),source=path.join(root,'source.txt');fs.writeFileSync(source,'Keep the work moving\n');
  const contract={goal:'Finish',authorization:'Isolated QA',criteria:[{id:'A1',requirement:'Keep work moving',source:'source.txt:1',verify:'Replay'}],sources:[{path:source,sha256:sha(source)}]};
  const run=path.join(root,'run');fs.mkdirSync(run);save(path.join(run,'contract.json'),contract);
  const binding={platform:'codex',projectRoot:root,allowedRoots:[root,run],supervisorId:'supervisor-qa',executorId:'executor-qa',callerTurnId:'supervisor-turn',
    contractSha256:sha(path.join(run,'contract.json')),createdAt:minutesAgo(createdMinutesAgo)};
  save(path.join(run,'binding.json'),binding);
  save(path.join(run,'daemon-state.json'),{phase:'starting',cursor:null,seen:[],messages:[],pending:null,inflight:null,reads:0,starts:0,
    lastExecutorActivityAt:Date.now()-quietMinutes*60000,lastProgressReviewAt:Date.now()-quietMinutes*60000});
  const executorLog=path.join(today(home),'rollout-t-executor-qa.jsonl');
  line(executorLog,{timestamp:binding.createdAt,type:'session_meta',payload:{id:'executor-qa',session_id:'executor-qa'}});
  if(settings)line(executorLog,{timestamp:binding.createdAt,type:'turn_context',payload:settings});
  const sent=path.join(root,'sent.json'),mockFile=path.join(root,'mock.json'),usage=path.join(root,'usage.jsonl'),quota=path.join(root,'quota.json');
  fs.writeFileSync(usage,JSON.stringify({conversationId:'unrelated',status:200})+'\n');
  save(mockFile,{supervisorId:binding.supervisorId,executorId:binding.executorId,...(finals?{finals}:{noTurn:true}),...mock});
  const env={...process.env,CODEX_HOME:home,CODEX_APP_TOOLS_SERVER_PATH:path.join(__dirname,'mock-codex-app-server.cjs'),MOCK_CODEX_FIXTURE:mockFile,MOCK_CODEX_SENT:sent,
    OPENCODEX_USAGE_FILE:usage,OPENCODEX_QUOTA_FILE:quota,CHROME_RELAY_BIN:path.join(root,'no-relay'),CODEX_WATCH_IDLE_SLEEP_MS:'200'};
  delete env.CODEX_THREAD_ID;
  let child;
  return {root,home,run,binding,executorLog,sent,usage,quota,env,statePath:path.join(run,'daemon-state.json'),
    start(){child=spawn(process.execPath,[path.join(scripts,'native-watch.cjs'),run],{env,stdio:['ignore','pipe','pipe']});return child;},
    calls(){const file=sent+'.args.json';return fs.existsSync(file)?read(file):[];},
    async stop(){if(child?.exitCode===null){child.kill('SIGTERM');await new Promise(resolve=>child.once('exit',resolve));}fs.rmSync(root,{recursive:true,force:true});}};
}
const fullAccess={model:'anthropic/claude-opus-5-5',effort:'high',approval_policy:'never',approvals_reviewer:'user'};

test('Jay\'s pause stops every model wake that a quiet run would otherwise cause, and the dashboard says so',async()=>{
  const quiet=fixture({settings:fullAccess,quietMinutes:20,createdMinutesAgo:20}),paused=fixture({settings:fullAccess,quietMinutes:20,createdMinutesAgo:20});
  execFileSync(process.execPath,[path.join(scripts,'supervise.cjs'),'pause',paused.run,'先暫停，等我說繼續'],{env:paused.env});
  assert.equal(read(path.join(paused.run,'PAUSED.json')).quote,'先暫停，等我說繼續');
  quiet.start();paused.start();
  try{
    await until(()=>read(quiet.statePath).pending?.kind==='progress_review');
    await until(()=>read(paused.statePath).reads>=3);
    assert.equal(read(paused.statePath).pending,null,'a paused run asks the supervisor nothing');
    const board=path.join(paused.run,'監督儀表板.md');await until(()=>fs.existsSync(board));
    const text=fs.readFileSync(board,'utf8');
    assert.match(text,/背景監看：運作中/);assert.match(text,/使用者暫停中/);assert.match(text,/執行對話權限：完全存取/);
    const resumed=JSON.parse(execFileSync(process.execPath,[path.join(scripts,'supervise.cjs'),'resume',paused.run],{env:paused.env,encoding:'utf8'}));
    assert.equal(resumed.resumed,true);assert.equal(fs.existsSync(path.join(paused.run,'PAUSED.json')),false);
    assert.equal(fs.readFileSync(path.join(paused.run,'pause-history.jsonl'),'utf8').includes('先暫停'),true,'the pause and its words stay on record');
  }finally{await quiet.stop();await paused.stop();}
});

test('auto review is reported once with the refusal text, so the supervisor asks for full access instead of pasted authorization',async()=>{
  const f=fixture({settings:{...fullAccess,approval_policy:'on-request',approvals_reviewer:'auto_review'}});
  const refusal='Script error:\nexec_command failed: CreateProcess { message: "Rejected(\\"This action was rejected due to unacceptable risk.\\\\nReason: 此 SSH 動作會以 root 身分讀取遠端 Jira 憑證；未獲得該具體操作授權。\\\\nThe agent must not attempt\\")" }';
  line(f.executorLog,{timestamp:minutesAgo(0.5),type:'response_item',payload:{type:'custom_tool_call_output',call_id:'call_jira',output:[{type:'input_text',text:refusal}]}});
  f.start();
  try{
    await until(()=>read(f.statePath).pending?.reasons?.includes('permission_review'));
    const event=read(f.statePath).pending;
    assert.equal(event.permission.approvalPolicy,'on-request');
    assert.equal(event.permission.newRejections.length,1);assert.match(event.permission.newRejections[0].reason,/SSH/);
  }finally{await f.stop();}
});

test('an active automation aimed at the executor wakes the supervisor to pause it',async()=>{
  const f=fixture({settings:fullAccess});
  const dir=path.join(f.home,'automations','gdb-watch');fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,'automation.toml'),'version = 1\nid = "gdb-watch"\nkind = "heartbeat"\nname = "GDB 監督排程"\nprompt = "每 30 分鐘看一次"\nstatus = "ACTIVE"\nrrule = "RRULE:FREQ=MINUTELY;INTERVAL=30"\ntarget_thread_id = "executor-qa"\nupdated_at = 1791700000000\n');
  f.start();
  try{
    await until(()=>read(f.statePath).pending?.reasons?.includes('automation_found'));
    assert.deepEqual(read(f.statePath).pending.automations.map(item=>[item.id,item.name]),[['gdb-watch','GDB 監督排程']]);
  }finally{await f.stop();}
});

test('a refused executor continues on the next model in Jay\'s order and gets its own model back after the reset',async()=>{
  const gate=path.join(os.tmpdir(),'batch3-gate-'+crypto.randomUUID());
  const f=fixture({settings:fullAccess,finals:['LONG_TASK_EVENT {"kind":"progress","nextAction":"run the B6 checks"}','LONG_TASK_EVENT {"kind":"progress","nextAction":"integrate B6"}'],mock:{secondTurnGate:gate}});
  // Every Anthropic OAuth account is exhausted and the earliest one resets in about three seconds.
  save(f.quota,{version:1,rows:{['anthropic\u0000a']:{fiveHourPercent:100,fiveHourResetAt:Date.now()+3000},['anthropic\u0000b']:{fiveHourPercent:100,fiveHourResetAt:Date.now()+9000}}});
  f.start();
  try{
    await until(()=>f.calls().some(call=>call.prompt.includes('run the B6 checks')));
    await until(()=>read(f.statePath).usageOffset!==undefined);
    line(f.usage,{timestamp:Date.now(),conversationId:hashId('executor-qa'),requestedModel:'anthropic/claude-opus-5-5',status:429,failureCause:'rate-limit',
      upstreamError:'All Anthropic OAuth accounts are temporarily rate-limited'});
    await until(()=>f.calls().some(call=>call.model==='anthropic-apikey/claude-opus-5-5'));
    const switched=f.calls().find(call=>call.model);
    assert.equal(switched.threadId,'executor-qa');assert.equal(switched.thinking,'high','reasoning stays as it was');
    assert.match(switched.prompt,/額度限速/);assert.match(switched.prompt,/anthropic-apikey\/claude-opus-5-5/);
    const published=read(path.join(f.run,'model-fallback.json'));
    assert.ok(published.limits['anthropic/'],'subagents read the same limit');assert.match(published.limits['anthropic/'].basis,/最早重置/);
    await new Promise(resolve=>setTimeout(resolve,3500));
    fs.writeFileSync(gate,'open');
    await until(()=>f.calls().some(call=>call.prompt.includes('integrate B6')));
    assert.equal(f.calls().find(call=>call.prompt.includes('integrate B6')).model,'anthropic/claude-opus-5-5','the first delivery after the reset restores the original model');
  }finally{await f.stop();fs.rmSync(gate,{force:true});}
});

test('model fallback follows anthropic/ -> anthropic-apikey/ -> gpt-5.6-sol and skips what is still limited',()=>{
  const fallback=require(path.join(scripts,'model-fallback.cjs'));
  const state={rateLimits:{'anthropic/':{until:Date.now()+60000}}};
  assert.equal(fallback.next('anthropic/claude-opus-5-5','anthropic/claude-opus-5-5','executor',state),'anthropic-apikey/claude-opus-5-5');
  state.rateLimits['anthropic-apikey/']={until:Date.now()+60000};
  assert.equal(fallback.next('anthropic/claude-sonnet-5-5','anthropic/claude-sonnet-5-5','subagent',state),'gpt-5.6-sol');
  state.rateLimits['gpt-5.6-sol']={until:Date.now()+60000};
  assert.equal(fallback.next('anthropic/claude-opus-5-5','anthropic/claude-opus-5-5','executor',state),null,'all limited is reported, not guessed');
  assert.equal(fallback.next('gpt-6-luna','gpt-6-luna','executor',{}),'anthropic/claude-opus-5-5','a GPT thread goes to Anthropic first');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'batch3-quota-'));
  try{
    const quota=path.join(root,'quota.json');
    withEnv({OPENCODEX_QUOTA_FILE:quota},()=>{
      save(quota,{rows:{['anthropic\u0000a']:{fiveHourPercent:100,fiveHourResetAt:5000},['anthropic\u0000b']:{fiveHourPercent:40}}});
      assert.equal(fallback.resetFor('anthropic/',1000).until,1000+fallback.FALLBACK_MS,'one account still has quota: the cache is stale, use five hours');
      save(quota,{rows:{['anthropic\u0000a']:{fiveHourPercent:100,fiveHourResetAt:5000},['anthropic\u0000b']:{weeklyPercent:100,weeklyResetAt:9000}}});
      assert.equal(fallback.resetFor('anthropic/',1000).until,5000,'the earliest real reset ends the limit');
      assert.equal(fallback.resetFor('anthropic-apikey/',1000).until,1000+fallback.FALLBACK_MS);
    });
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('Claude subagent routing substitutes only for a recorded rate limit',()=>{
  const {resolve}=require(path.join(scripts,'model-route.cjs'));
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'batch3-route-'));
  try{
    const file=path.join(root,'model-fallback.json');
    const catalog=[{id:'anthropic/claude-sonnet-5-5',efforts:['low','medium','high']},{id:'anthropic-apikey/claude-sonnet-5-5',efforts:['low','medium','high']},{id:'gpt-5.6-sol',efforts:['low','medium','high']}];
    const input={supervisorModel:'anthropic/claude-opus-5-5',roles:['general'],catalogs:{subagent:catalog},fallback:file};
    assert.equal(resolve(input).roles.general.model,'anthropic/claude-sonnet-5-5','no limit: the supervisor\'s own series');
    save(file,{limits:{'anthropic/':{until:new Date(Date.now()+60000).toISOString()}}});
    const limited=resolve(input).roles.general;
    assert.equal(limited.model,'anthropic-apikey/claude-sonnet-5-5');assert.equal(limited.basis,'rate-limit-fallback');assert.ok(limited.restoreAfter);
    save(file,{limits:{'anthropic/':{until:new Date(Date.now()-1000).toISOString()}}});
    assert.equal(resolve(input).roles.general.model,'anthropic/claude-sonnet-5-5','an expired limit returns to the original series');
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('an instruction nobody acts on wakes the supervisor twice, the second time for the supervisor to handle, and action clears it',()=>{
  const f=fixture({settings:fullAccess});
  try{
    withEnv({CODEX_HOME:f.home},()=>{
      const state={instruction:{eventId:'e1',what:'Run R14 against the deployed candidate',doneWhen:'R14 result in the snapshot',sentAt:Date.now()-31*60000,deadlineMs:30*60000,misses:0},
        lastRealEventAt:Date.now()-40*60000,lastExecutorActivityAt:Date.now()};
      let found=freshClock().check(f.run,f.binding,state);
      assert.ok(found.reasons.includes('instruction_overdue'));assert.equal(found.instructionOverdue.misses,1);assert.match(found.instructionOverdue.handling,/改道/);
      // Thirty more minutes pass with nothing from the executor.
      state.instruction.sentAt-=30*60000;state.lastRealEventAt-=30*60000;
      found=freshClock().check(f.run,f.binding,state);
      assert.equal(found.instructionOverdue.misses,2);assert.match(found.instructionOverdue.handling,/不通知使用者/);assert.equal(state.instruction,null);
      const acted={instruction:{eventId:'e2',what:'Retry',doneWhen:'Done',sentAt:Date.now()-31*60000,deadlineMs:30*60000,misses:0},lastRealEventAt:Date.now()-10*60000,lastExecutorActivityAt:Date.now()};
      assert.equal(freshClock().check(f.run,f.binding,acted)?.reasons?.includes('instruction_overdue')||false,false);assert.equal(acted.instruction,null);
    });
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('waiting on Jay\'s approval stops the hourly and idle reminders that only repeat the same question',()=>{
  const f=fixture({settings:fullAccess,createdMinutesAgo:180});
  try{
    withEnv({CODEX_HOME:f.home},()=>{
      const base=()=>({lastRealEventAt:Date.now()-120*60000,lastExecutorActivityAt:Date.now()-120*60000});
      assert.ok(freshClock().check(f.run,f.binding,base()).reasons.includes('no_event_hour'));
      assert.equal(freshClock().check(f.run,f.binding,{...base(),checkedWait:{kind:'user_approval',conditions:[]}}),null);
    });
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('an open criterion no package covers for 10 minutes wakes the supervisor once; a package naming it clears it',()=>{
  const f=fixture();
  try{
    f.binding.dispatchAudit={enabled:true,snapshot:'dispatch.json'};
    const snapshot=covered=>({schemaVersion:1,executorId:'executor-qa',planningRevision:'p1',activity:'working',capacity:{verified:4,evidence:['spawn_agent tool']},
      packages:{ready:[],inFlight:[{id:'W1',handle:'/root/w1',exclusiveResources:[],evidence:['wp/W1.md'],acceptanceIds:covered}],returned:[],blocked:[],completed:[],recurringRework:[]},
      acceptance:{revision:'r1',items:[{id:'A1',status:'PENDING',evidence:['wp/A1.md']}]}});
    // A busy executor keeps the other clock reasons quiet, so only the uncovered criterion can wake.
    const state={lastRealEventAt:Date.now(),lastExecutorActivityAt:Date.now()};
    const check=()=>withEnv({CODEX_HOME:f.home},()=>freshClock().check(f.run,f.binding,state));
    save(path.join(f.run,'dispatch.json'),snapshot([]));
    assert.equal(check()?.reasons.includes('unplanned_criteria')||false,false,'a criterion between two packages is not news yet');
    assert.ok(state.unplanned.A1,'the clock starts timing A1 as soon as nobody covers it');
    // Ten minutes later it is still uncovered.
    state.unplanned.A1-=10*60000;
    const found=check();
    assert.ok(found.reasons.includes('unplanned_criteria'));
    assert.deepEqual(found.unplannedCriteria.criteria,['A1']);assert.equal(found.unplannedCriteria.freeCapacity,3,'three seats sit free beside it');
    assert.equal(check()?.reasons.includes('unplanned_criteria')||false,false,'the same uncovered set wakes only once');
    save(path.join(f.run,'dispatch.json'),snapshot(['A1']));
    check();
    assert.equal(state.unplanned.A1,undefined,'a package naming A1 covers it and clears the timer');
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('an added criterion joins the scope from Jay\'s quote and blocks acceptance until it passes',()=>{
  const {append,effective}=require(path.join(scripts,'contract-state.cjs')),{validateDecision}=require(path.join(scripts,'guard.cjs'));
  const f=fixture();
  try{
    f.binding.supervisorId=process.env.CODEX_THREAD_ID||'supervisor-qa';save(path.join(f.run,'binding.json'),f.binding);
    save(path.join(f.run,'daemon-state.json'),{phase:'idle',pending:null,inflight:null});
    const quoteFile=path.join(f.root,'jay.md');fs.writeFileSync(quoteFile,'Jay: 也要驗證 Telegram 告警實際顯示在群組裡\n');
    const row={id:'add-telegram',contractSha256:f.binding.contractSha256,authority:{role:'user',quote:'也要驗證 Telegram 告警實際顯示在群組裡',locator:'supervisor chat 2026-10-11',at:'2026-10-11T10:00:00Z',
      source:{path:quoteFile,sha256:sha(quoteFile)}},changes:[{action:'add',id:'TG1',requirement:'Telegram 告警實際顯示在群組',verify:'讀群組畫面'}]};
    append(f.run,f.binding,row);
    const contract=effective(f.run,f.binding);
    assert.deepEqual(contract.criteria.map(item=>item.id),['A1','TG1']);
    assert.equal(read(path.join(f.run,'contract.json')).criteria.length,1,'the locked contract is untouched');
    const evidence=path.join(f.root,'proof.txt');fs.writeFileSync(evidence,'ok');
    const manifest=path.join(f.root,'manifest.json');save(manifest,{files:[{path:evidence,sha256:sha(evidence)}]});
    const event={id:'s1',kind:'submission',revision:'sha256:'+sha(manifest),manifest};
    const pass=id=>({id,status:'PASS',method:'read',expected:'x',actual:'x',evidence:[{path:evidence,sha256:sha(evidence)}]});
    const decision={eventId:'s1',disposition:'accept',revision:event.revision,contractStateSha256:contract.contractStateSha256,results:[pass('A1')]};
    assert.throws(()=>validateDecision(f.binding,contract,event,decision),/Incomplete acceptance table/);
    assert.equal(validateDecision(f.binding,contract,event,{...decision,results:[pass('A1'),pass('TG1')]}).disposition,'accept');
    assert.throws(()=>append(f.run,f.binding,{...row,id:'again'}),/new unique ID/);
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('a logged-out site is reported once per logout and only the tab the check opened is closed',()=>{
  const login=require(path.join(scripts,'login-check.cjs'));
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'batch3-login-'));
  try{
    const log=path.join(root,'relay.log'),landing=path.join(root,'landing');fs.writeFileSync(landing,'https://id.atlassian.com/login');
    const relay=path.join(root,'relay');
    fs.writeFileSync(relay,'#!/bin/sh\necho "$@" >> '+log+'\ncase "$1" in navigate) echo "Opened tab 4242";; get) if [ "$2" = url ]; then cat '+landing+'; else echo Jira; fi;; esac\n',{mode:0o755});
    save(path.join(root,'login-sites.json'),{sites:[{name:'Jira',url:'https://wwinno.atlassian.net/jira',loggedOutPattern:'id\\.atlassian\\.com/login'}]});
    withEnv({CHROME_RELAY_BIN:relay},()=>{
      const state={};
      assert.deepEqual(login.due(state,root).map(item=>item.name),['Jira']);
      assert.equal(login.due(state,root),null,'once an hour');
      state.lastLoginCheckAt=0;assert.deepEqual(login.due(state,root),[],'the same logout is not reported again');
      fs.writeFileSync(landing,'https://wwinno.atlassian.net/jira/your-work');state.lastLoginCheckAt=0;login.due(state,root);
      fs.writeFileSync(landing,'https://id.atlassian.com/login');state.lastLoginCheckAt=0;
      assert.deepEqual(login.due(state,root).map(item=>item.name),['Jira'],'a new logout after a login is reported again');
    });
    const calls=fs.readFileSync(log,'utf8');
    assert.match(calls,/navigate https:\/\/wwinno\.atlassian\.net\/jira --new/,'a new background tab, never the user\'s tab');
    assert.equal((calls.match(/^close 4242$/gm)||[]).length,(calls.match(/^navigate /gm)||[]).length,'every opened tab is closed');
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('Jay counts as online for 10 minutes after typing in the supervisor chat',()=>{
  const {observeSupervisorInput}=require(path.join(scripts,'checked-wait.cjs'));
  const state={},startedAt=Math.floor(Date.now()/1000)-120;
  observeSupervisorInput(state,{turns:[{id:'t1',startedAt,items:[{type:'userMessage',id:'u1',text:'繼續開發'}]}]});
  assert.equal(state.lastUserInputAt,startedAt*1000);
  observeSupervisorInput(state,{turns:[{id:'t2',startedAt:startedAt+60,items:[{type:'userMessage',id:'d1',text:'LONG_TASK_DELIVERY:review-x\nevent'}]}]});
  assert.equal(state.lastUserInputAt,startedAt*1000,'a watcher delivery is not Jay typing');
});
