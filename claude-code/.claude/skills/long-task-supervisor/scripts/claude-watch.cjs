#!/usr/bin/env node
// Watch one desktop executor until its next completed turn; App background Bash wakes the supervisor.
const fs=require('node:fs');
const path=require('node:path');
const {hash,read,need,validateContract}=require('./guard.cjs');
const run=path.resolve(process.argv[2]||'');
const binding=read(path.join(run,'binding.json'));
const statePath=path.join(run,'daemon-state.json');
const lockPath=path.join(run,'watcher.lock');
const readyPath=path.join(run,'native-ready.json');
const contractPath=path.join(run,'contract.json');
let state=read(statePath),ownsLock=false;
const now=()=>new Date().toISOString();
function save(file,value){fs.writeFileSync(file+'.tmp',JSON.stringify(value,null,2)+'\n');fs.renameSync(file+'.tmp',file);}
function checkpoint(){state.updatedAt=now();save(statePath,state);}
function stopped(){return fs.existsSync(path.join(run,'STOP'));}
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
  if(!value||!['progress','question','blocked','submission'].includes(value.kind))value={kind:line?'protocol_error':'unmarked_final'};
  if(value.kind==='progress'&&!(typeof value.nextAction==='string'&&value.nextAction.trim()))value={kind:'protocol_error'};
  if(value.kind==='submission'&&(!/^sha256:[a-f0-9]{64}$/.test(value.revision||'')||typeof value.manifest!=='string'))value={kind:'protocol_error'};
  return {id,kind:value.kind,revision:value.revision||null,manifest:value.manifest||null,
    nextAction:value.nextAction||null,waitMinutes:Number.isFinite(value.waitMinutes)?value.waitMinutes:null,
    text:text.slice(-8000),at:now()};
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
  need(binding.platform==='claude-code'&&binding.executorDesktopId,'Desktop executor binding required');
  need(hash(contractPath)===binding.contractSha256,'Locked contract changed');
  validateContract(read(contractPath));
  need(hash(path.join(run,'executor-prompt.txt'))===binding.promptSha256,'Executor prompt changed');
  need(!stopped(),'Run was stopped');
  need(!state.pending&&state.phase!=='accepted','Resolve the pending event before listening again');
  if(fs.existsSync(lockPath)){
    const old=read(lockPath);let alive=false;
    try{process.kill(old.pid,0);alive=true;}catch{}
    need(!alive,'Another desktop watcher owns this run');
    fs.unlinkSync(lockPath);
  }
  fs.writeFileSync(lockPath,JSON.stringify({pid:process.pid,run,at:now()}),{flag:'wx'});ownsLock=true;
  state.pid=process.pid;state.phase='watching';checkpoint();
  save(readyPath,{pid:process.pid,executorId:binding.executorId,executorDesktopId:binding.executorDesktopId,readVerified:true,at:now()});
  while(!stopped()){
    for(const {row,end} of readNew()){
      state.executorOffset=end;
      if(!row)continue;
      if(row.type==='user'&&row.origin?.kind==='human')state.turnText=[];
      if(row.type!=='assistant'||!row.message)continue;
      if(!row.uuid || row.isSidechain)continue;
      const own=(row.message.content||[]).filter(block=>block?.type==='text').map(block=>block.text);
      if(state.progressWait){state.progressWait=null;checkpoint();}
      if(own.length)state.turnText.push(...own);
      if(row.message.stop_reason!=='end_turn'||!state.turnText.join('').trim())continue;
      const event=eventOf(state.turnText.join('\n'),row.uuid);
      state.turnText=[];
      if(state.seen.includes(event.id))continue;
      if(event.kind==='progress'){
        state.repeatedProgress=state.lastProgressAction===event.nextAction?(state.repeatedProgress||0)+1:1;
        state.lastProgressAction=event.nextAction;
        if(state.repeatedProgress>=3)event.kind='stalled';
        else if(event.waitMinutes!==null){
          if(!(event.waitMinutes>0&&event.waitMinutes<=120)){event.kind='protocol_error';}
          else{state.progressWait={event,deadline:Date.now()+event.waitMinutes*60000};state.seen.push(event.id);checkpoint();continue;}
        }
      }
      state.pending=event;state.phase='awaiting_decision';checkpoint();
      console.log('LONG_TASK_WAKE '+JSON.stringify(event));
      return;
    }
    checkpoint();
    if(state.progressWait&&Date.now()>=state.progressWait.deadline){
      const event={...state.progressWait.event,kind:'continue'};
      state.progressWait=null;state.pending=event;state.phase='awaiting_decision';checkpoint();
      console.log('LONG_TASK_WAKE '+JSON.stringify(event));
      return;
    }
    await waitChange();
  }
  state.phase='stopped';checkpoint();
}
(async()=>{
  try{await watch();}
  catch(error){state.phase='error';state.error={message:error.message,at:now()};checkpoint();console.error(error.stack||error);process.exitCode=1;}
  finally{if(ownsLock){try{if(read(lockPath).pid===process.pid)fs.unlinkSync(lockPath);}catch{}}}
})();
