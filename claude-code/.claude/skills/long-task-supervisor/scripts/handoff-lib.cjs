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
  need(hash(contract)===binding.contractSha256,'Locked contract changed');validateContract(read(contract));
  return {binding,state:read(path.join(run,'daemon-state.json'))};
}
function stopped(run,state){return fs.existsSync(path.join(run,'STOP'))||state.phase==='accepted';}
function persist(run,state,event){
  need(!stopped(run,state),'Stopped or accepted run cannot accept a handoff');
  const eventHash=digest(event),prior=state.handoffEvents?.[event.id];
  need(!prior||prior===eventHash,'Same handoff ID has different content');
  if(state.seen?.includes(event.id)||state.resolved?.[event.id])return {alreadyProcessed:true,eventHash};
  need(!state.pending||state.pending.id===event.id,'Another event is already pending');
  if(state.pending){need(digest(state.pending)===eventHash,'Same pending ID has different content');return {existingPending:true,eventHash};}
  const binding=read(path.join(run,'binding.json'));
  if(binding.supervisorLog)state.pendingSupervisorOffset=fs.statSync(binding.supervisorLog).size;
  (state.handoffEvents||={})[event.id]=eventHash;state.pending=event;state.phase='awaiting_decision';
  save(path.join(run,'daemon-state.json'),state);
  return {existingPending:false,eventHash};
}
function ownerAlive(pid,signal=process.kill){try{signal(pid,0);return true;}catch(error){if(error?.code==='ESRCH')return false;if(error?.code==='EPERM')return true;throw error;}}
module.exports={digest,save,validateEvent,eventLine,loadRun,stopped,persist,ownerAlive};
