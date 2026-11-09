// v1.2.0 (Jay 2026-11-09「這些改法都OK…這次一起改一改」): the supervisor decides inside the contract, Jay's questions
// reach his phone in full, a switch meant for tests no longer silences a real run, subagents above the default are
// named, and the executor's permission is read at the start. What failed before, and what each test pins:
// - WEB 11/07 23:16 put questions to Jay and nothing reached his phone; when a push did go out it said only 「有 5 題」,
//   and Jay asked twice (11/07 18:53, 02:11) to have the questions listed again.
// - GDB 11/06-08 started its watcher with LONG_TASK_NOTIFY_DISABLE=1, and none of its 6 question pushes left, unseen.
// - WEB from 11/08 22:22: 29 subagents ran Opus xhigh because 36 dispatches named no model.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const http=require('node:http');
const crypto=require('node:crypto');
const {spawn,execFileSync}=require('node:child_process');
const codex=path.resolve(__dirname,'../codex/.agents/skills/long-task-supervisor/scripts');
const claude=path.resolve(__dirname,'../claude-code/.claude/skills/long-task-supervisor/scripts');
const save=(file,value)=>fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n');
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const line=(file,value)=>fs.appendFileSync(file,JSON.stringify(value)+'\n');
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const iso=ms=>new Date(ms).toISOString();
const opus='anthropic/claude-opus-5-5';
async function until(check,ms=15000){const end=Date.now()+ms;while(Date.now()<end){if(await check())return;await new Promise(resolve=>setTimeout(resolve,50));}throw Error('Timed out');}
// Sets environment values (undefined removes one) and returns the way back.
function setEnv(values){
  const old=Object.fromEntries(Object.keys(values).map(key=>[key,process.env[key]]));
  for(const [key,value] of Object.entries(values))if(value===undefined)delete process.env[key];else process.env[key]=value;
  return ()=>{for(const [key,value] of Object.entries(old))if(value===undefined)delete process.env[key];else process.env[key]=value;};
}
// A stand-in for api.telegram.org: records each sendMessage and fails the first N when asked.
async function telegram({fail=0}={}){
  const messages=[];let failures=fail;
  const server=http.createServer((req,res)=>{let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{
    const ok=failures--<=0;messages.push({ok,...JSON.parse(body||'{}')});
    res.writeHead(ok?200:502,{'content-type':'application/json'});res.end(JSON.stringify(ok?{ok:true,result:{}}:{ok:false,description:'bad gateway'}));});});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {messages,url:'http://127.0.0.1:'+server.address().port,close:()=>new Promise(resolve=>server.close(resolve))};
}
function notifyEnv(root,api){
  const config=path.join(root,'notify.json');
  save(config,{telegram:{keychainService:'qa.telegram',keychainAccount:'qa',chatId:'4242'}});
  return {LONG_TASK_HOME:path.join(root,'home'),LONG_TASK_NOTIFY_CONFIG:config,LONG_TASK_TELEGRAM_TOKEN:'123:qa-token',LONG_TASK_TELEGRAM_API:api,LONG_TASK_NOTIFY_RETRY_MS:'10'};
}
// Ledger rows as the supervisor's pending command writes them.
const ledger=(run,items)=>save(path.join(run,'pending-decisions.json'),{schema:1,items});
const open=(key,ask,updatedAt,extra={})=>({key,kind:'acceptance',ask,recommend:'A 照原條文驗',why:'改驗收要你同意',options:['A 照原條文驗','B 列已知缺口'],
  status:'open',raisedAt:updatedAt,updatedAt,presentedAt:null,answer:null,withdrawn:null,history:[],...extra});
const delegated=(key,ask,at)=>({key,kind:null,ask,status:'delegated',raisedAt:at,updatedAt:at,presentedAt:null,answer:null,withdrawn:null,history:[],
  delegated:{choice:'用 10 分鐘逾時',basis:'選擇原則：能自動就不加人工關卡',revert:'跟監督說改回 30 分鐘',at}});

test('both platforms ship the same notice, ledger and continuation modules',()=>{
  // A drift here means one platform pushes the questions or names subagents and the other does not.
  for(const name of ['notify.cjs','pending-decisions.cjs','execution-wake.cjs'])
    assert.deepEqual(fs.readFileSync(path.join(codex,name)),fs.readFileSync(path.join(claude,name)),name);
});

for(const [platform,dir] of [['codex',codex],['claude',claude]]){
  test(platform+': a question push carries each question in full and what the supervisor decided in Jay\'s place',()=>{
    const pending=require(dir+'/pending-decisions.cjs');
    const items=[open('r24','R24/R21 要 uat2、uat3 重新登入才能跑，要怎麼驗？',iso(0)),open('mail','寄信上限要多少？',iso(0),{options:[]})];
    const {text:body,delegated:used}=pending.pushText('區分 Debug 與新功能需求',items,[delegated('timeout','測試逾時要設多久？',iso(0))]);
    assert.match(body,/^【開發任務需要你決定】『區分 Debug 與新功能需求』有 2 題要你回答：/);
    for(const part of ['1. R24/R21 要 uat2、uat3 重新登入才能跑，要怎麼驗？','建議：A 照原條文驗','原因／影響：改驗收要你同意','選項：A 照原條文驗／B 列已知缺口',
      '2. 寄信上限要多少？','直接在監督對話回覆','監督已依規格代決','測試逾時要設多久？：用 10 分鐘逾時','改回：跟監督說改回 30 分鐘'])assert.ok(body.includes(part),part);
    assert.ok(!body.split('\n\n').find(block=>block.startsWith('2. ')).includes('選項'),'a question without choices gets no empty choices line');
    assert.deepEqual(used.map(item=>item.key),['timeout']);
    // Telegram takes 4096 characters: a long list stays under the limit and says how many more wait in the chat.
    const many=Array.from({length:40},(_,index)=>open('k'+index,'第 '+index+' 題：'+'很長的說明'.repeat(60),iso(0)));
    const long=pending.pushText('長清單',many,[]);
    assert.ok(long.text.length<=3800,String(long.text.length));assert.match(long.text,/另有 \d+ 題，請打開監督對話『長清單』查看。/);
  });

  test(platform+': each question version is pushed once, and a failed push is retried and stays visible until one gets through',async()=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'v120-push-')),run=path.join(root,'run');fs.mkdirSync(run);
    const api=await telegram({fail:2}); // the first push fails both of its tries
    const restore=setEnv({...notifyEnv(root,api.url),LONG_TASK_PUSH_RETRY_MS:'40',LONG_TASK_NOTIFY_DISABLE:undefined,LONG_TASK_TEMP_ROOT:undefined});
    try{
      const pending=require(dir+'/pending-decisions.cjs');
      ledger(run,[open('k1','第一題',iso(1000)),open('k2','第二題',iso(1000)),delegated('d1','逾時要多久？',iso(1000))]);
      const failed=await pending.pushOpen(run,{title:'監督'});
      assert.equal(failed.ok,false);assert.equal(api.messages.length,2);
      assert.equal(pending.pushProblem(run).key,failed.key,'the failure is on record for the dashboard and status');
      assert.equal((await pending.pushOpen(run,{title:'監督'})).skipped,true,'no retry inside the wait (10 minutes; 40 ms here)');
      assert.equal(api.messages.length,2);
      await new Promise(resolve=>setTimeout(resolve,60));
      const retried=await pending.pushOpen(run,{title:'監督'});
      assert.equal(retried.ok,true);assert.match(retried.key,/-r1$/);assert.equal(pending.pushProblem(run),null);
      assert.match(api.messages.at(-1).text,/第一題[\s\S]*第二題[\s\S]*逾時要多久？/);
      assert.equal((await pending.pushOpen(run,{title:'監督'})).reason,'already_pushed');
      // Jay answers k1: k2 went out already, so nothing is pushed again.
      const items=read(path.join(run,'pending-decisions.json')).items;items[0].status='answered';ledger(run,items);
      assert.equal((await pending.pushOpen(run,{title:'監督'})).reason,'already_pushed');
      // A new question goes out with the one still open; the delegated decision was listed once already.
      ledger(run,[...items,open('k3','第三題',iso(5000))]);
      assert.equal((await pending.pushOpen(run,{title:'監督'})).ok,true);
      const body=api.messages.at(-1).text;
      assert.match(body,/有 2 題/);assert.ok(body.includes('第二題')&&body.includes('第三題')&&!body.includes('第一題'));
      assert.ok(!body.includes('逾時要多久？'),'a delegated decision is listed once');
      // A changed question counts as new.
      const changed=read(path.join(run,'pending-decisions.json')).items,second=changed.find(item=>item.key==='k2');
      Object.assign(second,{ask:'第二題（改）',updatedAt:iso(9000)});ledger(run,changed);
      assert.equal((await pending.pushOpen(run,{title:'監督'})).ok,true);
      assert.equal(api.messages.filter(message=>message.ok).length,3);
    }finally{restore();await api.close();fs.rmSync(root,{recursive:true,force:true});}
  });

  test(platform+': the off switch quiets only test runs; a real run still reaches Jay and records that the switch was ignored',async()=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'v120-disable-')),api=await telegram();
    const restore=setEnv({...notifyEnv(root,api.url),LONG_TASK_NOTIFY_DISABLE:'1',LONG_TASK_TEMP_ROOT:undefined});
    try{
      const notify=require(dir+'/notify.cjs');
      const quiet=await notify.sendOnce(root,'test-run','【測試】不應送出');
      assert.equal(quiet.ok,false);assert.match(quiet.error,/test run/);assert.equal(api.messages.length,0);
      // Outside the temp folder a run is real (the temp root is pointed elsewhere for this test only).
      const elsewhere=path.join(root,'elsewhere');fs.mkdirSync(elsewhere);process.env.LONG_TASK_TEMP_ROOT=elsewhere;
      const real=await notify.sendOnce(root,'real-run','【開發任務需要你決定】一題');
      assert.equal(real.ok,true);assert.equal(real.disableIgnored,true);assert.equal(api.messages.length,1);
      assert.equal(notify.mark(root,'item-k1-x',{includedIn:'real-run'}),true);assert.equal(notify.mark(root,'item-k1-x'),false,'a mark is written once');
      assert.equal(notify.sent(root,'item-k1-x').includedIn,'real-run');
    }finally{restore();await api.close();fs.rmSync(root,{recursive:true,force:true});}
  });

  test(platform+': the dashboard shows a push that did not get through and every decision the supervisor made for Jay',()=>{
    const dashboard=require(dir+'/dashboard.cjs');
    const decided=[{key:'d1',ask:'逾時要多久？',choice:'10 分鐘',basis:'能自動就不加人工關卡',revert:'改回 30 分鐘',at:iso(0)}];
    const args={binding:{executorId:'e',supervisorId:'s'},state:{},snapshot:null,paced:{packages:[]},alive:true,hold:true,paused:false,
      ...(platform==='codex'?{ledger:{open:[],delegated:decided}}:{pendingDecisions:{open:[],delegated:decided}}),
      pushProblem:{key:'questions-x',at:iso(0),error:'HTTP 502 bad gateway'}};
    const page=dashboard.render(args);
    assert.match(page,/題目推播到你手機：.*沒送出（HTTP 502 bad gateway）；每 10 分鐘自動重試/);
    assert.match(page,/## 監督已代決（1 項）[\s\S]*\| 逾時要多久？ \| 10 分鐘 \| 能自動就不加人工關卡 \| 改回 30 分鐘 \|/);
    assert.match(dashboard.render({...args,pushProblem:null}),/題目推播到你手機：沒有失敗/);
  });
}

test('the subagent reminder names runs above the default once, on either route, and leaves old runs alone',()=>{
  const {modelReminder}=require(codex+'/execution-wake.cjs');
  const now=Date.now(),run=(id,model,effort,ago=60000)=>({id,model,effort,startedAt:now-ago});
  assert.equal(modelReminder([run('a','anthropic/claude-sonnet-5-5','medium')],{mainModel:opus,now}),null,'Sonnet at Medium is the default');
  const found=modelReminder([run('a',opus,'xhigh'),run('b',opus,'xhigh'),run('c','anthropic/claude-sonnet-5-5','high'),run('d','anthropic/claude-sonnet-5-5','low')],{mainModel:opus,now});
  assert.deepEqual(found.ids,['a','b','c']);
  assert.match(found.text,/^子代理模型提醒：最近 3 個子代理高於技能預設（Sonnet／Medium，介面 Sonnet／Low）：anthropic\/claude-opus-5-5／xhigh ×2、anthropic\/claude-sonnet-5-5／high ×1。/);
  assert.match(found.text,/每次派工都明確寫出模型/);
  assert.equal(modelReminder([run('a',opus,'xhigh')],{mainModel:opus,reported:['a'],now}),null,'a subagent is named once');
  assert.equal(modelReminder([run('old',opus,'xhigh',4*3600000)],{mainModel:opus,now}),null,'runs from before a restart are not raised again');
  // OpenAI route: Terra or Sol at Medium is the default, so a model choice there is not flagged; effort above Medium is.
  assert.equal(modelReminder([run('t','gpt-5.6-terra','medium'),run('s','gpt-5.6-sol','medium')],{mainModel:'gpt-6.1-sol',now}),null);
  assert.match(modelReminder([run('x','gpt-5.6-terra','high')],{mainModel:'gpt-6.1-sol',now}).text,/（Medium）/);
  // Claude Code logs no effort, so an Opus subagent is named by its model alone.
  assert.deepEqual(modelReminder([run('o','claude-opus-5-5',undefined)],{mainModel:'claude',now}).ids,['o']);
});

test('codex: full access is approval never with the full-access sandbox, as the executor log records it',()=>{
  const fallback=require(codex+'/model-fallback.cjs');
  assert.equal(fallback.fullAccess(null),null,'nothing read yet is not a reason to ask');
  assert.equal(fallback.fullAccess({approvalPolicy:'never',sandbox:'danger-full-access'}),true);
  assert.equal(fallback.fullAccess({approvalPolicy:'on-request',sandbox:'danger-full-access'}),false,'OPS ran like this under auto review 11/05-11/08');
  assert.equal(fallback.fullAccess({approvalPolicy:'never',sandbox:'workspace-write'}),false);
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'v120-access-')),restore=setEnv({CODEX_HOME:root});
  try{
    const now=new Date(),day=path.join(root,'sessions',String(now.getFullYear()),String(now.getMonth()+1).padStart(2,'0'),String(now.getDate()).padStart(2,'0'));
    fs.mkdirSync(day,{recursive:true});const log=path.join(day,'rollout-t-exec-access.jsonl');
    line(log,{timestamp:iso(Date.now()),type:'session_meta',payload:{id:'exec-access'}});
    line(log,{timestamp:iso(Date.now()),type:'turn_context',payload:{model:opus,effort:'xhigh',approval_policy:'never',approvals_reviewer:'user',sandbox_policy:{type:'danger-full-access'}}});
    const settings=fallback.settingsOf('exec-access');
    assert.equal(settings.sandbox,'danger-full-access');assert.equal(fallback.fullAccess(settings),true);
  }finally{restore();fs.rmSync(root,{recursive:true,force:true});}
});

// A running Codex watcher against the mock App, as in the v1.1.4 tests.
function codexFixture({finals}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'v120-codex-'));
  const home=path.join(root,'codex-home'),source=path.join(root,'source.txt');fs.writeFileSync(source,'Keep work moving\n');
  const contract={goal:'Finish',authorization:'Isolated QA',criteria:[{id:'A1',requirement:'Keep work moving',source:'source.txt:1',verify:'Replay'}],sources:[{path:source,sha256:sha(source)}]};
  const run=path.join(root,'run');fs.mkdirSync(run);save(path.join(run,'contract.json'),contract);
  const binding={platform:'codex',projectRoot:root,allowedRoots:[root,run],supervisorId:'supervisor-qa',executorId:'executor-qa',callerTurnId:'supervisor-turn',
    contractSha256:sha(path.join(run,'contract.json')),createdAt:iso(Date.now()-60000)};
  save(path.join(run,'binding.json'),binding);
  save(path.join(run,'daemon-state.json'),{phase:'starting',cursor:null,seen:[],messages:[],pending:null,inflight:null,reads:0,starts:0,
    lastExecutorActivityAt:Date.now(),lastProgressReviewAt:Date.now()});
  const now=new Date(),sessions=path.join(home,'sessions',String(now.getFullYear()),String(now.getMonth()+1).padStart(2,'0'),String(now.getDate()).padStart(2,'0'));
  fs.mkdirSync(sessions,{recursive:true});
  const executorLog=path.join(sessions,'rollout-t-executor-qa.jsonl');
  line(executorLog,{timestamp:binding.createdAt,type:'session_meta',payload:{id:'executor-qa'}});
  line(executorLog,{timestamp:binding.createdAt,type:'turn_context',payload:{model:opus,effort:'high',approval_policy:'never',approvals_reviewer:'user',sandbox_policy:{type:'danger-full-access'}}});
  const sent=path.join(root,'sent.json'),mockFile=path.join(root,'mock.json'),usage=path.join(root,'usage.jsonl');
  fs.writeFileSync(usage,JSON.stringify({conversationId:'unrelated',status:200})+'\n');
  save(mockFile,{supervisorId:binding.supervisorId,executorId:binding.executorId,...(finals?{finals}:{noTurn:true})});
  const env={...process.env,CODEX_HOME:home,CODEX_APP_TOOLS_SERVER_PATH:path.join(__dirname,'mock-codex-app-server.cjs'),MOCK_CODEX_FIXTURE:mockFile,MOCK_CODEX_SENT:sent,
    OPENCODEX_USAGE_FILE:usage,OPENCODEX_QUOTA_FILE:path.join(root,'quota.json'),CHROME_RELAY_BIN:path.join(root,'no-relay'),CODEX_WATCH_IDLE_SLEEP_MS:'200'};
  delete env.CODEX_THREAD_ID;delete env.LONG_TASK_NOTIFY_DISABLE;delete env.LONG_TASK_TEMP_ROOT;
  let child;
  return {root,run,sessions,statePath:path.join(run,'daemon-state.json'),
    start(extra={}){child=spawn(process.execPath,[path.join(codex,'native-watch.cjs'),run],{env:{...env,...extra},stdio:['ignore','pipe','pipe']});return child;},
    calls(){const file=sent+'.args.json';return fs.existsSync(file)?read(file):[];},
    async stop(){if(child?.exitCode===null){child.kill('SIGTERM');await new Promise(resolve=>child.once('exit',resolve));}fs.rmSync(root,{recursive:true,force:true});}};
}

test('codex: the watcher pushes the open questions once the supervisor has finished, and only once',async()=>{
  const f=codexFixture(),api=await telegram();
  try{
    ledger(f.run,[open('k1','R24 要不要列為已知缺口？',iso(Date.now()))]);
    f.start(notifyEnv(f.root,api.url));
    await until(()=>api.messages.length===1);
    assert.match(api.messages[0].text,/有 1 題要你回答：[\s\S]*1\. R24 要不要列為已知缺口？[\s\S]*建議：A 照原條文驗/);
    await until(()=>read(f.statePath).reads>=3);
    assert.equal(api.messages.length,1,'later reads do not push the same question again');
  }finally{await f.stop();await api.close();}
});

test('codex: a subagent above the default is named once at the end of the next message to the executor',async()=>{
  const f=codexFixture({finals:['LONG_TASK_EVENT {"kind":"progress","nextAction":"run the B6 checks"}']});
  try{
    // A subagent of this executor that ran on the main line's Opus at xhigh because its dispatch named no model.
    const sub=path.join(f.sessions,'rollout-t-sub-1.jsonl');
    line(sub,{timestamp:iso(Date.now()-30000),type:'session_meta',payload:{id:'sub-1',thread_source:'subagent',parent_thread_id:'executor-qa'}});
    line(sub,{timestamp:iso(Date.now()-30000),type:'turn_context',payload:{model:opus,effort:'xhigh'}});
    f.start();
    await until(()=>f.calls().some(call=>call.prompt.includes('run the B6 checks')));
    const sent=f.calls().find(call=>call.prompt.includes('run the B6 checks'));
    assert.match(sent.prompt,/全面加速[\s\S]*\n\n子代理模型提醒：最近 1 個子代理高於技能預設（Sonnet／Medium，介面 Sonnet／Low）：anthropic\/claude-opus-5-5／xhigh ×1。/);
    await until(()=>(read(f.statePath).modelReminded||[]).includes('sub-1'));
  }finally{await f.stop();}
});

test('claude: the receiver pushes the open questions once it is remounted after the event',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'v120-claude-')),api=await telegram();
  const project=path.join(root,'claude-config','projects','qa');fs.mkdirSync(project,{recursive:true});
  const source=path.join(root,'source.md');fs.writeFileSync(source,'QA criterion\n');
  const supervisorId=crypto.randomUUID(),executorId=crypto.randomUUID(),marker='LONG_TASK_BIND:'+crypto.randomUUID();
  line(path.join(project,supervisorId+'.jsonl'),{type:'user',sessionId:supervisorId,cwd:root,entrypoint:'claude-desktop'});
  line(path.join(project,executorId+'.jsonl'),{type:'user',sessionId:executorId,cwd:root,entrypoint:'claude-desktop',message:{content:[{type:'text',text:marker+' test'}]}});
  const input=path.join(root,'input.json'),run=path.join(root,'run');
  save(input,{dispatchAudit:false,loginSites:[],projectRoot:root,allowedRoots:[root],supervisorId,supervisorDesktopId:'local_'+crypto.randomUUID(),executorId,
    executorDesktopId:'local_'+crypto.randomUUID(),executorMarker:marker,executorPrompt:marker+' test',contract:{goal:'Test',authorization:'Isolated QA',
      criteria:[{id:'A1',requirement:'Valid event',source:'source.md:1',verify:'Read transcript'}],sources:[{path:source,sha256:sha(source)}]}});
  const env={...process.env,...notifyEnv(root,api.url),CLAUDE_WATCH_SETTLE_MS:'600',CLAUDE_CONFIG_DIR:path.join(root,'claude-config'),CLAUDE_SESSION_ID:supervisorId};
  delete env.LONG_TASK_NOTIFY_DISABLE;delete env.LONG_TASK_TEMP_ROOT;
  execFileSync(process.execPath,[path.join(claude,'supervise.cjs'),'init',run,input],{env});
  ledger(run,[open('k1','R24 要不要列為已知缺口？',iso(Date.now()))]);
  const child=spawn(process.execPath,[path.join(claude,'claude-watch.cjs'),run],{env,stdio:['ignore','pipe','pipe']});
  try{
    await until(()=>api.messages.length===1);
    assert.match(api.messages[0].text,/有 1 題要你回答：[\s\S]*R24 要不要列為已知缺口？/);
  }finally{child.kill('SIGTERM');await api.close();fs.rmSync(root,{recursive:true,force:true});}
});
