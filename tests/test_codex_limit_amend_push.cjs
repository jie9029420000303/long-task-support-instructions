// v1.1.4 (Jay 2026-11-09「修」). What failed on WEB 2026-11-08/09, and what each test below pins:
// 23:14:23 the supervisor stopped its watcher to record an authorization, hit its usage limit six seconds later, and the
// run stayed unwatched until Jay said 繼續 at 01:01. The refusal said "Try again at 11:40 PM." but the watcher assumed five
// hours; back at 01:02 it read the old 23:14 refusal and moved a supervisor that worked again to the paid API key until
// 04:14. Jay also asked that every message to the executor push it to dispatch subagents at full speed.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawn,execFileSync}=require('node:child_process');
const scripts=process.env.CODEX_SUPERVISOR_SCRIPTS||path.resolve(__dirname,'../codex/.agents/skills/long-task-supervisor/scripts');
const fallback=require(path.join(scripts,'model-fallback.cjs'));
const {EXECUTOR_PUSH}=require(path.join(scripts,'execution-wake.cjs'));
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const save=(file,value)=>fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n');
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const line=(file,value)=>fs.appendFileSync(file,JSON.stringify(value)+'\n');
const iso=ms=>new Date(ms).toISOString();
const opus='anthropic/claude-opus-5-5',paid='anthropic-apikey/claude-opus-5-5';
async function until(check,ms=20000){const end=Date.now()+ms;while(Date.now()<end){if(check())return;await new Promise(resolve=>setTimeout(resolve,50));}throw Error('Timed out');}
function withEnv(values,fn){
  const old=Object.fromEntries(Object.keys(values).map(key=>[key,process.env[key]]));Object.assign(process.env,values);
  try{return fn();}finally{for(const [key,value] of Object.entries(old))if(value===undefined)delete process.env[key];else process.env[key]=value;}
}
function scratch(){return fs.mkdtempSync(path.join(os.tmpdir(),'codex-v114-unit-'));}
function today(home){
  const now=new Date(),dir=path.join(home,'sessions',String(now.getFullYear()),String(now.getMonth()+1).padStart(2,'0'),String(now.getDate()).padStart(2,'0'));
  fs.mkdirSync(dir,{recursive:true});return dir;
}
// A local clock time the way the platform writes it in a usage-limit error.
const clock12=ms=>{const d=new Date(ms),h=d.getHours();return (h%12||12)+':'+String(d.getMinutes()).padStart(2,'0')+' '+(h<12?'AM':'PM');};
function fixture({executorModel=opus,supervisorModel=null,finals,state={},usageRows=[]}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'codex-v114-'));
  const home=path.join(root,'codex-home'),source=path.join(root,'source.txt');fs.writeFileSync(source,'Push the release branch whenever tests pass\n');
  const contract={goal:'Finish',authorization:'Isolated QA',criteria:[{id:'A1',requirement:'Keep work moving',source:'source.txt:1',verify:'Replay'}],sources:[{path:source,sha256:sha(source)}]};
  const run=path.join(root,'run');fs.mkdirSync(run);save(path.join(run,'contract.json'),contract);
  const binding={platform:'codex',projectRoot:root,allowedRoots:[root,run],supervisorId:'supervisor-qa',executorId:'executor-qa',callerTurnId:'supervisor-turn',
    contractSha256:sha(path.join(run,'contract.json')),createdAt:iso(Date.now()-60000)};
  save(path.join(run,'binding.json'),binding);
  save(path.join(run,'daemon-state.json'),{phase:'starting',cursor:null,seen:[],messages:[],pending:null,inflight:null,reads:0,starts:0,
    lastExecutorActivityAt:Date.now(),lastProgressReviewAt:Date.now(),...state});
  const settings=model=>({model,effort:'high',approval_policy:'never',approvals_reviewer:'user'});
  const executorLog=path.join(today(home),'rollout-t-executor-qa.jsonl');
  line(executorLog,{timestamp:binding.createdAt,type:'session_meta',payload:{id:'executor-qa'}});
  line(executorLog,{timestamp:binding.createdAt,type:'turn_context',payload:settings(executorModel)});
  if(supervisorModel){
    const log=path.join(today(home),'rollout-t-supervisor-qa.jsonl');
    line(log,{timestamp:binding.createdAt,type:'session_meta',payload:{id:'supervisor-qa'}});line(log,{timestamp:binding.createdAt,type:'turn_context',payload:settings(supervisorModel)});
  }
  const sent=path.join(root,'sent.json'),mockFile=path.join(root,'mock.json'),usage=path.join(root,'usage.jsonl'),quota=path.join(root,'quota.json');
  fs.writeFileSync(usage,JSON.stringify({conversationId:'unrelated',status:200})+'\n');for(const row of usageRows)line(usage,row);
  save(mockFile,{supervisorId:binding.supervisorId,executorId:binding.executorId,...(finals?{finals}:{noTurn:true})});
  const env={...process.env,CODEX_HOME:home,CODEX_APP_TOOLS_SERVER_PATH:path.join(__dirname,'mock-codex-app-server.cjs'),MOCK_CODEX_FIXTURE:mockFile,MOCK_CODEX_SENT:sent,
    OPENCODEX_USAGE_FILE:usage,OPENCODEX_QUOTA_FILE:quota,CHROME_RELAY_BIN:path.join(root,'no-relay'),CODEX_WATCH_IDLE_SLEEP_MS:'200'};
  delete env.CODEX_THREAD_ID;
  let child;
  const grant=id=>{
    const file=path.join(root,'amend-'+id+'.json');
    save(file,{id,contractSha256:binding.contractSha256,authority:{role:'user',quote:'Push the release branch whenever tests pass',at:iso(Date.now()),locator:'supervisor chat',
      source:{path:source,sha256:sha(source)}},changes:[{action:'authorization',id:'push-'+id,scope:'release branch push',instruction:'Push the release branch whenever tests pass'}]});
    return file;
  };
  return {root,run,binding,executorLog,env,statePath:path.join(run,'daemon-state.json'),grant,
    supervise:(args,extra={})=>execFileSync(process.execPath,[path.join(scripts,'supervise.cjs'),...args],{env:{...env,...extra},encoding:'utf8',stdio:['ignore','pipe','pipe']}),
    start(){child=spawn(process.execPath,[path.join(scripts,'native-watch.cjs'),run],{env,stdio:['ignore','pipe','pipe']});return child;},
    calls(){const file=sent+'.args.json';return fs.existsSync(file)?read(file):[];},
    refuse(threadId,model,at=Date.now()){line(usage,{timestamp:at,conversationId:fallback.hashId(threadId),requestedModel:model,status:429,errorCode:'usage_limit_reached'});},
    journal(){const file=path.join(run,'contract-amendments.jsonl');return fs.existsSync(file)?fs.readFileSync(file,'utf8').trim().split('\n').map(text=>JSON.parse(text).id):[];},
    async stop(){if(child?.exitCode===null){child.kill('SIGTERM');await new Promise(resolve=>child.once('exit',resolve));}fs.rmSync(root,{recursive:true,force:true});}};
}

test('the reset named in a refusal is read in both real formats, including a time that falls on the next day',()=>{
  const at=(y,m,d,h,mi)=>new Date(y,m-1,d,h,mi).getTime();
  assert.equal(fallback.retryAt("You've hit your usage limit. Try again at 11:40 PM.",at(2026,11,8,23,14)),at(2026,11,8,23,40),'WEB 23:14: back at 23:40, not five hours later');
  assert.equal(fallback.retryAt("You've hit your usage limit. Try again at Nov 10th, 2026 9:32 AM.",at(2026,11,9,1,2)),at(2026,11,10,9,32));
  assert.equal(fallback.retryAt("You've hit your usage limit. Try again at 12:05 AM.",at(2026,11,8,23,50)),at(2026,11,9,0,5),'a clock time before the refusal is the next day');
  assert.equal(fallback.retryAt('Please try again later.',at(2026,11,8,23,14)),null,'no named time falls back to the other sources');
});

test('the refused turn\'s own error wins over the quota cache and the five-hour guess; older errors and tool output do not count',()=>{
  const root=scratch(),rollout=path.join(root,'rollout.jsonl'),quota=path.join(root,'quota.json');
  try{
    const since=new Date(2026,10,8,23,14,26).getTime();
    line(rollout,{timestamp:iso(since-10*60000),type:'event_msg',payload:{type:'error',message:"You've hit your usage limit. Try again at 9:00 PM."}});
    line(rollout,{timestamp:iso(since+1000),type:'response_item',payload:{type:'function_call_output',event_msg:'quoted',output:"You've hit your usage limit. Try again at 8:00 PM."}});
    line(rollout,{timestamp:iso(since+3000),type:'event_msg',payload:{type:'task_complete',error:{message:"You've hit your usage limit. Try again at 11:40 PM."}}});
    save(quota,{version:1,rows:{['anthropic\u0000a']:{fiveHourPercent:100,fiveHourResetAt:since+2*3600000}}});
    withEnv({OPENCODEX_QUOTA_FILE:quota},()=>{
      const reset=fallback.resetFor('anthropic/',since,[rollout]);
      assert.equal(reset.until,new Date(2026,10,8,23,40).getTime());assert.equal(reset.fromError,true);assert.match(reset.basis,/錯誤訊息/);
      assert.equal(fallback.resetFor('anthropic/',since,[]).until,since+2*3600000,'without the error the quota cache comes next');
      assert.equal(fallback.resetFor('anthropic-apikey/',since,[]).until,since+fallback.FALLBACK_MS,'five hours only when nothing names the reset');
    });
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('a refusal already followed by a success is history on every read, and each route remembers when it last worked',()=>{
  const root=scratch(),usage=path.join(root,'usage.jsonl'),threads=[{role:'supervisor',threadId:'supervisor-qa'}],state={},id=fallback.hashId('supervisor-qa');
  try{
    fs.writeFileSync(usage,JSON.stringify({conversationId:'unrelated',status:200})+'\n');
    withEnv({OPENCODEX_USAGE_FILE:usage},()=>{
      assert.deepEqual(fallback.scan(state,threads),[]);
      const now=Date.now();
      line(usage,{timestamp:now-2*3600000,conversationId:id,requestedModel:opus,status:429,errorCode:'usage_limit_reached'});
      line(usage,{timestamp:now-60000,conversationId:id,requestedModel:opus,status:200});
      assert.deepEqual(fallback.scan(state,threads),[],'WEB 01:02: a refusal read after the supervisor worked again is not a live limit');
      assert.equal(state.routeOk['anthropic/'],now-60000);assert.equal(state.routeRefused['anthropic/'],now-2*3600000);
      line(usage,{timestamp:now,conversationId:id,requestedModel:opus,status:429,errorCode:'usage_limit_reached'});
      const hits=fallback.scan(state,threads);
      assert.equal(hits.length,1,'a refusal that is still the latest request is live');assert.equal(hits[0].at,now);
    });
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('a route that serves requests again ends its limit early, but only after ten quiet minutes and a success since the limit',()=>{
  const now=Date.now(),since=now-30*60000;
  const limited=extra=>({rateLimits:{'anthropic/':{since,until:now+4*3600000,model:opus}},modelSwitch:{s:{original:opus,current:paid,since,until:now+4*3600000,restored:null}},...extra});
  const recent=limited({routeRefused:{'anthropic/':now-5*60000},routeOk:{'anthropic/':now-60000}});
  assert.equal(fallback.recovered(recent,now),false,'refused five minutes ago: one chat\'s success could otherwise bounce another back and forth');
  const quiet=limited({routeRefused:{'anthropic/':now-15*60000},routeOk:{'anthropic/':now-60000}});
  assert.equal(fallback.recovered(quiet,now),true);
  assert.equal(quiet.rateLimits['anthropic/'].until,now);assert.equal(quiet.modelSwitch.s.until,now,'the switched chat is due to return now, not at a guessed 04:14');
  const before=limited({routeRefused:{'anthropic/':now-40*60000},routeOk:{'anthropic/':since-60000}});
  assert.equal(fallback.recovered(before,now),false,'a success from before the limit proves nothing');
});

test('an authorization reaches the effective contract through the running watcher, which keeps watching',async()=>{
  const f=fixture();
  try{
    const direct=JSON.parse(f.supervise(['amend',f.run,f.grant('before-watch')]));
    assert.equal(direct.recorded,true);assert.equal(direct.recordedBy,undefined,'without a watcher the supervisor still records directly');
    const child=f.start();
    await until(()=>read(f.statePath).reads>=2);
    const owner=read(path.join(f.run,'watcher.lock')).pid;
    const result=JSON.parse(f.supervise(['amend',f.run,f.grant('while-watching')]));
    assert.equal(result.recorded,true);assert.equal(result.recordedBy,'watcher');
    assert.equal(child.exitCode,null,'nothing stopped the watcher (WEB 23:14: stopping it left the run unwatched for 1 h 47 min)');
    assert.equal(read(path.join(f.run,'watcher.lock')).pid,owner);
    assert.deepEqual(f.journal(),['before-watch','while-watching']);
    assert.equal(read(path.join(f.run,'binding.json')).contractStateSha256,sha(path.join(f.run,'contract-amendments.jsonl')));
    assert.equal(fs.existsSync(path.join(f.run,'amend-request.json')),false);
    const reads=read(f.statePath).reads;
    await until(()=>read(f.statePath).reads>=reads+3);
    assert.equal(child.exitCode,null,'it keeps watching on the new contract state');
    assert.ok(!f.calls().some(call=>/LONG_TASK_AMEND/.test(call.prompt)),'the requester got the result itself: no extra supervisor turn');
  }finally{await f.stop();}
});

test('an authorization that cannot be recorded at once is queued, recorded after the dispatch writer, and announced to the supervisor',async()=>{
  const f=fixture();
  try{
    const child=f.start();
    await until(()=>read(f.statePath).reads>=2);
    save(path.join(f.run,'dispatch-write.lock'),{pid:process.pid});
    const queued=JSON.parse(f.supervise(['amend',f.run,f.grant('queued')],{LONG_TASK_AMEND_WAIT_MS:'1500'}));
    assert.equal(queued.queued,true);
    assert.throws(()=>f.supervise(['amend',f.run,f.grant('second')],{LONG_TASK_AMEND_WAIT_MS:'500'}),/has not recorded the previous authorization/,'one request at a time, never overwritten');
    assert.deepEqual(f.journal(),[],'nothing is written while another writer holds the run');
    fs.unlinkSync(path.join(f.run,'dispatch-write.lock'));
    await until(()=>f.calls().some(call=>call.threadId==='supervisor-qa'&&/LONG_TASK_AMEND_RECORDED/.test(call.prompt)));
    assert.deepEqual(f.journal(),['queued']);
    assert.ok(!f.calls().find(call=>/LONG_TASK_AMEND_RECORDED/.test(call.prompt)).prompt.includes(EXECUTOR_PUSH),'the push is for the executor only');
    assert.equal(child.exitCode,null);
  }finally{await f.stop();}
});

test('a refusal whose named reset already passed keeps the model and continues the stopped chat at once',async()=>{
  const f=fixture();
  try{
    const refusedAt=Date.now()-10*60000,reset=Date.now()-4*60000;
    line(f.executorLog,{timestamp:iso(refusedAt+3000),type:'event_msg',payload:{type:'task_complete',error:{message:"You've hit your usage limit. Try again at "+clock12(reset)+'.'}}});
    f.start();
    await until(()=>read(f.statePath).usageOffset!==undefined);
    f.refuse('executor-qa',opus,refusedAt);
    await until(()=>f.calls().some(call=>/已過/.test(call.prompt)));
    const resume=f.calls().find(call=>/已過/.test(call.prompt));
    assert.equal(resume.threadId,'executor-qa');assert.equal(resume.model,opus,'no move to the paid key for a limit that is over');
    assert.ok(resume.prompt.includes('\n\n'+EXECUTOR_PUSH+'\n'));assert.match(resume.prompt.split('\n').at(-1),/^背景程式送出時間（台北）：\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    assert.ok(!f.calls().some(call=>call.model===paid));
    assert.equal(read(f.statePath).rateLimits['anthropic/'].fromError,true);
  }finally{await f.stop();}
});

test('a refusal for a model the chat already left is ignored, but a chat back on that model is switched again',async()=>{
  const record={role:'executor',original:opus,current:paid,effort:'high',since:Date.now()-60000,until:Date.now()+3600000,restored:null};
  const stale=fixture({executorModel:paid,state:{modelSwitch:{'executor-qa':{...record}}}});
  const back=fixture({executorModel:opus,state:{modelSwitch:{'executor-qa':{...record}}}});
  try{
    stale.start();back.start();
    await until(()=>read(stale.statePath).usageOffset!==undefined&&read(back.statePath).usageOffset!==undefined);
    stale.refuse('executor-qa',opus);back.refuse('executor-qa',opus);
    await until(()=>back.calls().some(call=>call.model===paid));
    const again=back.calls().find(call=>call.model===paid);
    assert.equal(again.threadId,'executor-qa');assert.match(again.prompt,/額度限速/);
    assert.equal(read(back.statePath).modelSwitch['executor-qa'].current,paid);
    await until(()=>read(stale.statePath).rateLimits?.['anthropic/']&&!(read(stale.statePath).switchQueue||[]).length);
    assert.ok(!stale.calls().some(call=>call.model),'the chat already runs the paid key: nothing to switch');
  }finally{await stale.stop();await back.stop();}
});

test('a supervisor moved to the paid key gets its model back once its route works again, without waiting for an event',async()=>{
  const now=Date.now(),since=now-30*60000,other=fallback.hashId('other-chat');
  const record={role:'supervisor',original:opus,current:paid,effort:'high',since,until:now+4*3600000,restored:null};
  const usageRows=[{timestamp:now-20*60000,conversationId:other,requestedModel:opus,status:429},{timestamp:now-60000,conversationId:other,requestedModel:opus,status:200}];
  // The 01:02 state: a five-hour guess, saved by v1.1.3 without the refused thread's rollout.
  const state={modelSwitch:{'supervisor-qa':record},rateLimits:{'anthropic/':{since,until:now+4*3600000,model:opus,basis:'查不到額度重置時間，用 5 小時'}}};
  const f=fixture({supervisorModel:paid,state,usageRows});
  try{
    f.start();
    await until(()=>f.calls().some(call=>/LONG_TASK_MODEL_RESTORED/.test(call.prompt)));
    const restore=f.calls().find(call=>/LONG_TASK_MODEL_RESTORED/.test(call.prompt));
    assert.equal(restore.threadId,'supervisor-qa');assert.equal(restore.model,opus);assert.equal(restore.thinking,'high');
    assert.ok(!restore.prompt.includes(EXECUTOR_PUSH));
    await until(()=>read(f.statePath).modelSwitch['supervisor-qa'].restored);
    assert.deepEqual(read(path.join(f.run,'model-fallback.json')).limits,{},'subagents stop avoiding a route that works');
  }finally{await f.stop();}
  const g=fixture({supervisorModel:opus,state:{modelSwitch:{'supervisor-qa':{...record,until:now-1000}}}});
  try{
    g.start();
    await until(()=>read(g.statePath).modelSwitch['supervisor-qa'].restored);
    assert.equal(read(g.statePath).modelSwitch['supervisor-qa'].restoredBy,'already-on-original');
    assert.ok(!g.calls().some(call=>/LONG_TASK_MODEL_RESTORED/.test(call.prompt)),'already back on its model: no extra turn');
  }finally{await g.stop();}
});

test('every message to the executor carries the full-speed push and ends with its Taipei send time; receipts keep the bare prompt and a paused run gets none',async()=>{
  assert.match(EXECUTOR_PUSH,/積極派工/);assert.match(EXECUTOR_PUSH,/子代理/);assert.match(EXECUTOR_PUSH,/暫停或停止/);
  const f=fixture({finals:['LONG_TASK_EVENT {"kind":"progress","nextAction":"run the B6 checks"}']});
  try{
    f.start();
    await until(()=>f.calls().some(call=>call.prompt.includes('run the B6 checks')));
    const sent=f.calls().find(call=>call.prompt.includes('run the B6 checks'));
    assert.equal(sent.threadId,'executor-qa');
    // Only the Taipei time the program read from the clock follows the push (Jay 2026-11-10); the receipt hash still covers the bare prompt.
    const tail='\n\n'+EXECUTOR_PUSH+'\n',at=sent.prompt.lastIndexOf(tail);
    assert.ok(at>0);assert.match(sent.prompt.slice(at+tail.length),/^背景程式送出時間（台北）：\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    const [marker,...rest]=sent.prompt.slice(0,at).split('\n'),key=marker.replace('LONG_TASK_DELIVERY:',''),bare=rest.join('\n');
    const receipt=path.join(f.run,'receipt-'+key+'.json');
    await until(()=>fs.existsSync(receipt)&&read(receipt).confirmed);
    assert.equal(read(receipt).promptSha256,crypto.createHash('sha256').update(bare).digest('hex'),'deliveries saved before the upgrade still reconcile');
  }finally{await f.stop();}
  const p=fixture();
  try{
    p.supervise(['pause',p.run,'先暫停，等我說繼續']);
    p.start();
    await until(()=>read(p.statePath).usageOffset!==undefined);
    p.refuse('executor-qa',opus);
    await until(()=>p.calls().some(call=>call.model===paid));
    assert.ok(!p.calls().find(call=>call.model===paid).prompt.includes(EXECUTOR_PUSH),'Jay paused the run: no push to dispatch more');
  }finally{await p.stop();}
});

