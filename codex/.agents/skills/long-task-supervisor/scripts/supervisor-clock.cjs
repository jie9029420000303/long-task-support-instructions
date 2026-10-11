// The supervisor's own clock, in tiers (Jay 2026-10-07): code first confirms the work is moving and within its
// AI-speed baselines; only a problem wakes the model to analyse and push. Every 30 minutes the check is
// recorded in clock.jsonl even when nothing is wrong, so the clock can be audited without a model turn.
const fs=require('node:fs');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const pace=require('./pace.cjs');
const {PROGRESS_REVIEW_MS,REVIEW_INTERVAL_MS,OVERDUE_RATIO,REPEAT_FAILURES,BLOCKED_MS,SLEEP_NOTICE_MS,NO_EVENT_REVIEW_MS,IDLE_WORK_MS,AUTOMATION_CHECK_MS,UNPLANNED_MS}=require('./guard.cjs');
const automations=require('./automations.cjs');
const login=require('./login-check.cjs');
const now=()=>new Date().toISOString();
// The executor's own rollout holds its tool calls and command results; the App tools only show messages.
function executorLog(state,binding){
  // A compacted executor continues in a newer segment; switch to it instead of reading the closed file forever.
  const file=pace.sessionFile(binding.executorId);
  if(file&&file!==state.executorLog){state.executorLog=file;state.executorOffset=0;}
  if(!file&&state.executorLog&&fs.existsSync(state.executorLog))return state.executorLog;
  return file;
}
const unquote=text=>text.replace(/\\(.)/g,(match,char)=>({n:'\n',t:'\t',r:'\r'})[char]??char);
// Commands a tool call will run: exec_command calls inside a code-mode exec script, or a direct call's arguments.
function commandsOf(payload){
  if(payload.type==='custom_tool_call'&&typeof payload.input==='string')
    return [...payload.input.matchAll(/\bcmd\s*:\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/g)].map(match=>unquote(match[2]));
  if(payload.type==='function_call'&&['exec_command','shell'].includes(payload.name)){
    try{const args=JSON.parse(payload.arguments||'{}'),value=args.cmd??args.command;return [Array.isArray(value)?value.at(-1):value].filter(item=>typeof item==='string');}catch{}
  }
  return [];
}
// Polling a running job or waiting on a tool is not work: a main line that only polls one background job is idle.
function pollOnly(payload){
  if(payload.type==='function_call'){
    if(['wait','wait_agent'].includes(payload.name))return true;
    if(payload.name==='write_stdin'){try{return !JSON.parse(payload.arguments||'{}').chars;}catch{return false;}}
    return false;
  }
  const input=typeof payload.input==='string'?payload.input:'';
  return payload.type==='custom_tool_call'&&/write_stdin|custom_wait/.test(input)&&!/exec_command|apply_patch|chars\s*:\s*["'`][^"'`]/.test(input);
}
// Count failing commands the executor repeats; three identical failures mean it is retrying instead of changing
// approach. Calls still open count from any time (a turn's end closes them); failures count from the binding on.
function trackTools(state,row,boundAt=0){
  const payload=row.payload||{},at=row.timestamp||now();
  // The executor's permission mode and model, as each turn applies them. Under "auto review" the platform reviewer
  // only trusts Jay's own words in that chat, so forwarded authorization is refused (2026-10-11: A's Git and Docker
  // 3 times, GDB's Jira read once, half a day lost). Only switching the chat to full access clears it.
  const applied=row.type==='turn_context'?payload:row.type==='event_msg'&&payload.type==='thread_settings_applied'?payload.thread_settings||{}:null;
  if(applied&&(applied.approval_policy||applied.model))state.executorSettings={approvalPolicy:applied.approval_policy||state.executorSettings?.approvalPolicy||null,
    reviewer:applied.approvals_reviewer||state.executorSettings?.reviewer||null,model:applied.model||state.executorSettings?.model||null,
    effort:applied.effort||state.executorSettings?.effort||null,at};
  if(row.type==='response_item'&&['custom_tool_call_output','function_call_output'].includes(payload.type)){
    const output=typeof payload.output==='string'?payload.output:JSON.stringify(payload.output||'');
    if(/rejected due to unacceptable risk/i.test(output)&&!(state.reviewRejections||[]).some(item=>item.callId===payload.call_id)){
      const reason=/Reason:\s*([\s\S]{0,400}?)(?:\\n|\n|The agent must|$)/.exec(output)?.[1]||output.slice(0,300);
      (state.reviewRejections||=[]).push({callId:payload.call_id,at,reason:reason.replace(/\\+"?/g,'').trim()});
      if(state.reviewRejections.length>10)state.reviewRejections.splice(0,state.reviewRejections.length-10);
    }
  }
  if(row.type==='response_item'&&['custom_tool_call','function_call','message','reasoning'].includes(payload.type)&&!pollOnly(payload)){
    const workAt=Date.parse(at);if(Number.isFinite(workAt))state.lastExecutorWorkAt=Math.max(state.lastExecutorWorkAt||0,workAt);
  }
  if(row.type==='response_item'&&['custom_tool_call','function_call'].includes(payload.type)){
    const commands=commandsOf(payload).map(item=>item.replace(/\s+/g,' ').trim().slice(0,300)).filter(Boolean);
    if(commands.length)(state.openTools||={})[payload.call_id]={commands,at};
  }else if(row.type==='response_item'&&['custom_tool_call_output','function_call_output'].includes(payload.type))delete state.openTools?.[payload.call_id];
  else if(row.type==='event_msg'&&['task_complete','turn_aborted'].includes(payload.type))state.openTools={};
  else if(row.type==='event_msg'&&payload.type==='item_completed'&&payload.item?.type==='CommandExecution'){
    const item=payload.item,command=(Array.isArray(item.command)?item.command.at(-1):String(item.command||'')).replace(/\s+/g,' ').trim().slice(0,300);
    // A command that ran while a call was open means that call is not frozen behind a prompt.
    for(const open of Object.values(state.openTools||{}))open.ran=true;
    if(Date.parse(at)>=boundAt && command){
      if(item.status==='failed'||Number.isInteger(item.exit_code)&&item.exit_code!==0){const value=((state.failedCommands||={})[command]||={count:0});value.count++;value.lastAt=at;}
      else if(item.exit_code===0)delete state.failedCommands?.[command];
    }
  }
}
function readExecutor(state,binding){
  const file=executorLog(state,binding);if(!file)return;
  const size=fs.statSync(file).size;
  if(size<(state.executorOffset||0))state.executorOffset=0;
  if(size===state.executorOffset)return;
  const fd=fs.openSync(file,'r'),buffer=Buffer.alloc(size-state.executorOffset);
  try{fs.readSync(fd,buffer,0,buffer.length,state.executorOffset);}finally{fs.closeSync(fd);}
  const complete=buffer.lastIndexOf(10);if(complete<0)return;
  state.executorOffset+=complete+1;
  const boundAt=Date.parse(binding.createdAt)||0;
  for(const line of buffer.subarray(0,complete).toString('utf8').split('\n')){try{trackTools(state,JSON.parse(line),boundAt);}catch{}}
}
// A command with no result after 5 minutes, none of whose commands ran or is running, never started: on the GDB
// run it sat behind a permission prompt for 93 minutes. Only the user can clear that, so it is told at once.
function blockedTools(state){
  const old=Object.entries(state.openTools||{}).filter(([,item])=>!item.ran&&Date.now()-Date.parse(item.at)>=BLOCKED_MS);
  if(!old.length)return [];
  let processes='';try{processes=execFileSync('ps',['-axo','command'],{encoding:'utf8',maxBuffer:32*1024*1024});}catch{return [];}
  const piece=command=>command.split(/[^\x20-\x7e]|['"\\]/).map(value=>value.trim()).sort((a,b)=>b.length-a.length)[0]||'';
  return old.filter(([,item])=>item.commands.every(command=>piece(command).length>=12&&!processes.includes(piece(command))))
    .map(([id,item])=>({id,command:item.commands.join(' ; ').slice(0,300),since:item.at}));
}
// The machine's monotonic clock stops while it sleeps; the wall clock does not. A gap between them is sleep.
let lastTick=null;
function noteSleep(state,from,to){
  if(to-from<60000)return;
  const sleeps=state.sleeps||=[];
  if(sleeps.some(item=>Date.parse(item.from)<=from+1000&&Date.parse(item.to)>=to-1000))return;
  sleeps.push({from:new Date(from).toISOString(),to:new Date(to).toISOString()});
  if(sleeps.length>50)sleeps.splice(0,sleeps.length-50);
}
function tickSleep(state){
  const wall=Date.now(),mono=Number(process.hrtime.bigint()/1000000n);
  if(lastTick){const gap=(wall-lastTick.wall)-(mono-lastTick.mono);if(gap>=60000)noteSleep(state,wall-gap,wall);}
  lastTick={wall,mono};
}
// The kernel remembers the last sleep, which covers a sleep while no watcher was running. Only the part after the
// run was bound is this run's downtime: last night's closed lid must not wake the supervisor of a fresh run.
function kernelSleep(state,binding){
  try{
    const [slept,woke]=[...execFileSync('sysctl',['-n','kern.sleeptime','kern.waketime'],{encoding:'utf8'}).matchAll(/\bsec = (\d+)/g)].map(match=>Number(match[1])*1000);
    const bound=Date.parse(binding.createdAt)||0;
    if(slept&&woke&&woke>slept&&woke>bound)noteSleep(state,Math.max(slept,bound),woke);
  }catch{}
}
function snapshotOf(run,binding){try{return JSON.parse(fs.readFileSync(path.join(run,binding.dispatchAudit?.snapshot||'dispatch.json'),'utf8'));}catch{return null;}}
function paceNow(run,binding,state,snapshot=snapshotOf(run,binding)){return pace.inFlight(binding,snapshot,Date.now(),state.sleeps);}
// Overdue wakes only when the package is past 1.5x its baseline, has produced nothing for the silence window and
// has no process still running it (Jay 2026-10-11); a slow but working package is recorded, not interrupted.
function overdueNeedsReview(item,nowMs=Date.now()){
  const last=Date.parse(item.lastActivityAt);
  return item.ratio>=OVERDUE_RATIO && item.alive!==true && (!Number.isFinite(last) || last>nowMs || nowMs-last>=PROGRESS_REVIEW_MS);
}
// Sleep does not count toward the hour without an event, as it does not count toward a package's elapsed time.
function awakeSince(state,from,nowMs=Date.now()){
  const slept=(state.sleeps||[]).reduce((sum,item)=>sum+Math.max(0,Math.min(nowMs,Date.parse(item.to))-Math.max(from,Date.parse(item.from))),0);
  return nowMs-from-slept;
}
let lastClockAt=0;
function check(run,binding,state){
  if(Date.now()-lastClockAt<60000)return null;
  lastClockAt=Date.now();
  readExecutor(state,binding);
  // A watcher restarted on an existing run starts reading at its saved offset; take the current mode from the tail once.
  if(!state.executorSettings){const found=require('./model-fallback.cjs').settingsOf(binding.executorId);if(found)state.executorSettings=found;}
  const snapshot=snapshotOf(run,binding),paced=paceNow(run,binding,state,snapshot),announced=state.clockAnnounced||={};
  if(paced.processActivityAt)state.lastProcessActivityAt=Math.max(state.lastProcessActivityAt||0,paced.processActivityAt);
  if(paced.subagentActivityAt)state.lastSubagentActivityAt=Math.max(state.lastSubagentActivityAt||0,paced.subagentActivityAt);
  const once=key=>announced[key]?false:(announced[key]=now(),true);
  // A baseline overrun is a diagnostic, not evidence of a stalled worker. Reuse the existing
  // silence window: keep recording overruns while this package produces, wake if it goes quiet.
  const overdue=paced.packages.filter(item=>overdueNeedsReview(item) &&
    once('overdue:'+item.id+'@'+item.startedAt));
  const baselineMissing=paced.packages.filter(item=>item.baselineMissing&&once('baseline:'+item.id));
  const quietProcess=item=>item.process&&item.alive!==true&&item.lastActivityAt&&Date.now()-Date.parse(item.lastActivityAt)>=PROGRESS_REVIEW_MS;
  const processStalled=paced.packages.filter(item=>quietProcess(item)&&once('process:'+item.id+'@'+item.lastActivityAt));
  const stuck=blockedTools(state),blocked=stuck.filter(item=>once('blocked:'+item.id));
  const slept=(state.sleeps||[]).filter(item=>Date.parse(item.to)-Date.parse(item.from)>=SLEEP_NOTICE_MS&&once('sleep:'+item.from));
  const resources=pace.resourceUse(snapshot).filter(item=>item.free>0&&item.waiting.length&&once('resource:'+item.key+'@'+item.used+':'+item.waiting.join(',')));
  const repeated=Object.entries(state.failedCommands||{}).filter(([,item])=>item.count>=REPEAT_FAILURES&&!item.announced);
  for(const [,item] of repeated)item.announced=now();
  // A checked wait on Jay's approval already says what is missing: asking again every hour only spends turns.
  const waitingUser=state.checkedWait?.kind==='user_approval';
  const lastEvent=state.lastRealEventAt||Date.parse(binding.createdAt)||Date.now(),quietEvent=awakeSince(state,lastEvent)>=NO_EVENT_REVIEW_MS;
  const noEventHour=quietEvent&&!waitingUser&&once('no_event_hour:'+lastEvent);
  // A background job running alone is still idle capacity: only the executor's own turns and its subagents count.
  const idleSince=Math.max(state.lastExecutorActivityAt||0,state.lastExecutorWorkAt||0,state.lastSubagentActivityAt||0)||Date.parse(binding.createdAt)||Date.now();
  const openCriteria=(snapshot?.acceptance?.items||[]).filter(item=>['FAIL','PENDING','INCONCLUSIVE'].includes(item.status)).map(item=>item.id);
  const readyPackages=(snapshot?.packages?.ready||[]).map(item=>item.id);
  const idle=awakeSince(state,idleSince)>=IDLE_WORK_MS&&Boolean(openCriteria.length||readyPackages.length)&&!waitingUser;
  const idleWork=idle&&once('idle:'+idleSince)?{idleMinutes:Math.round(awakeSince(state,idleSince)/60000),openCriteria,readyPackages}:null;
  // An open criterion no live package names (acceptanceIds) for 10 minutes while seats sit free: the supervisor
  // names the packages to dispatch (Jay 2026-10-11). Kept in the clock so dispatch-audit stays shared with Claude.
  const live=['ready','inFlight','blocked','returned'].flatMap(key=>snapshot?.packages?.[key]||[]);
  const covered=new Set(live.flatMap(item=>Array.isArray(item.acceptanceIds)?item.acceptanceIds:[]));
  const uncovered=snapshot?openCriteria.filter(id=>!covered.has(id)).sort():[];
  const plan=state.unplanned||={};
  for(const id of Object.keys(plan))if(!uncovered.includes(id))delete plan[id];
  for(const id of uncovered)plan[id]??=Date.now();
  const longUncovered=uncovered.filter(id=>awakeSince(state,plan[id])>=UNPLANNED_MS);
  let unplanned=null;
  if(longUncovered.length&&!waitingUser&&once('unplanned:'+longUncovered.join(','))){
    const seats=Number(snapshot?.capacity?.verified)||0,inFlight=(snapshot?.packages?.inFlight||[]).length;
    unplanned={criteria:longUncovered,freeCapacity:Math.max(0,seats-inFlight),minutes:Math.round(Math.min(...longUncovered.map(id=>awakeSince(state,plan[id])))/60000)};
  }
  // A supervisor instruction not acted on by its deadline: no real event and no snapshot update since it was sent.
  // Action closes it even while Jay's approval is awaited; only the overdue notice waits (2026-10-11 A: an instruction
  // acted on at 23:17 stayed open behind an approval wait and would have fired as overdue the moment Jay switched).
  let instructionOverdue=null;const sent=state.instruction;
  if(sent){
    const acted=(state.lastRealEventAt||0)>sent.sentAt||Date.parse(snapshot?.updatedAt)>sent.sentAt;
    if(acted)state.instruction=null;
    else if(!waitingUser&&awakeSince(state,sent.sentAt)>=sent.deadlineMs*((sent.misses||0)+1)){
      sent.misses=(sent.misses||0)+1;
      instructionOverdue={eventId:sent.eventId,what:sent.what,doneWhen:sent.doneWhen,minutes:Math.round(awakeSince(state,sent.sentAt)/60000),misses:sent.misses,
        handling:sent.misses>=2?'第二次逾時：監督自行處理（改派子代理、拆小或接手判定），不通知使用者':'第一次逾時：監督改道，例如交子代理、拆小或換做法'};
      if(sent.misses>=2)state.instruction=null;
    }
  }
  // Permission mode: tell the supervisor once while the executor runs under auto review, again on each new
  // refusal, and once more when Jay switches it to full access so blocked work resumes without anyone asking.
  const settings=state.executorSettings,autoReview=Boolean(settings?.approvalPolicy&&settings.approvalPolicy!=='never');
  const rejections=(state.reviewRejections||[]).filter(item=>once('rejected:'+item.callId));
  let permission=null,permissionChanged=null;
  if(autoReview&&(once('permission:'+settings.approvalPolicy+':'+settings.reviewer)||rejections.length)){
    permission={approvalPolicy:settings.approvalPolicy,reviewer:settings.reviewer,since:settings.at,newRejections:rejections,title:state.threadTitles?.executor||null};
    state.permissionWarned=true;
  }else if(!autoReview&&settings&&state.permissionWarned){state.permissionWarned=false;permissionChanged={approvalPolicy:settings.approvalPolicy,at:settings.at};}
  let automationFound=[];
  if(Date.now()-(state.lastAutomationCheckAt||0)>=AUTOMATION_CHECK_MS){
    state.lastAutomationCheckAt=Date.now();
    automationFound=automations.aimedAt([binding.supervisorId,binding.executorId]).filter(item=>once('automation:'+item.id+'@'+item.updatedAt));
  }
  const loggedOut=login.due(state,run)||[];
  const reasons=[...(blocked.length?['executor_blocked']:[]),...(slept.length?['machine_slept']:[]),...(overdue.length?['overdue']:[]),...(baselineMissing.length?['baseline_missing']:[]),
    ...(processStalled.length?['process_stalled']:[]),...(repeated.length?['repeat']:[]),...(resources.length?['resource_underused']:[]),...(noEventHour?['no_event_hour']:[]),
    ...(idleWork?['idle_with_work']:[]),...(unplanned?['unplanned_criteria']:[]),...(instructionOverdue?['instruction_overdue']:[]),...(permission?['permission_review']:[]),
    ...(permissionChanged?['permission_changed']:[]),...(automationFound.length?['automation_found']:[]),...(loggedOut.length?['login_expired']:[])];
  if(Date.now()-(state.lastHealthAt||0)>=REVIEW_INTERVAL_MS){
    state.lastHealthAt=Date.now();
    const iso=value=>value?new Date(value).toISOString():null;
    fs.appendFileSync(path.join(run,'clock.jsonl'),JSON.stringify({at:now(),executorAt:iso(state.lastExecutorActivityAt),subagentAt:iso(state.lastSubagentActivityAt),
      processAt:iso(state.lastProcessActivityAt),packages:paced.packages.map(({id,elapsedMinutes,baselineMinutes,ratio,lastActivityAt,finished,alive})=>({id,elapsedMinutes,baselineMinutes,ratio,lastActivityAt,finished,alive})),
      problems:reasons,open:[...paced.packages.filter(item=>item.ratio>=OVERDUE_RATIO).map(item=>'overdue:'+item.id),...paced.packages.filter(item=>item.baselineMissing).map(item=>'baseline_missing:'+item.id),
        ...paced.packages.filter(quietProcess).map(item=>'process_stalled:'+item.id),...paced.packages.filter(item=>item.finished).map(item=>'snapshot_stale:'+item.id),
        ...stuck.map(item=>'executor_blocked:'+item.command.slice(0,60)),...(quietEvent?['no_event_hour']:[]),...(idle?['idle_with_work']:[])]})+'\n');
  }
  if(!reasons.length)return null;
  return {reasons,pace:paced,overdue:overdue.map(item=>item.id),baselineMissing:baselineMissing.map(item=>item.id),processStalled:processStalled.map(item=>item.id),
    failedCommands:repeated.map(([command,item])=>({command,count:item.count,lastAt:item.lastAt})),executorBlocked:blocked,machineSlept:slept,resourceUnderused:resources,
    ...(noEventHour?{noEventHour:{lastRealEventAt:new Date(lastEvent).toISOString(),awakeMinutes:Math.round(awakeSince(state,lastEvent)/60000)}}:{}),
    ...(idleWork?{idleWithWork:idleWork}:{}),...(unplanned?{unplannedCriteria:unplanned}:{}),...(instructionOverdue?{instructionOverdue}:{}),...(permission?{permission}:{}),
    ...(permissionChanged?{permissionChanged}:{}),...(automationFound.length?{automations:automationFound}:{}),...(loggedOut.length?{loggedOut}:{})};
}
module.exports={overdueNeedsReview,check,tickSleep,kernelSleep,paceNow,snapshotOf,executorLog,readExecutor,commandsOf,pollOnly,awakeSince};
