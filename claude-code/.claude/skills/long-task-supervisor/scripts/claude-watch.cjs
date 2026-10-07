#!/usr/bin/env node
// Watch one desktop executor until its next completed turn; App background Bash wakes the supervisor.
const fs=require('node:fs');
const checkedWait=require('./checked-wait.cjs');
const path=require('node:path');
const {hash,read,need,validateContract,PROGRESS_REVIEW_MS,REVIEW_INTERVAL_MS,OVERDUE_RATIO,REPEAT_FAILURES,BLOCKED_MS,SLEEP_NOTICE_MS,deliveredText,subagentActivityAt}=require('./guard.cjs');
const {execFileSync}=require('node:child_process');
const pace=require('./pace.cjs');
const {inspect:inspectDispatch,eventFor:dispatchEvent,markAnnounced}=require('./dispatch-audit.cjs');
const {digest,persist,ownerAlive}=require('./handoff-lib.cjs');
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
function handoffRequest(){
  const names=fs.readdirSync(run).filter(name=>/^handoff-request-[a-f0-9-]{36}\.json$/.test(name)).sort();
  if(!names.length)return false;
  const request=read(path.join(run,names[0])),event=read(request.eventFile);
  need(digest(event)===request.eventHash,'Handoff event changed after request');
  const result=persist(run,state,event);state=read(statePath);
  need(!result.alreadyProcessed,'Processed handoff cannot be pending again');
  save(path.join(run,'handoff-ack-'+event.id+'.json'),{pending:true,...result,at:now()});
  fs.unlinkSync(path.join(run,names[0]));
  return true;
}
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
    need(typeof value.id==='string'&&/^[a-f0-9-]{36}$/.test(value.id),'Invalid explicit event ID');
    need(Boolean(state.handoffEvents?.[value.id]),'Explicit event ID has no persisted handoff');
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
function trackTools(row){
  if(row.isSidechain||!Array.isArray(row.message?.content))return;
  for(const block of row.message.content){
    if(row.type==='assistant'&&block?.type==='tool_use'&&typeof block.input?.command==='string')(state.openTools||={})[block.id]={command:block.input.command.replace(/\s+/g,' ').trim().slice(0,300),at:row.timestamp||now(),background:Boolean(block.input.run_in_background)};
    if(row.type==='user'&&block?.type==='tool_result'&&state.openTools?.[block.tool_use_id]!==undefined){
      const open=state.openTools[block.tool_use_id],command=typeof open==='string'?open:open.command;delete state.openTools[block.tool_use_id];
      if(block.is_error||/Exit code [1-9]/.test(JSON.stringify(block.content||'').slice(0,80))){const item=((state.failedCommands||={})[command]||={count:0});item.count++;item.lastAt=row.timestamp||now();}
    }
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
function supervisorClock(){
  if(Date.now()-lastClockAt<60000)return null;
  lastClockAt=Date.now();
  const snapshot=snapshotNow(),paced=paceNow(snapshot),announced=state.clockAnnounced||={};
  if(paced.processActivityAt)state.lastProcessActivityAt=Math.max(state.lastProcessActivityAt||0,paced.processActivityAt);
  const once=key=>announced[key]?false:(announced[key]=now(),true);
  const overdue=paced.packages.filter(item=>item.ratio>=OVERDUE_RATIO&&once('overdue:'+item.id+'@'+item.startedAt));
  const baselineMissing=paced.packages.filter(item=>item.baselineMissing&&once('baseline:'+item.id));
  const quietProcess=item=>item.process&&item.alive!==true&&item.lastActivityAt&&Date.now()-Date.parse(item.lastActivityAt)>=PROGRESS_REVIEW_MS;
  const processStalled=paced.packages.filter(item=>quietProcess(item)&&once('process:'+item.id+'@'+item.lastActivityAt));
  const blocked=blockedTools().filter(item=>once('blocked:'+item.id));
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
        ...blockedTools().map(item=>'executor_blocked:'+item.command.slice(0,60))]})+'\n');
  }
  if(!reasons.length)return null;
  return {reasons,pace:paced,overdue:overdue.map(item=>item.id),baselineMissing:baselineMissing.map(item=>item.id),processStalled:processStalled.map(item=>item.id),
    failedCommands:repeated.map(([command,item])=>({command,count:item.count,lastAt:item.lastAt})),executorBlocked:blocked,machineSlept:slept,resourceUnderused:resources};
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
  validateContract(read(contractPath));
  need(hash(path.join(run,'executor-prompt.txt'))===binding.promptSha256,'Executor prompt changed');
  if(stopped()){state.phase='stopped';checkpoint();return;}
  state.pid=process.pid;state.phase='watching';checkpoint();
  save(readyPath,{pid:process.pid,executorId:binding.executorId,executorDesktopId:binding.executorDesktopId,readVerified:true,at:now()});
  let lastGrowthAt=Date.now();
  state.lastExecutorActivityAt ||= Math.max(Date.parse(binding.createdAt)||0,fs.statSync(binding.executorLog).mtimeMs);
  kernelSleep();
  // Whether the executor has been told this run: its transcript names the run path (the binding message).
  if(state.executorKnowsRun===undefined&&logMentions(binding.executorLog,run))state.executorKnowsRun=true;
  function finishFinal(){
    const final=state.message;
    state.message=null;
    state.executorOffset=final.finalEnd;
    const event=eventOf(final.texts.join('\n'),final.finalId);
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
    console.log('LONG_TASK_WAKE '+JSON.stringify(event));
    return true;
  }
  while(!stopped()){
    tickSleep();
    if(handoffRequest()){console.log('LONG_TASK_WAKE '+JSON.stringify(state.pending));return;}
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
      trackTools(row);
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
    if(!state.pending&&!state.message?.finalId){const audit=inspectDispatch(run,binding,state);
      if(!state.executorKnowsRun&&Date.now()-(Date.parse(binding.createdAt)||0)<PROGRESS_REVIEW_MS)audit.newIssues=audit.newIssues.filter(item=>item.kind!=='snapshot_missing');
      const auditEvent=dispatchEvent(audit);if(auditEvent){
      auditEvent.preflightArgv=[process.execPath,path.join(__dirname,'supervise.cjs'),'dispatch-preflight',run,auditEvent.id];
      markAnnounced(state,auditEvent);state.pendingSupervisorOffset=binding.supervisorLog?fs.statSync(binding.supervisorLog).size:null;state.pending=auditEvent;state.phase='awaiting_decision';checkpoint();
      console.log('LONG_TASK_WAKE '+JSON.stringify(auditEvent));return;
    }}
    if(state.progressWait&&Date.now()>=state.progressWait.deadline){
      const event={...state.progressWait.event,kind:'continue',declaredAt:state.progressWait.event.at,dueAt:new Date(state.progressWait.deadline).toISOString(),at:now()};
      state.progressWait=null;state.pendingSupervisorOffset=binding.supervisorLog?fs.statSync(binding.supervisorLog).size:null;state.pending=event;state.phase='awaiting_decision';checkpoint();
      console.log('LONG_TASK_WAKE '+JSON.stringify(event));
      return;
    }
    const hadCheckedWait=Boolean(state.checkedWait);
    checkedWait.supervisorInput(state,binding);
    state.lastSubagentActivityAt=Math.max(state.lastSubagentActivityAt||0,subagentActivityAt(binding));
    // An executor's declared wait no longer silences the supervisor (Jay 2026-10-07): silence, an overdue or
    // unbaselined package, a stalled test process and repeated failures each start a check while work goes on.
    const held=checkedWait.unchanged(state);
    const clock=supervisorClock();
    // Quiet means nothing moves at all: the executor, its subagents and the test processes it runs.
    const silent=!held&&(hadCheckedWait||Date.now()-Math.max(state.lastExecutorActivityAt,state.lastSubagentActivityAt,state.lastProcessActivityAt||0,state.lastProgressReviewAt||0)>=PROGRESS_REVIEW_MS);
    if(silent||clock){
      state.progressReviewSequence=(state.progressReviewSequence||0)+1;
      const reasons=[...(silent?[hadCheckedWait?'wait_changed':'silence']:[]),...(clock?.reasons||[])];
      const event={id:'progress-review-'+digest({executorId:binding.executorId,sequence:state.progressReviewSequence}).slice(0,24),
        kind:'progress_review',reasons,lastExecutorActivityAt:new Date(state.lastExecutorActivityAt).toISOString(),
        lastSubagentActivityAt:state.lastSubagentActivityAt?new Date(state.lastSubagentActivityAt).toISOString():null,
        lastProcessActivityAt:state.lastProcessActivityAt?new Date(state.lastProcessActivityAt).toISOString():null,
        unconfirmedDeliveries:state.unconfirmedDeliveries||{},pace:clock?.pace||paceNow(),overdue:clock?.overdue||[],
        baselineMissing:clock?.baselineMissing||[],processStalled:clock?.processStalled||[],executorBlocked:clock?.executorBlocked||[],
        machineSlept:clock?.machineSlept||[],resourceUnderused:clock?.resourceUnderused||[],
        failedCommands:clock?.failedCommands||[],declaredWaitMinutes:state.progressWait?.event?.waitMinutes??null,at:now()};
      state.pendingSupervisorOffset=binding.supervisorLog?fs.statSync(binding.supervisorLog).size:null;state.pending=event;state.phase='awaiting_decision';checkpoint();
      console.log('LONG_TASK_WAKE '+JSON.stringify(event));
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
