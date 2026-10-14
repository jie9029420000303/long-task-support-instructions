#!/usr/bin/env node
// Watch one desktop executor until its next completed turn; App background Bash wakes the supervisor. claude-hold.cjs
// keeps the supervisor chat loaded at the moment this exits.
const fs=require('node:fs');
const checkedWait=require('./checked-wait.cjs');
const path=require('node:path');
const {hash,read,need,validateContract,PROGRESS_REVIEW_MS,REVIEW_INTERVAL_MS,REPEAT_FAILURES,BLOCKED_MS,SLEEP_NOTICE_MS,IDLE_WORK_MS,
  NO_EVENT_REVIEW_MS,UNPLANNED_MS,PLATFORM_ERROR_MS,overdueTier,awakeSince,inputSource,deliveredText,subagentActivityAt}=require('./guard.cjs');
const {holdAlive}=require('./claude-hold.cjs');
const signals=require('./signals.cjs');
const login=require('./login-check.cjs');
const dashboard=require('./dashboard.cjs');
const {execFileSync}=require('node:child_process');
const pace=require('./pace.cjs');
const {inspect:inspectDispatch,eventFor:dispatchEvent,markAnnounced}=require('./dispatch-audit.cjs');
const {digest,promoteNext,ownerAlive}=require('./handoff-lib.cjs');
const run=path.resolve(process.argv[2]||'');
const binding=read(path.join(run,'binding.json'));
const statePath=path.join(run,'daemon-state.json');
const lockPath=path.join(run,'watcher.lock');
const readyPath=path.join(run,'native-ready.json');
const contractPath=path.join(run,'contract.json');
let state=read(statePath),ownsLock=false;
const now=()=>new Date().toISOString();
const settleMs=Number(process.env.CLAUDE_WATCH_SETTLE_MS||15000);
function save(file,value){fs.writeFileSync(file+'.tmp',JSON.stringify(value,null,2)+'\n');fs.renameSync(file+'.tmp',file);}
function checkpoint(){state.updatedAt=now();save(statePath,state);}
function stopped(){return fs.existsSync(path.join(run,'STOP'));}
// The background notification carries a locator, not the event body: the supervisor reads it with one context call.
function wake(event){
  const {text,pace:_pace,...rest}=event;
  console.log('LONG_TASK_WAKE '+JSON.stringify({...rest,...(typeof text==='string'?{textChars:text.length}:{}),
    context:[process.execPath,path.join(__dirname,'supervise.cjs'),'context',run,event.id].map(value=>"'"+String(value).replaceAll("'","'\\''")+"'").join(' ')}));
}
// Waiting on the supervisor's own ruling is a question for the supervisor, whatever kind the executor marked it
// (2026-10-12 GDB: a ruling request sent as progress + waitMinutes 60).
function asksSupervisor(text){
  return /(?:等待?|待|需要?|請).{0,10}監督.{0,20}(?:裁決|裁定|決定|決策|核准|判定|回覆|指示)|(?:waiting for|awaiting|needs?|requires?).{0,30}supervisor/i.test(text||'');
}
// Executor handoffs wait in the run's queue in the order sent; the oldest becomes pending on this watcher's state, so
// what the last tick measured (a sleep, Jay's latest input) is saved with it.
function handoffRequest(){return Boolean(promoteNext(run,state));}
function logMentions(file,text){
  const needle=Buffer.from(text),chunk=Buffer.alloc(1<<20),fd=fs.openSync(file,'r');
  let carry=Buffer.alloc(0),position=0;
  try{for(;;){const count=fs.readSync(fd,chunk,0,chunk.length,position);if(!count)return false;
    const joined=Buffer.concat([carry,chunk.subarray(0,count)]);if(joined.indexOf(needle)!==-1)return true;
    carry=joined.subarray(Math.max(0,joined.length-needle.length));position+=count;}}
  finally{fs.closeSync(fd);}
}
function readNew(){
  const file=binding.executorLog;
  const end=fs.statSync(file).size;
  need(end>=state.executorOffset,'Executor transcript was truncated');
  if(end===state.executorOffset)return [];
  const fd=fs.openSync(file,'r'),chunk=Buffer.alloc(65536),rows=[];
  let position=state.executorOffset,carry=Buffer.alloc(0);
  try{
    while(position<end){
      const count=fs.readSync(fd,chunk,0,Math.min(chunk.length,end-position),position);
      if(!count)break;
      position+=count;
      const joined=Buffer.concat([carry,chunk.subarray(0,count)]);
      let start=0,newline;
      while((newline=joined.indexOf(10,start))!==-1){
        const lineEnd=position-joined.length+newline+1;
        try{rows.push({row:JSON.parse(joined.subarray(start,newline).toString('utf8')),end:lineEnd});}
        catch{rows.push({row:null,end:lineEnd});}
        start=newline+1;
      }
      carry=joined.subarray(start);
    }
  }finally{fs.closeSync(fd);}
  state.reads++;
  return rows;
}
function eventOf(text,id){
  const line=text.split('\n').map(value=>value.trim()).filter(value=>value.startsWith('LONG_TASK_EVENT ')).pop();
  let value={kind:'unmarked_final'};
  if(line){try{value=JSON.parse(line.slice('LONG_TASK_EVENT '.length));}catch{value={kind:'protocol_error'};}}
  if(!value||!['progress','question','blocked','waiting','submission'].includes(value.kind))value={kind:line?'protocol_error':'unmarked_final'};
  if(['progress','waiting'].includes(value.kind)&&!(typeof value.nextAction==='string'&&value.nextAction.trim()))value={kind:'protocol_error'};
  if(value.kind==='submission'&&(!/^sha256:[a-f0-9]{64}$/.test(value.revision||'')||typeof value.manifest!=='string'))value={kind:'protocol_error'};
  if(value.id!==undefined){
    // An explicit ID names a handoff: persisted, this final mirrors it; still queued, it arrives in its turn. Anything
    // else reaches the supervisor as a protocol error instead of stopping the watcher (2026-10-13 15:56Z IA).
    const known=typeof value.id==='string'&&/^[a-f0-9-]{36}$/.test(value.id);
    if(!known||!state.handoffEvents?.[value.id])
      value=known&&fs.existsSync(path.join(run,'handoff-request-'+value.id+'.json'))?{...value,kind:'queued_mirror'}:{kind:'protocol_error'};
  }
  return {id:value.id||id,kind:value.kind,revision:value.revision||null,manifest:value.manifest||null,
    nextAction:value.nextAction||null,waitMinutes:Number.isFinite(value.waitMinutes)?value.waitMinutes:null,
    text,at:now()};
}
function waitingHasBlocker(text){
  // These phrases identify the observed permission block and explicit user-decision requests.
  // Keep the entire reply in the event so the supervisor decides, not this keyword check.
  const body=text.split('\n').filter(line=>!line.trim().startsWith('LONG_TASK_EVENT ')).join('\n');
  return /(?:權限.{0,16}(?:審查|拒絕|阻擋)|(?:審查|核准).{0,16}(?:拒絕|阻擋)|(?:merge|push|合併|發版).{0,40}(?:被擋|遭擋|阻塞|拒絕)|(?:需要|等待|等).{0,20}(?:Jay|使用者).{0,20}(?:決定|核准|授權)|(?:待決|需要授權|授權或處置))/i.test(body);
}
// Count failing commands the executor repeats; three identical failures mean it is retrying instead of changing approach.
// A success of the same command clears its count: only uninterrupted failures are a repeat.
function trackTools(row){
  if(row.isSidechain||!Array.isArray(row.message?.content))return;
  for(const block of row.message.content){
    if(row.type==='assistant'&&block?.type==='tool_use'){
      const items=state.callItems||={};items[block.id]=signals.workItem(block);
      const keys=Object.keys(items);if(keys.length>50)for(const key of keys.slice(0,keys.length-50))delete items[key];
    }
    if(row.type==='assistant'&&block?.type==='tool_use'&&typeof block.input?.command==='string')(state.openTools||={})[block.id]={command:block.input.command.replace(/\s+/g,' ').trim().slice(0,300),at:row.timestamp||now(),background:Boolean(block.input.run_in_background)};
    if(row.type==='user'&&block?.type==='tool_result'){
      // The auto-mode classifier's refusal: forwarded authorization does not satisfy it; only Jay switching the chat does.
      const reason=signals.refusalOf(block);
      if(reason&&!(state.reviewRejections||[]).some(item=>item.callId===block.tool_use_id)){
        (state.reviewRejections||=[]).push({callId:block.tool_use_id,at:row.timestamp||now(),item:state.callItems?.[block.tool_use_id]||'unknown',reason});
        if(state.reviewRejections.length>10)state.reviewRejections.splice(0,state.reviewRejections.length-10);
        state.rejectionCount=(state.rejectionCount||0)+1;
      }
    }
    if(row.type==='user'&&block?.type==='tool_result'&&state.openTools?.[block.tool_use_id]!==undefined){
      const open=state.openTools[block.tool_use_id],command=typeof open==='string'?open:open.command;delete state.openTools[block.tool_use_id];
      if(block.is_error||/Exit code [1-9]/.test(JSON.stringify(block.content||'').slice(0,80))){const item=((state.failedCommands||={})[command]||={count:0});item.count++;item.lastAt=row.timestamp||now();}
      else delete state.failedCommands?.[command];
    }
  }
}
// What each executor row says beyond its text: who sent a user turn and under which permission mode, the model and
// effort an assistant turn ran on, real work versus polling one background job, and a turn the platform ended.
function trackExecutor(row){
  const source=inputSource(row),at=Date.parse(row.timestamp)||Date.now();
  if(source&&row.permissionMode)state.executorSettings={...state.executorSettings,permissionMode:row.permissionMode,at:row.timestamp||now()};
  if(source==='scheduled')noteAutomation('executor',row,at);
  const error=signals.platformErrorOf(row);
  if(error&&!row.isSidechain)notePlatformError({who:'executor',...error});
  if(row.type!=='assistant'||row.isSidechain||!row.message||row.isApiErrorMessage)return;
  if(row.message.model&&row.message.model!=='<synthetic>')state.executorSettings={...state.executorSettings,model:row.message.model,effort:row.effort||state.executorSettings?.effort||null};
  const content=Array.isArray(row.message.content)?row.message.content:[];
  if(content.some(block=>['text','thinking'].includes(block?.type)||block?.type==='tool_use'&&!signals.pollOnly(block)))state.lastExecutorWorkAt=Math.max(state.lastExecutorWorkAt||0,Math.min(at,Date.now()));
}
function noteAutomation(chat,row,at){
  const list=state.automations||=[],key=chat+':'+(row.uuid||at);
  if(list.some(item=>item.key===key))return;
  list.push({key,chat,at:new Date(at).toISOString(),text:deliveredText({...row,turnOrigin:null})?.slice(0,200)||null});
  if(list.length>20)list.splice(0,list.length-20);
}
// A turn the platform ended (Jay 2026-10-14). A rate limit that names its reset is a known wait: one at a time, a later
// refusal with a later reset replaces it, and the reset wakes the supervisor once. Any other error is kept until the
// executor resumes; 2 minutes without that wakes the supervisor once with the error text.
// Resumed means the executor's own rows show work after the error (row time, not the time this watcher read them).
// That also ends a known wait: on 2026-10-03 the executor worked again 4 to 23 minutes after each weekly notice that
// named a reset two days away. An unpause restarts the work clock, so it re-arms what is still open (rearmedAt).
const resumedSince=since=>(state.lastExecutorWorkAt||0)>since;
const handledUpTo=since=>{state.platformErrorHandledSince=Math.max(state.platformErrorHandledSince||0,since);};
function settlePlatformErrors(){
  for(const key of ['rateLimit','platformError']){
    const item=state[key];
    if(item&&resumedSince(Math.max(item.since,item.rearmedAt||0))){handledUpTo(item.since);state[key]=null;}
  }
}
function notePlatformError(error){
  // rateLimitHandledSince is the cursor's name in runs started before v0.25.1.
  if(error.since<=Math.max(state.platformErrorHandledSince||0,state.rateLimitHandledSince||0)||error.since<(Date.parse(binding.createdAt)||0))return;
  settlePlatformErrors();
  if(resumedSince(error.since)){handledUpTo(error.since);return;}
  if(!error.until){state.platformError=error;return;}
  const known=state.rateLimit;
  if(!known||error.until>known.until)state.rateLimit={...error,since:Math.min(error.since,known?.since||error.since),...(known?.rearmedAt?{rearmedAt:known.rearmedAt}:{})};
}
// Jay's latest words in the supervisor chat (online for 10 minutes after typing) and automations aimed at it.
function scanSupervisor(){
  if(!binding.supervisorLog)return;
  let end;try{end=fs.statSync(binding.supervisorLog).size;}catch{return;}
  let start=state.supervisorScanOffset;
  if(start===undefined||start>end)start=Math.max(0,end-262144);
  if(end===start){state.supervisorScanOffset=end;return;}
  const fd=fs.openSync(binding.supervisorLog,'r'),buffer=Buffer.alloc(end-start);
  try{fs.readSync(fd,buffer,0,buffer.length,start);}finally{fs.closeSync(fd);}
  const complete=buffer.lastIndexOf(10);if(complete<0)return;
  state.supervisorScanOffset=start+complete+1;
  for(const line of buffer.subarray(0,complete).toString('utf8').split('\n')){
    let row;try{row=JSON.parse(line);}catch{continue;}
    const source=inputSource(row),at=Date.parse(row.timestamp)||Date.now();
    if(source==='human')state.lastUserInputAt=Math.max(state.lastUserInputAt||0,Math.min(at,Date.now()));
    if(source==='scheduled')noteAutomation('supervisor',row,at);
  }
}
function snapshotNow(){try{return read(path.join(run,binding.dispatchAudit?.snapshot||'dispatch.json'));}catch{return null;}}
function paceNow(snapshot=snapshotNow()){return pace.inFlight(binding,snapshot,Date.now(),state.sleeps);}
// A foreground command that has no result after 5 minutes and no process running it never started: on the GDB
// run it sat behind a permission prompt for 93 minutes. Only the user can clear that, so it is told at once.
function blockedTools(){
  const old=Object.entries(state.openTools||{}).filter(([,item])=>typeof item==='object'&&!item.background&&Date.now()-Date.parse(item.at)>=BLOCKED_MS);
  if(!old.length)return [];
  let processes='';try{processes=execFileSync('ps',['-axo','command'],{encoding:'utf8',maxBuffer:32*1024*1024});}catch{return [];}
  return old.filter(([,item])=>{
    const piece=item.command.split(/[^\x20-\x7e]|['"\\]/).map(value=>value.trim()).sort((a,b)=>b.length-a.length)[0]||'';
    return piece.length>=12&&!processes.includes(piece);
  }).map(([id,item])=>({id,command:item.command,since:item.at}));
}
// The machine's monotonic clock stops while it sleeps; the wall clock does not. A gap between them is sleep.
let lastTick=null;
function noteSleep(from,to){
  if(to-from<60000)return;
  const sleeps=state.sleeps||=[];
  if(sleeps.some(item=>Date.parse(item.from)<=from+1000&&Date.parse(item.to)>=to-1000))return;
  sleeps.push({from:new Date(from).toISOString(),to:new Date(to).toISOString()});
  if(sleeps.length>50)sleeps.splice(0,sleeps.length-50);
}
function tickSleep(){
  const wall=Date.now(),mono=Number(process.hrtime.bigint()/1000000n);
  if(lastTick){const gap=(wall-lastTick.wall)-(mono-lastTick.mono);if(gap>=60000)noteSleep(wall-gap,wall);}
  lastTick={wall,mono};
}
// The kernel remembers the last sleep, which covers a sleep while no watcher was running. Only the part after the
// run was bound is this run's downtime: last night's closed lid must not wake the supervisor of a fresh run.
function kernelSleep(){
  try{
    const [slept,woke]=[...execFileSync('sysctl',['-n','kern.sleeptime','kern.waketime'],{encoding:'utf8'}).matchAll(/\bsec = (\d+)/g)].map(match=>Number(match[1])*1000);
    const bound=Date.parse(binding.createdAt)||0;
    if(slept&&woke&&woke>slept&&woke>bound)noteSleep(Math.max(slept,bound),woke);
  }catch{}
}
// The supervisor's own clock, in tiers (Jay 2026-10-07): code first confirms the work is moving and within its
// AI-speed baselines; only a problem wakes the model to analyse and push. Every 30 minutes the check is
// recorded in clock.jsonl even when nothing is wrong, so the clock can be audited without a model turn.
let lastClockAt=0;
const paused=()=>fs.existsSync(path.join(run,'PAUSED.json'));
// A known external wait: the shared subscription limit stops the executor and the supervisor alike until its reset.
const rateLimited=()=>Boolean(state.rateLimit&&Date.now()<state.rateLimit.until);
function supervisorClock(){
  if(Date.now()-lastClockAt<60000)return null;
  lastClockAt=Date.now();
  const snapshot=snapshotNow(),paced=paceNow(snapshot),announced=state.clockAnnounced||={};
  if(paced.processActivityAt)state.lastProcessActivityAt=Math.max(state.lastProcessActivityAt||0,paced.processActivityAt);
  for(const item of paced.rateLimits||[])notePlatformError({who:'subagent '+item.id,...item.rateLimit});
  settlePlatformErrors();
  const once=key=>announced[key]?false:(announced[key]=now(),true);
  const awake=from=>awakeSince(state.sleeps,from);
  // A checked wait on Jay's approval already says what is missing, and a rate limit is a known wait: asking again only spends turns.
  const waitingUser=state.checkedWait?.kind==='user_approval',limited=rateLimited();
  // Rule A (Jay 2026-10-13): each baseline wakes the supervisor once at 1.5x and once more at 3x, whether or not the
  // package still produces, to judge whether it runs, is stuck, can go faster or grew in scope (GDB and IA: 12
  // packages past 1.5x, 3 analysed). A re-estimated baseline, a new startedAt or minutes, gets its own two wakes:
  // GDB C13-RELOGIN-EXEC ran a second phase on the first phase's 17.5 minutes. A rate-limited supervisor cannot act,
  // so the tier waits for the reset.
  const overdue=limited?[]:paced.packages.filter(item=>{const tier=overdueTier(item);
    return Boolean(tier)&&once('overdue:'+item.id+'@'+item.startedAt+'/'+item.executorBaselineMinutes+'x'+tier);});
  const baselineMissing=paced.packages.filter(item=>item.baselineMissing&&once('baseline:'+item.id));
  const quietProcess=item=>item.process&&item.alive!==true&&item.lastActivityAt&&Date.now()-Date.parse(item.lastActivityAt)>=PROGRESS_REVIEW_MS;
  const processStalled=paced.packages.filter(item=>quietProcess(item)&&once('process:'+item.id+'@'+item.lastActivityAt));
  const blocked=blockedTools().filter(item=>once('blocked:'+item.id));
  const slept=(state.sleeps||[]).filter(item=>Date.parse(item.to)-Date.parse(item.from)>=SLEEP_NOTICE_MS&&once('sleep:'+item.from));
  const resources=pace.resourceUse(snapshot).filter(item=>item.free>0&&item.waiting.length&&once('resource:'+item.key+'@'+item.used+':'+item.waiting.join(',')));
  let rateReset=null;
  // Every refusal row of a limit that reset is old news, so the cursor moves to the reset itself: a subagent's
  // transcript is read again on every tick.
  if(state.rateLimit&&!limited){const {rearmedAt:_rearmed,...limit}=state.rateLimit;rateReset={...limit,since:new Date(limit.since).toISOString(),until:new Date(limit.until).toISOString()};
    handledUpTo(limit.until);state.rateLimit=null;state.lastRealEventAt=Date.now();}
  // A platform error the executor has not left for 2 minutes, while no rate limit runs and Jay's approval is not
  // what the run waits on: once per error, with the error text.
  const failed=state.platformError;
  const platformError=failed&&!limited&&!waitingUser&&awake(Math.max(failed.since,failed.rearmedAt||0))>=PLATFORM_ERROR_MS&&once('platform_error:'+failed.since)?
    {who:failed.who,since:new Date(failed.since).toISOString(),kind:failed.kind,status:failed.status,text:failed.text}:null;
  const lastEvent=state.lastRealEventAt||Date.parse(binding.createdAt)||Date.now(),quietEvent=awake(lastEvent)>=NO_EVENT_REVIEW_MS;
  const noEventHour=quietEvent&&!waitingUser&&!limited&&once('no_event_hour:'+lastEvent);
  // A background job running alone is still idle capacity: only the executor's own work and its subagents count;
  // a turn that only polls a job or sleeps is not work.
  const idleSince=Math.max(state.lastExecutorWorkAt||0,state.lastSubagentActivityAt||0)||Date.parse(binding.createdAt)||Date.now();
  const openCriteria=(snapshot?.acceptance?.items||[]).filter(item=>['FAIL','PENDING','INCONCLUSIVE'].includes(item.status)).map(item=>item.id);
  const readyPackages=(snapshot?.packages?.ready||[]).map(item=>item.id);
  const idle=awake(idleSince)>=IDLE_WORK_MS&&Boolean(openCriteria.length||readyPackages.length)&&!waitingUser&&!limited;
  const idleWork=idle&&once('idle:'+idleSince)?{idleMinutes:Math.round(awake(idleSince)/60000),openCriteria,readyPackages}:null;
  // An open criterion no live package names (acceptanceIds) for 10 minutes: the supervisor names the packages to dispatch.
  const live=['ready','inFlight','blocked','returned'].flatMap(key=>snapshot?.packages?.[key]||[]);
  const covered=new Set(live.flatMap(item=>Array.isArray(item.acceptanceIds)?item.acceptanceIds:[]));
  const uncovered=snapshot?openCriteria.filter(id=>!covered.has(id)).sort():[];
  const plan=state.unplanned||={};
  for(const id of Object.keys(plan))if(!uncovered.includes(id))delete plan[id];
  for(const id of uncovered)plan[id]??=Date.now();
  const longUncovered=uncovered.filter(id=>awake(plan[id])>=UNPLANNED_MS);
  let unplanned=null;
  if(longUncovered.length&&!waitingUser&&!limited&&once('unplanned:'+longUncovered.join(','))){
    const seats=Number(snapshot?.capacity?.verified)||0,inFlight=(snapshot?.packages?.inFlight||[]).length;
    unplanned={criteria:longUncovered,freeCapacity:Math.max(0,seats-inFlight),minutes:Math.round(Math.min(...longUncovered.map(id=>awake(plan[id])))/60000)};
  }
  // A supervisor instruction not acted on by its deadline: no completed executor turn and no snapshot update since it
  // was sent. Action closes it even while Jay's approval is awaited; only the overdue notice waits.
  let instructionOverdue=null;const sent=state.instruction;
  if(sent){
    const acted=(state.lastRealEventAt||0)>sent.sentAt||Date.parse(snapshot?.updatedAt)>sent.sentAt;
    if(acted)state.instruction=null;
    else if(!waitingUser&&!limited&&awake(sent.sentAt)>=sent.deadlineMs*((sent.misses||0)+1)){
      sent.misses=(sent.misses||0)+1;
      instructionOverdue={eventId:sent.eventId,what:sent.what,doneWhen:sent.doneWhen,minutes:Math.round(awake(sent.sentAt)/60000),misses:sent.misses,
        handling:sent.misses>=2?'第二次逾時：監督自行處理（改派子代理、拆小或接手判定），不通知使用者':'第一次逾時：監督改道，例如交子代理、拆小或換做法'};
      if(sent.misses>=2)state.instruction=null;
    }
  }
  // Auto mode: tell the supervisor once while the executor runs under it, again only when a refusal blocks a work item
  // not refused before, and once more when Jay switches the chat to bypass permissions so blocked work resumes.
  const settings=state.executorSettings,autoMode=settings?.permissionMode==='auto';
  const rejections=(state.reviewRejections||[]).filter(item=>once('rejected:'+item.callId)&&once('rejected-item:'+(item.item||item.callId)));
  let permission=null,permissionChanged=null;
  if(autoMode&&(once('permission:auto')||rejections.length)){
    permission={permissionMode:settings.permissionMode,since:settings.at,newRejections:rejections.map(({item,reason,at})=>({item,reason,at}))};state.permissionWarned=true;
  }else if(settings?.permissionMode==='bypassPermissions'&&state.permissionWarned){state.permissionWarned=false;permissionChanged={permissionMode:settings.permissionMode,at:settings.at};}
  const automations=(state.automations||[]).filter(item=>once('automation:'+item.key));
  const loggedOut=paused()?[]:login.due(state,run)||[];
  // The executor runs on Opus at high effort unless Jay named another model (Jay 2026-10-13, as Codex 2026-10-11).
  let executorModel=null;
  if(settings?.model&&!binding.executorModelOverride&&(!signals.isOpus(settings.model)||['low','medium'].includes(settings.effort))&&once('model:'+settings.model+':'+settings.effort))
    executorModel={model:settings.model,effort:settings.effort||null,want:{family:'opus',effort:'high'},executorDesktopId:binding.executorDesktopId};
  const repeated=Object.entries(state.failedCommands||{}).filter(([,item])=>item.count>=REPEAT_FAILURES&&!item.announced);
  for(const [,item] of repeated)item.announced=now();
  const reasons=[...(blocked.length?['executor_blocked']:[]),...(slept.length?['machine_slept']:[]),...(overdue.length?['overdue']:[]),...(baselineMissing.length?['baseline_missing']:[]),
    ...(processStalled.length?['process_stalled']:[]),...(repeated.length?['repeat']:[]),...(resources.length?['resource_underused']:[]),...(idleWork?['idle_with_work']:[]),
    ...(noEventHour?['no_event_hour']:[]),...(unplanned?['unplanned_criteria']:[]),...(instructionOverdue?['instruction_overdue']:[]),...(permission?['permission_review']:[]),
    ...(permissionChanged?['permission_changed']:[]),...(automations.length?['automation_found']:[]),...(loggedOut.length?['login_expired']:[]),...(rateReset?['rate_limit_reset']:[]),
    ...(platformError?['platform_error']:[]),...(executorModel?['executor_model']:[])];
  if(Date.now()-(state.lastHealthAt||0)>=REVIEW_INTERVAL_MS){
    state.lastHealthAt=Date.now();
    const iso=value=>value?new Date(value).toISOString():null;
    fs.appendFileSync(path.join(run,'clock.jsonl'),JSON.stringify({at:now(),executorAt:iso(state.lastExecutorActivityAt),executorWorkAt:iso(state.lastExecutorWorkAt),subagentAt:iso(state.lastSubagentActivityAt),
      processAt:iso(state.lastProcessActivityAt),packages:paced.packages.map(({id,elapsedMinutes,baselineMinutes,ratio,lastActivityAt,finished,alive})=>({id,elapsedMinutes,baselineMinutes,ratio,lastActivityAt,finished,alive})),
      problems:reasons,open:[...paced.packages.filter(item=>overdueTier(item)).map(item=>'overdue:'+item.id),...paced.packages.filter(item=>item.baselineMissing).map(item=>'baseline_missing:'+item.id),
        ...paced.packages.filter(quietProcess).map(item=>'process_stalled:'+item.id),...paced.packages.filter(item=>item.finished).map(item=>'snapshot_stale:'+item.id),
        ...blockedTools().map(item=>'executor_blocked:'+item.command.slice(0,60)),...(idle?['idle_with_work']:[]),...(quietEvent&&!limited?['no_event_hour']:[]),
        ...(limited?['rate_limited']:[]),...(state.platformError?['platform_error']:[])]})+'\n');
  }
  if(!reasons.length)return null;
  return {reasons,pace:paced,overdue:overdue.map(item=>item.id),baselineMissing:baselineMissing.map(item=>item.id),processStalled:processStalled.map(item=>item.id),
    failedCommands:repeated.map(([command,item])=>({command,count:item.count,lastAt:item.lastAt})),executorBlocked:blocked,machineSlept:slept,resourceUnderused:resources,idleWithWork:idleWork,
    ...(noEventHour?{noEventHour:{lastRealEventAt:new Date(lastEvent).toISOString(),awakeMinutes:Math.round(awake(lastEvent)/60000)}}:{}),
    ...(unplanned?{unplannedCriteria:unplanned}:{}),...(instructionOverdue?{instructionOverdue}:{}),...(permission?{permission}:{}),...(permissionChanged?{permissionChanged}:{}),
    ...(automations.length?{automations}:{}),...(loggedOut.length?{loggedOut}:{}),...(rateReset?{rateLimit:rateReset}:{}),...(platformError?{platformError}:{}),...(executorModel?{executorModel}:{})};
}
let lastDashboardAt=0;
function writeDashboard(){
  if(Date.now()-lastDashboardAt<60000)return;
  lastDashboardAt=Date.now();
  try{const snapshot=snapshotNow();dashboard.write(run,{binding,state,snapshot,paced:paceNow(snapshot),alive:true,hold:holdAlive(run),paused:paused()});}
  catch(error){state.dashboardError={message:error.message,at:now()};}
}
async function waitChange(){
  await new Promise(resolve=>{
    let watcher;
    const done=()=>{clearTimeout(timer);watcher?.close();resolve();};
    const timer=setTimeout(done,2000);
    try{watcher=fs.watch(path.dirname(binding.executorLog),done);watcher.on('error',done);}catch{}
  });
}
async function watch(){
  need(!fs.existsSync(path.join(run,'contract-update.lock')),'Contract update is in progress');
  if(fs.existsSync(lockPath)){
    const old=read(lockPath);
    need(!ownerAlive(old.pid),'Another desktop watcher owns this run');
    fs.unlinkSync(lockPath);
  }
  fs.writeFileSync(lockPath,JSON.stringify({pid:process.pid,run,at:now()}),{flag:'wx'});ownsLock=true;
  state=read(statePath);
  if(stopped()){state.phase='stopped';checkpoint();return;}
  if(state.pending||state.phase==='accepted')return;
  need(binding.platform==='claude-code'&&binding.executorDesktopId,'Desktop executor binding required');
  need(hash(contractPath)===binding.contractSha256,'Locked contract changed');
  validateContract(read(contractPath),{run,binding});
  need(hash(path.join(run,'executor-prompt.txt'))===binding.promptSha256,'Executor prompt changed');
  if(stopped()){state.phase='stopped';checkpoint();return;}
  // A watcher that starts cleanly has recovered; keep the error only while the phase is still 'error'.
  state.pid=process.pid;state.phase='watching';state.error=null;checkpoint();
  save(readyPath,{pid:process.pid,executorId:binding.executorId,executorDesktopId:binding.executorDesktopId,readVerified:true,at:now()});
  let lastGrowthAt=Date.now();
  state.lastExecutorActivityAt ||= Math.max(Date.parse(binding.createdAt)||0,fs.statSync(binding.executorLog).mtimeMs);
  state.lastExecutorWorkAt ||= state.lastExecutorActivityAt;
  kernelSleep();
  // Whether the executor has been told this run: its transcript names the run path (the binding message).
  if(state.executorKnowsRun===undefined&&logMentions(binding.executorLog,run))state.executorKnowsRun=true;
  function finishFinal(){
    const final=state.message;
    state.message=null;
    state.executorOffset=final.finalEnd;
    const event=eventOf(final.texts.join('\n'),final.finalId);
    state.lastRealEventAt=Date.now();
    // Not marked seen: the queued handoff it mirrors must still become pending when its turn comes.
    if(event.kind==='queued_mirror'){checkpoint();return false;}
    if(['waiting','progress'].includes(event.kind)&&asksSupervisor(event.text.split('\n').filter(line=>!line.trim().startsWith('LONG_TASK_EVENT ')).join('\n')))event.kind='question';
    const writtenAt=Date.parse(final.finalAt)||Date.now();
    const recorded=state.handoffEvents?.[event.id];
    // The persisted handoff is authoritative. Claude may summarize that event again in its visible
    // final reply; the explicit ID identifies the summary as a mirror, not a second event body.
    if(state.seen.includes(event.id)||recorded){state.seen.includes(event.id)||(state.seen.push(event.id));checkpoint();return false;}
    if(event.kind==='waiting'){
      if(waitingHasBlocker(event.text))event.kind='blocked';
      else{
        const minutes=event.waitMinutes;
        if(!(minutes>0&&minutes<=120))event.kind='protocol_error';
        else{state.progressWait={event,deadline:writtenAt+minutes*60000};state.seen.push(event.id);checkpoint();return false;}
      }
    }
    if(event.kind==='progress'){
      state.repeatedProgress=state.lastProgressAction===event.nextAction?(state.repeatedProgress||0)+1:1;
      state.lastProgressAction=event.nextAction;
      if(state.repeatedProgress>=2)event.kind='stalled';
      else if(event.waitMinutes!==null){
        if(!(event.waitMinutes>0&&event.waitMinutes<=120)){event.kind='protocol_error';}
        else{state.progressWait={event,deadline:writtenAt+event.waitMinutes*60000};state.seen.push(event.id);checkpoint();return false;}
      }
    }
    state.pendingSupervisorOffset=binding.supervisorLog?fs.statSync(binding.supervisorLog).size:null;state.pending=event;state.phase='awaiting_decision';checkpoint();
    wake(event);
    return true;
  }
  while(!stopped()){
    tickSleep();
    if(handoffRequest()){wake(state.pending);return;}
    const rows=readNew();
    if(rows.length)lastGrowthAt=Date.now();
    let finalized=false;
    for(const {row,end} of rows){
      const toolResult=row?.type==='user'&&Array.isArray(row.message?.content)&&
        row.message.content.some(block=>block?.type==='tool_result');
      if((row?.type==='assistant'&&!row.isSidechain)||toolResult){
        const recorded=Date.parse(row.timestamp);
        state.lastExecutorActivityAt=Math.max(state.lastExecutorActivityAt,Number.isFinite(recorded)?Math.min(recorded,Date.now()):Date.now());
      }
      const id=row?.type==='assistant'&&row.message&&!row.isSidechain?(row.message.id||row.uuid):null;
      if(state.message?.finalId && ((id&&id!==state.message.id)||row?.type==='user')){
        if(finishFinal())return;
        finalized=true;
        break;
      }
      state.executorOffset=end;
      if(!row)continue;
      const text=deliveredText(row);
      if(text&&text.includes(run))state.executorKnowsRun=true;
      for(const [id,item] of Object.entries(state.unconfirmedDeliveries||{})){
        if(text&&item.requires.every(value=>text.includes(value))){
          (state.confirmedDeliveries||={})[id]={messageId:item.messageId,queuedAt:item.queuedAt,confirmedAt:now(),row:row.uuid||row.type};
          delete state.unconfirmedDeliveries[id];
        }
      }
      trackTools(row);trackExecutor(row);
      if(row.type==='user'){state.message=null;continue;}
      if(!id||!row.uuid)continue;
      if(state.message?.id!==id){state.message={id,texts:[],finalId:null,finalEnd:null};
        if(state.progressWait)state.progressWait=null;}
      const own=(row.message.content||[]).filter(block=>block?.type==='text').map(block=>block.text);
      state.message.texts.push(...own);
      if(row.message.stop_reason==='end_turn'){
        state.message.finalId=row.uuid;
        state.message.finalAt=row.timestamp;
      }
      if(state.message.finalId)state.message.finalEnd=end;
    }
    checkpoint();
    if(finalized)continue;
    if(state.message?.finalId&&Date.now()-lastGrowthAt>=settleMs){
      if(finishFinal())return;
      continue;
    }
    // Executor replies come first: audit only once no completed reply is still settling.
    // Asking for the first snapshot before the binding message reached the executor only wakes the supervisor
    // for nothing (2026-10-07: the first event of the GDB run); the snapshot is due once the executor knows the run.
    // Jay's pause stops every model wake; a real executor event still reaches the supervisor.
    const isPaused=paused();
    // Unpausing restarts the work clock; a platform error or rate limit still open keeps its own clock from now on.
    if(state.pausedSeen&&!isPaused){const at=Date.now();settlePlatformErrors();for(const item of [state.rateLimit,state.platformError])if(item)item.rearmedAt=at;
      state.lastRealEventAt=at;state.lastExecutorWorkAt=at;state.lastProgressReviewAt=at;state.unplanned={};}
    state.pausedSeen=isPaused;
    writeDashboard();
    if(!isPaused&&!state.pending&&!state.message?.finalId){const audit=inspectDispatch(run,binding,state);
      if(!state.executorKnowsRun&&Date.now()-(Date.parse(binding.createdAt)||0)<PROGRESS_REVIEW_MS)audit.newIssues=audit.newIssues.filter(item=>item.kind!=='snapshot_missing');
      const auditEvent=dispatchEvent(audit);if(auditEvent){
      auditEvent.preflightArgv=[process.execPath,path.join(__dirname,'supervise.cjs'),'dispatch-preflight',run,auditEvent.id];
      markAnnounced(state,auditEvent);state.pendingSupervisorOffset=binding.supervisorLog?fs.statSync(binding.supervisorLog).size:null;state.pending=auditEvent;state.phase='awaiting_decision';checkpoint();
      wake(auditEvent);return;
    }}
    if(state.progressWait&&Date.now()>=state.progressWait.deadline){
      const event={...state.progressWait.event,kind:'continue',declaredAt:state.progressWait.event.at,dueAt:new Date(state.progressWait.deadline).toISOString(),at:now()};
      state.progressWait=null;state.pendingSupervisorOffset=binding.supervisorLog?fs.statSync(binding.supervisorLog).size:null;state.pending=event;state.phase='awaiting_decision';checkpoint();
      wake(event);
      return;
    }
    const hadCheckedWait=Boolean(state.checkedWait);
    checkedWait.supervisorInput(state,binding);
    state.lastSubagentActivityAt=Math.max(state.lastSubagentActivityAt||0,subagentActivityAt(binding));
    scanSupervisor();
    // An executor's declared wait no longer silences the supervisor (Jay 2026-10-07): silence, an overdue or
    // unbaselined package, a stalled test process and repeated failures each start a check while work goes on.
    const held=checkedWait.unchanged(state);
    const clock=isPaused?null:supervisorClock();
    // Quiet means nothing moves at all: the executor, its subagents and the test processes it runs. A pause or a
    // running rate limit is a known stop, not silence.
    const silent=!held&&!isPaused&&!rateLimited()&&(hadCheckedWait||Date.now()-Math.max(state.lastExecutorActivityAt,state.lastSubagentActivityAt,state.lastProcessActivityAt||0,state.lastProgressReviewAt||0)>=PROGRESS_REVIEW_MS);
    if(silent||clock){
      state.progressReviewSequence=(state.progressReviewSequence||0)+1;
      const reasons=[...(silent?[hadCheckedWait?'wait_changed':'silence']:[]),...(clock?.reasons||[])];
      const event={id:'progress-review-'+digest({executorId:binding.executorId,sequence:state.progressReviewSequence}).slice(0,24),
        kind:'progress_review',reasons,lastExecutorActivityAt:new Date(state.lastExecutorActivityAt).toISOString(),
        lastSubagentActivityAt:state.lastSubagentActivityAt?new Date(state.lastSubagentActivityAt).toISOString():null,
        lastProcessActivityAt:state.lastProcessActivityAt?new Date(state.lastProcessActivityAt).toISOString():null,
        unconfirmedDeliveries:state.unconfirmedDeliveries||{},pace:clock?.pace||paceNow(),overdue:clock?.overdue||[],
        baselineMissing:clock?.baselineMissing||[],processStalled:clock?.processStalled||[],executorBlocked:clock?.executorBlocked||[],
        machineSlept:clock?.machineSlept||[],resourceUnderused:clock?.resourceUnderused||[],idleWithWork:clock?.idleWithWork||null,
        failedCommands:clock?.failedCommands||[],declaredWaitMinutes:state.progressWait?.event?.waitMinutes??null,
        ...Object.fromEntries(['noEventHour','unplannedCriteria','instructionOverdue','permission','permissionChanged','automations','loggedOut','rateLimit','platformError','executorModel']
          .filter(key=>clock?.[key]).map(key=>[key,clock[key]])),at:now()};
      state.pendingSupervisorOffset=binding.supervisorLog?fs.statSync(binding.supervisorLog).size:null;state.pending=event;state.phase='awaiting_decision';checkpoint();
      wake(event);
      return;
    }
    await waitChange();
  }
  state.phase='stopped';checkpoint();
}
(async()=>{
  try{await watch();}
  catch(error){
    if(ownsLock){
      if(stopped()){state.phase='stopped';checkpoint();return;}
      state.phase='error';state.error={message:error.message,at:now()};checkpoint();
    }
    console.error(error.stack||error);process.exitCode=1;
  }
  finally{if(ownsLock){try{if(read(lockPath).pid===process.pid)fs.unlinkSync(lockPath);}catch{}}}
})();
