const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {hash,read,need,validateContract}=require('./guard.cjs');
const digest=value=>{const copy={...value};delete copy.at;return crypto.createHash('sha256').update(JSON.stringify(copy)).digest('hex');};
function save(file,value){fs.writeFileSync(file+'.tmp',JSON.stringify(value,null,2)+'\n');fs.renameSync(file+'.tmp',file);}
function validateEvent(value){
  need(value&&typeof value.id==='string'&&/^[a-f0-9-]{36}$/.test(value.id),'Handoff event needs a stable UUID id');
  need(['question','blocked','submission'].includes(value.kind),'Invalid handoff event kind');
  need(typeof value.text==='string'&&value.text.trim(),'Handoff event needs complete non-empty text');
  if(value.kind==='submission')need(/^sha256:[a-f0-9]{64}$/.test(value.revision||'')&&path.isAbsolute(value.manifest||''),'Invalid handoff submission');
  const line=eventLine(value),lines=value.text.split('\n'),index=lines.findLastIndex(item=>item.trim().startsWith('LONG_TASK_EVENT '));
  if(index===-1)lines.push(line);else lines[index]=line;
  return {id:value.id,kind:value.kind,revision:value.revision||null,manifest:value.manifest||null,
    nextAction:value.nextAction||null,waitMinutes:Number.isFinite(value.waitMinutes)?value.waitMinutes:null,
    text:lines.join('\n'),at:value.at||new Date().toISOString()};
}
function eventLine(value){const item={id:value.id,kind:value.kind,...(value.revision?{revision:value.revision}:{}),...(value.manifest?{manifest:value.manifest}:{})};return 'LONG_TASK_EVENT '+JSON.stringify(item);}
function loadRun(run){
  const binding=read(path.join(run,'binding.json')),contract=path.join(run,'contract.json');
  need(binding.platform==='claude-code','Claude Desktop run required');
  need(hash(contract)===binding.contractSha256,'Locked contract changed');validateContract(read(contract),{run,binding});
  return {binding,state:read(path.join(run,'daemon-state.json'))};
}
function stopped(run,state){return fs.existsSync(path.join(run,'STOP'))||state.phase==='accepted';}
// The supervisor handles one event at a time. Every executor handoff first enters this durable queue, one request file
// per event, oldest first, and becomes the pending event only when the slot is free: a second question or submission
// waits its turn instead of failing (2026-10-12/13 IA: 7 of 22 prepares refused with "Another event is already
// pending"; a question and a resubmission never reached the supervisor, the resubmission for at least 9.1 hours).
const REQUEST=/^handoff-request-([a-f0-9-]{36})\.json$/;
function queued(run){
  const items=[];
  for(const name of fs.readdirSync(run)){
    const match=REQUEST.exec(name);if(!match)continue;
    const file=path.join(run,name);
    try{items.push({...read(file),file,id:match[1]});}catch(error){items.push({file,id:match[1],at:'',broken:error.message});}
  }
  return items.sort((a,b)=>String(a.at||'').localeCompare(String(b.at||''))||a.id.localeCompare(b.id));
}
function enqueue(run,event,eventFile,eventHash){
  const file=path.join(run,'handoff-request-'+event.id+'.json');
  try{fs.writeFileSync(file,JSON.stringify({id:event.id,eventFile,eventHash,at:new Date().toISOString()},null,2)+'\n',{flag:'wx'});}
  catch(error){if(error.code!=='EEXIST')throw error;need(read(file).eventHash===eventHash,'Same handoff ID has different content');}
}
// Make the oldest queued event the pending one. The caller owns watcher.lock, so it is the only daemon-state writer, and
// passes its own state: the watcher's copy can hold changes not saved yet (a sleep its last tick measured), which a
// fresh read would lose. A request that cannot be delivered is set aside as .bad and reaches the supervisor as a
// protocol error, so one broken file never holds back the events behind it.
function promoteNext(run,state){
  for(;;){
    if(state.pending||stopped(run,state))return null;
    const next=queued(run)[0];if(!next)return null;
    let event,eventHash;
    try{
      need(!next.broken,'unreadable request ('+next.broken+')');
      event=read(next.eventFile);eventHash=digest(event);
      need(event.id===next.id&&eventHash===next.eventHash,'Handoff event changed after request');
      need(!state.handoffEvents?.[event.id]||state.handoffEvents[event.id]===eventHash,'Same handoff ID has different content');
    }catch(error){
      fs.renameSync(next.file,next.file+'.bad');
      event={id:'handoff-error-'+next.id,kind:'protocol_error',revision:null,manifest:null,nextAction:null,waitMinutes:null,
        text:'執行端交接的事件 '+next.id+' 無法送達（'+error.message+'），請求檔已改名為 '+path.basename(next.file)+'.bad；請查該事件檔與執行端最後回覆，必要時請執行端用新 ID 重送。',
        at:new Date().toISOString()};
      eventHash=digest(event);
      if(state.seen?.includes(event.id)||state.resolved?.[event.id])continue;
    }
    if(state.seen?.includes(event.id)||state.resolved?.[event.id]){fs.unlinkSync(next.file);continue;} // a processed event sent again
    const binding=read(path.join(run,'binding.json'));
    if(binding.supervisorLog)state.pendingSupervisorOffset=fs.statSync(binding.supervisorLog).size;
    (state.handoffEvents||={})[event.id]=eventHash;state.pending=event;state.phase='awaiting_decision';state.lastRealEventAt=Date.now();
    save(path.join(run,'daemon-state.json'),state);
    save(path.join(run,'handoff-ack-'+event.id+'.json'),{pending:true,eventHash,at:new Date().toISOString()});
    if(fs.existsSync(next.file))fs.unlinkSync(next.file);
    return event;
  }
}
function ownerAlive(pid,signal=process.kill){try{signal(pid,0);return true;}catch(error){if(error?.code==='ESRCH')return false;if(error?.code==='EPERM')return true;throw error;}}
module.exports={digest,save,validateEvent,eventLine,loadRun,stopped,queued,enqueue,promoteNext,ownerAlive};
