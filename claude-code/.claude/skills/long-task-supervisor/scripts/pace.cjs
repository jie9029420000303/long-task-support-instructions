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
function agentRuns(binding){
  const dir=subagentDir(binding);let names=[];
  try{names=fs.readdirSync(dir).filter(name=>/^agent-.+\.jsonl$/.test(name));}catch{}
  return names.map(name=>agentRun(path.join(dir,name)));
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
  return {...known,samples:0,source:DEFAULTS[model]?'default for '+model:'default (Sonnet 5.5) for unmeasured '+(model||'model')};
}
function baseline({model,estimatedOutputTokens,toolMinutes=0},measured){
  const known=rate(model,measured);
  const tokens=Number.isFinite(estimatedOutputTokens)&&estimatedOutputTokens>0?estimatedOutputTokens:known.outputTokens;
  const minutes=round(tokens/known.tokensPerSecond/60+(Number(toolMinutes)||0));
  return {model:model||null,estimatedOutputTokens:tokens,tokensPerSecond:known.tokensPerSecond,toolMinutes:Number(toolMinutes)||0,minutes,
    basis:`${tokens} output tokens ÷ ${known.tokensPerSecond} tokens/s (${known.source}, ${known.samples} samples)`+(toolMinutes?` + ${toolMinutes} min measured tool time`:'')};
}
// In-flight packages against their baselines. An agent package is recomputed from its own transcript; a
// process package (tests, product runs) can only carry the executor's measured baseline.
function inFlight(binding,snapshot,now=Date.now()){
  const runs=agentRuns(binding),measured=speed(runs),byId=new Map(runs.map(run=>[run.id,run]));
  const packages=(snapshot?.packages?.inFlight||[]).map(item=>{
    const agentId=/^agent:(.+)$/.exec(item.handle||'')?.[1],run=agentId?byId.get(agentId):null,declared=item.baseline||null;
    const startedAt=Date.parse(declared?.startedAt)||run?.startedAt||null;
    const own=run?baseline({model:run.model||declared?.model,estimatedOutputTokens:declared?.estimatedOutputTokens,toolMinutes:declared?.toolMinutes},measured):null;
    const minutes=declared?.minutes||own?.minutes||null;
    const elapsed=startedAt?round((now-startedAt)/60000):null;
    const mismatch=Boolean(declared?.minutes&&own?.minutes&&Math.abs(declared.minutes-own.minutes)/own.minutes>0.5);
    return {id:item.id,handle:item.handle,startedAt:startedAt?new Date(startedAt).toISOString():null,elapsedMinutes:elapsed,
      baselineMinutes:minutes,ratio:minutes&&elapsed!==null?round(elapsed/minutes):null,executorBaselineMinutes:declared?.minutes??null,
      supervisorBaselineMinutes:own?.minutes??null,mismatch,outputTokens:run?.outputTokens??null,
      lastActivityAt:run?.lastAt?new Date(run.lastAt).toISOString():null,baselineMissing:!minutes};
  });
  return {speed:measured,packages};
}
module.exports={DEFAULTS,agentRuns,speed,rate,baseline,inFlight};
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
