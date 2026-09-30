#!/usr/bin/env node
const fs=require('node:fs');
const path=require('node:path');
const {read,need}=require('./guard.cjs');
const {digest,save,validateEvent,eventLine,loadRun,stopped,persist,ownerAlive}=require('./handoff-lib.cjs');
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
  const eventHash=digest(event),eventFile=path.join(run,'handoff-'+event.id+'.json'),request=path.join(run,'handoff-request-'+event.id+'.json'),ack=path.join(run,'handoff-ack-'+event.id+'.json'),lock=path.join(run,'watcher.lock');
  if(fs.existsSync(eventFile))need(digest(read(eventFile))===eventHash,'Same handoff ID has different content');
  else fs.writeFileSync(eventFile,JSON.stringify(event,null,2)+'\n',{flag:'wx'});
  let result;
  if(lockAlive(lock)){
    if(!fs.existsSync(request))fs.writeFileSync(request,JSON.stringify({id:event.id,eventFile,eventHash,at:now()},null,2)+'\n',{flag:'wx'});
    const end=Date.now()+Number(process.env.CLAUDE_HANDOFF_WAIT_MS||5000);
    while(Date.now()<end&&!fs.existsSync(ack))await sleep(50);
    need(fs.existsSync(ack),'Handoff pending receipt timed out; inspect '+request+' and do not resend');
    result=read(ack);need(result.eventHash===eventHash&&result.pending===true,'Invalid handoff pending receipt');
  }else{
    try{acquire(lock);}catch{throw Error('Watcher ownership changed; retry only after inspecting '+eventFile);}
    try{const current=read(path.join(run,'daemon-state.json'));result={pending:true,...persist(run,current,event),at:now()};save(ack,result);if(fs.existsSync(request))fs.unlinkSync(request);}finally{try{if(read(lock).pid===process.pid)fs.unlinkSync(lock);}catch{}}
  }
  const latest=read(path.join(run,'daemon-state.json'));need(!stopped(run,latest),'Run stopped before notification qualification');
  need(latest.pending?.id===event.id&&digest(latest.pending)===eventHash,'Pending receipt no longer matches handoff event');
  need(!result.alreadyProcessed,'Processed handoff cannot issue a new notification');
  const marker='LONG_TASK_HANDOFF:'+event.id+':'+eventHash,notification=path.join(run,'handoff-notification-'+event.id+'.json');
  const finalEventLine=eventLine(event);
  if(fs.existsSync(notification)){
    const prior=read(notification);need(prior.eventSha256===eventHash,'Notification belongs to different event content');
    console.log(JSON.stringify({ready:false,eventId:event.id,eventSha256:eventHash,retryAllowed:false,reconcile:[eventFile,ack,notification,path.join(run,'daemon-state.json')]}));return;
  }
  try{fs.writeFileSync(notification,JSON.stringify({eventId:event.id,eventSha256:eventHash,status:'issued',targetDesktopId:binding.supervisorDesktopId,marker,at:now()},null,2)+'\n',{flag:'wx'});}catch(error){if(error.code!=='EEXIST')throw error;const prior=read(notification);need(prior.eventSha256===eventHash,'Notification belongs to different event content');console.log(JSON.stringify({ready:false,eventId:event.id,eventSha256:eventHash,retryAllowed:false,reconcile:[eventFile,ack,notification,path.join(run,'daemon-state.json')]}));return;}
  console.log(JSON.stringify({ready:true,eventId:event.id,eventSha256:eventHash,finalEventLine,targetDesktopId:binding.supervisorDesktopId,targetSessionId:binding.supervisorId,marker,message:marker+'\n長任務事件已持久化。run='+run+' event='+eventFile+' ack='+ack,run,eventFile,pendingReceipt:ack,notification,state:path.join(run,'daemon-state.json')}));
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
