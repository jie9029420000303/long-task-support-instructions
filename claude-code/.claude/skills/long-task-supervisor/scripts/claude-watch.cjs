#!/usr/bin/env node
// One resident file watcher. Claude is invoked only after a bound turn ends.
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { hash, read, need, validateContract, validateDecision } = require('./guard.cjs');
const run = path.resolve(process.argv[2] || '');
const binding = read(path.join(run,'binding.json'));
const contractPath = path.join(run,'contract.json');
const statePath = path.join(run,'daemon-state.json');
const lockPath = path.join(run,'watcher.lock');
let state = read(statePath), ownsLock = false;
const now = () => new Date().toISOString();
const stopped = () => fs.existsSync(path.join(run,'STOP'));
function save(file, value) {fs.writeFileSync(file+'.tmp',JSON.stringify(value,null,2)+'\n');fs.renameSync(file+'.tmp',file);}
function checkpoint() {state.updatedAt=now();save(statePath,state);}
function checkSources() {need(hash(contractPath)===binding.contractSha256,'Locked contract changed');return validateContract(read(contractPath));}
function transcript(id) {
  const root=path.join(process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME,'.claude'),'projects');
  const found=[];
  for (const project of fs.readdirSync(root,{withFileTypes:true})) {
    if (!project.isDirectory()) continue;
    const file=path.join(root,project.name,id+'.jsonl');
    if (fs.existsSync(file)) found.push(file);
  }
  need(found.length===1,'Cannot find one exact Claude transcript for '+id);
  return found[0];
}
function take(file, offset) {
  const end=fs.statSync(file).size;
  if (end<offset) throw Error('Transcript was truncated');
  const fd=fs.openSync(file,'r'), chunk=Buffer.alloc(65536), lines=[];
  let position=offset, carry=Buffer.alloc(0);
  try {
    while (position<end) {
      const count=fs.readSync(fd,chunk,0,Math.min(chunk.length,end-position),position);
      if (!count) break;
      position+=count;
      const joined=Buffer.concat([carry,chunk.subarray(0,count)]);
      let start=0, newline;
      while ((newline=joined.indexOf(10,start))!==-1) {
        try {lines.push(JSON.parse(joined.subarray(start,newline).toString('utf8')));} catch {}
        start=newline+1;
      }
      carry=joined.subarray(start);
    }
  } finally {fs.closeSync(fd);}
  return {offset:position-carry.length,lines};
}
function finalEvents(lines) {
  return lines.filter(row => row.type==='assistant' && row.uuid && row.message?.stop_reason==='end_turn')
    .map(row => ({id:row.uuid,text:(row.message.content || []).filter(block=>block.type==='text').map(block=>block.text).join('\n')}));
}
function eventOf(final) {
  const line=final.text.split('\n').find(value=>value.startsWith('LONG_TASK_EVENT '));
  let item={kind:'unmarked_final'};
  if (line) {try {item=JSON.parse(line.slice('LONG_TASK_EVENT '.length));} catch {item={kind:'protocol_error'};}}
  if (!item || !['submission','question','blocked','progress'].includes(item.kind)) item={kind:line?'protocol_error':'unmarked_final'};
  if (item.kind==='submission' && (!/^sha256:[a-f0-9]{64}$/.test(item.revision) || typeof item.manifest!=='string')) item={kind:'protocol_error'};
  if (item.kind==='progress' && !(typeof item.nextAction==='string' && item.nextAction.trim())) item={kind:'protocol_error'};
  return {id:final.id,kind:item.kind,revision:item.revision||null,manifest:item.manifest||null,nextAction:item.nextAction||null,text:final.text.slice(0,8000),at:now()};
}
async function waitChange(file, ms=2000) {
  await new Promise(resolve=>{
    let watcher;
    const done=()=>{clearTimeout(timer);watcher?.close();resolve();};
    const timer=setTimeout(done,ms);
    try {watcher=fs.watch(path.dirname(file),done);watcher.on('error',()=>{watcher?.close();watcher=null;});} catch {}
  });
}
function promptSeen(file, marker) {
  if (!fs.existsSync(file)) return false;
  try {execFileSync('rg',['--quiet','--fixed-strings',marker,file],{timeout:10000});return true;} catch {return false;}
}
function promptCompleted(file, marker) {
  try {
    const located=execFileSync('rg',['--byte-offset','--only-matching','--fixed-strings',marker,file],{timeout:10000,encoding:'utf8'});
    const offset=Number(located.split('\n')[0].split(':')[0]);
    return Number.isSafeInteger(offset) && finalEvents(take(file,offset).lines).length>0;
  } catch {return false;}
}
async function invoke(id, prompt, key, initial=false) {
  const marker='LONG_TASK_DELIVERY:'+key;
  const full=marker+'\n'+prompt;
  let targetLog;
  try {targetLog=transcript(id);} catch {}
  if (state.inflight?.key===key && state.inflight.pid) {
    let alive=true;
    try {process.kill(state.inflight.pid,0);} catch {alive=false;}
    while (alive && !stopped()) {
      await waitChange(targetLog || binding.supervisorLog);
      try {process.kill(state.inflight.pid,0);} catch {alive=false;}
      try {targetLog=transcript(id);} catch {}
      if (targetLog && promptSeen(targetLog,marker)) break;
    }
  }
  if (state.messages.some(row=>row.key===key) || (targetLog && promptSeen(targetLog,marker))) {
    if (state.inflight?.key===key && state.inflight.pid) {
      let alive=true;try {process.kill(state.inflight.pid,0);} catch {alive=false;}
      need(alive || promptCompleted(targetLog,marker),'Delivery uncertain: prompt recorded without completed turn');
    }
    if (!state.messages.some(row=>row.key===key)) state.messages.push({key,target:id,reconciled:true,at:now()});
    state.inflight=null;checkpoint();return;
  }
  need(!state.inflight || state.inflight.key===key,'Another delivery is unresolved');
  state.inflight={key,target:id,at:now()};checkpoint();
  const out=path.join(run,'cli-'+key+'.json'),err=path.join(run,'cli-'+key+'.err');
  const output=fs.openSync(out,'a'),errors=fs.openSync(err,'a');
  const args=['-p',initial?'--session-id':'--resume',id,'--permission-mode',binding.permissionMode || 'auto','--output-format','json',full];
  const env={...process.env};delete env.CLAUDECODE;
  const result=await new Promise((resolve,reject)=>{
    const child=spawn(process.env.CLAUDE_CLI_PATH||'claude',args,{cwd:id===binding.supervisorId?binding.supervisorCwd:binding.projectRoot,env,stdio:['ignore',output,errors]});
    state.inflight.pid=child.pid;checkpoint();
    child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));
  });
  fs.closeSync(output);fs.closeSync(errors);
  need(result.code===0,'Claude CLI failed for '+key+'; inspect '+err);
  targetLog=transcript(id);
  need(promptSeen(targetLog,marker),'Claude response was not recorded in exact target session');
  save(path.join(run,'receipt-'+key+'.json'),{key,target:id,marker,output:out,at:now()});
  state.messages.push({key,target:id,at:now()});state.inflight=null;checkpoint();
}
function reviewPrompt(event) {
  const file=path.join(run,'decision-'+event.id+'.json');
  return `這是原監督對話的長任務事件，不是新任務。請重新載入 long-task-supervisor 技能，按鎖定契約 ${contractPath} 獨立處理事件 ${JSON.stringify(event)}。`
    + `將判定寫在 ${file}，執行 node ${path.join(__dirname,'supervise.cjs')} decision ${run} ${file}。`
    + '退件或代答只寫 reply 欄；背景程式會送回精確執行 session 並驗證記錄。新的商業取捨才向使用者確認；未全部通過不得稱完成。';
}
async function handlePending() {
  const event=state.pending, key='review-'+event.id;
  await invoke(binding.supervisorId,reviewPrompt(event),key);
  const file=path.join(run,'decision-'+event.id+'.json');
  if (!fs.existsSync(file)) {state.phase='needs_attention';checkpoint();await waitChange(file);return;}
  const decision=validateDecision(binding,checkSources(),event,read(file));
  if (decision.disposition==='needs_user') {state.phase='needs_user';checkpoint();await waitChange(file);return;}
  if (decision.disposition==='accept') {
    (state.resolved ||= {})[event.id]={event,decisionSha256:hash(file)};
    state.seen.push(event.id);state.pending=null;state.phase='accepted';state.acceptedAt=now();checkpoint();return;
  }
  await invoke(binding.executorId,decision.reply,'answer-'+event.id);
  (state.resolved ||= {})[event.id]={event,decisionSha256:hash(file)};
  state.seen.push(event.id);state.pending=null;state.phase='watching';checkpoint();
}
async function watch() {
  if (fs.existsSync(lockPath)) {
    const old=read(lockPath);let alive=false;
    try {process.kill(old.pid,0);alive=true;} catch {}
    need(!alive,'Another watcher owns this run');fs.unlinkSync(lockPath);
  }
  fs.writeFileSync(lockPath,JSON.stringify({pid:process.pid,run,at:now()}),{flag:'wx'});ownsLock=true;
  checkSources();need(hash(path.join(run,'executor-prompt.txt'))===binding.promptSha256,'Executor prompt changed');
  state.pid=process.pid;checkpoint();
  if (!state.executorStarted) {
    let offset=binding.supervisorStartOffset;
    while (!stopped()) {
      const batch=take(binding.supervisorLog,offset);offset=batch.offset;
      if (finalEvents(batch.lines).length) break;
      await waitChange(binding.supervisorLog);
    }
    if (stopped()) return;
    await invoke(binding.executorId,fs.readFileSync(path.join(run,'executor-prompt.txt'),'utf8'),'initial',true);
    state.executorStarted=true;checkpoint();
  }
  const executorLog=transcript(binding.executorId);
  save(path.join(run,'native-ready.json'),{pid:process.pid,executorId:binding.executorId,readVerified:true,at:now()});
  if (state.error) { (state.history ||= []).push(state.error);delete state.error; }
  state.phase=state.pending?'awaiting_decision':'watching';checkpoint();
  while (!stopped() && state.phase!=='accepted') {
    if (state.pending) {await handlePending();continue;}
    if (!state.queue?.length) {
      const batch=take(executorLog,state.executorOffset);
      state.executorOffset=batch.offset;state.reads++;
      state.queue=finalEvents(batch.lines).filter(row=>!state.seen.includes(row.id));checkpoint();
      if (!state.queue.length) {await waitChange(executorLog);continue;}
    }
    while (state.queue.length) {
      const final=state.queue[0];
      if (state.seen.includes(final.id)) {state.queue.shift();checkpoint();continue;}
      const event=eventOf(final);
      if (event.kind==='progress') {
        const repeated=state.lastProgressAction===event.nextAction?(state.repeatedProgress||0)+1:1;
        state.lastProgressAction=event.nextAction;state.repeatedProgress=repeated;
        if (repeated<3) {
          await invoke(binding.executorId,`續接 ${event.id}：執行你剛明列的下一步「${event.nextAction}」，沿用原契約及已完成工作。`,'continue-'+event.id);
          state.seen.push(event.id);state.queue.shift();checkpoint();continue;
        }
        event.kind='stalled';
      }
      state.pending=event;state.phase='awaiting_decision';state.queue.shift();checkpoint();break;
    }
  }
  if (state.phase!=='accepted') {state.phase='stopped';state.stoppedAt=now();checkpoint();}
}
(async()=>{
  try {await watch();}
  catch(error) {state.phase=error.message.startsWith('Delivery uncertain:')?'needs_reconcile':'error';state.error={message:error.message,at:now()};checkpoint();console.error(error.stack||error);process.exitCode=1;}
  finally {state.endedAt=now();checkpoint();if (ownsLock) {try {if(read(lockPath).pid===process.pid)fs.unlinkSync(lockPath);} catch {}}}
})();
