#!/usr/bin/env node
// AI-speed baselines: how long a work package should take, from the model's measured output tokens per
// second in this run, not from human development experience. The executor writes the baseline into its
// dispatch snapshot; the supervisor recomputes it with the same formula and compares.
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
// Used only until this run has three finished subagents of the model. Measured on 2026-10-08 from the Codex
// subagent rollouts on Jay's Mac with this file's own parser (May–Oct 2026, finished, at least a minute of turn
// time): median output tokens per second of turn time and median output tokens, n = 60, 31 and 11.
const DEFAULTS={'gpt-5.6-sol':{tokensPerSecond:34.9,outputTokens:19817},'gpt-5.6-terra':{tokensPerSecond:42.2,outputTokens:14627},
  'gpt-6.1-sol':{tokensPerSecond:25.7,outputTokens:9554}};
const FALLBACK=DEFAULTS['gpt-5.6-sol'];
const MIN_SAMPLES=3;
const median=values=>{const sorted=[...values].sort((a,b)=>a-b),mid=sorted.length>>1;return sorted.length%2?sorted[mid]:(sorted[mid-1]+sorted[mid])/2;};
const round=value=>Math.round(value*10)/10;
function sessionsRoot(){return path.join(process.env.CODEX_HOME||path.join(os.homedir(),'.codex'),'sessions');}
// A thread's rollout is sessions/YYYY/MM/DD/rollout-<time>-<thread id>.jsonl; newest days are searched first.
function sessionFile(threadId){
  const root=sessionsRoot(),list=dir=>{try{return fs.readdirSync(dir).filter(name=>/^\d+$/.test(name)).sort().reverse();}catch{return [];}};
  for(const year of list(root))for(const month of list(path.join(root,year)))for(const day of list(path.join(root,year,month))){
    const dir=path.join(root,year,month,day),name=fs.readdirSync(dir).find(item=>item.endsWith('-'+threadId+'.jsonl'));
    if(name)return path.join(dir,name);
  }
  return null;
}
function firstLine(file){
  const fd=fs.openSync(file,'r');
  try{const buffer=Buffer.alloc(256*1024),size=fs.readSync(fd,buffer,0,buffer.length,0),end=buffer.subarray(0,size).indexOf(10);
    return buffer.subarray(0,end<0?size:end).toString('utf8');}finally{fs.closeSync(fd);}
}
// A Codex subagent rollout starts with session_meta naming its agent path and the root thread it serves; a
// subagent turn runs from task_started to task_complete, and token_count carries the running output total.
// Turns are summed because a subagent waits between messages, and that wait is not output time.
const parsed=new Map();
function agentRun(file,meta){
  let item=parsed.get(file);
  if(!item)parsed.set(file,item={offset:0,model:null,startedAt:null,lastAt:null,turnAt:null,activeMs:0,outputTokens:0,done:false});
  const size=fs.statSync(file).size;
  if(size>item.offset){
    const fd=fs.openSync(file,'r'),buffer=Buffer.alloc(size-item.offset);
    try{fs.readSync(fd,buffer,0,buffer.length,item.offset);}finally{fs.closeSync(fd);}
    const complete=buffer.lastIndexOf(10);
    if(complete>=0){
      item.offset+=complete+1;
      for(const line of buffer.subarray(0,complete).toString('utf8').split('\n')){
        let row;try{row=JSON.parse(line);}catch{continue;}
        const at=Date.parse(row.timestamp),payload=row.payload||{};
        if(Number.isFinite(at)){item.startedAt??=at;item.lastAt=at;}
        if(row.type==='turn_context')item.model=payload.model||item.model;
        else if(payload.type==='task_started'){item.turnAt=at;item.done=false;}
        else if(payload.type==='task_complete'||payload.type==='turn_aborted'){if(item.turnAt)item.activeMs+=at-item.turnAt;item.turnAt=null;item.done=payload.type==='task_complete';}
        else if(payload.type==='token_count'&&payload.info?.total_token_usage)item.outputTokens=payload.info.total_token_usage.output_tokens||0;
      }
    }
  }
  const activeMs=item.activeMs+(item.turnAt&&item.lastAt?item.lastAt-item.turnAt:0);
  return {id:meta.id,path:meta.agent_path||null,model:item.model,startedAt:item.startedAt,lastAt:item.lastAt,outputTokens:item.outputTokens,done:item.done,seconds:activeMs/1000};
}
// Rollouts live in sessions/YYYY/MM/DD by local start date; subagents of this executor start after binding.
const metas=new Map();
function rollouts(binding,now=Date.now()){
  const files=[],from=new Date((Date.parse(binding.createdAt)||now)-24*3600*1000);from.setHours(0,0,0,0);
  for(const day=new Date(from);day.getTime()<=now;day.setDate(day.getDate()+1)){
    const dir=path.join(sessionsRoot(),String(day.getFullYear()),String(day.getMonth()+1).padStart(2,'0'),String(day.getDate()).padStart(2,'0'));
    try{for(const name of fs.readdirSync(dir))if(name.endsWith('.jsonl'))files.push(path.join(dir,name));}catch{}
  }
  return files;
}
function agentRuns(binding){
  const runs=[];
  for(const file of rollouts(binding)){
    let meta=metas.get(file);
    if(meta===undefined){try{const row=JSON.parse(firstLine(file));meta=row.type==='session_meta'?row.payload:null;}catch{meta=null;}metas.set(file,meta);}
    if(meta?.thread_source!=='subagent'||![meta.session_id,meta.parent_thread_id].includes(binding.executorId))continue;
    try{runs.push(agentRun(file,meta));}catch{}
  }
  return runs;
}
// A finished run shorter than a minute is a launch failure or a one-line answer, not a speed sample.
function speed(runs){
  const models={};
  for(const run of runs.filter(item=>item.done&&item.model&&item.seconds>=60&&item.outputTokens>0))(models[run.model]||=[]).push(run);
  const result={};
  for(const [model,items] of Object.entries(models))if(items.length>=MIN_SAMPLES)
    result[model]={tokensPerSecond:round(median(items.map(item=>item.outputTokens/item.seconds))),outputTokens:Math.round(median(items.map(item=>item.outputTokens))),samples:items.length,source:'this run'};
  return result;
}
function rate(model,measured){
  if(measured[model])return measured[model];
  const known=DEFAULTS[model]||FALLBACK;
  return {...known,samples:0,source:DEFAULTS[model]?'default for '+model:'default (gpt-5.6-sol) for unmeasured '+(model||'model')};
}
function baseline({model,estimatedOutputTokens,toolMinutes=0},measured){
  const known=rate(model,measured);
  const tokens=Number.isFinite(estimatedOutputTokens)&&estimatedOutputTokens>0?estimatedOutputTokens:known.outputTokens;
  const minutes=round(tokens/known.tokensPerSecond/60+(Number(toolMinutes)||0));
  return {model:model||null,estimatedOutputTokens:tokens,tokensPerSecond:known.tokensPerSecond,toolMinutes:Number(toolMinutes)||0,minutes,
    basis:`${tokens} output tokens ÷ ${known.tokensPerSecond} tokens/s (${known.source}, ${known.samples} samples)`+(toolMinutes?` + ${toolMinutes} min measured tool time`:'')};
}
// A Codex subagent is named by its agent path (/root/name) or its thread ID; anything else is a process package.
function agentRef(handle){
  const value=/^agent:(.+)$/.exec(handle||'')?.[1]||handle||'';
  return value.startsWith('/root/')||/^[0-9a-f]{8}-[0-9a-f]{4}-/.test(value)?value:null;
}
// A process package (tests, product runs) shows activity through its evidence files, such as its log.
function evidenceActivity(item){
  let latest=0;
  for(const file of item.evidence||[])try{if(path.isAbsolute(file))latest=Math.max(latest,fs.statSync(file).mtimeMs);}catch{}
  return latest||null;
}
// A process package started through the task's resource ledger (resources/<id>.log beside resources.json) can
// be checked for life: a drill waiting on a lease writes nothing for half an hour but is not stalled.
function processAlive(item){
  const id=/^resource:(.+)$/.exec(item.handle||'')?.[1];
  if(!id)return null;
  for(const file of item.evidence||[]){
    if(!path.isAbsolute(file)||path.basename(path.dirname(file))!=='resources')continue;
    try{
      const entry=(JSON.parse(fs.readFileSync(path.join(path.dirname(path.dirname(file)),'resources.json'),'utf8')).resources||[]).find(value=>value.id===id);
      if(!entry?.pgid)continue;
      try{process.kill(-entry.pgid,0);return true;}catch(error){return error.code==='EPERM';}
    }catch{}
  }
  return null;
}
// Minutes the machine slept inside a window: a closed lid stops every package, so it is not lateness.
function sleptWithin(sleeps,from,to){
  let total=0;
  for(const item of sleeps||[]){const start=Math.max(from,Date.parse(item.from)),end=Math.min(to,Date.parse(item.to));if(end>start)total+=end-start;}
  return total;
}
// In-flight packages against their baselines. An agent package is recomputed from its own rollout; a process
// package can only carry the executor's measured baseline. Elapsed time excludes machine sleep, and an agent
// whose rollout already completed its turn is finished (the snapshot is stale), not overdue.
function inFlight(binding,snapshot,now=Date.now(),sleeps=[]){
  const runs=agentRuns(binding),measured=speed(runs),latest=new Map();
  for(const run of runs)for(const key of [run.id,run.path])if(key&&(!latest.has(key)||latest.get(key).startedAt<run.startedAt))latest.set(key,run);
  const packages=(snapshot?.packages?.inFlight||[]).map(item=>{
    const ref=agentRef(item.handle),run=ref?latest.get(ref):null,declared=item.baseline||null;
    const startedAt=Date.parse(declared?.startedAt)||run?.startedAt||null;
    const own=run?baseline({model:run.model||declared?.model,estimatedOutputTokens:declared?.estimatedOutputTokens,toolMinutes:declared?.toolMinutes},measured):null;
    const minutes=declared?.minutes||own?.minutes||null,process=!ref,activity=process?evidenceActivity(item):run?.lastAt;
    const finished=Boolean(run?.done),alive=process?processAlive(item):null;
    const slept=startedAt?sleptWithin(sleeps,startedAt,now):0;
    const elapsed=startedAt?round((now-startedAt-slept)/60000):null;
    const mismatch=Boolean(declared?.minutes&&own?.minutes&&Math.abs(declared.minutes-own.minutes)/own.minutes>0.5);
    return {id:item.id,handle:item.handle,startedAt:startedAt?new Date(startedAt).toISOString():null,elapsedMinutes:elapsed,
      baselineMinutes:minutes,ratio:minutes&&elapsed!==null&&!finished?round(elapsed/minutes):null,executorBaselineMinutes:declared?.minutes??null,
      supervisorBaselineMinutes:own?.minutes??null,mismatch,outputTokens:run?.outputTokens??null,
      lastActivityAt:activity?new Date(activity).toISOString():null,process,alive,finished,sleptMinutes:round(slept/60000),baselineMissing:!minutes&&!finished};
  });
  // A live process counts as activity even while it writes nothing.
  const processActivityAt=Math.max(0,...packages.filter(item=>item.process&&(item.lastActivityAt||item.alive)).map(item=>item.alive?now:Date.parse(item.lastActivityAt)))||null;
  const subagentActivityAt=Math.max(0,...runs.map(run=>run.lastAt||0))||null;
  return {speed:measured,packages,processActivityAt,subagentActivityAt};
}
// Real test resources (a host's diagnosis slots, test identities) the snapshot declares: capacity.resources
// [{key,slots}] and per-package uses [{key,units}]. Free slots while ready or blocked work needs the same resource
// mean the run could go faster (2026-10-07: the GDB host ran 2 of its 4 diagnosis slots while tests waited).
function resourceUse(snapshot){
  const declared=snapshot?.capacity?.resources;
  if(!Array.isArray(declared))return [];
  const packages=snapshot.packages||{},uses=(item,key)=>(item.uses||[]).filter(use=>use&&use.key===key);
  return declared.filter(item=>item&&item.key&&Number(item.slots)>0).map(({key,slots})=>{
    const used=(packages.inFlight||[]).reduce((sum,item)=>sum+uses(item,key).reduce((total,use)=>total+(Number(use.units)||1),0),0);
    const waiting=[...(packages.ready||[]),...(packages.blocked||[])].filter(item=>uses(item,key).length).map(item=>item.id);
    return {key,slots:Number(slots),used,free:Number(slots)-used,waiting};
  });
}
module.exports={DEFAULTS,sessionsRoot,sessionFile,agentRuns,speed,rate,baseline,inFlight,sleptWithin,resourceUse};
if(require.main===module){
  const [command,runArg,...rest]=process.argv.slice(2);
  try{
    if(!['status','estimate'].includes(command)||!path.isAbsolute(runArg||''))throw Error('Usage: pace.cjs status ABSOLUTE_RUN | pace.cjs estimate ABSOLUTE_RUN --model MODEL [--tokens N] [--tool-minutes M]');
    const run=path.resolve(runArg),binding=JSON.parse(fs.readFileSync(path.join(run,'binding.json'),'utf8'));
    const option=name=>{const index=rest.indexOf('--'+name);return index>=0?rest[index+1]:undefined;};
    if(command==='estimate'){
      const value=baseline({model:option('model'),estimatedOutputTokens:Number(option('tokens')),toolMinutes:Number(option('tool-minutes')||0)},speed(agentRuns(binding)));
      console.log(JSON.stringify({...value,startedAt:new Date().toISOString()}));
    }else{
      let snapshot=null,sleeps=[];try{snapshot=JSON.parse(fs.readFileSync(path.join(run,binding.dispatchAudit?.snapshot||'dispatch.json'),'utf8'));}catch{}
      try{sleeps=JSON.parse(fs.readFileSync(path.join(run,'daemon-state.json'),'utf8')).sleeps||[];}catch{}
      console.log(JSON.stringify(inFlight(binding,snapshot,Date.now(),sleeps)));
    }
  }catch(error){console.error(error.message);process.exitCode=1;}
}
