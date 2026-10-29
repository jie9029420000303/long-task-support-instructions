// Rate-limit model fallback (Jay 2026-10-11): when the supervisor, the executor or one of its subagents is refused
// for quota, switch to the next model in Jay's order anthropic/ -> anthropic-apikey/ -> gpt-6.1-sol, and switch
// back when the limit resets. opencodex records every request in usage.jsonl with conversationId =
// sha256(Codex thread id)[:32], so a 429 maps to the exact thread (2026-10-11 05:04: this research chat on
// anthropic/claude-opus-5-5, "All Anthropic OAuth accounts are temporarily rate-limited").
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const pace=require('./pace.cjs');
const FALLBACK_MS=5*60*60*1000;
// The last stop moved from gpt-5.6-sol to the current GPT model (Jay 2026-10-29: 「限速後換模型換成你的推薦的那個 SOL」).
const LAST_RESORT='gpt-6.1-sol';
const home=()=>process.env.OPENCODEX_HOME||path.join(os.homedir(),'.opencodex');
const usageFile=()=>process.env.OPENCODEX_USAGE_FILE||path.join(home(),'usage.jsonl');
const quotaFile=()=>process.env.OPENCODEX_QUOTA_FILE||path.join(home(),'provider-account-quota-cache.json');
const hashId=id=>crypto.createHash('sha256').update(String(id)).digest('hex').slice(0,32);
// The limit belongs to a provider path: anthropic/ and anthropic-apikey/ are separate accounts; other models stand alone.
function keyOf(model){const match=/^(anthropic(?:-apikey)?\/)/.exec(model||'');return match?match[1]:String(model||'');}
function chainFor(original,role){
  const name=/(claude-[^/]+)$/.exec(original||'')?.[1]||(role==='subagent'?'claude-sonnet-5-5':'claude-opus-5-5');
  return ['anthropic/'+name,'anthropic-apikey/'+name,LAST_RESORT];
}
function limited(state,model,now=Date.now()){const item=state.rateLimits?.[keyOf(model)];return Boolean(item&&item.until>now);}
function next(original,current,role,state,now=Date.now()){
  return chainFor(original,role).find(model=>model!==current&&!limited(state,model,now))||null;
}
// H1: the recorded reset when opencodex has one; otherwise five hours after the refusal.
function resetFor(key,since){
  if(key==='anthropic/'){
    try{
      const rows=Object.entries(JSON.parse(fs.readFileSync(quotaFile(),'utf8')).rows||{}).filter(([id])=>id.startsWith('anthropic\u0000')).map(([,row])=>row);
      const resets=rows.map(row=>Math.max(row.fiveHourPercent>=100?Number(row.fiveHourResetAt)||0:0,row.weeklyPercent>=100?Number(row.weeklyResetAt)||0:0));
      // Every account must be exhausted for "all accounts limited"; the first one to reset ends the limit.
      if(rows.length&&resets.every(at=>at>since))return {until:Math.min(...resets),basis:'opencodex 額度紀錄的最早重置時間'};
    }catch{}
  }
  return {until:since+FALLBACK_MS,basis:'查不到額度重置時間，用 5 小時'};
}
function isLimit(row){return row.status===429||row.status===402||row.failureCause==='rate-limit'||['rate_limit_exceeded','insufficient_quota'].includes(row.errorCode);}
const hitOf=(owner,row)=>({...owner,model:row.requestedModel||row.model,at:Number(row.timestamp)||Date.now(),error:String(row.upstreamError||row.errorCode||row.status).slice(0,200)});
function readRange(file,from,to){
  const fd=fs.openSync(file,'r'),buffer=Buffer.alloc(to-from);
  try{fs.readSync(fd,buffer,0,buffer.length,from);}finally{fs.closeSync(fd);}
  return buffer;
}
// New refusals since the last read. The first read looks back over the file's tail: a thread refused before the
// watcher (re)started still waits on that refusal (2026-10-11 22:09: A's supervisor was refused, the watcher restarted
// at 22:49 and read from the end, so the live limit was never handled). Only a thread whose latest request is still
// the refusal, within the five-hour fallback window, counts; an older refusal followed by a success is history.
function scan(state,threads){
  const file=usageFile();let size;
  try{size=fs.statSync(file).size;}catch{return [];}
  const owners=new Map(threads.map(item=>[hashId(item.threadId),item]));
  if(state.usageOffset===undefined||size<state.usageOffset){
    state.usageOffset=size;
    const from=Math.max(0,size-32*1024*1024),latest=new Map();
    for(const line of readRange(file,from,size).toString('utf8').split('\n')){
      if(!line.includes('"conversationId"'))continue;
      let row;try{row=JSON.parse(line);}catch{continue;}
      if(owners.has(row.conversationId)&&row.model!=='codex-auto-review')latest.set(row.conversationId,row);
    }
    return [...latest].filter(([,row])=>isLimit(row)&&Date.now()-Number(row.timestamp)<FALLBACK_MS).map(([id,row])=>hitOf(owners.get(id),row));
  }
  if(size===state.usageOffset)return [];
  const buffer=readRange(file,state.usageOffset,state.usageOffset+Math.min(size-state.usageOffset,64*1024*1024));
  const complete=buffer.lastIndexOf(10);if(complete<0)return [];
  state.usageOffset+=complete+1;
  const hits=[];
  for(const line of buffer.subarray(0,complete).toString('utf8').split('\n')){
    if(!line.includes('"conversationId"'))continue;
    let row;try{row=JSON.parse(line);}catch{continue;}
    const owner=owners.get(row.conversationId);
    if(owner&&isLimit(row))hits.push(hitOf(owner,row));
  }
  return hits;
}
// The latest model and reasoning a thread runs with, from its own rollout.
function settingsOf(threadId){
  const file=pace.sessionFile(threadId);if(!file)return null;
  const size=fs.statSync(file).size,length=Math.min(size,4*1024*1024),buffer=Buffer.alloc(length),fd=fs.openSync(file,'r');
  try{fs.readSync(fd,buffer,0,length,size-length);}finally{fs.closeSync(fd);}
  let found=null;
  for(const line of buffer.toString('utf8').split('\n')){
    if(!line.includes('"turn_context"'))continue;
    try{const row=JSON.parse(line);if(row.type==='turn_context')found={model:row.payload?.model||null,effort:row.payload?.effort||null,
      approvalPolicy:row.payload?.approval_policy||null,reviewer:row.payload?.approvals_reviewer||null,at:row.timestamp};}catch{}
  }
  return found;
}
function publish(run,state,now=Date.now()){
  const limits=Object.fromEntries(Object.entries(state.rateLimits||{}).filter(([,item])=>item.until>now)
    .map(([key,item])=>[key,{until:new Date(item.until).toISOString(),basis:item.basis,model:item.model}]));
  const body={chain:['anthropic/','anthropic-apikey/',LAST_RESORT],limits,
    rule:'派子代理前：模型的系列在 limits 且 until 未到，就依 chain 改用下一個同層級模型（Opus 換 Opus、Sonnet 換 Sonnet），全被限速才用 '+LAST_RESORT+'；until 過後回到原模型。',
    updatedAt:new Date(now).toISOString()};
  const file=path.join(run,'model-fallback.json');
  fs.writeFileSync(file+'.tmp',JSON.stringify(body,null,2)+'\n');fs.renameSync(file+'.tmp',file);
  return body;
}
module.exports={FALLBACK_MS,LAST_RESORT,hashId,keyOf,chainFor,limited,next,resetFor,scan,settingsOf,publish};
