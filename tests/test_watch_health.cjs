// v0.34.0 (Jay 2026-10-29): a watch that stops working reaches Jay within 10 minutes through 「Jay的小秘書」, once per
// outage and once more when it recovers. Three earlier stalls (10-17, 10-18, 10-28) were each noticed hours later,
// about 18 hours of waiting in all. notify.cjs, watch-health.cjs and watch-guard.cjs are the same file on both
// platforms, so every check below runs against the Codex and the Claude copy.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const http=require('node:http');
const crypto=require('node:crypto');
const {spawn,spawnSync}=require('node:child_process');
const codex=path.resolve(__dirname,'../codex/.agents/skills/long-task-supervisor/scripts');
const claude=path.resolve(__dirname,'../claude-code/.claude/skills/long-task-supervisor/scripts');
const save=(file,value)=>fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n');
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const minutesAgo=minutes=>new Date(Date.now()-minutes*60000).toISOString();
async function until(check,ms=12000){const end=Date.now()+ms;while(Date.now()<end){if(await check())return;await new Promise(resolve=>setTimeout(resolve,50));}throw Error('Timed out');}

// A stand-in for api.telegram.org: records each sendMessage, and fails the first N when asked.
async function telegram({fail=0}={}){
  const messages=[];let failures=fail;
  const server=http.createServer((req,res)=>{let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{
    const ok=failures--<=0;messages.push({url:req.url,ok,...JSON.parse(body||'{}')});
    res.writeHead(ok?200:502,{'content-type':'application/json'});res.end(JSON.stringify(ok?{ok:true,result:{}}:{ok:false,description:'bad gateway'}));});});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {messages,url:'http://127.0.0.1:'+server.address().port,close:()=>new Promise(resolve=>server.close(resolve))};
}
function env(root,api){
  const config=path.join(root,'notify.json');
  save(config,{telegram:{keychainService:'qa.telegram',keychainAccount:'qa',chatId:'4242'}});
  return {LONG_TASK_HOME:path.join(root,'home'),LONG_TASK_NOTIFY_CONFIG:config,LONG_TASK_TELEGRAM_TOKEN:'123:qa-token',LONG_TASK_TELEGRAM_API:api,LONG_TASK_NOTIFY_RETRY_MS:'10'};
}
function fresh(dir){for(const name of ['notify.cjs','watch-health.cjs','watch-guard.cjs'])delete require.cache[path.join(dir,name)];return dir;}
const deadPid=()=>{const child=spawnSync(process.execPath,['-e','console.log(process.pid)'],{encoding:'utf8'});return Number(child.stdout.trim());};
function codexRun(root,state={},runtime=null){
  const run=path.join(root,'run');fs.mkdirSync(run,{recursive:true});
  save(path.join(run,'binding.json'),{platform:'codex',supervisorId:'supervisor-qa',executorId:'executor-qa',createdAt:minutesAgo(60)});
  save(path.join(run,'daemon-state.json'),{phase:'watching',threadTitles:{executor:'執行：開票分類',supervisor:'區分 Debug 與新功能需求'},...state});
  if(runtime)save(path.join(run,'runtime-state.json'),runtime);
  fs.writeFileSync(path.join(run,'監督儀表板.md'),'# 監督儀表板\n\n更新時間：—\n');
  return run;
}

for(const [platform,dir] of [['codex',codex],['claude',claude]]){
  test(platform+': a notice is pushed once per key, retried once, and a double failure is recorded',async()=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'notify-')),api=await telegram({fail:1});
    Object.assign(process.env,env(root,api.url));
    try{
      const notify=require(fresh(dir)+'/notify.cjs');
      const first=await notify.sendOnce(root,'outage-1','【測試】一則');
      assert.equal(first.ok,true);assert.equal(first.attempts,2,'one failure, one retry');
      const again=await notify.sendOnce(root,'outage-1','【測試】一則');
      assert.equal(again.skipped,true);assert.equal(api.messages.length,2);
      assert.equal(api.messages[1].chat_id,'4242');assert.equal(api.messages[1].reply_markup,undefined,'no buttons: another program reads this bot');
      assert.ok(!JSON.stringify(read(path.join(root,'notifications','outage-1.json'))).includes('qa-token'),'the token never lands in a run file');
      const down=await telegram({fail:9});process.env.LONG_TASK_TELEGRAM_API=down.url;
      const failed=await notify.sendOnce(root,'outage-2','【測試】二則');
      assert.equal(failed.ok,false);assert.equal(failed.attempts,2);assert.match(failed.error,/502/);
      await down.close();
    }finally{await api.close();fs.rmSync(root,{recursive:true,force:true});}
  });

  test(platform+': ten minutes of failed reads push Jay once, mark the dashboard, and the recovery pushes once more',async()=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'health-')),api=await telegram();
    Object.assign(process.env,env(root,api.url));
    try{
      const health=require(fresh(dir)+'/watch-health.cjs');
      const run=codexRun(root,{appHealth:{failingSince:minutesAgo(9),kind:'read',lastError:'read_thread: Codex app tool request failed'}},
        {pid:process.pid,heartbeatAt:new Date().toISOString()});
      assert.equal((await health.check(run)).open,null,'nine minutes is not yet an outage');assert.equal(api.messages.length,0);
      const state=read(path.join(run,'daemon-state.json'));state.appHealth.failingSince=minutesAgo(11);save(path.join(run,'daemon-state.json'),state);
      await health.check(run);await health.check(run);
      assert.equal(api.messages.length,1,'one push per outage, not one per check');
      assert.match(api.messages[0].text,/^【開發任務中止，需要開啟查看】『執行：開票分類』的背景監看已 11 分鐘讀不到執行對話。請打開 Codex 的監督對話『區分 Debug 與新功能需求』查看。$/);
      assert.match(fs.readFileSync(path.join(run,'監督儀表板.md'),'utf8'),/注意：背景監看從 .* 起沒在運作（讀不到執行對話.*已用小秘書推播通知你/);
      delete state.appHealth.failingSince;save(path.join(run,'daemon-state.json'),state);
      await health.check(run);await health.check(run);
      assert.equal(api.messages.length,2);assert.equal(api.messages[1].text,'【已恢復，不用處理】『執行：開票分類』的背景監看已恢復運作。');
      assert.doesNotMatch(fs.readFileSync(path.join(run,'監督儀表板.md'),'utf8'),/注意：背景監看/);
      assert.equal(read(path.join(run,'watch-health.json')).history.at(-1).closedBy,'recovered');
    }finally{await api.close();fs.rmSync(root,{recursive:true,force:true});}
  });

  test(platform+': a watcher whose whole parent is gone is reported after 10 minutes, a finished run never',async()=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'health-dead-')),api=await telegram();
    Object.assign(process.env,env(root,api.url));
    try{
      const health=require(fresh(dir)+'/watch-health.cjs'),pid=deadPid();
      const run=codexRun(root,{},{pid,heartbeatAt:minutesAgo(4),phase:'running'});
      assert.equal((await health.check(run)).outage,'watcher_dead');assert.equal(api.messages.length,0,'four minutes: the supervisor may be restarting it');
      save(path.join(run,'runtime-state.json'),{pid,heartbeatAt:minutesAgo(12),phase:'running'});
      await health.check(run);
      assert.equal(api.messages.length,1);assert.match(api.messages[0].text,/背景監看已停止約 12 分鐘，系統無法從 App 外重開。.*說「繼續」就會重新掛上。$/);
      fs.writeFileSync(path.join(run,'STOP'),'done');
      assert.equal((await health.check(run)).ended,true);assert.equal(api.messages.length,1,'a stopped run is not an outage and sends no recovery');
    }finally{await api.close();fs.rmSync(root,{recursive:true,force:true});}
  });

  test(platform+': a Claude receiver that exits after its handoff is not an outage; one gone while watching is',async()=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'health-claude-')),api=await telegram();
    Object.assign(process.env,env(root,api.url));
    try{
      const health=require(fresh(dir)+'/watch-health.cjs'),run=path.join(root,'run');fs.mkdirSync(run);
      save(path.join(run,'binding.json'),{platform:'claude-code',supervisorId:'s',executorId:'e'});
      save(path.join(run,'daemon-state.json'),{phase:'awaiting_decision',updatedAt:minutesAgo(30)});
      assert.equal((await health.check(run)).outage,null);
      save(path.join(run,'daemon-state.json'),{phase:'watching',pid:deadPid(),updatedAt:minutesAgo(15)});
      await health.check(run);
      assert.equal(api.messages.length,1);assert.match(api.messages[0].text,/請打開 Claude 的監督對話/);
    }finally{await api.close();fs.rmSync(root,{recursive:true,force:true});}
  });

  test(platform+': the guard checks registered runs and drops finished and missing ones',async()=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'guard-')),api=await telegram();
    Object.assign(process.env,env(root,api.url));
    try{
      const guard=require(fresh(dir)+'/watch-guard.cjs');
      const live=codexRun(path.join(root,'a'),{appHealth:{failingSince:minutesAgo(20),kind:'read',lastError:'x'}},{pid:process.pid,heartbeatAt:new Date().toISOString()});
      const done=codexRun(path.join(root,'b'),{phase:'accepted'});
      guard.register(live,{platform:'codex'});guard.register(done,{platform:'codex'});guard.register(path.join(root,'gone'),{platform:'codex'});
      assert.equal(guard.entries().length,3);
      const result=await guard.check();
      assert.equal(result.runs.find(item=>item.run===live).outage,'read_failing');
      assert.deepEqual(guard.entries().map(item=>item.run),[live]);assert.equal(api.messages.length,1);
      // Without its own registry a test run under the temp directory never reaches the real one.
      const outside=spawnSync(process.execPath,['-e','console.log(JSON.stringify(require('+JSON.stringify(dir+'/watch-guard.cjs')+').register('+JSON.stringify(live)+')))'],
        {encoding:'utf8',env:{...process.env,LONG_TASK_HOME:''}});
      assert.equal(outside.stdout.trim(),'null');
    }finally{await api.close();fs.rmSync(root,{recursive:true,force:true});}
  });

  test(platform+': questions put to Jay push once per batch, and test runs never reach a real phone',async()=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'pending-push-')),api=await telegram();
    Object.assign(process.env,env(root,api.url));
    try{
      fresh(dir);delete require.cache[path.join(dir,'pending-decisions.cjs')];
      const pending=require(dir+'/pending-decisions.cjs');
      const first=await pending.pushShown(root,{shown:['k2','k1'],at:'x'},'區分 Debug 與新功能需求');
      assert.equal(first.push.ok,true);
      assert.equal(api.messages[0].text,'【開發任務需要你決定】『區分 Debug 與新功能需求』有 2 題要你回答，請打開該監督對話查看。');
      assert.equal((await pending.pushShown(root,{shown:['k1','k2'],at:'y'},'區分 Debug 與新功能需求')).push.skipped,true,'the same batch is not pushed again');
      await pending.pushShown(root,{shown:['k1','k2','k3'],at:'z'},'區分 Debug 與新功能需求');
      assert.equal(api.messages.length,2);assert.match(api.messages[1].text,/有 3 題/);
      delete process.env.LONG_TASK_NOTIFY_CONFIG;
      const quiet=await require(dir+'/notify.cjs').sendOnce(root,'outage-x','【測試】不應送出');
      assert.equal(quiet.ok,false);assert.match(quiet.error,/test run/);assert.equal(api.messages.length,2);
    }finally{await api.close();fs.rmSync(root,{recursive:true,force:true});}
  });
}

test('codex: a second run-watch start leaves the live parent alone',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'run-watch-once-'));
  try{
    const run=codexRun(root,{},{pid:process.pid,heartbeatAt:new Date().toISOString(),phase:'running',launches:[]});
    const second=spawnSync(process.execPath,[path.join(codex,'run-watch.cjs'),run],{encoding:'utf8',timeout:10000,env:{...process.env,LONG_TASK_REGISTER:'0'}});
    assert.equal(second.status,0);assert.equal(JSON.parse(second.stdout).alreadyRunning,process.pid);
    assert.equal(read(path.join(run,'runtime-state.json')).pid,process.pid,'the live parent record is untouched');
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('codex: the watcher warns the supervisor chat once when it cannot watch for 10 minutes',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'watch-alert-')),source=path.join(root,'source.txt');fs.writeFileSync(source,'Keep watching\n');
  const run=path.join(root,'run');fs.mkdirSync(run);
  save(path.join(run,'contract.json'),{goal:'Watch',authorization:'Isolated QA',criteria:[{id:'A1',requirement:'Watch',source:'source.txt:1',verify:'Read'}],sources:[{path:source,sha256:sha(source)}]});
  save(path.join(run,'binding.json'),{platform:'codex',projectRoot:root,allowedRoots:[root,run],supervisorId:'supervisor-qa',executorId:'executor-qa',callerTurnId:'t',
    contractSha256:sha(path.join(run,'contract.json')),createdAt:new Date().toISOString()});
  save(path.join(run,'daemon-state.json'),{phase:'starting',cursor:null,seen:[],messages:[],pending:null,inflight:null,reads:0,starts:0,
    appHealth:{failingSince:minutesAgo(12),kind:'read',lastError:'read_thread: Codex app tool request failed'}});
  const mock=path.join(root,'mock.json'),sent=path.join(root,'sent.json'),errors=path.join(root,'read-errors');fs.writeFileSync(errors,'99');
  save(mock,{supervisorId:'supervisor-qa',executorId:'executor-qa',noTurn:true,readErrorFile:errors,readErrorMessage:'Permission denied'});
  const env={...process.env,CODEX_HOME:path.join(root,'codex-home'),CODEX_APP_TOOLS_SERVER_PATH:path.join(__dirname,'mock-codex-app-server.cjs'),MOCK_CODEX_FIXTURE:mock,MOCK_CODEX_SENT:sent,
    LONG_TASK_NOTIFY_DISABLE:'1',LONG_TASK_REGISTER:'0'};
  try{
    for(let round=0;round<2;round++){
      const child=spawn(process.execPath,[path.join(codex,'native-watch.cjs'),run],{env,stdio:'ignore'});
      await new Promise(resolve=>child.once('exit',resolve));
    }
    const sends=JSON.parse(fs.readFileSync(sent,'utf8'));
    assert.equal(sends.filter(text=>text.startsWith('LONG_TASK_WATCH_ALERT')).length,1,'one warning per outage across restarts');
    assert.match(sends[0],/背景監看已 1\d 分鐘沒在運作.*supervise\.cjs status/);
    const state=read(path.join(run,'daemon-state.json'));
    assert.equal(state.appHealth.warnedOk,true);assert.equal(state.phase,'error');
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
