// The supervisor's own clock, in tiers (Jay 2026-10-07): code first confirms the work is moving and within its
// AI-speed baselines; only a problem wakes the model to analyse and push. Every 30 minutes the check is
// recorded in clock.jsonl even when nothing is wrong, so the clock can be audited without a model turn.
const fs=require('node:fs');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const pace=require('./pace.cjs');
const {PROGRESS_REVIEW_MS,REVIEW_INTERVAL_MS,OVERDUE_RATIO,REPEAT_FAILURES,BLOCKED_MS,SLEEP_NOTICE_MS}=require('./guard.cjs');
const now=()=>new Date().toISOString();
// The executor's own rollout holds its tool calls and command results; the App tools only show messages.
function executorLog(state,binding){
  if(state.executorLog&&fs.existsSync(state.executorLog))return state.executorLog;
  const file=pace.sessionFile(binding.executorId);
  if(file){state.executorLog=file;state.executorOffset=0;}
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
// Count failing commands the executor repeats; three identical failures mean it is retrying instead of changing
// approach. Calls still open count from any time (a turn's end closes them); failures count from the binding on.
function trackTools(state,row,boundAt=0){
  const payload=row.payload||{},at=row.timestamp||now();
  if(row.type==='response_item'&&['custom_tool_call','function_call'].includes(payload.type)){
    const commands=commandsOf(payload).map(item=>item.replace(/\s+/g,' ').trim().slice(0,300)).filter(Boolean);
    if(commands.length)(state.openTools||={})[payload.call_id]={commands,at};
  }else if(row.type==='response_item'&&['custom_tool_call_output','function_call_output'].includes(payload.type))delete state.openTools?.[payload.call_id];
  else if(row.type==='event_msg'&&['task_complete','turn_aborted'].includes(payload.type))state.openTools={};
  else if(row.type==='event_msg'&&payload.type==='item_completed'&&payload.item?.type==='CommandExecution'){
    const item=payload.item,command=(Array.isArray(item.command)?item.command.at(-1):String(item.command||'')).replace(/\s+/g,' ').trim().slice(0,300);
    // A command that ran while a call was open means that call is not frozen behind a prompt.
    for(const open of Object.values(state.openTools||{}))open.ran=true;
    if((item.status==='failed'||Number.isInteger(item.exit_code)&&item.exit_code!==0)&&Date.parse(at)>=boundAt){const value=((state.failedCommands||={})[command]||={count:0});value.count++;value.lastAt=at;}
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
let lastClockAt=0;
function check(run,binding,state){
  if(Date.now()-lastClockAt<60000)return null;
  lastClockAt=Date.now();
  readExecutor(state,binding);
  const snapshot=snapshotOf(run,binding),paced=paceNow(run,binding,state,snapshot),announced=state.clockAnnounced||={};
  if(paced.processActivityAt)state.lastProcessActivityAt=Math.max(state.lastProcessActivityAt||0,paced.processActivityAt);
  if(paced.subagentActivityAt)state.lastSubagentActivityAt=Math.max(state.lastSubagentActivityAt||0,paced.subagentActivityAt);
  const once=key=>announced[key]?false:(announced[key]=now(),true);
  const overdue=paced.packages.filter(item=>item.ratio>=OVERDUE_RATIO&&once('overdue:'+item.id+'@'+item.startedAt));
  const baselineMissing=paced.packages.filter(item=>item.baselineMissing&&once('baseline:'+item.id));
  const quietProcess=item=>item.process&&item.alive!==true&&item.lastActivityAt&&Date.now()-Date.parse(item.lastActivityAt)>=PROGRESS_REVIEW_MS;
  const processStalled=paced.packages.filter(item=>quietProcess(item)&&once('process:'+item.id+'@'+item.lastActivityAt));
  const stuck=blockedTools(state),blocked=stuck.filter(item=>once('blocked:'+item.id));
  const slept=(state.sleeps||[]).filter(item=>Date.parse(item.to)-Date.parse(item.from)>=SLEEP_NOTICE_MS&&once('sleep:'+item.from));
  const resources=pace.resourceUse(snapshot).filter(item=>item.free>0&&item.waiting.length&&once('resource:'+item.key+'@'+item.used+':'+item.waiting.join(',')));
  const repeated=Object.entries(state.failedCommands||{}).filter(([,item])=>item.count>=REPEAT_FAILURES&&!item.announced);
  for(const [,item] of repeated)item.announced=now();
  const reasons=[...(blocked.length?['executor_blocked']:[]),...(slept.length?['machine_slept']:[]),...(overdue.length?['overdue']:[]),...(baselineMissing.length?['baseline_missing']:[]),
    ...(processStalled.length?['process_stalled']:[]),...(repeated.length?['repeat']:[]),...(resources.length?['resource_underused']:[])];
  if(Date.now()-(state.lastHealthAt||0)>=REVIEW_INTERVAL_MS){
    state.lastHealthAt=Date.now();
    const iso=value=>value?new Date(value).toISOString():null;
    fs.appendFileSync(path.join(run,'clock.jsonl'),JSON.stringify({at:now(),executorAt:iso(state.lastExecutorActivityAt),subagentAt:iso(state.lastSubagentActivityAt),
      processAt:iso(state.lastProcessActivityAt),packages:paced.packages.map(({id,elapsedMinutes,baselineMinutes,ratio,lastActivityAt,finished,alive})=>({id,elapsedMinutes,baselineMinutes,ratio,lastActivityAt,finished,alive})),
      problems:reasons,open:[...paced.packages.filter(item=>item.ratio>=OVERDUE_RATIO).map(item=>'overdue:'+item.id),...paced.packages.filter(item=>item.baselineMissing).map(item=>'baseline_missing:'+item.id),
        ...paced.packages.filter(quietProcess).map(item=>'process_stalled:'+item.id),...paced.packages.filter(item=>item.finished).map(item=>'snapshot_stale:'+item.id),
        ...stuck.map(item=>'executor_blocked:'+item.command.slice(0,60))]})+'\n');
  }
  if(!reasons.length)return null;
  return {reasons,pace:paced,overdue:overdue.map(item=>item.id),baselineMissing:baselineMissing.map(item=>item.id),processStalled:processStalled.map(item=>item.id),
    failedCommands:repeated.map(([command,item])=>({command,count:item.count,lastAt:item.lastAt})),executorBlocked:blocked,machineSlept:slept,resourceUnderused:resources};
}
module.exports={check,tickSleep,kernelSleep,paceNow,snapshotOf,executorLog,readExecutor,commandsOf};
