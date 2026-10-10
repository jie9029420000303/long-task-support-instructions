#!/usr/bin/env node
// AI-speed baselines: how long a work package should take, from the model's measured output tokens per
// second in this run, not from human development experience. The executor writes the baseline into its
// dispatch snapshot; the supervisor recomputes it with the same formula and compares.
const fs=require('node:fs');
const path=require('node:path');
// Used only until this run has three finished subagents of the model. Measured on the 2026-10-07 GDB
// engine-direct run: 30 Sonnet 5.5 technical packages, median 66.9 output tokens/s and 47,118 output tokens.
const DEFAULTS={'claude-sonnet-5-5':{tokensPerSecond:66.9,outputTokens:47118}};
const FALLBACK=DEFAULTS['claude-sonnet-5-5'];
const MIN_SAMPLES=3;
const median=values=>{const sorted=[...values].sort((a,b)=>a-b),mid=sorted.length>>1;return sorted.length%2?sorted[mid]:(sorted[mid-1]+sorted[mid])/2;};
const round=value=>Math.round(value*10)/10;
function agentRun(file){
  const messages=new Map();let startedAt=null,lastAt=null,done=false,model=null;
  for(const line of fs.readFileSync(file,'utf8').split('\n')){
    let row;try{row=JSON.parse(line);}catch{continue;}
    const at=Date.parse(row.timestamp);
    if(Number.isFinite(at)){startedAt??=at;lastAt=at;}
    if(row.type!=='assistant'||!row.message)continue;
    model=row.message.model||model;
    if(row.message.usage)messages.set(row.message.id||row.uuid,row.message.usage.output_tokens||0);
    done=row.message.stop_reason==='end_turn';
  }
  const outputTokens=[...messages.values()].reduce((sum,value)=>sum+value,0);
  const seconds=startedAt&&lastAt?(lastAt-startedAt)/1000:0;
  return {id:path.basename(file,'.jsonl').replace(/^agent-/,''),model,startedAt,lastAt,outputTokens,done,seconds};
}
function subagentDir(binding){return path.join(path.dirname(binding.executorLog),binding.executorId,'subagents');}
const agentFiles=dir=>{try{return fs.readdirSync(dir).filter(name=>/^agent-.+\.jsonl$/.test(name)).map(name=>path.join(dir,name));}catch{return [];}};
// Agents a dynamic workflow starts live one level down, in subagents/workflows/<runId>/. Its journal names each one
// with the label the script gave it (the work package id; the snapshot names it workflow:<runId>:<label>) and records
// result or failed when it ends: a workflow agent ends on a structured-output tool call, not on end_turn.
function workflowRuns(binding){
  const root=path.join(subagentDir(binding),'workflows');let dirs=[];
  try{dirs=fs.readdirSync(root,{withFileTypes:true}).filter(entry=>entry.isDirectory()).map(entry=>entry.name);}catch{}
  return dirs.flatMap(dir=>{
    const events=new Map();
    try{for(const line of fs.readFileSync(path.join(root,dir,'journal.jsonl'),'utf8').split('\n')){
      let row;try{row=JSON.parse(line);}catch{continue;}
      if(!row.agentId)continue;const item=events.get(row.agentId)||{};
      if(row.type==='started')item.label=row.label??null;else if(row.type==='result')item.result=true;else if(row.type==='failed')item.failed=true;
      events.set(row.agentId,item);
    }}catch{}
    return agentFiles(path.join(root,dir)).map(file=>{const run=agentRun(file),item=events.get(run.id)||{};
      return {...run,workflow:dir,label:item.label??null,done:Boolean(item.result||item.failed),failed:Boolean(item.failed)};});
  });
}
function agentRuns(binding){return [...agentFiles(subagentDir(binding)).map(agentRun),...workflowRuns(binding)];}
// A finished run shorter than a minute is a launch failure or a one-line answer, not a speed sample.
function speed(runs){
  const models={};
  for(const run of runs.filter(item=>item.done&&!item.failed&&item.model&&item.seconds>=60&&item.outputTokens>0))(models[run.model]||=[]).push(run);
  const result={};
  for(const [model,items] of Object.entries(models))if(items.length>=MIN_SAMPLES)
    result[model]={tokensPerSecond:round(median(items.map(item=>item.outputTokens/item.seconds))),outputTokens:Math.round(median(items.map(item=>item.outputTokens))),samples:items.length,source:'this run'};
  return result;
}
function rate(model,measured){
  if(measured[model])return measured[model];
  const known=DEFAULTS[model]||FALLBACK;
  return {...known,samples:0,source:DEFAULTS[model]?'default for '+model:'default (Sonnet 5.5) for unmeasured '+(model||'model')};
}
function baseline({model,estimatedOutputTokens,toolMinutes=0},measured){
  const known=rate(model,measured);
  const tokens=Number.isFinite(estimatedOutputTokens)&&estimatedOutputTokens>0?estimatedOutputTokens:known.outputTokens;
  const minutes=round(tokens/known.tokensPerSecond/60+(Number(toolMinutes)||0));
  return {model:model||null,estimatedOutputTokens:tokens,tokensPerSecond:known.tokensPerSecond,toolMinutes:Number(toolMinutes)||0,minutes,
    basis:`${tokens} output tokens ÷ ${known.tokensPerSecond} tokens/s (${known.source}, ${known.samples} samples)`+(toolMinutes?` + ${toolMinutes} min measured tool time`:'')};
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
// In-flight packages against their baselines. An agent package is recomputed from its own transcript; a
// process package can only carry the executor's measured baseline. Elapsed time excludes machine sleep, and an
// agent whose transcript already ended is finished (the snapshot is stale), not overdue.
function inFlight(binding,snapshot,now=Date.now(),sleeps=[]){
  const runs=agentRuns(binding),measured=speed(runs),byId=new Map(runs.map(run=>[run.id,run]));
  for(const run of runs)if(run.workflow&&run.label)byId.set(run.workflow+':'+run.label,run);
  const packages=(snapshot?.packages?.inFlight||[]).map(item=>{
    const agentId=/^(?:agent|workflow):(.+)$/.exec(item.handle||'')?.[1],run=agentId?byId.get(agentId):null,declared=item.baseline||null;
    const startedAt=Date.parse(declared?.startedAt)||run?.startedAt||null;
    const own=run?baseline({model:run.model||declared?.model,estimatedOutputTokens:declared?.estimatedOutputTokens,toolMinutes:declared?.toolMinutes},measured):null;
    const minutes=declared?.minutes||own?.minutes||null,process=!agentId,activity=process?evidenceActivity(item):run?.lastAt;
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
  return {speed:measured,packages,processActivityAt};
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
module.exports={DEFAULTS,agentRuns,speed,rate,baseline,inFlight,sleptWithin,resourceUse};
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
      let snapshot=null;try{snapshot=JSON.parse(fs.readFileSync(path.join(run,binding.dispatchAudit?.snapshot||'dispatch.json'),'utf8'));}catch{}
      console.log(JSON.stringify(inFlight(binding,snapshot)));
    }
  }catch(error){console.error(error.message);process.exitCode=1;}
}
