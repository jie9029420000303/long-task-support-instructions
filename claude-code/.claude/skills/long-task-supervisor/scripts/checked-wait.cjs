// A checked wait suppresses redundant model reviews, never event consumption.
const fs=require('node:fs'),crypto=require('node:crypto'),path=require('node:path');
const sha=file=>fs.existsSync(file)?crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'):null;
function validateWait(config,wait){
  const need=(ok,message)=>{if(!ok)throw Error(message);};
  need(wait&&['user_approval','external_result'].includes(wait.kind),'Checked wait needs user_approval or external_result kind');
  need(Array.isArray(wait.conditions),'Checked wait needs explicit conditions');
  for(const item of wait.conditions){
    need(item&&path.isAbsolute(item.path)&&config.allowedRoots?.some(root=>{const rel=path.relative(root,item.path);return rel===''||(!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel));}),'Wait condition outside allowed roots');
    need((item.sha256===null||/^[a-f0-9]{64}$/.test(item.sha256))&&sha(item.path)===item.sha256,'Wait condition missing or changed');
  }
  if(wait.resumeAt!==undefined)need(Number.isFinite(Date.parse(wait.resumeAt))&&Date.parse(wait.resumeAt)>Date.now(),'Wait resumeAt must be a future, source-backed deadline');
  need(wait.kind==='user_approval'||wait.conditions.length||wait.resumeAt,'External wait needs an observable result or deadline');
  return wait;
}
function remember(state,decision,binding){
  if(!decision.wait)return;
  state.checkedWait={...decision.wait,eventId:decision.eventId,executorMarker:state.lastExecutorActivityMarker,
    supervisorMarker:state.pendingSupervisorInputMarker===undefined?state.lastSupervisorInputMarker:state.pendingSupervisorInputMarker,executorAt:state.lastExecutorActivityAt};
  if(binding.supervisorLog)state.checkedWait.supervisorOffset=state.pendingSupervisorOffset??fs.statSync(binding.supervisorLog).size;
}
function unchanged(state,now=Date.now()){
  const wait=state.checkedWait;if(!wait)return false;
  let changed=wait.executorMarker!==state.lastExecutorActivityMarker||(wait.supervisorMarker||null)!==(state.lastSupervisorInputMarker||null)||wait.executorAt!==state.lastExecutorActivityAt;
  if(wait.resumeAt&&now>=Date.parse(wait.resumeAt))changed=true;
  try{if(wait.conditions.some(item=>sha(item.path)!==item.sha256))changed=true;}catch{changed=true;}
  if(changed){delete state.checkedWait;state.lastProgressReviewAt=0;return false;}
  return true;
}
function supervisorInput(state,binding){
  const wait=state.checkedWait;if(!wait||!binding.supervisorLog)return;
  const end=fs.statSync(binding.supervisorLog).size,start=wait.supervisorOffset;
  if(end<start){delete state.checkedWait;state.lastProgressReviewAt=0;return;}
  if(end===start)return;
  const fd=fs.openSync(binding.supervisorLog,'r'),buffer=Buffer.alloc(end-start);
  try{fs.readSync(fd,buffer,0,buffer.length,start);}finally{fs.closeSync(fd);}
  const complete=buffer.lastIndexOf(10);if(complete<0)return;
  wait.supervisorOffset=start+complete+1;
  const human=buffer.subarray(0,complete).toString('utf8').split('\n').some(line=>{
    try{const row=JSON.parse(line),content=row.message?.content;return row.type==='user'&&!row.isSidechain&&!row.origin&&
      (typeof content==='string'||Array.isArray(content)&&content.some(block=>block.type==='text'));}catch{return false;}
  });
  if(human){delete state.checkedWait;state.lastProgressReviewAt=0;}
}
function observeSupervisorInput(state,detail){
  const turn=detail.turns?.[0];
  const human=turn?.items?.filter(item=>item.type==='userMessage'&&!JSON.stringify(item).includes('LONG_TASK_DELIVERY:')).at(-1);
  if(human)state.lastSupervisorInputMarker=human.id||turn.id;
}
module.exports={validateWait,remember,unchanged,supervisorInput,observeSupervisorInput};
