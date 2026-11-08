#!/usr/bin/env node
// Run only from the executor's own Bash. Own-session inbox delivery and native Bash completion both return there.
// The supervisor's watcher never receives or reuses this process's inbox token.
const fs=require('node:fs'),path=require('node:path'),net=require('node:net'),crypto=require('node:crypto');
const {read,need,hash,validateContract}=require('./guard.cjs');
const completion=require('./execution-wake.cjs'),pace=require('./pace.cjs');
const {ownerAlive}=require('./handoff-lib.cjs');
const uuid=/^[a-f0-9-]{36}$/;
const digest=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const save=(file,value)=>{fs.writeFileSync(file+'.tmp',JSON.stringify(value,null,2)+'\n',{mode:0o600});fs.renameSync(file+'.tmp',file);};
const now=()=>new Date().toISOString();
function load(run){
  const binding=read(path.join(run,'binding.json'));
  need(binding.platform==='claude-code','Claude Desktop execution watch required');
  need(process.env.CLAUDE_SESSION_ID===binding.executorId,'Start execution-watch from the bound executor itself');
  const contract=path.join(run,'contract.json');need(hash(contract)===binding.contractSha256,'Locked contract changed');
  validateContract(read(contract),{run,binding});return binding;
}
function paths(run,id){need(uuid.test(id||''),'Execution watch needs its registered UUID');const dir=path.join(run,'execution-waits');return {dir,request:path.join(dir,id+'.json'),state:path.join(dir,'state-'+id+'.json'),receipt:path.join(dir,'receipt-'+id+'.json')};}
function request(run,id,binding){
  const p=paths(run,id),item=read(p.request),copy={...item};delete copy.sha256;
  need(item.id===id&&item.executorId===binding.executorId&&item.sha256===digest(copy),'Execution request changed or belongs to another executor');return item;
}
function snapshot(run,binding){try{return read(path.join(run,binding.dispatchAudit?.snapshot||'dispatch.json'));}catch{return null;}}
function alive(file){try{return ownerAlive(read(file).pid);}catch{return false;}}
function register(run,input){
  const binding=load(run),state=read(path.join(run,'daemon-state.json'));
  need(!fs.existsSync(path.join(run,'STOP'))&&state.phase!=='accepted','Stopped or accepted run');
  need(input.kind===undefined||['progress','waiting'].includes(input.kind),'Questions, blocks and submissions use the supervisor handoff');
  need(input&&typeof input.nextAction==='string'&&input.nextAction.trim(),'State the next execution action');
  need(input.kind==='progress'||Number.isFinite(input.waitMinutes)&&input.waitMinutes>0&&input.waitMinutes<=120,'Waiting needs the original bounded waitMinutes');
  const id=input.id||crypto.randomUUID(),p=paths(run,id);fs.mkdirSync(p.dir,{recursive:true});
  const item={id,executorId:binding.executorId,kind:input.kind==='progress'?'progress':'waiting',nextAction:input.nextAction,
    waitFor:input.waitFor||[],waitMinutes:input.waitMinutes??null,createdAt:now()};
  need(Array.isArray(item.waitFor),'waitFor must be a list');
  const check=completion.inspect(binding,{event:item},snapshot(run,binding),pace.agentRuns(binding));
  need(!check.issues.length,'Completion sources must be readable or safely observable within allowed roots');
  if(fs.existsSync(p.request)){
    const old=request(run,id,binding);need(old.nextAction===item.nextAction&&digest(old.waitFor)===digest(item.waitFor)&&old.kind===item.kind&&old.waitMinutes===item.waitMinutes,'Same execution watch ID has different work');
  }else fs.writeFileSync(p.request,JSON.stringify({...item,sha256:digest(item)},null,2)+'\n',{flag:'wx',mode:0o600});
  const lock=path.join(run,'execution-watcher.lock');
  return {id,request:p.request,watcherAlive:alive(lock),watchArgv:[process.execPath,__filename,'watch',run],
    event:{kind:item.kind,nextAction:item.nextAction,...(item.waitMinutes?{waitMinutes:item.waitMinutes}:{}),executionWatch:id,waitFor:item.waitFor}};
}
function receipt(run,id){
  const binding=load(run),item=request(run,id,binding),p=paths(run,id),result=read(p.state);
  need(result.readyAt&&result.requestSha256===item.sha256,'No matching completion result to receive');
  const value={id,executorId:binding.executorId,requestSha256:item.sha256,receivedAt:now()};
  if(!fs.existsSync(p.receipt))fs.writeFileSync(p.receipt,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
  return read(p.receipt);
}
// Official own-child inbox protocol: auth JSONL, then a user message. Written is not a model-read receipt.
function sendOwn(message,env=process.env){
  if(!env.CLAUDE_CODE_MESSAGING_SOCKET||!env.CLAUDE_CODE_MESSAGING_TOKEN)return Promise.resolve(false);
  return new Promise(resolve=>{
    let settled=false;const finish=value=>{if(settled)return;settled=true;resolve(value);};
    const socket=net.createConnection(env.CLAUDE_CODE_MESSAGING_SOCKET);
    socket.setTimeout(15000,()=>{socket.destroy();finish(false);});
    socket.on('error',()=>finish(false));
    socket.on('connect',()=>socket.end(JSON.stringify({type:'auth',token:env.CLAUDE_CODE_MESSAGING_TOKEN})+'\n'+
      JSON.stringify({type:'user',message:{role:'user',content:message}})+'\n',()=>{finish(true);socket.unref();}));
  });
}
async function watch(run){
  const binding=load(run),lock=path.join(run,'execution-watcher.lock'),dir=path.join(run,'execution-waits');
  fs.mkdirSync(dir,{recursive:true});
  if(alive(lock))return {alreadyRunning:true};
  if(fs.existsSync(lock))fs.unlinkSync(lock);
  fs.writeFileSync(lock,JSON.stringify({pid:process.pid,executorId:binding.executorId,at:now()})+'\n',{flag:'wx',mode:0o600});
  const receiptsFile=path.join(run,'execution-wake-receipts.json');
  let receipts={};try{receipts=read(receiptsFile);}catch{}
  const stopped=()=>fs.existsSync(path.join(run,'STOP'))||read(path.join(run,'daemon-state.json')).phase==='accepted';
  try{
    while(!stopped()){
      if(!fs.existsSync(path.join(run,'PAUSED.json'))&&!fs.existsSync(path.join(run,'contract-update.lock'))){
        for(const name of fs.readdirSync(dir).filter(name=>uuid.test(name.slice(0,-5))&&name.endsWith('.json'))){
          const id=name.slice(0,-5),item=request(run,id,binding),p=paths(run,id);
          if(fs.existsSync(p.receipt))continue;
          let status={};try{status=read(p.state);}catch{}
          if(status.socketWrittenAt||status.fallbackAt)continue; // uncertain delivery is reconciled, never blindly resent
          const inspection=completion.inspect(binding,{event:item},snapshot(run,binding),pace.agentRuns(binding),receipts);
          const due=item.kind==='progress'||Date.now()>=Date.parse(item.createdAt)+item.waitMinutes*60000;
          if(inspection.blocked||item.kind!=='progress'&&!inspection.ready.length&&!(due&&!inspection.observable))continue;
          if(stopped()||fs.existsSync(path.join(run,'PAUSED.json'))||fs.existsSync(path.join(run,'contract-update.lock')))break;
          load(run);
          const marker='LONG_TASK_EXECUTION_RESUME:'+id;
          const prompt=marker+'\n'+completion.prompt(item,inspection)+'\n先讀 '+p.state+'，再以此參數陣列執行收件命令：'+
            JSON.stringify([process.execPath,__filename,'receipt',run,id])+'；收件不是驗收通過。';
          status={id,requestSha256:item.sha256,readyAt:now(),sources:inspection.ready,prompt};save(p.state,status);
          if(await sendOwn(prompt)){
            status.socketWrittenAt=now();save(p.state,status);
            for(const source of inspection.ready)receipts[source.key]={id,transportWrittenAt:status.socketWrittenAt};save(receiptsFile,receipts);
          }else{
            status.fallbackAt=now();save(p.state,status);
            // Exiting this executor-owned background Bash invokes only its own native task-completion notification.
            console.log(prompt);return {fallback:true,id};
          }
        }
      }
      // Same bounded local cadence as the existing Claude watcher; no model or cross-session API polling.
      await completion.waitChange(2000,()=>{
        const candidates=[];const files=[];
        if(!fs.existsSync(path.join(run,'PAUSED.json'))){
          for(const name of fs.readdirSync(dir).filter(name=>uuid.test(name.slice(0,-5))&&name.endsWith('.json'))){
            const id=name.slice(0,-5),p=paths(run,id);if(fs.existsSync(p.receipt))continue;
            let state={};try{state=read(p.state);}catch{}
            if(state.socketWrittenAt||state.fallbackAt)continue;
            const item=request(run,id,binding),found=completion.inspect(binding,{event:item},snapshot(run,binding),pace.agentRuns(binding),receipts);
            candidates.push(...found.ready);files.push(...found.files);
          }
        }
        return {ready:candidates,files};
      },[path.join(run,binding.dispatchAudit?.snapshot||'dispatch.json')]);
    }
    return {stopped:true};
  }finally{try{if(read(lock).pid===process.pid)fs.unlinkSync(lock);}catch{}}
}
module.exports={register,receipt,watch,sendOwn,request,paths};
if(require.main===module)(async()=>{
  try{
    const [command,runArg,input]=process.argv.slice(2);need(runArg&&path.isAbsolute(runArg),'Absolute run required');const run=path.resolve(runArg);
    const value=command==='register'?register(run,read(input)):command==='receipt'?receipt(run,input):command==='watch'?await watch(run):null;
    need(value,'Commands: register RUN INPUT_JSON, watch RUN, receipt RUN ID');
    if(command!=='watch')console.log(JSON.stringify(value));
  }catch(error){console.error(error.message);process.exitCode=1;}
})();
