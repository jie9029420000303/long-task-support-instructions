#!/usr/bin/env node
// Watch one desktop executor until its next completed turn; App background Bash wakes the supervisor.
const fs=require('node:fs');
const checkedWait=require('./checked-wait.cjs');
const path=require('node:path');
const {hash,read,need,validateContract,PROGRESS_REVIEW_MS,deliveredText,subagentActivityAt}=require('./guard.cjs');
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
      if(state.repeatedProgress>=3)event.kind='stalled';
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
      for(const [id,item] of Object.entries(state.unconfirmedDeliveries||{})){
        if(text&&item.requires.every(value=>text.includes(value))){
          (state.confirmedDeliveries||={})[id]={messageId:item.messageId,queuedAt:item.queuedAt,confirmedAt:now(),row:row.uuid||row.type};
          delete state.unconfirmedDeliveries[id];
        }
      }
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
    if(!state.pending&&!state.message?.finalId){const audit=inspectDispatch(run,binding,state),auditEvent=dispatchEvent(audit);if(auditEvent){
      auditEvent.preflightArgv=[process.execPath,path.join(__dirname,'supervise.cjs'),'dispatch-preflight',run,auditEvent.id];
      markAnnounced(state,auditEvent);state.pendingSupervisorOffset=binding.supervisorLog?fs.statSync(binding.supervisorLog).size:null;state.pending=auditEvent;state.phase='awaiting_decision';checkpoint();
      console.log('LONG_TASK_WAKE '+JSON.stringify(auditEvent));return;
    }}
    if(state.progressWait&&Date.now()>=state.progressWait.deadline){
      const event={...state.progressWait.event,kind:'continue'};
      state.progressWait=null;state.pendingSupervisorOffset=binding.supervisorLog?fs.statSync(binding.supervisorLog).size:null;state.pending=event;state.phase='awaiting_decision';checkpoint();
      console.log('LONG_TASK_WAKE '+JSON.stringify(event));
      return;
    }
    const hadCheckedWait=Boolean(state.checkedWait);
    checkedWait.supervisorInput(state,binding);
    state.lastSubagentActivityAt=Math.max(state.lastSubagentActivityAt||0,subagentActivityAt(binding));
    if(!checkedWait.unchanged(state)&&(hadCheckedWait||Date.now()-Math.max(state.lastExecutorActivityAt,state.lastSubagentActivityAt,state.lastProgressReviewAt||0)>=PROGRESS_REVIEW_MS)){
      state.progressReviewSequence=(state.progressReviewSequence||0)+1;
      const event={id:'progress-review-'+digest({executorId:binding.executorId,sequence:state.progressReviewSequence}).slice(0,24),
        kind:'progress_review',lastExecutorActivityAt:new Date(state.lastExecutorActivityAt).toISOString(),
        lastSubagentActivityAt:state.lastSubagentActivityAt?new Date(state.lastSubagentActivityAt).toISOString():null,
        unconfirmedDeliveries:state.unconfirmedDeliveries||{},at:now()};
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
