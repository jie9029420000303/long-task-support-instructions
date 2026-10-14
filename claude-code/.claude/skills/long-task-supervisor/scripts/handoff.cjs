#!/usr/bin/env node
const fs=require('node:fs');
const path=require('node:path');
const {read,need}=require('./guard.cjs');
const {digest,save,validateEvent,eventLine,loadRun,stopped,queued,enqueue,promoteNext,ownerAlive}=require('./handoff-lib.cjs');
const [command,runArg,inputArg]=process.argv.slice(2),run=runArg&&path.resolve(runArg);
const now=()=>new Date().toISOString();
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function lockAlive(file){return fs.existsSync(file)&&ownerAlive(read(file).pid);}
function acquire(lock){
  if(fs.existsSync(lock)&&!lockAlive(lock)){const stale=read(lock);if(fs.existsSync(lock)&&read(lock).pid===stale.pid)fs.unlinkSync(lock);}
  fs.writeFileSync(lock,JSON.stringify({pid:process.pid,run,kind:'handoff',at:now()}),{flag:'wx'});
}
async function prepare(){
  need(run&&path.isAbsolute(runArg||'')&&path.isAbsolute(inputArg||''),'Usage: handoff.cjs prepare ABS_RUN ABS_EVENT_JSON');
  const event=validateEvent(read(inputArg)),{binding,state}=loadRun(run);need(!stopped(run,state),'Stopped or accepted run cannot accept a handoff');
  const eventHash=digest(event),eventFile=path.join(run,'handoff-'+event.id+'.json'),ack=path.join(run,'handoff-ack-'+event.id+'.json'),lock=path.join(run,'watcher.lock'),statePath=path.join(run,'daemon-state.json');
  if(fs.existsSync(eventFile))need(digest(read(eventFile))===eventHash,'Same handoff ID has different content');
  else fs.writeFileSync(eventFile,JSON.stringify(event,null,2)+'\n',{flag:'wx'});
  need(!state.handoffEvents?.[event.id]||state.handoffEvents[event.id]===eventHash,'Same handoff ID has different content');
  need(!state.seen?.includes(event.id)&&!state.resolved?.[event.id],'Processed handoff cannot issue a new notification');
  // Every event enters the durable queue first; it becomes pending when the supervisor has no event in hand. A second
  // event while one is pending waits its turn instead of failing.
  if(state.pending?.id!==event.id)enqueue(run,event,eventFile,eventHash);
  if(lockAlive(lock)){
    // The live watcher promotes the oldest queued event on its next check; a slow watcher only leaves this one queued.
    const end=Date.now()+Number(process.env.CLAUDE_HANDOFF_WAIT_MS||5000);
    while(Date.now()<end&&!fs.existsSync(ack))await sleep(50);
  }else if(!read(statePath).pending){
    // No watcher and a free slot: promote under the watcher lock. Losing the lock to a watcher just started leaves the
    // event queued for that watcher; never take the lock while the supervisor holds an event, as it re-arms the watcher.
    let owned=false;
    try{acquire(lock);owned=true;}catch{}
    if(owned)try{promoteNext(run,read(statePath));}finally{try{if(read(lock).pid===process.pid)fs.unlinkSync(lock);}catch{}}
  }
  const latest=read(statePath);need(!stopped(run,latest),'Run stopped before notification qualification');
  const pending=latest.pending?.id===event.id;
  if(pending)need(digest(latest.pending)===eventHash,'Pending receipt no longer matches handoff event');
  const position=queued(run).findIndex(item=>item.id===event.id)+1;
  need(pending||position>0,'Handoff is neither pending nor queued; inspect '+eventFile+' and daemon-state.json, and do not resend');
  const ahead=pending?null:{id:latest.pending?.id||null,kind:latest.pending?.kind||null,position};
  const marker='LONG_TASK_HANDOFF:'+event.id+':'+eventHash,notification=path.join(run,'handoff-notification-'+event.id+'.json');
  const finalEventLine=eventLine(event);
  if(fs.existsSync(notification)){
    const prior=read(notification);need(prior.eventSha256===eventHash,'Notification belongs to different event content');
    console.log(JSON.stringify({ready:false,eventId:event.id,eventSha256:eventHash,retryAllowed:false,reconcile:[eventFile,ack,notification,statePath]}));return;
  }
  try{fs.writeFileSync(notification,JSON.stringify({eventId:event.id,eventSha256:eventHash,status:'issued',targetDesktopId:binding.supervisorDesktopId,marker,at:now()},null,2)+'\n',{flag:'wx'});}catch(error){if(error.code!=='EEXIST')throw error;const prior=read(notification);need(prior.eventSha256===eventHash,'Notification belongs to different event content');console.log(JSON.stringify({ready:false,eventId:event.id,eventSha256:eventHash,retryAllowed:false,reconcile:[eventFile,ack,notification,statePath]}));return;}
  // A queued event still gets its one native notice: it wakes a supervisor that may not have woken for the event ahead.
  const message=pending?marker+'\n長任務事件已持久化。run='+run+' event='+eventFile+' ack='+ack
    :marker+'\n長任務事件已排隊（第 '+ahead.position+' 個；'+(ahead.id?'前面有待處理的 '+ahead.kind+' '+ahead.id:'背景監看尚未收件')+'）。run='+run+' event='+eventFile+
      '。執行 supervise.cjs context RUN '+event.id+' 會指出先處理哪個事件；決策後重掛 watcher，本事件依序送到。';
  console.log(JSON.stringify({ready:true,eventId:event.id,eventSha256:eventHash,finalEventLine,targetDesktopId:binding.supervisorDesktopId,targetSessionId:binding.supervisorId,marker,message,
    run,eventFile,queued:!pending,...(ahead?{ahead}:{}),pendingReceipt:pending?ack:null,notification,state:statePath}));
}
function receipt(){
  need(run&&path.isAbsolute(runArg||'')&&path.isAbsolute(inputArg||''),'Usage: handoff.cjs receipt ABS_RUN ABS_RECEIPT_JSON');
  const value=read(inputArg),status=value.status||value.delivery?.status,messageId=value.messageId||value.delivery?.messageId;
  need(typeof value.eventId==='string'&&['delivered','queued','unknown'].includes(status),'Invalid native delivery receipt');
  const eventFile=path.join(run,'handoff-'+value.eventId+'.json'),notification=path.join(run,'handoff-notification-'+value.eventId+'.json');need(fs.existsSync(eventFile)&&fs.existsSync(notification),'Unknown handoff notification');
  const issued=read(notification);need(value.marker===issued.marker,'Receipt marker mismatch');
  if(status!=='unknown')need(typeof messageId==='string'&&messageId.trim(),'Delivered or queued receipt needs messageId');
  const output=path.join(run,'handoff-delivery-'+value.eventId+'.json');need(!fs.existsSync(output),'Delivery already recorded; reconcile it instead of resending');
  save(output,{...value,status,messageId:messageId||null,eventSha256:digest(read(eventFile)),at:now()});
  console.log(JSON.stringify({recorded:true,status,retryAllowed:false,receipt:output,...(status==='unknown'?{reconcile:[eventFile,path.join(run,'daemon-state.json'),output]}:{})}));
}
(async()=>{try{if(command==='prepare')await prepare();else if(command==='receipt')receipt();else throw Error('Commands: prepare ABS_RUN ABS_EVENT_JSON; receipt ABS_RUN ABS_RECEIPT_JSON');}catch(error){console.error(error.message);process.exitCode=1;}})();
