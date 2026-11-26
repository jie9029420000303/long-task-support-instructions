// v1.16.0 (Jay 2026-11-25 Q13「A」). 工區 E: the watcher had switched the executor to Muse at 12:04; at 13:26 Jay set the
// chat to Opus by hand to get it working again. The watcher kept judging from its own switch record, which still said
// Muse, so neither the model order nor the Claude reserve (weekly 9.2%, below the 35% kept for the supervisor) looked at
// Opus, and the executor would have used the supervisor's Claude quota until the OpenAI pauses ended. What the test pins:
// a model chosen by hand after a switch is what the watcher judges from then on. v1.18.0 (Jay 2026-11-26 decisions 19
// and 24): the executor follows Opus subscription → Opus API → Sol …, and steps down four ladder steps after the
// subagents, so the same reading now moves a hand-picked Opus to the Opus API instead of to Sol.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const scripts=process.env.CODEX_SUPERVISOR_SCRIPTS||path.resolve(__dirname,'../codex/.agents/skills/long-task-supervisor/scripts');
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const save=(file,value)=>fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n');
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const line=(file,value)=>fs.appendFileSync(file,JSON.stringify(value)+'\n');
const iso=ms=>new Date(ms).toISOString();
const opus='anthropic/claude-opus-5-5',opusApi='anthropic-apikey/claude-opus-5-5',sonnet='anthropic/claude-sonnet-5-5',sol='gpt-6.10-sol';
const MINUTE=60000,HOUR=60*MINUTE,DAY=24*HOUR;
async function until(check,ms=15000){const end=Date.now()+ms;while(Date.now()<end){if(check())return;await new Promise(resolve=>setTimeout(resolve,50));}throw Error('Timed out');}
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
// Available share 19.8% (no stop lines): ladder step 5, so the executor keeps away from its first stop only.
const reading=now=>({accounts:[
  {provider:'anthropic',label:'max-20x',plan:'max_20x',paused:false,quota:{weeklyPercent:100,weeklyResetAt:now+2*DAY,fiveHourPercent:0,fiveHourResetAt:now+3*HOUR}},
  {provider:'anthropic',label:'max-5x',plan:'max_5x',paused:false,quota:{weeklyPercent:1,weeklyResetAt:now+5*DAY,fiveHourPercent:24,fiveHourResetAt:now+2*HOUR}},
  {provider:'openai',label:'not-claude',plan:'pro',paused:false,quota:{weeklyPercent:10,weeklyResetAt:now+DAY}}]});

// The watcher switched the executor from Sonnet to Sol two hours ago; a minute ago Jay set the chat to Opus by hand.
function fixture({handPicked=true,original=sonnet,current=sol}={}){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'codex-v1160-'))),now=Date.now();
  const home=path.join(root,'codex-home'),source=path.join(root,'source.txt');fs.writeFileSync(source,'Keep the work moving\n');
  const contract={goal:'Finish',authorization:'Isolated QA',criteria:[{id:'A1',requirement:'Keep work moving',source:'source.txt:1',verify:'Replay'}],sources:[{path:source,sha256:sha(source)}]};
  const run=path.join(root,'run');fs.mkdirSync(run);save(path.join(run,'contract.json'),contract);
  const binding={platform:'codex',projectRoot:root,allowedRoots:[root,run],supervisorId:'supervisor-qa',executorId:'executor-qa',callerTurnId:'supervisor-turn',
    contractSha256:sha(path.join(run,'contract.json')),createdAt:iso(now-3*HOUR),modelPolicy:'automatic'};
  save(path.join(run,'binding.json'),binding);
  const record={role:'executor',original,current,effort:'high',since:now-2*HOUR,until:now-HOUR,restored:null,respondedAt:now-2*HOUR+MINUTE,budgetOrigin:true};
  save(path.join(run,'daemon-state.json'),{phase:'starting',cursor:null,seen:[],messages:[],pending:null,inflight:null,reads:0,starts:0,
    lastExecutorActivityAt:now,lastProgressReviewAt:now,modelSwitch:{'executor-qa':record}});
  const day=new Date(),dir=path.join(home,'sessions',String(day.getFullYear()),String(day.getMonth()+1).padStart(2,'0'),String(day.getDate()).padStart(2,'0'));
  fs.mkdirSync(dir,{recursive:true});
  const log=id=>path.join(dir,'rollout-t-'+id+'.jsonl');
  line(log('supervisor-qa'),{timestamp:binding.createdAt,type:'session_meta',payload:{id:'supervisor-qa'}});
  line(log('supervisor-qa'),{timestamp:binding.createdAt,type:'turn_context',payload:{turn_id:'s-turn',model:opus,effort:'xhigh',approval_policy:'never'}});
  line(log('executor-qa'),{timestamp:binding.createdAt,type:'session_meta',payload:{id:'executor-qa'}});
  line(log('executor-qa'),{timestamp:iso(now-2*HOUR+MINUTE),type:'turn_context',payload:{turn_id:'sol-turn',model:current,effort:'high',approval_policy:'never'}});
  if(handPicked){
    line(log('executor-qa'),{timestamp:iso(now-MINUTE),type:'event_msg',payload:{type:'thread_settings_applied',thread_settings:{model:opus,approval_policy:'never'}}});
    line(log('executor-qa'),{timestamp:iso(now-MINUTE+5000),type:'turn_context',payload:{turn_id:'opus-turn',model:opus,effort:'high',approval_policy:'never'}});
  }
  const sent=path.join(root,'sent.json'),mockFile=path.join(root,'mock.json'),usage=path.join(root,'usage.jsonl'),quotaFile=path.join(root,'claude-quota.json');
  fs.writeFileSync(usage,JSON.stringify({conversationId:'unrelated',status:200})+'\n');
  save(quotaFile,reading(now));
  save(mockFile,{supervisorId:binding.supervisorId,executorId:binding.executorId,noTurn:true});
  const env={...process.env,CODEX_HOME:home,CODEX_APP_TOOLS_SERVER_PATH:path.join(__dirname,'mock-codex-app-server.cjs'),MOCK_CODEX_FIXTURE:mockFile,MOCK_CODEX_SENT:sent,
    OPENCODEX_MODEL_CATALOG:path.join(__dirname,'fixtures/model-routing-catalog.json'),OPENCODEX_USAGE_FILE:usage,OPENCODEX_QUOTA_FILE:path.join(root,'quota-cache.json'),
    OPENCODEX_HOME:path.join(root,'opencodex'),CHROME_RELAY_BIN:path.join(root,'no-relay'),CODEX_WATCH_IDLE_SLEEP_MS:'200',CODEX_SUPERVISOR_DECISION_POLL_MS:'100',
    LONG_TASK_HOME:path.join(root,'long-task-home'),LONG_TASK_CLAUDE_QUOTA_FILE:quotaFile};
  delete env.CODEX_THREAD_ID;delete env.CODEX_TURN_ID;
  let child;
  return {run,statePath:path.join(run,'daemon-state.json'),
    start(){child=spawn(process.execPath,[path.join(scripts,'native-watch.cjs'),run],{env,stdio:['ignore','pipe','pipe']});},
    calls(){const file=sent+'.args.json';return fs.existsSync(file)?read(file):[];},
    async stop(){if(child?.exitCode===null){child.kill('SIGTERM');await new Promise(resolve=>child.once('exit',resolve));}fs.rmSync(root,{recursive:true,force:true});}};
}

test('a model Jay sets by hand after a switch is judged from then on: Opus at ladder step 5 moves to the Opus API',async()=>{
  const f=fixture();
  try{
    f.start();
    await until(()=>f.calls().some(call=>call.threadId==='executor-qa'&&call.model));
    const moved=f.calls().find(call=>call.threadId==='executor-qa'&&call.model);
    assert.equal(moved.model,opusApi,'the executor skips only its first stop, the Opus subscription');
    assert.match(moved.prompt,/降級第 5 階/);
    const record=read(f.statePath).modelSwitch['executor-qa'];
    assert.deepEqual([record.original,record.current],[opus,opusApi],'the hand-picked Opus is the new starting point');
  }finally{await f.stop();}
});

test('without a hand-picked model the switched chat stays on its route: the Opus API is the highest one the executor may use',async()=>{
  // Moving back to the subscription while the ladder still keeps the executor off it would switch it again on the next reading.
  const f=fixture({handPicked:false,original:opus,current:opusApi});
  try{
    f.start();
    await until(()=>read(f.statePath).claudeQuota);
    await delay(1500);
    assert.deepEqual(f.calls().filter(call=>call.threadId==='executor-qa'&&call.model),[]);
    assert.equal(read(f.statePath).modelSwitch['executor-qa'].restored,null);
  }finally{await f.stop();}
});

